import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Synthetic data only. No .env, browser profile, user database or network access.
const source = await readFile(new URL('../../prototype/travel-journal/china-map-data.js', import.meta.url), 'utf8');
const polygon = 'POLYGON ((110 20, 111 20, 111 21, 110 20))';
const node = (gb, name, level, children = []) => ({
  gb, name, level, children, center: { lng: 110, lat: 20 },
});
const payload = children => ({ data: { district: [node('156000000', '中华人民共和国', 5, children)] } });
const plain = value => JSON.parse(JSON.stringify(value));

function harness(respond = () => { throw new Error('Unexpected mock API request'); }) {
  let now = 0;
  let active = 0;
  let peak = 0;
  let configCalls = 0;
  const calls = [];
  class Clock extends Date { static now() { return now; } }
  const sandbox = {
    window: {}, document: {}, URL, URLSearchParams, AbortSignal, Date: Clock,
    setTimeout(callback, milliseconds) { now += milliseconds; callback(); },
    async fetch(input) {
      if (input === './map-config') {
        configCalls++;
        return { ok: true, json: async () => ({ key: '0'.repeat(32) }) };
      }
      const url = new URL(input);
      assert.equal(url.origin, 'https://api.tianditu.gov.cn');
      const call = {
        keyword: url.searchParams.get('keyword'),
        childLevel: url.searchParams.get('childLevel'),
        extensions: url.searchParams.get('extensions'),
        startedAt: now,
      };
      calls.push(call);
      peak = Math.max(peak, ++active);
      try {
        const result = await respond(call);
        return { ok: true, status: 200, json: async () => ({ status: 200, ...result }) };
      } finally { active--; }
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'china-map-data.js' });
  return { api: sandbox.window.ChinaMapData, sandbox, calls,
    get peak() { return peak; }, get configCalls() { return configCalls; } };
}

test('four municipalities stay whole; district children do not become destinations', () => {
  const provinces = ['110000', '120000', '310000', '500000'].map((code, i) =>
    node('156' + code, ['北京市', '天津市', '上海市', '重庆市'][i], 4, [node('156110101', '测试区', 2)]));
  const result = harness().api.directoryFromPayload(payload(provinces));
  assert.equal(result.features.length, 4);
  assert.ok(result.features.every(item => item.properties.kind === 'municipality'));
});

test('Hong Kong and Macao each retain one special-region entrance', () => {
  const result = harness().api.directoryFromPayload(payload([
    node('156810000', '香港特别行政区', 4), node('156820000', '澳门特别行政区', 4),
  ]));
  assert.equal(result.features.length, 2);
  assert.ok(result.features.every(item => item.properties.kind === 'special-region'));
});

test('prefecture city, autonomous prefecture, league and region are retained', () => {
  const children = ['示例市', '示例自治州', '示例盟', '示例地区']
    .map((name, i) => node('156440' + (i + 1) + '00', name, 3));
  const result = harness().api.directoryFromPayload(payload([node('156440000', '示例省', 4, children)]));
  assert.equal(result.features.length, 4);
  assert.ok(result.features.every(item => item.properties.kind === 'prefecture'));
});

test('direct county-level units differ from ordinary nested counties', () => {
  const result = harness().api.directoryFromPayload(payload([node('156410000', '示例省', 4, [
    node('156419001', '示例直辖市', 2),
    node('156410100', '示例地级市', 3, [node('156410101', '示例区', 2)]),
  ])]));
  assert.deepEqual(plain(result.features.map(item => item.properties.kind)), ['direct-admin-unit', 'prefecture']);
});

test('Taiwan city/county suggestions stay distinct from mainland prefectures', () => {
  const result = harness().api.directoryFromPayload(payload([node('156710000', '台湾省', 4, [
    node('156710100', '示例市', 3), node('156710200', '示例县', 3),
  ])]));
  assert.equal(result.features.length, 2);
  assert.ok(result.features.every(item => item.properties.kind === 'taiwan-destination'));
});

test('non-city level-three nodes are explicitly recorded, not silently approved', () => {
  const result = harness().api.directoryFromPayload(payload([node('156620000', '示例省', 4, [
    node('156620100', '示例马场', 3), node('156620200', '示例自然保护区', 3),
  ])]));
  assert.equal(result.features.length, 0);
  assert.equal(result.metadata.excludedNonCityUnits.length, 2);
});

test('missing province children never create a whole-province city', () => {
  const result = harness().api.directoryFromPayload(payload([node('156440000', '示例省', 4)]));
  assert.equal(result.features.length, 0);
  assert.ok(result.metadata.notices.some(message => message.includes('未将整省')));
});

test('empty, coerced, nonfinite and out-of-range coordinates are rejected visibly', () => {
  for (const invalid of [null, undefined, '', ' ', true, [], {}, Infinity, 'bad', 181]) {
    const city = node('156440100', '示例市', 3);
    city.center.lng = invalid;
    const result = harness().api.directoryFromPayload(payload([node('156440000', '示例省', 4, [city])]));
    assert.equal(result.features.length, 0, String(invalid));
    assert.equal(result.metadata.rejectedDestinations[0].reason, '中心点缺失或无效');
  }
  const city = node('156440100', '示例市', 3);
  city.center.lat = 91;
  assert.equal(harness().api.directoryFromPayload(payload([node('156440000', '示例省', 4, [city])])).features.length, 0);
});

test('finite numeric strings and true zero coordinates remain valid', () => {
  const city = node('156440100', '示例市', 3);
  city.center = { lng: '110.5', lat: 0 };
  const result = harness().api.directoryFromPayload(payload([node('156440000', '示例省', 4, [city])]));
  assert.deepEqual(plain(result.features[0].properties.center), [110.5, 0]);
});

test('invalid and duplicate provider codes are surfaced for review', () => {
  const city = node('156440100', '示例市', 3);
  const result = harness().api.directoryFromPayload(payload([node('156440000', '示例省', 4, [
    city, { ...city }, node('440100', '另例市', 3),
  ])]));
  assert.equal(result.features.length, 1);
  assert.equal(result.metadata.rejectedDestinations.length, 2);
});

test('malformed directory is rejected rather than reported as a complete empty map', () => {
  for (const value of [{}, { data: { district: [] } }, { data: { district: [node('156440000', '示例省', 4)] } }]) {
    assert.throws(() => harness().api.directoryFromPayload(value), /目录/);
  }
});

test('WKT retains multipolygon islands and holes without simplifying', () => {
  const boundary = 'MULTIPOLYGON (((110 20,111 20,111 21,110 20),(110.2 20.2,110.4 20.2,110.4 20.4,110.2 20.2)),((112 22,113 22,113 23,112 22)))';
  const geometry = harness().api.parseBoundary(boundary);
  assert.equal(geometry.type, 'MultiPolygon');
  assert.equal(geometry.coordinates.length, 2);
  assert.equal(geometry.coordinates[0].length, 2);
  assert.equal(geometry.coordinates.flat(2).length, 12);
});

test('invalid geometry and projected coordinates are not drawn as longitude/latitude', () => {
  for (const value of ['', 'POLYGON EMPTY', 'SRID=3857;' + polygon, 'POLYGON ((999 20,111 20,111 21))']) {
    assert.equal(harness().api.parseBoundary(value), null);
  }
});

test('boundary never falls back to the same name, a sole unrelated node, or duplicate code', async () => {
  for (const districts of [
    [{ ...node('156440200', '示例市', 3), boundary: polygon }],
    [{ ...node('156440200', '别的市', 3), boundary: polygon }],
    [{ ...node('156440100', '已改名市', 3), boundary: polygon }],
    [1, 2].map(() => ({ ...node('156440100', '示例市', 3), boundary: polygon })),
  ]) {
    const h = harness(() => ({ data: { district: districts } }));
    assert.equal(await h.api.boundary({ adcode: '156440100', name: '示例市' }), null);
  }
});

test('boundary requires a provider code and makes no request for name-only input', async () => {
  const h = harness();
  for (const adcode of ['', '440100', '156440100x']) {
    assert.equal(await h.api.boundary({ adcode, name: '示例市' }), null);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.configCalls, 0);
});

test('exact boundary match retains business id and deduplicates concurrent requests', async () => {
  const h = harness(() => ({ data: { district: [{ ...node('156440100', '示例市', 3), boundary: polygon }] } }));
  const target = { id: 'synthetic-city-id', adcode: '156440100', name: '示例市', parentName: '示例省' };
  const [first, second] = await Promise.all([h.api.boundary(target), h.api.boundary(target)]);
  assert.equal(first, second);
  assert.equal(first.properties.id, target.id);
  assert.equal(first.geometry.type, 'Polygon');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].keyword, target.adcode);
  // A stale or conflicting mapping cannot borrow another mapping's cached geometry.
  assert.equal(await h.api.boundary({ ...target, name: '别的市' }), null);
  assert.equal(h.calls.length, 1);
});

test('failed requests can be explicitly retried and retain the serial start interval', async () => {
  let attempts = 0;
  const h = harness(() => {
    if (++attempts === 1) throw new Error('Synthetic network failure');
    return { data: { district: [{ ...node('156440100', '示例市', 3), boundary: polygon }] } };
  });
  const target = { adcode: '156440100', name: '示例市' };
  await assert.rejects(h.api.boundary(target), /请求失败/);
  assert.ok(await h.api.boundary(target));
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1].startedAt - h.calls[0].startedAt >= 1500);
});

test('directory-only load is one request; it does not eagerly fetch province geometry', async () => {
  const h = harness(() => payload([node('156440000', '示例省', 4, [node('156440100', '示例市', 3)])]));
  await Promise.all([h.api.load(), h.api.load()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].childLevel, '2');
});

test('legacy 34-part outline proves a 51-second scheduling floor, not real load speed', async () => {
  const provinces = Array.from({ length: 34 }, (_, i) => node('156' + (110000 + i * 10000), '合成省' + i, 4));
  const h = harness(call => call.keyword === '中华人民共和国' ? payload(provinces)
    : { data: { district: [{ ...provinces.find(item => item.gb === call.keyword), boundary: polygon }] } });
  const result = await h.api.outline();
  assert.equal(h.calls.length, 35);
  assert.equal(h.peak, 1);
  assert.equal(h.calls.at(-1).startedAt - h.calls[0].startedAt, 51000);
  assert.equal(result.metadata.loaded, 34);
  assert.equal(result.metadata.countryBoundaryAvailable, false);
  assert.equal(result.metadata.kind, 'province-derived-country-background');
});
