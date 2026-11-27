(() => {
  'use strict'

  const app = document.querySelector('#app')
  const mapFailure = document.querySelector('#demo-map-fail')
  const storageKey = 'cijianji.refactor.flow-demo.v1'
  // Coordinates use the same 720 × 490 projection as the local country overview.
  const cities = [
    { id: 'guangzhou', name: '广州', region: '广东', x: 484.0, y: 409.4, dx: -23, dy: -12 },
    { id: 'hangzhou', name: '杭州', region: '浙江', x: 544.7, y: 313.8, dx: -22, dy: 19 },
    { id: 'shenzhen', name: '深圳', region: '广东', x: 492.8, y: 417.9, dx: 20, dy: 15 },
    { id: 'suzhou', name: '苏州', region: '江苏', x: 551.3, y: 298.9, dx: -18, dy: -16 },
    { id: 'shanghai', name: '上海', region: '上海', x: 560.3, y: 299.8, dx: 23, dy: -4 },
  ]
  const subjects = {
    arcade: { name: '骑楼街口.jpg', image: 'arcade-sample.webp', cover: 'arcade-cover.webp', alt: '骑楼街道的合成摄影样片' },
    street: { name: '街口.jpg', image: 'street-sample.webp', cover: 'street-cover.webp', alt: '杭州街口的日常街景' },
    lane: { name: '巷里.jpg', image: 'lane-sample.webp', alt: '阴天里的一条城市小巷' },
    lake: { name: '湖畔.jpg', image: 'lake-sample.webp', alt: '湖畔的薄雾与远山' },
    garden: { name: '庭园.jpg', art: 'garden' },
    mountain: { name: '远山.jpg', art: 'mountain' },
  }

  function initialState() {
    return {
      version: 2,
      profile: 'sample',
      accounts: {
        sample: [
          { city: 'guangzhou', year: '2026', photos: [{ id: 'g1', subject: 'arcade', note: '沿着骑楼慢慢走，回头看了一眼街口。' }] },
          { city: 'shenzhen', year: '2026', photos: [] },
          { city: 'hangzhou', year: '2026', photos: [
            { id: 's3', subject: 'street', note: '散步到街口，在路边停了片刻。' },
            { id: 's4', subject: 'lane' },
            { id: 's1', subject: 'lake', note: '湖面刚起一层薄雾。' },
          ] },
          { city: 'hangzhou', year: '2025', photos: [{ id: 's2', subject: 'lane' }] },
          { city: 'suzhou', year: '2025', photos: [] },
        ],
        fresh: [],
      },
    }
  }

  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey))
      if (saved && ['sample', 'fresh'].includes(saved.profile)
        && Array.isArray(saved.accounts?.sample) && Array.isArray(saved.accounts?.fresh)) {
        if (!saved.version) {
          const additions = initialState().accounts.sample.filter(album => ['guangzhou', 'shenzhen'].includes(album.city)
            && !saved.accounts.sample.some(item => item.city === album.city))
          saved.accounts.sample.push(...additions)
          saved.version = 2
        }
        return saved
      }
    } catch { /* Browsers may restrict storage on local file URLs. */ }
    return initialState()
  }

  const state = restore()
  function persist() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)) }
    catch { /* The demo still works in memory. */ }
  }

  let draft = null
  let lastHash = null
  let library = { text: '', year: '', scroll: 0 }
  let albumPosition = null
  let mapPosition = null
  let pendingMapFocus = ''
  let outlineRequest
  let uploadTimer
  const albums = () => state.accounts[state.profile]
  const byCity = id => albums().filter(album => album.city === id)
  const getCity = id => cities.find(city => city.id === id)
  const searchName = city => city.name + '市 ' + city.region
  const getAlbum = (city, year) => byCity(city).find(album => album.year === year)
  const yearName = year => year === 'unknown' ? '未标年份' : year + ' 年'
  const yearSort = (a, b) => Number(b === 'unknown' ? 0 : b) - Number(a === 'unknown' ? 0 : a)
  const countPhotos = list => list.reduce((count, album) => count + album.photos.length, 0)
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

  function ensureAlbum(city, year) {
    let album = getAlbum(city, year)
    if (!album) {
      album = { city, year, photos: [] }
      albums().push(album)
      persist()
    }
    return album
  }

  function locationInfo() {
    const [path, query] = location.hash.slice(1).split('?')
    const [page = 'home', cityId, year, photo] = (path || 'home').split('/')
    const params = new URLSearchParams(query)
    return { page, city: getCity(cityId), year, photo, via: params.get('via'), origin: params.get('from') === 'map' ? 'map' : 'albums' }
  }

  const cityUrl = (city, origin) => '#city/' + city + '?from=' + origin
  const albumUrl = (city, year, origin) => '#album/' + city + '/' + year + '?from=' + origin
  const photoUrl = (album, photo, origin) => '#photo/' + album.city + '/' + album.year + '/' + photo.id + '?from=' + origin
  const addUrl = (city, year, via, origin) => '#add/' + city + (year ? '/' + year : '') + '?via=' + via + '&from=' + origin
  function importOrigin(city, year, via, origin) {
    if (via === 'album' && year) return albumUrl(city.id, year, origin)
    if (via === 'city') return cityUrl(city.id, origin)
    return '#home'
  }
  const nav = (url, label, secondary = false) => '<a class="button' + (secondary ? ' secondary' : '') + '" href="' + esc(url) + '">' + esc(label) + '</a>'
  const action = (id, label, secondary = false) => '<button type="button" class="button' + (secondary ? ' secondary' : '') + '" data-action="' + id + '">' + esc(label) + '</button>'
  const group = (...items) => '<div class="actions">' + items.join('') + '</div>'
  const status = text => '<p class="status" role="status">' + esc(text) + '</p>'

  function page(title, parentUrl, parentName, body) {
    return '<section class="inner-page"><a class="back-link" href="' + esc(parentUrl) + '">← ' + esc(parentName)
      + '</a><div class="page-heading"><h1 tabindex="-1">' + esc(title) + '</h1></div>' + body + '</section>'
  }

  function art(subject, preview = false) {
    if (!subject) return '<span class="photo-art empty-art" aria-hidden="true"></span>'
    if (subject.image) {
      if (preview) return '<img class="photo-preview" src="' + subject.image + '" alt="' + esc(subject.alt) + '">'
      return '<img class="photo-art" src="' + (subject.cover || subject.image) + '" alt="" loading="lazy" decoding="async">'
    }
    // Earlier demo sessions can still contain the original illustrated samples.
    return '<span class="photo-art art-' + subject.art + (preview ? ' photo-preview' : '') + '" role="img" aria-label="' + esc(subject.name + '，合成示意') + '"></span>'
  }

  function tile(url, title, detail, subject) {
    const meta = detail ? '<span class="album-meta">' + esc(detail) + '</span>' : ''
    return '<a class="album-card' + (subject ? '' : ' album-empty') + '" href="' + esc(url) + '">' + art(subject)
      + '<span class="album-caption"><strong class="album-title">' + esc(title) + '</strong>' + meta + '</span></a>'
  }

  function yearField(value = '', fixed = false) {
    const unknown = value === 'unknown'
    return '<label class="field">年份<input id="year-input" type="number" min="1" max="9999" step="1" placeholder="例如 2026" value="'
      + esc(unknown ? '' : value) + '"' + (unknown || fixed ? ' disabled' : '') + '></label>'
      + '<label><input id="unknown-year" type="checkbox"' + (unknown ? ' checked' : '') + (fixed ? ' disabled' : '') + '> 未标年份</label>'
  }

  function readYear() {
    const input = app.querySelector('#year-input')
    if (app.querySelector('#unknown-year').checked) return 'unknown'
    const year = input.valueAsNumber
    if (Number.isInteger(year) && year >= 1 && year <= 9999) return String(year)
    input.setCustomValidity('请输入 1 到 9999 之间的年份，或勾选未标年份。')
    input.reportValidity()
    return null
  }

  function chooser(create) {
    const label = create ? '创建年份影集' : '添加照片'
    const target = create ? '#create/' : '#add/'
    return page(label, create ? '#albums' : '#home', create ? '我的相册' : '首页',
      '<section class="panel"><h2>选择城市</h2><label class="field">搜索城市或地区<input type="search" id="city-search" placeholder="输入城市名或省份"></label>'
      + '<div class="city-list">' + cities.map(city => '<a class="button secondary" data-search="' + searchName(city) + '" href="'
        + target + city.id + '">' + city.name + '</a>').join('') + '</div><p id="city-no-result" hidden role="status">没有匹配的示例城市。</p></section>')
  }

  function albumList() {
    const shown = cities.filter(city => {
      const owned = byCity(city.id)
      return owned.length && searchName(city).includes(library.text.trim()) && (!library.year || owned.some(album => album.year === library.year))
    })
    if (!shown.length && (library.text || library.year)) return status('没有符合筛选条件的城市相册。') + action('clear-filters', '清除筛选', true)
    if (!shown.length) return '<div class="library-empty">' + status('还没有相册。可以先建一本空影集，也可以从首页直接添加照片。') + '</div>'
    return '<div class="album-grid city-grid">' + shown.map(city => {
      const owned = byCity(city.id).sort((a, b) => yearSort(a.year, b.year))
      const cover = owned.find(album => album.photos.length)?.photos[0]
      const years = owned.filter(album => album.year !== 'unknown').map(album => album.year)
      let period = years.length ? years.at(-1) : '未标年份'
      if (years.length > 1) period += '–' + years[0]
      return tile(cityUrl(city.id, 'albums'), city.name, period + ' · ' + owned.length + ' 本影集 · ' + countPhotos(owned) + ' 张照片', subjects[cover?.subject])
    }).join('') + '</div>'
  }

  function libraryPage() {
    const years = [...new Set(albums().map(album => album.year))].sort(yearSort)
    const filters = '<div class="actions library-filters"><label class="field">搜索城市<input id="library-search" type="search" value="' + esc(library.text) + '" placeholder="城市名或地区"></label>'
      + '<label class="field">筛选年份<select id="library-year"><option value="">全部年份</option>' + years.map(year => '<option value="' + esc(year) + '"'
        + (year === library.year ? ' selected' : '') + '>' + esc(yearName(year)) + '</option>').join('') + '</select></label></div>'
    return page('我的相册', '#home', '首页', filters + '<div id="library-results">' + albumList() + '</div>'
      + group(nav('#choose-city-title', '选择城市，创建影集', true)))
  }

  function cityPage(city, origin) {
    const owned = byCity(city.id).sort((a, b) => yearSort(a.year, b.year))
    const grid = '<div class="album-grid year-grid">' + owned.map(album => tile(albumUrl(city.id, album.year, origin), yearName(album.year), album.photos.length + ' 张照片', subjects[album.photos[0]?.subject])).join('') + '</div>'
    return page(city.name, '#' + origin, origin === 'map' ? '城市地图' : '我的相册', '<h2>年份影集</h2>' + (owned.length ? grid : status('这座城市还没有年份影集。'))
      + group(nav(addUrl(city.id, '', 'city', origin), '添加照片'), nav('#create/' + city.id + '?from=' + origin, '创建年份影集', true)))
  }

  function albumPage(city, album, origin) {
    const grid = '<div class="album-grid photo-grid">' + album.photos.map(photo => {
      const subject = subjects[photo.subject]
      return tile(photoUrl(album, photo, origin), subject.name, '', subject)
    }).join('') + '</div>'
    return page(city.name + ' · ' + yearName(album.year), cityUrl(city.id, origin), city.name,
      (album.photos.length ? grid : status('这本影集还是空的。')) + group(nav(addUrl(city.id, album.year, 'album', origin), '添加照片')))
  }

  function photoPage(city, album, photoId, origin) {
    const index = album.photos.findIndex(photo => photo.id === photoId)
    if (index < 0) return
    const item = album.photos[index]
    const subject = subjects[item.subject]
    const count = album.photos.length
    const back = albumUrl(city.id, album.year, origin)
    const locationLabel = city.name + ' · ' + yearName(album.year)
    const tools = '<nav class="viewer-tools" aria-label="照片浏览">'
      + '<a href="' + esc(back) + '" class="viewer-return" aria-label="返回' + esc(locationLabel) + '影集">返回影集</a>'
      + '<button class="viewer-step" type="button" data-step="-1"' + (index === 0 ? ' disabled' : '') + '>上一张</button>'
      + '<span class="viewer-count" aria-label="第 ' + (index + 1) + ' 张，共 ' + count + ' 张">' + (index + 1) + ' / ' + count + '</span>'
      + '<button class="viewer-step" type="button" data-step="1"' + (index === count - 1 ? ' disabled' : '') + '>下一张</button></nav>'
    return '<section class="photo-viewer"><figure class="viewer-figure"><div class="viewer-stage">' + art(subject, true) + tools
      + '</div><figcaption class="viewer-caption"><p class="viewer-location">' + esc(locationLabel) + '</p>'
      + '<h1 tabindex="-1">' + esc(subject.name) + '</h1><p class="viewer-note">' + esc(item.note || '暂无文字记录') + '</p></figcaption></figure></section>'
  }

  function stepPhoto(direction) {
    const { city, year, photo, origin } = locationInfo()
    const album = city && getAlbum(city.id, year)
    if (!album) return
    const index = album.photos.findIndex(item => item.id === photo)
    const next = album.photos[index + direction]
    if (index >= 0 && next) {
      // A browser Back from the viewer returns to its entry point, even after several photos.
      location.replace(photoUrl(album, next, origin))
    }
  }

  function loadCityOutlines() {
    if (!outlineRequest) {
      const script = document.createElement('script')
      outlineRequest = new Promise((resolve, reject) => {
        script.onload = () => resolve(window.prototypeCityOutlines)
        script.onerror = () => {
          script.remove()
          outlineRequest = undefined
          reject(new Error('City outlines could not be loaded'))
        }
      })
      script.src = 'city-outlines.js'
      document.head.append(script)
    }
    return outlineRequest
  }

  function mapMarker(city, count, outline) {
    const label = city.name + '，' + (count ? '已点亮，' + count + ' 张照片' : '暂无照片')
    const anchor = city.dx < 0 ? 'end' : 'start'
    const x2 = city.x + city.dx
    const y2 = city.y + city.dy
    return '<a id="map-pin-' + city.id + '" class="map-marker ' + (count ? 'lit' : 'unlit') + '" data-map-city="' + city.id
      + '" href="' + cityUrl(city.id, 'map') + '" aria-label="' + esc(label) + '"><title>' + esc(label) + '</title>'
      + '<path class="city-outline" d="' + esc(outline) + '"/>'
      + '<path class="map-leader" d="M' + city.x + ' ' + city.y + ' L' + x2 + ' ' + y2 + '"/>'
      + '<circle class="map-hit" cx="' + city.x + '" cy="' + city.y + '" r="6" fill="transparent"/>'
      + '<circle class="map-pin" cx="' + city.x + '" cy="' + city.y + '" r="' + (count ? 4 : 3) + '"/>'
      + '<text class="map-city-label" x="' + (x2 + Math.sign(city.dx) * 3) + '" y="' + y2 + '" dominant-baseline="central" text-anchor="' + anchor + '">' + city.name + '</text></a>'
  }

  function renderMap() {
    app.replaceChildren(document.querySelector('#map-template').content.cloneNode(true))
    const entries = cities.map(city => {
      const owned = byCity(city.id).sort((a, b) => yearSort(a.year, b.year))
      return { city, count: countPhotos(owned), cover: owned.find(album => album.photos.length)?.photos[0] }
    })
    const lit = entries.filter(entry => entry.count)
    app.querySelector('#footprint-count').textContent = lit.length
    const list = app.querySelector('#footprint-cities')
    list.innerHTML = lit.map(({ city, cover, count }) => {
      const region = city.name === city.region ? '' : city.region + ' · '
      return '<a id="map-row-' + city.id + '" class="footprint-city" data-map-city="' + city.id + '" href="' + cityUrl(city.id, 'map')
        + '"><span class="footprint-cover">' + art(subjects[cover.subject]) + '</span><span class="footprint-city-text"><strong>' + city.name
        + '</strong><small>' + region + count + ' 张照片</small></span><span class="footprint-chevron" aria-hidden="true">›</span></a>'
    }).join('') || '<div class="footprint-empty"><p>还没有点亮的城市。保存第一张照片，就会点亮它所在的城市。</p><a href="#add">添加照片</a></div>'
    const choices = entries.map(({ city, count }) => '<a class="footprint-choice" id="map-choice-' + city.id + '" data-map-city="' + city.id
      + '" href="' + cityUrl(city.id, 'map') + '"><strong>' + city.name + '</strong><small>' + (count ? '已点亮' : '暂无照片') + '</small></a>').join('')
    list.insertAdjacentHTML('beforeend', '<details class="footprint-picker"><summary>按名称选城</summary><div>' + choices + '</div></details>')

    const surface = app.querySelector('#map-surface')
    function showFailure() {
      surface.innerHTML = '<div class="map-status">' + status('地图暂时无法显示。可以按名称选城，或重试地图。')
        + group(action('retry-map', '重试地图'), nav('#albums', '去我的相册', true)) + '</div>'
      if (pendingMapFocus && app.querySelector('h1') === document.activeElement) {
        const fallback = app.querySelector('#map-row-' + mapPosition.city) || app.querySelector('.footprint-picker summary')
        fallback.focus({ preventScroll: true })
      }
      pendingMapFocus = ''
    }
    if (mapFailure.checked) {
      showFailure()
      return
    }
    surface.innerHTML = '<div class="footprint-map-art"></div><div class="map-status" role="status">正在加载地图…</div>'
    const picture = new Image(720, 490)
    picture.alt = ''
    picture.className = 'footprint-base'
    const loaded = new Promise((resolve, reject) => {
      picture.onload = resolve
      picture.onerror = reject
    })
    const layer = surface.querySelector('.footprint-map-art')
    layer.append(picture)
    picture.src = 'map-overview.svg'
    Promise.all([loaded, loadCityOutlines()]).then(([, outlines]) => {
      if (!surface.isConnected) return
      // Paint lit cities last so that an adjacent hollow marker never covers a saved city.
      const pins = [...entries.filter(entry => !entry.count), ...lit]
        .map(({ city, count }) => mapMarker(city, count, outlines[city.id])).join('')
      layer.insertAdjacentHTML('beforeend', '<svg class="footprint-markers" viewBox="0 0 720 490" role="group" aria-label="全国地图上的城市相册">' + pins + '</svg>')
      surface.querySelector('.map-status').remove()
      if (pendingMapFocus && app.querySelector('h1') === document.activeElement) {
        app.querySelector('#' + pendingMapFocus)?.focus({ preventScroll: true })
      }
      pendingMapFocus = ''
    }).catch(() => { if (surface.isConnected) showFailure() })
  }

  function addPage(city, fixedYear, via, origin) {
    if (!draft || draft.city !== city.id || draft.fixedYear !== fixedYear) {
      clearTimeout(uploadTimer)
      draft = { city: city.id, fixedYear, year: fixedYear || '', subject: '', stage: 'review' }
    }
    const source = importOrigin(city, fixedYear, via, origin)
    const back = source === '#home' ? '#add' : source
    const backLabel = source === '#home' ? '重新选城' : fixedYear ? '返回影集' : '返回' + city.name
    let content
    if (draft.stage === 'review') {
      content = '<h2>选择与核对</h2><label class="field">示例照片<select id="sample-photo"><option value="">选择一张示例照片</option>'
        + ['lake', 'street', 'lane', 'arcade'].map(key => '<option value="' + key + '"' + (key === draft.subject ? ' selected' : '') + '>' + subjects[key].name + '</option>').join('')
        + '</select></label>' + yearField(draft.year, Boolean(fixedYear)) + group(action('queue', '确认队列'), action('cancel', '取消', true))
    } else {
      const subject = subjects[draft.subject]
      const target = city.name + ' · ' + yearName(draft.year)
      const actions = {
        queued: group(action('upload', '上传并校验'), action('upload-fail', '模拟上传失败', true), action('cancel', '取消', true)),
        uploading: group(action('cancel', '取消', true)),
        failed: group(action('upload', '重试上传'), action('cancel', '取消', true)),
        staged: group(action('save', '确认保存'), action('cancel', '取消', true)),
        saved: group(nav(albumUrl(city.id, draft.year, origin), '查看目标影集'), nav(source, source === '#home' ? '回到首页' : '返回来源页', true)),
      }
      const labels = { queued: '队列已确认', uploading: '正在上传并校验…', failed: '上传失败，可以重试。', staged: '已校验，待保存', saved: '照片已保存' }
      content = '<h2>' + target + '</h2><p>' + esc(subject.name) + '</p>' + status(labels[draft.stage]) + actions[draft.stage]
    }
    return page('添加照片 · ' + city.name, back, backLabel, '<div class="panel">' + content + '</div>')
  }

  function createPage(city, origin) {
    return page('创建年份影集', cityUrl(city.id, origin), city.name, '<div class="panel"><h2>' + city.name + '</h2>' + yearField()
      + group(action('create', '创建或打开影集'), nav('#choose-city-title', '重新选城', true)) + '</div>')
  }

  function render(focusSelector) {
    const { page: name, city, year, photo, origin, via } = locationInfo()
    if (name === 'home') {
      app.replaceChildren(document.querySelector('#home-template').content.cloneNode(true))
    } else if (name === 'map') {
      renderMap()
    } else {
      const album = city && getAlbum(city.id, year)
      let html
      if (name === 'albums') html = libraryPage()
      else if (name === 'choose-city-title' || (name === 'add' && !city)) html = chooser(name === 'choose-city-title')
      else if (name === 'add' && city && (!year || album)) html = addPage(city, year, via, origin)
      else if (name === 'create' && city) html = createPage(city, origin)
      else if (name === 'city' && city) html = cityPage(city, origin)
      else if (name === 'album' && album) html = albumPage(city, album, origin)
      else if (name === 'photo' && album) html = photoPage(city, album, photo, origin)
      app.innerHTML = html || page('找不到这本影集或照片', '#home', '首页', nav('#albums', '打开我的相册'))
    }
    const title = app.querySelector('h1')
    document.title = (title?.textContent || '首页') + ' · 此间集原型'
    document.querySelector('#demo-profile').textContent = state.profile === 'sample' ? '示例账号' : '新账号'
    if (focusSelector) {
      const next = app.querySelector(focusSelector)
      if (next?.matches('[role="status"]')) next.tabIndex = -1
      next?.focus({ preventScroll: true })
    }
  }

  function renderAfterWait(nextAction) {
    // Leave focus in the header or settings when the user has moved there during a delay.
    render(app.contains(document.activeElement) ? nextAction : undefined)
  }

  function navigate() {
    const { page: name, city, year, origin } = locationInfo()
    const leavingPhoto = lastHash?.startsWith('#photo/')
    const previousStep = document.activeElement?.dataset.step
    pendingMapFocus = ''
    if (name !== 'add' || !city) {
      clearTimeout(uploadTimer)
      draft = null
    }
    render()
    if (lastHash !== null) {
      let focusTarget = app.querySelector('h1')
      let scrollTop = name === 'albums' ? library.scroll : 0
      if (name === 'map' && mapPosition && lastHash === cityUrl(mapPosition.city, 'map')) {
        scrollTop = mapPosition.scroll
        if (mapPosition.link.startsWith('map-choice-')) app.querySelector('.footprint-picker').open = true
        if (mapPosition.link.startsWith('map-pin-') && !app.querySelector('[data-action="retry-map"]')) {
          pendingMapFocus = mapPosition.link
        } else {
          focusTarget = app.querySelector('#' + mapPosition.link) || app.querySelector('.footprint-picker summary')
        }
      } else if (leavingPhoto && name === 'album' && city && albumPosition?.route === albumUrl(city.id, year, origin)) {
        focusTarget = Array.from(app.querySelectorAll('.photo-grid a')).find(link => link.hash === albumPosition.photo) || focusTarget
        scrollTop = albumPosition.scroll
      } else if (leavingPhoto && name === 'photo') {
        scrollTop = window.scrollY
        if (previousStep) {
          focusTarget = app.querySelector('.viewer-step[data-step="' + previousStep + '"]:enabled')
            || app.querySelector('.viewer-step:enabled') || app.querySelector('.viewer-return') || focusTarget
        }
      }
      if (focusTarget?.matches('h1')) focusTarget.tabIndex = -1
      focusTarget?.focus({ preventScroll: true })
      window.scrollTo(0, scrollTop)
    }
    lastHash = location.hash
  }

  function switchProfile(profile) {
    state.profile = profile
    persist()
    clearTimeout(uploadTimer)
    draft = null
    library = { text: '', year: '', scroll: 0 }
    albumPosition = null
    mapPosition = null
    pendingMapFocus = ''
    mapFailure.checked = false
    document.querySelector('#demo-controls').open = false
    if (location.hash === '#home') navigate()
    else location.hash = 'home'
  }

  app.addEventListener('input', event => {
    const field = event.target
    if (field.id === 'year-input') field.setCustomValidity('')
    if (field.id === 'library-search' || field.id === 'library-year') {
      library.text = app.querySelector('#library-search').value
      library.year = app.querySelector('#library-year').value
      app.querySelector('#library-results').innerHTML = albumList()
    }
    if (field.id === 'city-search') {
      const choices = [...app.querySelectorAll('[data-search]')]
      choices.forEach(choice => { choice.hidden = !choice.dataset.search.includes(field.value.trim()) })
      app.querySelector('#city-no-result').hidden = choices.some(choice => !choice.hidden)
    }
    if (field.id === 'unknown-year') {
      const yearInput = app.querySelector('#year-input')
      yearInput.disabled = field.checked
      yearInput.setCustomValidity('')
    }
  })

  app.addEventListener('click', event => {
    const mapLink = event.target.closest('a[data-map-city]')
    if (mapLink) mapPosition = { city: mapLink.dataset.mapCity, link: mapLink.id, scroll: window.scrollY }
    const photoLink = event.target.closest('.photo-grid a')
    if (photoLink) {
      const { city, year, origin } = locationInfo()
      albumPosition = { route: albumUrl(city.id, year, origin), photo: photoLink.hash, scroll: window.scrollY }
    }
    const button = event.target.closest('button')
    if (locationInfo().page === 'albums' && event.target.closest('a')) library.scroll = window.scrollY
    if (!button) return
    if (button.dataset.step) {
      stepPhoto(Number(button.dataset.step))
      return
    }
    const { city, year: routeYear, origin, via } = locationInfo()
    let nextFocus
    switch (button.dataset.action) {
      case 'clear-filters':
        library = { text: '', year: '', scroll: 0 }
        nextFocus = '#library-search'
        break
      case 'retry-map':
        mapFailure.checked = false
        nextFocus = '.footprint-picker summary'
        break
      case 'create': {
        const year = readYear()
        if (!year) return
        ensureAlbum(city.id, year)
        location.hash = albumUrl(city.id, year, origin)
        return
      }
      case 'queue': {
        const selected = app.querySelector('#sample-photo')
        if (!selected.value) {
          selected.required = true
          selected.reportValidity()
          return
        }
        const year = readYear()
        if (!year) return
        Object.assign(draft, { subject: selected.value, year, stage: 'queued' })
        nextFocus = '[data-action="upload"]'
        break
      }
      case 'upload':
      case 'upload-fail': {
        if (!['queued', 'failed'].includes(draft?.stage)) return
        ensureAlbum(draft.city, draft.year)
        draft.stage = 'uploading'
        nextFocus = '[role="status"]'
        const shouldFail = button.dataset.action === 'upload-fail'
        uploadTimer = setTimeout(() => {
          if (draft?.stage !== 'uploading') return
          draft.stage = shouldFail ? 'failed' : 'staged'
          renderAfterWait('[data-action="upload"], [data-action="save"]')
        }, 450)
        break
      }
      case 'save': {
        if (draft?.stage !== 'staged') return
        const album = ensureAlbum(draft.city, draft.year)
        const id = state.profile + '-' + Date.now().toString(36) + '-' + album.photos.length
        album.photos.push({ id, subject: draft.subject })
        draft.stage = 'saved'
        persist()
        nextFocus = '.actions a'
        break
      }
      case 'cancel':
        clearTimeout(uploadTimer)
        draft = null
        location.hash = importOrigin(city, routeYear, via, origin)
        return
      default: return
    }
    render(nextFocus)
  })

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!app.querySelector('.photo-viewer') || document.querySelector('#demo-controls').open) return
    if (!app.contains(event.target) && event.target !== document.body) return
    if (event.key === 'Escape') {
      event.preventDefault()
      app.querySelector('.viewer-return').click()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      stepPhoto(event.key === 'ArrowLeft' ? -1 : 1)
    }
  })

  document.querySelector('#demo-new').addEventListener('click', () => switchProfile('fresh'))
  document.querySelector('#demo-sample').addEventListener('click', () => switchProfile('sample'))
  mapFailure.addEventListener('change', () => {
    if (locationInfo().page === 'map') render()
  })
  window.addEventListener('hashchange', navigate)
  navigate()
})()
