const button = document.querySelector('#run-probe');
const state = document.querySelector('#probe-state');
const output = document.querySelector('#probe-result');
const scope = document.querySelector('#probe-scope');
let latestPayload = null;

export function getLatestPayload() {
  return latestPayload;
}

function inspectDistricts(districts) {
  const levelCounts = {};
  const boundaryCounts = {};
  const nodes = [];
  const visit = (node, parentName = null) => {
    const level = String(node.level ?? 'unknown');
    levelCounts[level] = (levelCounts[level] || 0) + 1;
    const boundaryChars = typeof node.boundary === 'string' ? node.boundary.length : 0;
    if (boundaryChars) boundaryCounts[level] = (boundaryCounts[level] || 0) + 1;
    const boundaryDiagnostics = {};
    const parsedGeometry = window.ChinaMapData?.parseBoundary(node.boundary, boundaryDiagnostics);
    nodes.push({
      name: node.name ?? null,
      gb: node.gb ?? null,
      level: node.level ?? null,
      parentName,
      fields: Object.keys(node),
      center: node.center ?? null,
      boundaryChars,
      boundaryValueType: typeof node.boundary,
      boundaryIsArray: Array.isArray(node.boundary),
      boundaryObjectKeys: node.boundary && typeof node.boundary === 'object' ? Object.keys(node.boundary).slice(0, 12) : [],
      boundaryPreview: node.boundary === undefined ? null : JSON.stringify(node.boundary).slice(0, 180),
      boundaryEnd: typeof node.boundary === 'string' ? node.boundary.slice(-100) : null,
      parsedGeometryType: parsedGeometry?.type ?? null,
      boundaryDiagnostics,
      boundaryType: typeof node.boundary === 'string' ? node.boundary.match(/^[A-Z]+/i)?.[0] ?? 'unrecognized' : null,
      childCount: Array.isArray(node.children) ? node.children.length : 0,
    });
    if (Array.isArray(node.children)) node.children.forEach(child => visit(child, node.name));
  };
  districts.forEach(node => visit(node));
  const samples = [];
  if (nodes[0]) samples.push(nodes[0]);
  const city = nodes.find(node => Number(node.level) === 3);
  if (city) samples.push(city);
  else if (nodes[1]) samples.push(nodes[1]);
  return { totalNodes: nodes.length, levelCounts, boundaryCounts, samples };
}

button.addEventListener('click', async () => {
  button.disabled = true;
  scope.disabled = true;
  state.textContent = '正在检查官方接口…';
  output.textContent = '等待响应。';
  latestPayload = null;
  let key = '';
  const clean = value => String(value ?? '').replaceAll(key || '\u0000', '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[网址已省略]');
  try {
    const configResponse = await fetch('./map-config', { cache: 'no-store' });
    const config = await configResponse.json();
    key = config.key;
    if (!configResponse.ok || typeof key !== 'string' || !/^[a-f\d]{32}$/i.test(key)) {
      throw new Error('本机地图配置不可用。');
    }
    const endpoint = new URL('https://api.tianditu.gov.cn/v2/administrative');
    const queries = {
      guangdong: { keyword: '156440000', childLevel: '0', extensions: 'true' },
      shenzhen: { keyword: '深圳', childLevel: '0', extensions: 'true' },
      country: { keyword: '中华人民共和国', childLevel: '2', extensions: 'true' },
    };
    const query = queries[scope.value] || queries.guangdong;
    endpoint.search = new URLSearchParams({
      ...query,
      tk: key,
    });
    const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(25000) });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      output.textContent = JSON.stringify({ httpStatus: response.status, responseBytes: new TextEncoder().encode(text).length, error: '响应不是 JSON；为避免显示敏感内容，不展示原文。' }, null, 2);
      state.textContent = '接口未返回可解析的数据。';
      return;
    }
    latestPayload = payload;
    const districts = Array.isArray(payload.data?.district) ? payload.data.district : [];
    const summary = {
      query,
      httpStatus: response.status,
      status: payload.status ?? null,
      code: payload.code ?? null,
      message: clean(payload.message ?? payload.msg ?? ''),
      resolution: clean(payload.resolve ?? ''),
      responseBytes: new TextEncoder().encode(text).length,
      topLevelFields: Object.keys(payload),
      suggestionCount: Array.isArray(payload.data?.suggestion) ? payload.data.suggestion.length : 0,
      districtCount: districts.length,
      ...inspectDistricts(districts),
    };
    output.textContent = JSON.stringify(summary, null, 2);
    state.textContent = response.ok && districts.length ? '已取得响应，请检查边界覆盖统计。' : '未取得可用城市边界；已显示脱敏原因。';
  } catch (error) {
    output.textContent = JSON.stringify({ error: clean(error?.name === 'TimeoutError' ? '请求超时。' : error?.message || '浏览器请求失败。') }, null, 2);
    state.textContent = '检查未完成；请查看脱敏错误。';
  } finally {
    key = '';
    button.disabled = false;
    scope.disabled = false;
  }
});
