'use strict';

// This prototype intentionally holds demo data in memory only.
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let cities = [
  { id: 'shenzhen', name: '深圳', lng: 114.06, lat: 22.55, en: 'SHENZHEN' },
  { id: 'guangzhou', name: '广州', lng: 113.27, lat: 23.13, en: 'GUANGZHOU' },
  { id: 'hongkong', name: '香港', lng: 114.17, lat: 22.32, en: 'HONG KONG' },
  { id: 'hezhou', name: '贺州', lng: 111.55, lat: 24.42, en: 'HEZHOU' },
  { id: 'macau', name: '澳门', lng: 113.55, lat: 22.20, en: 'MACAU' },
  { id: 'beijing', name: '北京', lng: 116.40, lat: 39.90, en: 'BEIJING' },
];
const sampleNumbers = [1, 3, 5, 9, 14, 17];
const makeAlbum = (year, photos = []) => ({ id: crypto.randomUUID(), year, photos });
const seed2024 = makeAlbum(2024, sampleNumbers.map((number, index) => ({ id: crypto.randomUUID(), name: `24-${number}.jpg`, src: `./sample/${index + 1}.jpg`, note: '' })));
const profiles = new Map([['旅人', { name: '旅人', albums: { shenzhen: [makeAlbum(2026), seed2024, makeAlbum(null)], guangzhou: [makeAlbum(2025)], hongkong: [makeAlbum(2024)] } }]]);
let currentProfile = profiles.get('旅人');
let route = { screen: 'map' };
let sorting = false;
let visibleCount = 12;
let currentPhotoId = null;
let viewerContext = null;
let pendingImport = [];
let draggedId = null;
let pointerDrag = null;
let toastTimer;
let map = null;
let mapStarting = false;
let boundaryLoading = new Set();


const cityById = id => cities.find(city => city.id === id);
const albumsFor = cityId => currentProfile?.albums[cityId] || [];
const sortedAlbums = cityId => [...albumsFor(cityId)].sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
const currentCity = () => cityById(route.cityId);
const currentAlbum = () => albumsFor(route.cityId).find(album => album.id === route.albumId);
const yearLabel = year => year === null ? '未标年份' : `${year} 年`;
const photoCount = cityId => albumsFor(cityId).reduce((sum, album) => sum + album.photos.length, 0);
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function navigate(next, { replace = false } = {}) {
  if (!currentProfile && next.screen !== 'auth') next = { screen: 'auth', mode: 'login' };
  route = next;
  sorting = false;
  visibleCount = 12;
  if (replace) history.replaceState(route, '');
  else history.pushState(route, '');
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
window.addEventListener('popstate', event => {
  if ($('#photo-dialog').open) saveNote();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  route = event.state || { screen: 'map' };
  if (!currentProfile) route = { screen: 'auth', mode: 'login' };
  if (route.albumId && !albumsFor(route.cityId).some(album => album.id === route.albumId)) route = { screen: 'map' };
  sorting = false;
  visibleCount = 12;
  render();
});

function render() {
  document.body.classList.toggle('atlas-view', route.screen === 'map');
  $('#map-screen').hidden = route.screen !== 'map';
  $('#detail-screen').hidden = !['city', 'album', 'all'].includes(route.screen);
  $('#auth-screen').hidden = route.screen !== 'auth';
  $('#main-nav').hidden = !currentProfile;
  $('#account').innerHTML = currentProfile ? `<span class="avatar">${escapeHtml(currentProfile.name.slice(0, 1))}</span><span class="account-name">${escapeHtml(currentProfile.name)} · 演示</span><button class="logout" data-action="logout">退出</button>` : '<span class="muted">你的私人旅行手帐</span>';
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.action === (route.screen === 'all' ? 'my-albums' : 'home')));
  if (route.screen === 'map') {
    renderMapIndex();
    if (!map) initMap();
    else updateMarkers();

  } else if (route.screen === 'city') renderCity();
  else if (route.screen === 'album') renderAlbum();
  else if (route.screen === 'all') renderAll();
  else renderAuth();
}
function renderMapIndex() {
  const ownCities = cities.filter(city => albumsFor(city.id).length);
  const litCities = ownCities.filter(city => photoCount(city.id) > 0);
  const albumCount = ownCities.reduce((sum, city) => sum + albumsFor(city.id).length, 0);
  const count = ownCities.reduce((sum, city) => sum + photoCount(city.id), 0);
  $('#journey-counts').innerHTML = `<div><strong>${litCities.length.toString().padStart(2, '0')}</strong><span>座已点亮</span></div><div><strong>${albumCount.toString().padStart(2, '0')}</strong><span>本影集</span></div><div><strong>${count.toString().padStart(2, '0')}</strong><span>个瞬间</span></div>`;
  const query = $('#city-search').value.trim().toLowerCase();
  const results = query ? cities.filter(city => city.name.includes(query) || city.id.includes(query) || city.en.toLowerCase().includes(query) || (city.fullName || '').includes(query)) : [...ownCities].sort((a, b) => photoCount(b.id) - photoCount(a.id));
  $('#search-clear').hidden = !query;
  $('#city-list-title').textContent = query ? '搜索结果' : '我的城市';
  $('#city-list-count').textContent = `${results.length} 座`;
  $('#city-list').innerHTML = results.length ? results.map(city => `<button class="city-item ${photoCount(city.id) ? 'lit' : ''}" data-action="city" data-city="${city.id}"><span>${city.name[0]}</span><div><h3>${city.name}</h3><small>${albumsFor(city.id).length ? photoCount(city.id) ? `${photoCount(city.id)} 张照片 · 已点亮` : `${albumsFor(city.id).length} 本空影集 · 未点亮` : '还没有影集，去留下一页'}</small></div><span class="city-arrow">↗</span></button>`).join('') : `<p class="no-cities">${query ? '没有找到这座城市。<br>请试试城市全名或查看地图。' : '手帐还是空白的。<br>在地图上点一座城市，或搜索城市开始。'}</p>`;
}
function breadcrumbs(city, album) {
  return `<div class="breadcrumbs"><button data-action="home">旅程地图</button><span>/</span>${city ? `<button data-action="city" data-city="${city.id}">${city.name}</button>` : '<span>我的影集</span>'}${album ? `<span>/</span><span>${yearLabel(album.year)}</span>` : ''}</div>`;
}
function chapterCards(city) {
  return sortedAlbums(city.id).map(album => `<button class="chapter ${album.year === null ? 'unmarked' : ''}" data-action="album" data-city="${city.id}" data-album="${album.id}"><div class="chapter-picture ${album.photos.length ? '' : 'blank'}">${album.photos.length ? `<img src="${escapeHtml(album.photos[0].src)}" alt="${city.name}${yearLabel(album.year)}影集封面" loading="lazy">` : '<span>故事，慢慢写</span>'}</div><div class="chapter-body"><div><h2>${album.year ?? '未标年份'}</h2><small>${album.photos.length ? `${album.photos.length} 张照片 · 随时回来翻翻` : '空白的一页 · 等你添加照片'}</small></div><span class="chapter-arrow">↗</span></div></button>`).join('');
}
function renderCity() {
  const city = currentCity();
  if (!city) return navigate({ screen: 'map' }, { replace: true });
  const albums = albumsFor(city.id);
  const cover = albums.includes(seed2024) ? './sample/5.jpg' : sortedAlbums(city.id).find(album => album.photos.length)?.photos[0].src;
  $('#detail-screen').innerHTML = `${breadcrumbs(city)}<div class="detail-intro"><div><p class="eyebrow">${city.en} · MY CITY JOURNAL</p><h1>${city.name}，留在记忆里。</h1><p class="muted">${albums.length ? `${albums.length} 本影集，${photoCount(city.id)} 个被记住的瞬间。挑一年，慢慢翻。` : '旅程可以从一张照片开始，也可以从一本空影集开始。'}</p></div><button class="button primary" data-action="create-year">新建年份影集 <span>＋</span></button></div>${cover ? `<div class="city-cover"><img src="${escapeHtml(cover)}" alt="${city.name}影集照片"><span class="cover-label">留在这座城的一页。</span></div>` : ''}${albums.length ? `<div class="chapter-list">${chapterCards(city)}</div>` : '<div class="empty-state"><span class="empty-symbol">⌑</span><h2>这座城，等你写下第一页。</h2><p>先选择一个年份，有照片时再慢慢加进来。</p><button class="button secondary" data-action="create-year">留下第一本影集 ＋</button></div>'}`;
}
function renderAll() {
  const own = cities.filter(city => albumsFor(city.id).length);
  $('#detail-screen').innerHTML = `${breadcrumbs()}<div class="detail-intro"><div><p class="eyebrow">YOUR LITTLE COLLECTION</p><h1>一本一本，都是回忆。</h1><p class="muted">按城市收藏，按年份翻阅。</p></div><button class="button secondary" data-action="home">去地图找一座城 ↗</button></div>${own.length ? own.map(city => `<section class="all-albums-city"><h2>${city.name} <button class="text-link" data-action="city" data-city="${city.id}">查看城市 ↗</button></h2><div class="chapter-list">${chapterCards(city)}</div></section>`).join('') : '<div class="empty-state"><span class="empty-symbol">⌑</span><h2>第一本手帐，从这里开始。</h2><p>去地图选一座城市，为它留下一页。</p><button class="button primary" data-action="home">打开旅行地图</button></div>'}`;
}
function renderAlbum() {
  const album = currentAlbum();
  const city = currentCity();
  if (!album) return navigate({ screen: 'city', cityId: route.cityId }, { replace: true });
  $('#detail-screen').innerHTML = `${breadcrumbs(city, album)}<div class="detail-intro"><div><p class="eyebrow">${city.en} · A CHAPTER TO REMEMBER</p><div class="album-headline"><span class="album-year">${album.year ?? '未标年份'}</span><span class="divider"></span><h1>${city.name}的片刻</h1></div><p class="muted">从初到这座城开始，按自己的顺序，慢慢回看。</p></div><div class="album-tools">${album.photos.length > 1 ? `<button class="button secondary" data-action="sort">${sorting ? '完成整理 ✓' : '调整顺序 ⇄'}</button>` : ''}<button class="button primary" data-action="import">添加照片 ＋</button></div></div><div class="album-bar"><span>${album.photos.length} 张照片 · ${sorting ? '按住「拖动」手柄，或使用前移 / 后移' : '按你安排的顺序'}</span><span>${sorting ? '顺序仅保留在本次浏览中' : '点开照片，查看原图与文字'}</span></div>${album.photos.length ? `<div class="photo-grid ${sorting ? 'sorting' : ''}">${album.photos.slice(0, visibleCount).map((photo, index) => `<article class="photo-card" data-photo="${photo.id}" draggable="${sorting}"><button class="photo-open" data-action="photo" data-photo="${photo.id}" aria-label="查看第 ${index + 1} 张照片原图"><img src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.name)}" loading="lazy" draggable="false"></button><div class="photo-caption"><div><strong>旅行片刻 ${String(index + 1).padStart(2, '0')}</strong><br><small>${escapeHtml(photo.name)}</small></div>${photo.note ? '<span class="photo-note-dot" title="有文字记录" aria-label="有文字记录">记</span>' : ''}</div>${sorting ? `<div class="photo-tools"><button class="drag-handle" aria-label="拖动照片排序" title="按住拖动排序">⠿ 拖动</button><button data-action="move" data-photo="${photo.id}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>← 前移</button><button data-action="move" data-photo="${photo.id}" data-direction="1" ${index === album.photos.length - 1 ? 'disabled' : ''}>后移 →</button></div>` : ''}</article>`).join('')}</div>${album.photos.length > visibleCount ? `<button class="button secondary load-more" data-action="more">再翻一页 · 还有 ${album.photos.length - visibleCount} 张 ↓</button>` : ''}` : '<div class="empty-state"><span class="empty-symbol">▧</span><h2>影集已留好，等照片到来。</h2><p>从电脑或 U 盘选几张照片，收下这年的故事。</p><button class="button primary" data-action="import">添加第一张照片 ＋</button></div>'}`;
}
function openYear() {
  $('#year-city-label').textContent = `${currentCity().name} · 新建年份影集`;
  $('#album-year').innerHTML = Array.from({ length: 37 }, (_, index) => 2026 - index).map(year => `<option value="${year}">${year} 年</option>`).join('') + '<option value="unknown">暂不填写年份</option>';
  $('#year-dialog').showModal();
}
$('#year-form').addEventListener('submit', event => {
  event.preventDefault();
  const year = $('#album-year').value === 'unknown' ? null : Number($('#album-year').value);
  const albums = currentProfile.albums[route.cityId] ||= [];
  let album = albums.find(item => item.year === year);
  const existed = Boolean(album);
  if (!album) { album = makeAlbum(year); albums.push(album); }
  $('#year-dialog').close();
  navigate({ screen: 'album', cityId: route.cityId, albumId: album.id });
  toast(existed ? '这本影集已经有了，已为你打开。' : '空白的一页，已经留好了。');
});

function filenameOrder(name) {
  const match = name.match(/^(\d{4}|\d{2})-(\d+)(?=\D|$)/);
  return match ? { year: match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1]), order: Number(match[2]) } : null;
}
function clearPending() {
  for (const photo of pendingImport) URL.revokeObjectURL(photo.src);
  pendingImport = [];
  $('#photo-input').value = '';
}
$('#photo-input').addEventListener('change', () => {
  const files = [...$('#photo-input').files];
  clearPending();
  const accepted = files.filter(file => ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type));
  if (!accepted.length) { if (files.length) toast('请选择 JPG、PNG、WebP 或 GIF 照片。'); return; }
  pendingImport = accepted.map(file => ({ id: crypto.randomUUID(), name: file.name, src: URL.createObjectURL(file), size: file.size, note: '', numbering: filenameOrder(file.name) }));
  const numbered = pendingImport.every(photo => photo.numbering);
  const numberedItems = pendingImport.filter(photo => photo.numbering);
  const duplicateNumbers = new Set(numberedItems.map(photo => `${photo.numbering.year}-${photo.numbering.order}`)).size < numberedItems.length;
  if (numbered) pendingImport.sort((a, b) => a.numbering.order - b.numbering.order);
  const album = currentAlbum();
  const conflicts = pendingImport.filter(photo => album.year !== null && photo.numbering && photo.numbering.year !== album.year);
  $('#import-summary').textContent = `${currentCity().name} · ${yearLabel(album.year)} · ${pendingImport.length} 张照片`;
  $('#import-files').innerHTML = pendingImport.map((photo, index) => `<div class="import-row"><span>${index + 1}</span><span>${escapeHtml(photo.name)}</span><small>${(photo.size / 1024 / 1024).toFixed(1)} MB</small></div>`).join('');
  $('#import-message').innerHTML = `<p class="field-help">${numbered ? '已按文件名中的序号排列这批照片' : '这批照片沿用文件选择顺序'}；添加后仍可移动调整，已有照片顺序不变。</p>${accepted.length !== files.length ? `<p class="import-warning">${files.length - accepted.length} 个不支持的文件已略过。</p>` : ''}${conflicts.length ? `<p class="import-warning">${conflicts.length} 张照片的文件名年份与当前 ${album.year} 年不同。请核对；确认后仍放入当前影集，不会自动更改年份。</p>` : ''}${album.year === null ? '<p class="field-help">当前是“未标年份”影集，不会根据文件名自动填入年份。</p>' : ''}`;
  $('#conflict-label').hidden = !conflicts.length;
  if (duplicateNumbers) $('#import-message').insertAdjacentHTML('beforeend', '<p class="import-warning">这批照片有重复编号，均会保留；相同编号沿用选择顺序，添加后可自行调整。</p>');
  $('#confirm-conflict').checked = false;
  $('#confirm-import').disabled = Boolean(conflicts.length);
  $('#import-dialog').showModal();
});
$('#confirm-conflict').addEventListener('change', () => { $('#confirm-import').disabled = !$('#confirm-conflict').checked; });
$('#confirm-import').addEventListener('click', () => {
  if ($('#confirm-import').disabled || !pendingImport.length) return;
  const count = pendingImport.length;
  currentAlbum().photos.push(...pendingImport);
  pendingImport = [];
  $('#import-dialog').close();
  renderAlbum();
  toast(`已在原型中添加 ${count} 张照片，本次浏览期间可查看。`);
});
$('#import-dialog').addEventListener('close', clearPending);

function movePhoto(id, destination) {
  const album = currentAlbum();
  const index = album.photos.findIndex(photo => photo.id === id);
  if (index < 0 || destination < 0 || destination >= album.photos.length || index === destination) return;
  const [photo] = album.photos.splice(index, 1);
  album.photos.splice(destination, 0, photo);
  visibleCount = Math.max(visibleCount, destination + 1);
  renderAlbum();
}
$('#detail-screen').addEventListener('dragstart', event => {
  const card = event.target.closest('.photo-card');
  if (!sorting || !card) return;
  draggedId = card.dataset.photo;
  event.dataTransfer.setData('text/plain', draggedId);
  event.dataTransfer.effectAllowed = 'move';
});
$('#detail-screen').addEventListener('dragover', event => {
  const card = event.target.closest('.photo-card');
  if (!sorting || !draggedId || !card) return;
  event.preventDefault();
  card.classList.add('drag-over');
});
$('#detail-screen').addEventListener('dragleave', event => { event.target.closest('.photo-card')?.classList.remove('drag-over'); });
$('#detail-screen').addEventListener('drop', event => {
  const card = event.target.closest('.photo-card');
  if (!sorting || !draggedId || !card) return;
  event.preventDefault();
  movePhoto(draggedId, currentAlbum().photos.findIndex(photo => photo.id === card.dataset.photo));
  draggedId = null;
});
$('#detail-screen').addEventListener('dragend', () => { draggedId = null; document.querySelectorAll('.drag-over').forEach(card => card.classList.remove('drag-over')); });
// An explicit pointer handle also supports browsers that do not emit HTML drag events.
$('#detail-screen').addEventListener('pointerdown', event => {
  const handle = event.target.closest('.drag-handle');
  if (!sorting || !handle || event.button !== 0) return;
  event.preventDefault();
  pointerDrag = { id: handle.closest('.photo-card').dataset.photo, target: null };
  handle.setPointerCapture(event.pointerId);
});
$('#detail-screen').addEventListener('pointermove', event => {
  if (!pointerDrag) return;
  const card = document.elementFromPoint(event.clientX, event.clientY)?.closest('.photo-card');
  document.querySelectorAll('.drag-over').forEach(item => item.classList.remove('drag-over'));
  pointerDrag.target = card?.dataset.photo;
  if (card && pointerDrag.target !== pointerDrag.id) card.classList.add('drag-over');
});
$('#detail-screen').addEventListener('pointerup', () => {
  if (!pointerDrag) return;
  const { id, target } = pointerDrag;
  pointerDrag = null;
  if (target) movePhoto(id, currentAlbum().photos.findIndex(photo => photo.id === target));
  document.querySelectorAll('.drag-over').forEach(card => card.classList.remove('drag-over'));
});
$('#detail-screen').addEventListener('pointercancel', () => {
  pointerDrag = null;
  document.querySelectorAll('.drag-over').forEach(card => card.classList.remove('drag-over'));
});

function saveNote(announce = false) {
  const photo = viewerContext?.photo;
  if (!photo) return;
  photo.note = $('#photo-note').value;
  $('#note-state').textContent = '已保存在本次浏览中。';
  if (announce) toast('这一段记忆，已记在这张照片旁。');
}
function openPhoto(id) {
  if ($('#photo-dialog').open) saveNote();
  currentPhotoId = id;
  const album = currentAlbum();
  const index = album.photos.findIndex(photo => photo.id === id);
  const photo = album.photos[index];
  viewerContext = { album, photo };
  $('#viewer-count').textContent = `${currentCity().name} · ${yearLabel(album.year)} ／ ${index + 1} of ${album.photos.length}`;
  $('#viewer-title').textContent = `旅行片刻 ${String(index + 1).padStart(2, '0')}`;
  $('#viewer-filename').textContent = `${photo.name} · 原始文件`;
  $('#photo-note').value = photo.note;
  $('#note-state').textContent = photo.note ? '这张照片的文字记录。' : '文字可以留白。';
  $('#original-error').hidden = true;
  $('#original-image').hidden = false;
  $('#original-image').src = photo.src;
  $('#original-image').alt = photo.name;
  $('[data-action="previous-photo"]').disabled = index === 0;
  $('[data-action="next-photo"]').disabled = index === album.photos.length - 1;
  if (!$('#photo-dialog').open) $('#photo-dialog').showModal();
}
$('#photo-note').addEventListener('input', () => { $('#note-state').textContent = '尚未保存；切换照片或关闭时会保留在本次浏览中。'; });
$('#save-note').addEventListener('click', () => saveNote(true));
$('#photo-dialog').addEventListener('close', () => {
  saveNote();
  if (route.screen === 'album' && currentAlbum() === viewerContext?.album) renderAlbum();
  viewerContext = null;
});
$('#photo-dialog').addEventListener('keydown', event => {
  if (event.target.matches('textarea')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    shiftPhoto(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
function shiftPhoto(direction) {
  const photos = currentAlbum().photos;
  const index = photos.findIndex(photo => photo.id === currentPhotoId) + direction;
  if (photos[index]) openPhoto(photos[index].id);
}

function renderAuth() {
  const register = route.mode === 'register';
  $('#auth-screen').innerHTML = `<div class="auth-layout"><div class="auth-story"><p class="eyebrow">YOUR JOURNEYS, YOUR STORIES</p><h1>走过的路，<br>总有值得留住的光。</h1><p class="muted">为自己，留一本慢慢变厚的旅行手帐。</p><div class="auth-photo"><img src="./sample/5.jpg" alt="深圳海边的天空"><span class="tape"></span><p>把日子，过成可以回看的风景。</p></div></div><form id="auth-form" class="auth-form"><div class="auth-tabs"><button type="button" data-action="login-tab" class="${register ? '' : 'active'}">登录</button><button type="button" data-action="register-tab" class="${register ? 'active' : ''}">注册</button></div><label for="username">${register ? '给自己起一个名字' : '账号'}</label><input id="username" name="demo-name" required maxlength="20" autocomplete="off" placeholder="${register ? '例如：慢慢走' : '演示账号：旅人'}" value="${register ? '' : escapeHtml(route.username || '旅人')}"><label for="password">密码（固定演示口令）</label><input id="password" type="password" value="demo2026" readonly autocomplete="off" aria-describedby="auth-demo-note">${register ? '<label for="password-confirm">确认演示口令</label><input id="password-confirm" type="password" value="demo2026" readonly autocomplete="off">' : ''}<p id="auth-demo-note" class="auth-note">当前只体验流程，演示口令为 demo2026，已自动填好。正式账号与密码设置将在开发后启用。</p><div class="auth-error" id="auth-error" role="alert"></div><button type="submit" class="button primary">${register ? '创建我的手帐 ＋' : '翻开我的手帐 →'}</button><p class="auth-switch">${register ? '已有演示账号？<button type="button" data-action="login-tab">去登录</button>' : '还没有账号？<button type="button" data-action="register-tab">从第一本开始</button>'}</p></form></div>`;
  $('#auth-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('#username').value.trim();
    if (!name) { $('#auth-error').textContent = '请先填写一个名字。'; return; }
    if (register) {
      if (profiles.has(name)) { $('#auth-error').textContent = '这个演示账号已经存在，可以直接登录。'; return; }
      profiles.set(name, { name, albums: {} });
      navigate({ screen: 'auth', mode: 'login', username: name }, { replace: true });
      toast('演示账号已创建，登录后开始你的第一本手帐。');
    } else {
      if (!profiles.has(name)) { $('#auth-error').textContent = '还没有这个演示账号，请先注册。'; return; }
      currentProfile = profiles.get(name);
      $('#city-search').value = '';
      navigate({ screen: 'map' }, { replace: true });
    }
  });
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'home') navigate({ screen: 'map' });
  else if (action === 'my-albums') navigate({ screen: 'all' });
  else if (action === 'city') navigate({ screen: 'city', cityId: button.dataset.city });
  else if (action === 'album') navigate({ screen: 'album', cityId: button.dataset.city, albumId: button.dataset.album });
  else if (action === 'open-seeded') navigate({ screen: 'album', cityId: 'shenzhen', albumId: seed2024.id });
  else if (action === 'create-year') openYear();
  else if (action === 'close-year') $('#year-dialog').close();
  else if (action === 'import') $('#photo-input').click();
  else if (action === 'close-import') $('#import-dialog').close();
  else if (action === 'sort') { sorting = !sorting; renderAlbum(); if (!sorting) toast('顺序已记下，本次浏览期间会保留。'); }
  else if (action === 'move') { const index = currentAlbum().photos.findIndex(photo => photo.id === button.dataset.photo); movePhoto(button.dataset.photo, index + Number(button.dataset.direction)); }
  else if (action === 'more') { visibleCount += 12; const scrollY = window.scrollY; renderAlbum(); window.scrollTo(0, scrollY); }
  else if (action === 'photo') openPhoto(button.dataset.photo);
  else if (action === 'close-photo') $('#photo-dialog').close();
  else if (action === 'previous-photo') shiftPhoto(-1);
  else if (action === 'next-photo') shiftPhoto(1);
  else if (action === 'retry-original') { $('#original-error').hidden = true; $('#original-image').hidden = false; $('#original-image').src = currentAlbum().photos.find(photo => photo.id === currentPhotoId).src; }
  else if (action === 'logout') {
    currentProfile = null;
    $('#detail-screen').replaceChildren();
    $('#city-list').replaceChildren();
    $('#city-search').value = '';
    navigate({ screen: 'auth', mode: 'login' }, { replace: true });
  } else if (action === 'login-tab' || action === 'register-tab') navigate({ screen: 'auth', mode: action === 'login-tab' ? 'login' : 'register' }, { replace: true });
  else if (action === 'retry-map') initMap(true);
});
$('#city-search').addEventListener('input', renderMapIndex);
$('#search-clear').addEventListener('click', () => { $('#city-search').value = ''; renderMapIndex(); $('#city-search').focus(); });
document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || image.closest('#travel-map')) return;
  if (image.id === 'original-image') { image.hidden = true; $('#original-error').hidden = false; return; }
  image.hidden = true;
  if (!image.parentElement.querySelector('.unavailable')) {
    const placeholder = document.createElement('span');
    placeholder.className = 'unavailable';
    placeholder.textContent = '照片暂不可用';
    image.parentElement.append(placeholder);
  }
}, true);

function mapMessage(message, retry = false) {
  $('#map-status').innerHTML = `${escapeHtml(message)}${retry ? '<button data-action="retry-map">重新展开地图</button>' : ''}`;
  $('#map-status').hidden = false;
}
async function initMap(retryMissing = false) {
  if (mapStarting) return;
  mapStarting = true;
  mapMessage('正在读取中国城市目录…');
  try {
    const collection = await ChinaMapData.load();
    const aliases = { '156440300': 'shenzhen', '156440100': 'guangzhou', '156450900': 'yulin', '156451100': 'hezhou', '156810000': 'hongkong', '156820000': 'macau', '156110000': 'beijing' };
    const oldCities = cities;
    cities = collection.features.map(feature => {
      const properties = feature.properties;
      const code = String(properties.adcode || properties.id);
      const existing = oldCities.find(city => properties.name === city.name || properties.name === `${city.name}市` || (city.id === 'hongkong' && properties.name.startsWith('香港')) || (city.id === 'macau' && properties.name.startsWith('澳门')));
      const id = aliases[code] || existing?.id || code;
      const name = properties.name.replace(/特别行政区$|市$/g, '');
      return { id, name, fullName: properties.name, en: existing?.en || 'CITY JOURNAL', lng: Number(properties.center?.[0]), lat: Number(properties.center?.[1]), feature };
    });
    // Preserve existing demo albums even if a provider temporarily omits a city.
    for (const city of oldCities) if (!cities.some(item => item.id === city.id)) cities.push(city);
    renderMapIndex();
    map ||= new CityAtlas($('#travel-map'), { onCitySelect: id => navigate({ screen: 'city', cityId: id }) });
    map.setData(cities, collection.outline);
    updateMarkers();
    mapMessage('正在展开中国轮廓…');
    const outline = collection.outline || await ChinaMapData.outline({
      retryMissing,
      onProgress(progress) {
        mapMessage(`正在展开中国地图 · ${progress.processed}/${progress.total}`);
        if (progress.loaded && (progress.processed % 5 === 0 || progress.pending === 0)) {
          map.setData(cities, progress.collection);
        }
      },
    });
    map.setData(cities, outline?.type ? outline : outline?.outline);
    updateMarkers();
    if (outline?.metadata?.missing?.length) mapMessage('部分地图边界暂未加载，请稍后重试。城市搜索仍可使用。', true);
    else $('#map-status').hidden = true;
  } catch {
    mapMessage('中国地图暂未加载完成。请检查网络后重试；仍可从右侧进入已有城市。', true);
  } finally { mapStarting = false; }
}
function updateMarkers() {
  if (!map || !currentProfile) return;
  map.updateCounts(cities.map(city => [city.id, photoCount(city.id)]));
  for (const city of cities) {
    if (!photoCount(city.id) || !city.feature || boundaryLoading.has(city.id) || map.boundaries.has(city.id)) continue;
    boundaryLoading.add(city.id);
    ChinaMapData.boundary(city.feature).then(feature => {
      if (feature) map.setBoundary(city.id, feature);
    }).catch(() => {}).finally(() => boundaryLoading.delete(city.id));
  }
}
$('#map-reset').addEventListener('click', () => map?.reset());
$('#map-zoom-in').addEventListener('click', () => map?.zoom(1.45));
$('#map-zoom-out').addEventListener('click', () => map?.zoom(1 / 1.45));
history.replaceState(route, '');
render();
