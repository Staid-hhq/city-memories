(() => {
  'use strict';

  const endpoint = 'https://api.tianditu.gov.cn/v2/administrative';
  const docs = 'http://lbs.tianditu.gov.cn/server/administrative2.html';
  const municipalityCodes = new Set(['110000', '120000', '310000', '500000']);
  const specialRegionCodes = new Set(['810000', '820000']);
  const requests = new Map();
  const boundaryCache = new Map();
  let configPromise;
  let directoryPromise;
  let outlinePromise;
  let outlineRetryPromise;
  const outlineParts = new Map();
  let provinceNodes = [];
  const requestStartInterval = 1500;
  let requestTail = Promise.resolve();
  let lastRequestStartedAt = -Infinity;
  const outlineListeners = new Set();
  let lastOutlineProgress;

  function checkedGeometry(type, coordinates, diagnostics = {}) {
    const invalid = reason => { diagnostics.reason = reason; return null; };
    if (!['Polygon', 'MultiPolygon'].includes(type) || !Array.isArray(coordinates)) return invalid('Unsupported geometry type');
    const polygons = type === 'Polygon' ? [coordinates] : coordinates;
    if (!polygons.length) return invalid('Empty polygon list');
    let positionCount = 0;
    const normalized = [];
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length) return invalid('Empty or invalid polygon');
      const rings = [];
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 3) return invalid(`Invalid ring: ${Array.isArray(ring) ? ring.length : 'not-array'} positions`);
        const positions = [];
        for (const point of ring) {
          if (!Array.isArray(point) || point.length < 2) return invalid('Invalid coordinate dimensions');
          const [longitude, latitude] = point;
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
            || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return invalid('Coordinate outside longitude/latitude range');
          positions.push([longitude, latitude]);
          if (++positionCount > 1_000_000) return invalid('Boundary exceeds coordinate safety limit');
        }
        const first = positions[0];
        const last = positions.at(-1);
        if (first[0] !== last[0] || first[1] !== last[1]) positions.push([...first]);
        if (positions.length < 4) return invalid('Ring cannot be closed');
        rings.push(positions);
      }
      normalized.push(rings);
    }
    return { type, coordinates: type === 'Polygon' ? normalized[0] : normalized };
  }

  /** Convert documented WKT polygon boundaries, retaining islands and inner rings. */
  function parseBoundary(value, diagnostics = {}) {
    if (value && typeof value === 'object') {
      const geometry = value.type === 'Feature' ? value.geometry : value;
      return geometry ? checkedGeometry(geometry.type, geometry.coordinates, diagnostics) : null;
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 20_000_000) {
      diagnostics.reason = 'Missing, empty or oversized boundary';
      return null;
    }
    let source = value.trim();
    if (source.startsWith('"') || source.startsWith('{')) {
      try {
        const decoded = JSON.parse(source);
        if (decoded === value) return null;
        return parseBoundary(decoded, diagnostics);
      } catch {
        diagnostics.reason = 'Invalid JSON boundary wrapper';
        return null;
      }
    }
    const srid = source.match(/^SRID\s*=\s*(\d+)\s*;\s*/i);
    if (srid) {
      if (!['4326', '4490'].includes(srid[1])) { diagnostics.reason = 'Non-geographic SRID'; return null; }
      source = source.slice(srid[0].length);
    }
    const prefix = source.match(/^(MULTIPOLYGON|POLYGON)\s*(?:ZM|Z|M)?\s*/i);
    if (!prefix) { diagnostics.reason = 'Unsupported WKT prefix'; return null; }
    const type = prefix[1].toUpperCase() === 'POLYGON' ? 'Polygon' : 'MultiPolygon';
    source = source.slice(prefix[0].length);
    if (/^EMPTY$/i.test(source)) { diagnostics.reason = 'Empty WKT geometry'; return null; }
    const numberPattern = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y;
    let cursor = 0;
    const whitespace = () => { while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++; };
    const character = () => { whitespace(); return source[cursor]; };
    const readNumber = () => {
      whitespace();
      numberPattern.lastIndex = cursor;
      const match = numberPattern.exec(source);
      if (!match) throw new Error('Invalid coordinate');
      cursor = numberPattern.lastIndex;
      const number = Number(match[0]);
      if (!Number.isFinite(number)) throw new Error('Invalid coordinate');
      return number;
    };
    const group = depth => {
      if (depth > 5 || character() !== '(') throw new Error('Invalid boundary group');
      cursor++;
      const items = [];
      while (true) {
        if (character() === '(') items.push(group(depth + 1));
        else {
          const point = [readNumber(), readNumber()];
          while (character() !== ',' && character() !== ')') {
            if (point.length >= 4) throw new Error('Invalid coordinate dimension');
            point.push(readNumber());
          }
          items.push(point);
        }
        const delimiter = character();
        cursor++;
        if (delimiter === ')') return items;
        if (delimiter !== ',') throw new Error('Invalid boundary delimiter');
      }
    };
    try {
      const coordinates = group(0);
      whitespace();
      if (cursor !== source.length) { diagnostics.reason = 'Unexpected trailing WKT data'; return null; }
      return checkedGeometry(type, coordinates, diagnostics);
    } catch (error) {
      diagnostics.reason = error.message;
      return null;
    }
  }

  function centerOf(node) {
    const longitude = Number(node.center?.lng);
    const latitude = Number(node.center?.lat);
    return Number.isFinite(longitude) && Number.isFinite(latitude)
      && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? [longitude, latitude] : null;
  }

  function featureOf(node, parentName = null, kind = 'prefecture') {
    const code = String(node.gb ?? '');
    return {
      type: 'Feature',
      properties: {
        id: code,
        adcode: code,
        name: String(node.name ?? ''),
        center: centerOf(node),
        level: Number(node.level),
        parentName,
        kind,
        provider: '天地图行政区划 V2',
      },
      geometry: parseBoundary(node.boundary),
    };
  }

  function directoryFromPayload(payload) {
    const districts = payload.data?.district;
    if (!Array.isArray(districts) || !districts.length) throw new Error('官方接口没有返回全国城市目录。');
    const country = districts.find(node => Number(node.level) === 5);
    if (!country) throw new Error('官方接口未返回国家层级目录。');
    const features = [];
    const seen = new Set();
    const levels = {};
    const notices = [];
    const excludedNonCityUnits = [];
    const inspect = node => {
      const level = String(node.level);
      levels[level] = (levels[level] || 0) + 1;
      if (Array.isArray(node.children)) node.children.forEach(inspect);
    };
    districts.forEach(inspect);
    const add = (node, parentName, kind) => {
      const feature = featureOf(node, parentName, kind);
      if (!feature.properties.id || seen.has(feature.properties.id) || !feature.properties.center) return;
      seen.add(feature.properties.id);
      features.push(feature);
    };
    for (const province of country.children || []) {
      const code = String(province.gb ?? '').slice(-6);
      if (municipalityCodes.has(code)) {
        add(province, null, 'municipality');
        continue;
      }
      if (specialRegionCodes.has(code)) {
        add(province, null, 'special-region');
        continue;
      }
      const children = Array.isArray(province.children) ? province.children : [];
      if (!children.length) {
        notices.push(`${province.name}本次未返回城市子目录；未将整省伪装为地级城市。`);
      }
      for (const city of children) {
        if (Number(city.level) === 3) {
          const isTaiwan = code === '710000';
          const isCityUnit = isTaiwan ? /(?:市|县)$/.test(String(city.name)) : /(?:市|自治州|地区|盟)$/.test(String(city.name));
          if (isCityUnit) add(city, province.name, isTaiwan ? 'taiwan-destination' : 'prefecture');
          else excludedNonCityUnits.push({ adcode: String(city.gb), name: String(city.name), parentName: String(province.name), reason: '官方目录层级为 3，但名称不是本原型采用的行政城市单位。' });
        }
        else if (Number(city.level) === 2) add(city, province.name, 'direct-admin-unit');
      }
    }
    const outlineFeature = featureOf(country, null, 'country');
    const outline = outlineFeature.geometry ? outlineFeature : null;
    if (!outline) notices.push('全国目录响应未含可用国家轮廓；本模块不生成或猜测国界。');
    if (features.some(feature => !feature.geometry)) {
      notices.push('目录中的城市通常只有中心点；边界仅在城市有照片或被实际选中时按需查询。');
    }
    if (excludedNonCityUnits.length) notices.push(`已排除 ${excludedNonCityUnits.length} 个不符合城市单位名称规则的官方目录节点，例如马场、保护区。`);
    return {
      type: 'FeatureCollection',
      features,
      outline,
      metadata: {
        provider: '天地图行政区划 V2',
        source: docs,
        fetchedAt: new Date().toISOString(),
        coordinateSystem: '官方接口原始经纬度，未作坐标转换',
        persistence: '当前页面内存；不写入磁盘、localStorage 或 IndexedDB',
        sourceLevelCounts: levels,
        destinationCount: features.length,
        excludedNonCityUnits,
        destinationKinds: features.reduce((counts, feature) => {
          const kind = feature.properties.kind;
          counts[kind] = (counts[kind] || 0) + 1;
          return counts;
        }, {}),
        notices,
      },
    };
  }

  function mapKey() {
    configPromise ??= fetch('./map-config', { cache: 'no-store', credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error('本机地图配置不可用。');
        const config = await response.json();
        if (!/^[a-f\d]{32}$/i.test(config.key || '')) throw new Error('本机地图配置不可用。');
        return config.key;
      }).catch(error => { configPromise = null; throw error; });
    return configPromise;
  }

  function withinRequestLimit(work) {
    // All administrative API calls share one queue, including directory and city requests.
    const next = requestTail.then(async () => {
      const wait = requestStartInterval - (Date.now() - lastRequestStartedAt);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastRequestStartedAt = Date.now();
      return work();
    });
    requestTail = next.catch(() => {});
    return next;
  }

  function requestDistrict(keyword, childLevel, extensions, { fresh = false } = {}) {
    if (typeof document === 'undefined') return Promise.reject(new Error('此地图密钥必须在浏览器中使用。'));
    const cacheId = JSON.stringify([keyword, childLevel, extensions]);
    if (fresh) requests.delete(cacheId);
    if (requests.has(cacheId)) return requests.get(cacheId);
    const promise = mapKey().then(key => withinRequestLimit(async () => {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ keyword, childLevel: String(childLevel), extensions: String(extensions), tk: key });
      let response;
      let payload;
      try {
        response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(25000) });
        payload = await response.json();
      } catch {
        throw new Error('城市资料请求失败，请检查网络后重试。');
      }
      if (!response.ok || Number(payload.status) !== 200) {
        const status = Number.isFinite(Number(payload.code)) ? Number(payload.code) : response.status;
        if (status === 302010) {
          const error = new Error('天地图暂时限制了请求频率（302010），请稍后点重试补齐地图。');
          error.code = '302010';
          throw error;
        }
        throw new Error(`官方城市资料暂时不可用（状态 ${status}）。`);
      }
      return payload;
    })).catch(error => { requests.delete(cacheId); throw error; });
    requests.set(cacheId, promise);
    return promise;
  }

  function load() {
    directoryPromise ??= requestDistrict('中华人民共和国', 2, true)
      .then(payload => {
        const result = directoryFromPayload(payload);
        const country = payload.data.district.find(node => Number(node.level) === 5);
        provinceNodes = Array.isArray(country?.children) ? country.children : [];
        return result;
      })
      .catch(error => { directoryPromise = null; throw error; });
    return directoryPromise;
  }

  function geometryMetrics(feature) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let coordinateCount = 0;
    const visit = coordinates => {
      if (typeof coordinates[0] === 'number') {
        const [lng, lat] = coordinates;
        bounds[0] = Math.min(bounds[0], lng);
        bounds[1] = Math.min(bounds[1], lat);
        bounds[2] = Math.max(bounds[2], lng);
        bounds[3] = Math.max(bounds[3], lat);
        coordinateCount++;
      } else coordinates.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    return { bounds, coordinateCount };
  }

  function notifyProgress(listener, progress) {
    try {
      // Progress is advisory; a renderer failure must not cancel queued requests.
      Promise.resolve(listener(progress)).catch(() => {});
    } catch {}
  }

  function publishOutlineProgress(collection) {
    const metadata = collection.metadata;
    lastOutlineProgress = {
      processed: metadata.processed,
      total: metadata.requested,
      loaded: metadata.loaded,
      missing: metadata.missing.length,
      pending: metadata.pending,
      collection,
    };
    outlineListeners.forEach(listener => notifyProgress(listener, lastOutlineProgress));
  }

  function outlineCollection(nodes, results, requestsThisRun) {
    const values = [...results.values()];
    const features = values.filter(result => result.feature).map(result => result.feature);
    const missing = values.filter(result => result.missing).map(result => result.missing);
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let coordinateCount = 0;
    // Metrics are computed once per fetched geometry, not by retraversing every vertex on progress.
    for (const result of values) {
      if (!result.metrics) continue;
      coordinateCount += result.metrics.coordinateCount;
      bounds[0] = Math.min(bounds[0], result.metrics.bounds[0]);
      bounds[1] = Math.min(bounds[1], result.metrics.bounds[1]);
      bounds[2] = Math.max(bounds[2], result.metrics.bounds[2]);
      bounds[3] = Math.max(bounds[3], result.metrics.bounds[3]);
    }
    return {
      type: 'FeatureCollection',
      features,
      metadata: {
        provider: '天地图行政区划 V2',
        source: docs,
        fetchedAt: new Date().toISOString(),
        kind: 'province-derived-country-background',
        complete: nodes.length === 34 && results.size === nodes.length && missing.length === 0,
        requested: nodes.length,
        requestsThisRun,
        processed: results.size,
        pending: nodes.length - results.size,
        loaded: features.length,
        missing,
        bounds: coordinateCount ? bounds : null,
        minLatitude: coordinateCount ? bounds[1] : null,
        maxLatitude: coordinateCount ? bounds[3] : null,
        coordinateCount,
        countryBoundaryAvailable: false,
        persistence: '只在当前页面内存缓存，不持久下载或打包。',
        notices: [
          '国家级查询未返回轮廓；这里组合当次省级边界用于同色、无省界、无省级点击的中国背景。',
          '保留接口返回的全部面和岛屿，不另画国界、海域线或裁去南方几何。',
          '省级几何齐全不等于已证明所有海域线和国家版图要素齐全；需结合实际返回与地图呈现继续核查。',
          '接口返回不构成离线打包、再分发或对外上线数据授权。',
        ],
      },
    };
  }

  async function collectOutline(retryMissing) {
      const directory = await load();
      if (directory.outline) {
        const collection = {
          type: 'FeatureCollection',
          features: [directory.outline],
          metadata: { provider: '天地图行政区划 V2', source: docs, kind: 'country-boundary', complete: true, requested: 0, requestsThisRun: 0, processed: 0, pending: 0, loaded: 1, missing: [] },
        };
        publishOutlineProgress(collection);
        return collection;
      }
      const nodes = provinceNodes.filter(node => Number(node.level) === 4);
      const targets = nodes.filter(node => !outlineParts.get(String(node.gb))?.feature);
      const results = new Map(nodes.flatMap(node => {
        const code = String(node.gb);
        const cached = outlineParts.get(code);
        return cached?.feature ? [[code, cached]] : [];
      }));
      const snapshot = () => outlineCollection(nodes, results, targets.length);
      publishOutlineProgress(snapshot());
      await Promise.all(targets.map(async node => {
        let result;
        try {
          const payload = await requestDistrict(String(node.gb), 0, true, { fresh: retryMissing });
          const returned = payload.data?.district?.find(item => String(item.gb) === String(node.gb));
          const feature = returned ? featureOf(returned, null, 'background-part') : null;
          if (!feature?.geometry) {
            const diagnostics = {};
            if (returned) parseBoundary(returned.boundary, diagnostics);
            result = { missing: { name: String(node.name), adcode: String(node.gb), reason: returned ? `边界无法解析：${diagnostics.reason || 'Unknown boundary shape'}` : '接口没有返回匹配的行政编码。' } };
          } else result = { feature, metrics: geometryMetrics(feature) };
        } catch (error) {
          result = { missing: { name: String(node.name), adcode: String(node.gb), reason: error.message || '边界请求失败。', ...(error.code ? { code: error.code } : {}) } };
        }
        outlineParts.set(String(node.gb), result);
        results.set(String(node.gb), result);
        publishOutlineProgress(snapshot());
      }));
      return snapshot();
  }

  function outline({ retryMissing = false, onProgress } = {}) {
    let startingRun = false;
    if (!outlinePromise) {
      startingRun = true;
      outlinePromise = collectOutline(false).catch(error => { outlinePromise = null; throw error; });
    } else if (retryMissing && !outlineRetryPromise) {
      startingRun = true;
      const previous = outlinePromise;
      outlineRetryPromise = previous.then(result => result.metadata.missing.length ? collectOutline(true) : result)
        .finally(() => { outlineRetryPromise = null; });
      outlinePromise = outlineRetryPromise;
    }
    if (typeof onProgress !== 'function') return outlinePromise;
    // A separate wrapper lets concurrent callers unsubscribe independently.
    const listener = progress => onProgress(progress);
    outlineListeners.add(listener);
    if (!startingRun && lastOutlineProgress) notifyProgress(listener, lastOutlineProgress);
    return outlinePromise.then(result => {
      if (startingRun && result.metadata.requestsThisRun === 0 && lastOutlineProgress) notifyProgress(listener, lastOutlineProgress);
      return result;
    }).finally(() => outlineListeners.delete(listener));
  }

  function boundary(city) {
    const properties = city?.properties ?? city;
    if (!properties || typeof properties !== 'object') return Promise.resolve(null);
    const code = String(properties.adcode ?? properties.gb ?? '').trim();
    const name = String(properties.name ?? '').trim();
    const keyword = /^\d{6,12}$/.test(code) ? code : name;
    if (!keyword || keyword.length > 60) return Promise.resolve(null);
    const cacheId = code || `${properties.parentName || ''}/${name}`;
    if (boundaryCache.has(cacheId)) return boundaryCache.get(cacheId);
    const promise = requestDistrict(keyword, 0, true).then(payload => {
      const nodes = Array.isArray(payload.data?.district) ? payload.data.district : [];
      const exact = nodes.find(node => String(node.gb) === code)
        || nodes.find(node => node.name === name)
        || (nodes.length === 1 ? nodes[0] : null);
      if (!exact) return null;
      const feature = featureOf(exact, properties.parentName ?? null, properties.kind ?? 'prefecture');
      if (!feature.geometry) return null;
      feature.properties.id = properties.id ?? feature.properties.id;
      return feature;
    }).catch(error => { boundaryCache.delete(cacheId); throw error; });
    boundaryCache.set(cacheId, promise);
    return promise;
  }

  window.ChinaMapData = { load, boundary, outline, parseBoundary, directoryFromPayload };
})();
