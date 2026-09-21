/* Bounded integration probe. No real accounts, photos, or persistence. */
'use strict';
const byId = id => document.getElementById(id);
const started = performance.now();
const checks = [];
const errors = [];
const tileFailures = [];
const tileSuccesses = new Set();
const positions = [];
const cities = [
  { id: 'shenzhen', name: '深圳', lng: 114.06, lat: 22.55, years: [2024, 2026] },
  { id: 'guangzhou', name: '广州', lng: 113.27, lat: 23.13, years: [2025] },
  { id: 'hezhou', name: '贺州', lng: 111.55, lat: 24.42, years: [] },
  { id: 'hongkong', name: '香港', lng: 114.17, lat: 22.32, years: [2024] },
  { id: 'macau', name: '澳门', lng: 113.55, lat: 22.20, years: [] },
  { id: 'beijing', name: '北京', lng: 116.40, lat: 39.90, years: [2026] },
];
let map, currentCity, mapPosition, mapSize, key = '', stage = 'boot', finished = false;
const markers = new Map();
const redact = value => String(value).split(key || '\u0000').join('[REDACTED]').replace(/([?&]tk=)[^&\s"'<>]+/gi, '$1[REDACTED]');
function check(name, value) { checks.push({ name, passed: Boolean(value) }); if (!value) throw new Error(name); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, ms = 25000) {
  const start = performance.now();
  while (!test()) { if (performance.now() - start > ms) throw new Error('Timed out waiting for map evidence'); await sleep(150); }
}
window.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement) {
    if (/tianditu\.gov\.cn/.test(event.target.src)) tileFailures.push('Map image failed');
  } else if (event.message) errors.push(redact(stage + ': ' + event.message));
}, true);
document.addEventListener('load', event => {
  if (event.target instanceof HTMLImageElement && /tianditu\.gov\.cn/.test(event.target.src) && /(?:wmts|SERVICE=WMTS)/i.test(event.target.src)) {
    if (event.target.naturalWidth > 0) tileSuccesses.add(redact(event.target.src));
  }
}, true);
function tileStats() {
  const images = [...document.querySelectorAll('#map img')].filter(img => /(?:wmts|SERVICE=WMTS)/i.test(img.src));
  const decoded = images.filter(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
  return { present: images.length, decoded: decoded.length,
    base: decoded.filter(img => /vec_[cw]/.test(img.src)).length,
    labels: decoded.filter(img => /cva_[cw]/.test(img.src)).length,
    successfulUrls: tileSuccesses.size, failedEvents: tileFailures.length };
}
function renderSearch() {
  const query = byId('query').value.trim();
  byId('cities').replaceChildren();
  for (const city of cities.filter(item => item.name.includes(query))) {
    const button = document.createElement('button'); button.textContent = city.name;
    button.dataset.city = city.id; button.addEventListener('click', () => openCity(city));
    byId('cities').append(button);
  }
}
function renderYears() {
  byId('city-title').textContent = currentCity.name + ' · 年份影集';
  byId('years').replaceChildren();
  for (const year of [...currentCity.years].sort((a, b) => b - a)) {
    const card = document.createElement('div'); card.className = 'year'; card.dataset.year = String(year);
    const label = document.createElement('strong'); label.textContent = String(year);
    card.append(label, '示例影集'); byId('years').append(card);
  }
  byId('empty').hidden = currentCity.years.length > 0;
  byId('new-album').hidden = false;
}
function readPosition() {
  const center = map.getCenter();
  return { lng: center.getLng(), lat: center.getLat(), zoom: map.getZoom() };
}
function openCity(city) {
  mapPosition = readPosition();
  mapSize = { width: byId('map').clientWidth, height: byId('map').clientHeight };
  currentCity = city; byId('map').hidden = true; byId('album').hidden = false;
  renderYears(); byId('state').textContent = '已进入：' + city.name;
}
function backToMap() {
  try {
    byId('album').hidden = true; byId('map').hidden = false;
    // The same mounted map already retains its view. A redundant reset rounds
    // the center to tile pixels at low zoom; resize only if layout changed.
    if (byId('map').clientWidth !== mapSize.width || byId('map').clientHeight !== mapSize.height) {
      map.checkResize();
      map.centerAndZoom(new T.LngLat(mapPosition.lng, mapPosition.lat), mapPosition.zoom);
    }
    byId('state').textContent = '点击城市标记，或从左侧搜索进入';
  } catch (error) { errors.push(redact('Return to map: ' + error.message)); }
}
byId('query').addEventListener('input', renderSearch);
byId('back').addEventListener('click', backToMap);
byId('create').addEventListener('click', () => {
  const year = Number(byId('year').value);
  if (!currentCity.years.includes(year)) currentCity.years.push(year);
  renderYears();
});
renderSearch();
async function finish(passed, error) {
  if (finished) return; finished = true;
  const result = { passed, error: error ? redact(error) : undefined, userAgent: navigator.userAgent,
    checks, tiles: tileStats(), errors, positions, elapsedMs: Math.round(performance.now() - started),
    sampleCities: cities.map(city => city.name), sdkAvailable: Boolean(window.T?.Map),
    searchScope: 'Six local fixture cities; not nationwide API search',
    coordinates: 'Hand-set approximate representative points, not an official administrative directory' };
  byId('state').textContent = passed ? '验证通过：真实底图与注记已加载，六个城市入口检查通过' : '验证未通过：' + (error ? redact(error) : '请查看测试记录');
  byId('report').textContent = `${checks.filter(item => item.passed).length} 项检查通过\n底图瓦片 ${result.tiles.base} · 注记瓦片 ${result.tiles.labels}\n总耗时 ${result.elapsedMs} ms`;
  document.documentElement.dataset.probeStatus = passed ? 'passed' : 'failed';
  await fetch('./result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
}
async function run() {
  const config = await (await fetch('./config')).json(); key = config.key;
  stage = 'sdk';
  const sdk = document.createElement('script');
  const ready = new Promise((resolve, reject) => { sdk.onload = resolve; sdk.onerror = () => reject(new Error('天地图脚本未能加载')); });
  sdk.src = 'https://api.tianditu.gov.cn/api?v=4.0&tk=' + encodeURIComponent(key); document.head.append(sdk);
  await ready; check('Official SDK defines T.Map and T.Marker', window.T?.Map && window.T?.Marker);
  map = new T.Map('map'); map.centerAndZoom(new T.LngLat(104, 35), 4);
  for (const city of cities) {
    const icon = new T.Icon({ iconUrl: './marker.svg?city=' + city.id, iconSize: new T.Point(76, 34), iconAnchor: new T.Point(38, 30) });
    const marker = new T.Marker(new T.LngLat(city.lng, city.lat), { icon });
    // Let the SDK finish dispatching the marker event before hiding its map.
    marker.addEventListener('click', () => queueMicrotask(() => openCity(city)));
    map.addOverLay(marker); markers.set(city.id, marker);
  }
  await until(() => { const stats = tileStats(); return stats.base > 0 && stats.labels > 0; }, 35000);
  check('Real base tiles and label tiles decoded', tileStats().base > 0 && tileStats().labels > 0);
  for (const city of cities) {
    stage = 'marker-' + city.id;
    const icon = document.querySelector('#map img[src*="city=' + city.id + '"]');
    check(city.name + ' marker rendered', Boolean(icon));
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await until(() => currentCity?.id === city.id && !byId('album').hidden, 2000);
    check(city.name + ' marker enters matching city', !byId('album').hidden && currentCity.id === city.id);
    if (city.id === 'shenzhen') check('Years rendered newest first', [...byId('years').children].map(el => el.dataset.year).join(',') === '2026,2024');
    if (city.id === 'hezhou') {
      check('City without photos is accessible', !byId('empty').hidden && !byId('new-album').hidden);
      byId('year').value = '2025'; byId('create').click();
      check('Can create empty fixture album', byId('years').firstElementChild?.dataset.year === '2025');
    }
    stage = 'return-' + city.id;
    const before = { ...mapPosition }; byId('back').click(); await sleep(250);
    const after = readPosition(); positions.push({ city: city.id, before, after });
    check(city.name + ' back restores map and position', !byId('map').hidden && byId('album').hidden && after.zoom === before.zoom && Math.abs(after.lng - before.lng) < 0.001 && Math.abs(after.lat - before.lat) < 0.001);
  }
  stage = 'search';
  byId('query').value = '香港'; byId('query').dispatchEvent(new Event('input'));
  check('Sample city search filters correctly', byId('cities').children.length === 1 && byId('cities').firstElementChild.dataset.city === 'hongkong');
  byId('cities').firstElementChild.click(); check('Search enters the same city route', currentCity.id === 'hongkong');
  byId('back').click(); byId('query').value = ''; renderSearch();
  stage = 'final-map';
  await until(() => { const stats = tileStats(); return stats.present > 0 && stats.decoded === stats.present; });
  await sleep(800);
  check('All map tile image elements decoded', tileStats().decoded === tileStats().present);
  check('No map tile load errors', tileFailures.length === 0);
  check('No runtime errors', errors.length === 0);
  await finish(true);
}
setTimeout(() => finish(false, '地图验证等待超时'), 55000);
run().catch(error => finish(false, error.message));
