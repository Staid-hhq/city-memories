'use strict';
(() => {
  const status = document.querySelector('#status');
  const start = performance.now();
  const state = { sdkReady: false, directory: null, directoryError: null, firstMapMs: null };
  let directory;
  const views = {
    national: [105, 28, 3], mainland: [104, 35, 4], south: [113, 12, 5],
    taiwan: [121, 24, 7], islands: [123.6, 25.8, 8], hongkongMacau: [113.85, 22.25, 9],
  };
  let map;
  const coordinates = (lng, lat) => window.MapAuditWmts
    ? new MapAuditWmts.LngLat(lng, lat) : new T.LngLat(lng, lat);
  function tiles() {
    const images = [...document.querySelectorAll('#map img')].filter(img => /wmts/i.test(img.src));
    const decoded = images.filter(img => img.complete && img.naturalWidth > 0);
    return { present: images.length, decoded: decoded.length,
      base: decoded.filter(img => /vec_w/i.test(img.src)).length,
      labels: decoded.filter(img => /cva_w/i.test(img.src)).length };
  }
  function directorySummary(payload, bytes, elapsedMs) {
    directory = ChinaMapData.directoryFromPayload(payload);
    const country = payload.data.district.find(item => Number(item.level) === 5);
    const provinces = country.children || [];
    const conflicts = [];
    const codes = new Set();
    const visit = (item, parent) => {
      const code = String(item.gb);
      if (codes.has(code)) conflicts.push({ code, name: item.name, reason: 'duplicate-source-code' });
      codes.add(code);
      if (!/^156\d{6}$/.test(code)) conflicts.push({ code, name: item.name, reason: 'invalid-code' });
      if (parent && Number(parent.level) === 4 && code.slice(3, 5) !== String(parent.gb).slice(3, 5)) {
        conflicts.push({ code, name: item.name, parent: parent.name, reason: 'province-code-mismatch' });
      }
      (item.children || []).forEach(child => visit(child, item));
    };
    visit(country);
    const special = directory.features.filter(f => f.properties.kind !== 'prefecture').map(f => {
      const { adcode, name, kind, parentName } = f.properties;
      return { adcode, name, kind, parentName };
    });
    const seeded = [
      ['156440300', '深圳市', '广东省'], ['156440100', '广州市', '广东省'],
      ['156451100', '贺州市', '广西壮族自治区'],
    ].map(([code, name, parent]) => {
      const candidates = directory.features.filter(f => f.properties.adcode === code);
      return { code, matched: candidates.length === 1 && candidates[0].properties.name === name
        && candidates[0].properties.parentName === parent };
    });
    return {
      httpStatus: 200, businessStatus: payload.status, bytes, elapsedMs,
      country: { code: country.gb, name: country.name, hasOutline: Boolean(directory.outline) },
      sourceLevelCounts: directory.metadata.sourceLevelCounts, sourceNodeCount: codes.size,
      destinationCount: directory.features.length, kinds: directory.metadata.destinationKinds,
      provinces: provinces.map(p => ({ code: p.gb, name: p.name, children: p.children?.length || 0,
        destinations: directory.features.filter(f => f.properties.parentName === p.name
          || f.properties.adcode === p.gb).length })),
      special, conflicts, seeded, rejected: directory.metadata.rejectedDestinations,
      excluded: directory.metadata.excludedNonCityUnits, notices: directory.metadata.notices,
    };
  }
  window.mapAudit = {
    state, tiles,
    async directory() {
      const before = performance.now();
      try {
        const config = await (await fetch('./map-config', { cache: 'no-store' })).json();
        const url = new URL('https://api.tianditu.gov.cn/v2/administrative');
        url.search = new URLSearchParams({ keyword: '中华人民共和国', childLevel: '2', extensions: 'false', tk: config.key });
        const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(25000) });
        const body = await response.text();
        const payload = JSON.parse(body);
        if (!response.ok || Number(payload.status) !== 200) throw new Error('Directory request failed');
        state.directory = directorySummary(payload, new TextEncoder().encode(body).length, Math.round(performance.now() - before));
        status.textContent = '全国目录 ' + state.directory.destinationCount + ' 个候选入口；当前视图：全国。';
        return state.directory;
      } catch {
        state.directoryError = 'Official directory unavailable or invalid (details/credentials omitted)';
        return null;
      }
    },
    // Public names/codes can be inspected in memory; never dump/persist raw provider responses.
    reviewRows() {
      return directory?.features.map(f => ({
        code: f.properties.adcode, name: f.properties.name, parent: f.properties.parentName, kind: f.properties.kind,
      })) || [];
    },
    view(name) {
      const position = views[name];
      if (!position) throw new Error('Unknown audit view');
      map.centerAndZoom(coordinates(position[0], position[1]), position[2]);
      status.textContent = '官方底图与注记 · 核验视图：' + name + ' · 地图不代表城市映射已审核';
    },
    snapshot() {
      return { center: { lng: map.getCenter().getLng(), lat: map.getCenter().getLat() },
        zoom: map.getZoom(), bounds: {
          west: map.getBounds().getSouthWest().getLng(), south: map.getBounds().getSouthWest().getLat(),
          east: map.getBounds().getNorthEast().getLng(), north: map.getBounds().getNorthEast().getLat(),
        }, tiles: tiles(), attribution: document.querySelector('.tdt-control-copyright')?.innerText || null };
    },
  };
  async function initialize() { try {
    state.sdkReady = Boolean(window.T?.Map);
    if (!state.sdkReady && !window.MapAuditWmts) throw new Error('Map engine not ready');
    state.engine = window.MapAuditWmts ? 'official-wmts-no-sdk' : 'official-sdk';
    map = window.MapAuditWmts ? await MapAuditWmts.create('map') : new T.Map('map', { projection: 'EPSG:900913' });
    map.centerAndZoom(coordinates(105, 28), 3);
    if (state.sdkReady) map.addControl(new T.Control.Zoom());
    const poll = setInterval(() => {
      const result = tiles();
      if (result.base && result.labels && result.decoded === result.present) {
        state.firstMapMs = Math.round(performance.now() - start);
        clearInterval(poll);
      }
    }, 100);
    setTimeout(() => clearInterval(poll), 30000);
  } catch { window.auditErrors.push({ kind: 'map-init' }); } }
  initialize();
})();
