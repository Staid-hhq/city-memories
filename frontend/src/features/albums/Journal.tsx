import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from '../../shared/api'
import type { User } from '../../shared/api'
import { UploadPanel } from '../imports/UploadPanel'
import { BatchImport } from '../imports/BatchImport'
import { PhotoGallery } from '../photos/PhotoGallery'
import { MovePhoto } from '../photos/MovePhoto'
import { Duplicates } from '../photos/Duplicates'
import { PhotoLifecycle, Trash } from '../trash/Trash'
import { CityMap } from '../map/CityMap'
import type { MapMemory } from '../map/CityMap'
import { MapService } from '../map/mapService'
import type { Album, Atlas, City } from './types'
import { AlbumCard, AlbumLibrary } from './AlbumLibrary'
import { HomeSidebar } from './HomeSidebar'
import type { AlbumLibraryMemory } from './AlbumLibrary'

type PageData<T> = { items: T[]; next_cursor: string | null }
type CityAlbums = PageData<Album> & { city: City }
type PageMemory = { read: () => { count: number; scrollY: number }; write: (value: { count: number; scrollY: number }) => void }
type Load<T> = { data?: T; error?: unknown; loading: boolean }

// Components are keyed by route/query and account. Unmount cancels requests;
// the API generation guard also rejects responses belonging to an old session.
function useResource<T>(path: string) {
  const [state, setState] = useState<Load<T>>({ loading: true })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api<T>(path, { signal: controller.signal }).then((data) => {
      setState({ data, loading: false })
    }).catch((error: unknown) => {
      if (!isAbort(error)) setState({ error, loading: false })
    })
    return () => controller.abort()
  }, [path, attempt])
  const retry = useCallback(() => { setState({ loading: true }); setAttempt((value) => value + 1) }, [])
  return { ...state, retry }
}

function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const missing = error instanceof ApiError && error.status === 404
  return <div className="load-error" role="alert">
    <p>{missing ? '这里暂时无法打开，内容可能不存在或不属于当前账号。' : errorMessage(error)}</p>
    {!missing && <button className="quiet-button" onClick={retry}>重新加载</button>}
    {missing && <Link to="/">返回城市入口</Link>}
  </div>
}

function Paged<T>({ initial, path, memory, children }: {
  initial: PageData<T>; path: string; memory?: PageMemory; children: (items: T[]) => React.ReactNode
}) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState(!!memory)
  const [restoring, setRestoring] = useState(!!memory)
  const [restoreFailed, setRestoreFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<unknown>()
  const active = useRef<AbortController | null>(null)
  const pendingScroll = useRef<number | null>(null)
  useEffect(() => {
    if (!memory) return
    const controller = new AbortController()
    active.current = controller
    const saved = memory.read()
    setBusy(true); setRestoring(true); setError(undefined)
    void (async () => {
      try {
        let fresh = initial
        // Rebuild the previously opened year window from current account data.
        while (fresh.next_cursor && fresh.items.length < saved.count) {
          const next = await api<PageData<T>>(`${path}?cursor=${encodeURIComponent(fresh.next_cursor)}`, { signal: controller.signal })
          fresh = { ...next, items: [...fresh.items, ...next.items] }
        }
        if (controller.signal.aborted) return
        pendingScroll.current = saved.scrollY
        memory.write({ count: fresh.items.length, scrollY: saved.scrollY })
        setData({ ...fresh }); setRestoreFailed(false)
      } catch (reason) { if (!isAbort(reason)) { setError(reason); setRestoreFailed(true) } }
      finally { if (!controller.signal.aborted) { setBusy(false); setRestoring(false) } }
    })()
    return () => controller.abort()
  }, [initial, path, memory, attempt])
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return
    window.scrollTo({ top: pendingScroll.current, behavior: 'instant' })
    pendingScroll.current = null
  }, [data])
  useEffect(() => () => active.current?.abort(), [])
  async function more() {
    if (!data.next_cursor) return
    setBusy(true)
    setError(undefined)
    const controller = new AbortController()
    active.current = controller
    try {
      const next = await api<PageData<T>>(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.next_cursor)}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      const fresh = { items: [...data.items, ...next.items], next_cursor: next.next_cursor }
      setData(fresh)
      if (memory) memory.write({ ...memory.read(), count: fresh.items.length })
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <>{restoring ? <p role="status">正在翻开年份影集…</p> : children(data.items)}
    {error !== undefined && <div className="form-error" role="alert"><p>{errorMessage(error)}</p>
      {restoreFailed && <button className="quiet-button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新加载年份影集</button>}</div>}
    {!restoring && !restoreFailed && data.next_cursor && <button className="quiet-button more-button" disabled={busy} onClick={() => void more()}>{busy ? '正在加载…' : '加载更多'}</button>}
  </>
}

function CitySearch({ query }: { query: string }) {
  const isDefault = !query
  const path = isDefault ? '/cities?view=province-centers&limit=100' : `/cities?q=${encodeURIComponent(query)}`
  const result = useResource<PageData<City>>(path)
  if (result.loading) return <p role="status">正在查找城市…</p>
  if (!result.data) return <LoadError error={result.error} retry={result.retry} />
  function description(city: City) {
    if (isDefault && city.unit_kind === 'prefecture') return city.parent_name?.endsWith('自治区') ? '首府' : '省会'
    if (isDefault && city.unit_kind === 'taiwan-destination') return '省会'
    return { prefecture: '地级城市', municipality: '直辖市', 'special-region': '特别行政区', 'direct-admin-unit': '省直辖县级单位', 'taiwan-destination': '台湾地区市县' }[city.unit_kind] ?? '已审核目的地'
  }
  return <Paged initial={result.data} path={path}>{(items) => items.length ?
    <div className="city-grid">{items.map((city) => <Link className="city-card" key={city.id} to={`/cities/${city.id}`}>
      <span className="city-initial" aria-hidden="true">{city.name[0]}</span>
      <span><strong>{city.name}</strong><small>{city.parent_name ?? city.name} · {description(city)}</small></span>
      <span className="card-arrow" aria-hidden="true">↗</span>
    </Link>)}</div> : <div className="empty-note" role="status">{isDefault ? '暂时没有可选的省会入口，请搜索城市或稍后重试。' : <>当前开放的城市中没有“{query}”。试试城市全称或所属地区；待映射城市暂未开放。</>}</div>
  }</Paged>
}

function Home({ user, service, memory }: { user: User; service: MapService; memory: MapMemory }) {
  const location = useLocation()
  const main = useRef<HTMLElement>(null)
  useEffect(() => {
    if (location.hash !== '#choose-city-title') return
    const element = main.current, target = document.getElementById('choose-city-title')
    if (!element || !target) return
    // A short loading page limits the first scroll; realign as content arrives until the user takes over.
    let frame: number | undefined, stopped = false
    const align = () => {
      if (stopped) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = undefined; if (!stopped) target.scrollIntoView({ block: 'start', behavior: 'instant' }) })
    }
    const observer = new ResizeObserver(align)
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    const stop = () => {
      stopped = true
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      for (const type of inputs) window.removeEventListener(type, interact, true)
    }
    const interact = (event: Event) => { if (event.isTrusted) stop() }
    observer.observe(element)
    for (const type of inputs) window.addEventListener(type, interact, { capture: true, passive: true })
    align()
    return stop
  }, [location.key, location.hash])
  const atlas = useResource<Atlas>('/me/atlas')
  const recent = useResource<PageData<Album>>('/me/albums?sort=recent&limit=3')
  const refreshAtlas = atlas.retry
  const refreshRecent = recent.retry
  useEffect(() => {
    const channel = new BroadcastChannel('city-memories-data')
    const refresh = () => { refreshAtlas(); refreshRecent() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    channel.onmessage = refresh
    window.addEventListener('city-memories:data-changed', refresh)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => { channel.close(); window.removeEventListener('city-memories:data-changed', refresh); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [refreshAtlas, refreshRecent])
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  function search(event: FormEvent) { event.preventDefault(); setQuery(input.trim()) }
  return <main ref={main} className="journal-main map-home">
    <div className="page-heading"><div><p className="eyebrow">YOUR TRAVEL JOURNAL</p><h1>你好，{user.username}</h1>
      <p className="muted">从一座城市开始，给每一年的回忆留个位置。</p></div><span className="chapter-mark">第一章 / 城市</span></div>
    <div className="home-overview-grid"><CityMap service={service} memory={memory} atlas={atlas.data} />
      <HomeSidebar atlas={atlas.data} loading={atlas.loading} retryAtlas={refreshAtlas} recent={recent} /></div>
    <section className="journal-section" aria-labelledby="my-cities-title">
      <div className="section-heading"><h2 id="my-cities-title">我的城市相册</h2>{atlas.data && <span>{atlas.data.items.length} 本城市相册 · {atlas.data.album_count} 本年份影集 · {atlas.data.photo_count} 张照片</span>}</div>
      {atlas.loading ? <p role="status">正在读取你的手帐…</p> : !atlas.data ? <LoadError error={atlas.error} retry={atlas.retry} /> :
        atlas.data.items.length ? <div className="saved-cities">{atlas.data.items.map((item) => <Link key={item.city.id} className="saved-city" to={`/cities/${item.city.id}`}>
          <strong>{item.city.name}</strong><span>{item.album_count} 本年份影集 · {item.photo_count} 张照片</span>
          <small>{item.lit ? '已有旅行照片' : '暂无照片 · 尚未点亮'}{!item.city.can_create ? ' · 暂停新建' : ''}</small>
        </Link>)}</div> : <div className="empty-note"><strong>你的第一本手帐，还在等一个目的地。</strong><p>先选一座城市，再创建年份影集。没有照片也可以先留好位置。</p></div>}
    </section>
    <section className="journal-section" aria-labelledby="choose-city-title">
      <div className="section-heading"><h2 id="choose-city-title">选择一座城市</h2><span>{query ? '全国城市搜索结果' : '各省级地区入口 · 城市拼音 A–Z'}</span></div>
      <form className="search-form" onSubmit={search}>
        <label className="sr-only" htmlFor="city-search">搜索城市</label>
        <input id="city-search" type="search" maxLength={80} placeholder="搜索城市或所属地区，例如 深圳" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="quiet-button" type="submit">搜索</button>
        {query && <button className="quiet-button" type="button" onClick={() => { setInput(''); setQuery('') }}>返回省会列表</button>}
      </form>
      {!query && <p className="field-help">每个省级地区一个入口，展示省会、自治区首府及直辖市、港澳。其他城市可在上方搜索。</p>}
      <CitySearch key={query} query={query} />
      <p className="scope-note">城市搜索独立于地图服务；仅开放已审核映射，空影集不会点亮城市。草湖市等待地图供应商映射，暂未开放。</p>
    </section>
  </main>
}

function NewAlbum({ city, cityAlbumOrigin }: { city: City; cityAlbumOrigin?: string }) {
  const navigate = useNavigate()
  const [year, setYear] = useState('')
  const [unmarked, setUnmarked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!unmarked && (!/^\d{1,4}$/.test(year) || Number(year) < 1)) {
      setError('请输入 1–9999 的整数年份，或选择未标年份。'); return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError('')
    try {
      const result = await api<Album & { created: boolean }>(`/cities/${city.id}/albums`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ year: unmarked ? null : Number(year) }),
      })
      navigate(`/albums/${result.id}`, { state: { albumOrigin: `/cities/${city.id}`, cityAlbumOrigin } })
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  if (!city.can_create) return <p className="scope-note">这个城市暂时停止新建影集，已有影集仍可查看。</p>
  return <aside className="create-panel"><p className="eyebrow">A NEW CHAPTER</p><h2>留下一年的位置</h2>
    <p className="muted">还没有照片，也可以先建一本空影集。</p>
    <form onSubmit={submit} aria-busy={busy}>
      <label htmlFor="album-year">影集年份</label>
      <input id="album-year" inputMode="numeric" maxLength={4} placeholder="例如 2026" value={year} disabled={unmarked || busy} onChange={(event) => setYear(event.target.value)} aria-describedby="year-help" />
      <label className="checkbox-label"><input type="checkbox" checked={unmarked} disabled={busy} onChange={(event) => setUnmarked(event.target.checked)} />未标年份</label>
      <p id="year-help" className="field-help">相同年份会直接进入已有影集，不会覆盖。未标年份只保留一本。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy} type="submit">{busy ? '正在保存…' : '创建或进入影集'}<span aria-hidden="true">→</span></button>
    </form>
  </aside>
}

function CityPage({ cityId, memory }: { cityId: string; memory: PageMemory }) {
  const location = useLocation()
  const cityAlbumOrigin = location.state?.cityAlbumOrigin === '/albums' ? '/albums' : undefined
  const path = `/cities/${encodeURIComponent(cityId)}/albums`
  const result = useResource<CityAlbums>(path)
  return <main className="journal-main">
    <Link className="back-link" to={cityAlbumOrigin ?? '/'}>{cityAlbumOrigin ? '← 返回我的相册' : '← 返回城市入口'}</Link>
    {result.loading ? <p role="status">正在翻开城市手帐…</p> : !result.data ? <LoadError error={result.error} retry={result.retry} /> : <>
      <div className="page-heading"><div><p className="eyebrow">{result.data.city.parent_name ?? result.data.city.name} · 城市相册</p><h1>{result.data.city.name}</h1><p className="muted">这座城市的每一年，都有一个影集。未标年份收在最后。</p></div><span className="chapter-mark">第二章 / 年份影集</span></div>
      {result.data.city.can_create && <Link className="batch-entry" to={`/cities/${cityId}/import`} state={location.state}>批量导入原图 <span>核对年份，分组放入影集 →</span></Link>}
      <div className="years-layout"><section aria-labelledby="years-title"><div className="section-heading"><h2 id="years-title">我的年份影集</h2><span>从新到旧</span></div>
        <Paged initial={result.data} path={path} memory={memory}>{(items) => items.length ? <div className="album-grid">{items.map((album) => <AlbumCard key={album.id} album={album} origin={`/cities/${cityId}`} cityAlbumOrigin={cityAlbumOrigin} onOpen={() => memory.write({ ...memory.read(), scrollY: window.scrollY })} />)}</div> : <div className="empty-note"><strong>这座城市，还没有你的年份影集。</strong><p>在右侧选一个年份，或留下“未标年份”的位置。</p></div>}</Paged>
      </section><NewAlbum city={result.data.city} cityAlbumOrigin={cityAlbumOrigin} /></div>
    </>}
  </main>
}

function AlbumPage({ albumId }: { albumId: string }) {
  const result = useResource<Album>(`/albums/${encodeURIComponent(albumId)}`)
  if (result.loading) return <main className="journal-main"><p role="status">正在打开影集…</p></main>
  if (!result.data) return <main className="journal-main"><LoadError error={result.error} retry={result.retry} /></main>
  return <AlbumContent initial={result.data} />
}

function AlbumContent({ initial }: { initial: Album }) {
  const location = useLocation()
  const [origin] = useState<unknown>(() => location.state?.albumOrigin)
  const [cityAlbumOrigin] = useState(() => location.state?.cityAlbumOrigin === '/albums' ? '/albums' : undefined)
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [initial.id])
  const [album, setAlbum] = useState(initial)
  const [savedPhotoId, setSavedPhotoId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const readPhotos = useCallback((count: number, revision: number) => {
    setAlbum((value) => ({ ...value, photo_count: count, revision }))
  }, [])
  const [error, setError] = useState('')
  const refreshRequest = useRef<AbortController | null>(null)
  useEffect(() => () => refreshRequest.current?.abort(), [])
  const saved = useCallback((id: string) => {
    setSavedPhotoId(id); setRefreshKey((value) => value + 1); setError('')
    refreshRequest.current?.abort()
    const controller = new AbortController()
    refreshRequest.current = controller
    void api<Album>(`/albums/${initial.id}`, { signal: controller.signal }).then(setAlbum)
      .catch((reason) => { if (!isAbort(reason)) setError('图片已保存，但影集数量刷新失败，请重新打开影集。') })
  }, [initial.id])
  return <main className="journal-main">
    <Link className="back-link" to={origin === '/albums' ? '/albums' : origin === '/' ? '/' : `/cities/${album.city.id}`} state={cityAlbumOrigin ? { cityAlbumOrigin } : undefined}>{origin === '/albums' ? '← 返回我的相册' : origin === '/' ? '← 返回首页' : `← 返回${album.city.name}年份影集`}</Link>
    <div className="page-heading"><div><p className="eyebrow">{album.city.name} · 私人影集</p><h1>{album.year === null ? '未标年份' : `${album.year} 年`}</h1><p className="muted">{album.photo_count} 张照片 · 已保存的年份影集</p></div><span className="chapter-mark">第三章 / 影集</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <Link className="batch-entry" to={`/albums/${album.id}/import`} state={location.state}>批量导入原图 <span>全部加入当前影集 →</span></Link>
    <UploadPanel albumId={album.id} cityName={album.city.name} year={album.year} onSaved={saved} />
    <PhotoGallery key={refreshKey} albumId={album.id} savedPhotoId={savedPhotoId} onRead={readPhotos} coverPhotoId={album.cover_photo_id} onAlbumChanged={setAlbum} />
  </main>
}

function CityRoute({ memory }: { memory: (id: string) => PageMemory }) { const { cityId = '' } = useParams(); return <CityPage key={cityId} cityId={cityId} memory={memory(cityId)} /> }
function AlbumRoute() { const { albumId = '' } = useParams(); return <AlbumPage key={albumId} albumId={albumId} /> }
function MoveRoute() { const { albumId = '', photoId = '' } = useParams(); return <MovePhoto key={`${albumId}:${photoId}`} albumId={albumId} photoId={photoId} /> }
function DuplicatesRoute() { const { albumId = '' } = useParams(); return <Duplicates key={albumId} albumId={albumId} /> }
function TrashPhotoRoute({ action }: { action: 'trash' | 'restore' }) { const { albumId, photoId = '' } = useParams(); return <PhotoLifecycle key={`${action}:${albumId}:${photoId}`} photoId={photoId} albumId={albumId} action={action} /> }

function ImportPage({ cityId, albumId }: { cityId?: string; albumId?: string }) {
  const location = useLocation()
  const result = useResource<Album | CityAlbums>(albumId ? `/albums/${albumId}` : `/cities/${cityId}/albums`)
  if (result.loading) return <main className="journal-main"><p role="status">正在打开批量导入…</p></main>
  if (!result.data) return <main className="journal-main"><LoadError error={result.error} retry={result.retry} /></main>
  const data = result.data
  return <main className="journal-main"><Link className="back-link" to={albumId ? `/albums/${albumId}` : `/cities/${cityId}`} state={location.state}>← 返回{albumId ? '年份影集' : '城市手帐'}</Link>
    <BatchImport cityId={data.city.id} cityName={data.city.name} albumId={albumId} year={'year' in data ? data.year : undefined} />
  </main>
}
function ImportRoute() { const { cityId, albumId } = useParams(); return <ImportPage key={cityId ?? albumId} cityId={cityId} albumId={albumId} /> }

export function Journal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const location = useLocation()
  const [libraryMemory] = useState<AlbumLibraryMemory>(() => {
    let saved: ReturnType<AlbumLibraryMemory['read']> = { count: 0, scrollY: 0 }
    return { read: () => saved, write: next => { saved = next } }
  })
  const [cityMemories] = useState(() => {
    const cities = new Map<string, PageMemory>()
    return (id: string): PageMemory => {
      const existing = cities.get(id)
      if (existing) return existing
      let saved = { count: 0, scrollY: 0 }
      const entry: PageMemory = { read: () => saved, write: value => { saved = value } }
      cities.set(id, entry)
      return entry
    }
  })
  const [service] = useState(() => new MapService())
  const [memory] = useState<MapMemory>(() => {
    let view: ReturnType<MapMemory['read']>
    return { read: () => view, write: next => { view = next } }
  })
  const albumActive = location.pathname.startsWith('/albums') || location.pathname.startsWith('/cities/')
  return <div className="home-page"><header className="home-header"><Link to="/" className="brand-link"><span className="wordmark">城影记</span><small>CITY MEMORIES</small></Link>
    <nav className="journal-nav" aria-label="主导航"><Link to="/" aria-current={location.pathname === '/' ? 'page' : undefined}>城市地图</Link><Link to="/albums" aria-current={albumActive ? 'page' : undefined}>我的相册</Link></nav>
    <div className="account-menu"><Link className="quiet-button" to="/trash">回收站</Link><span>{user.username}</span><button className="quiet-button" onClick={onLogout}>退出登录</button></div>
  </header><Routes><Route path="/" element={<Home user={user} service={service} memory={memory} />} /><Route path="/albums" element={<AlbumLibrary memory={libraryMemory} />} /><Route path="/cities/:cityId" element={<CityRoute memory={cityMemories} />} /><Route path="/albums/:albumId" element={<AlbumRoute />} /><Route path="/cities/:cityId/import" element={<ImportRoute />} /><Route path="/albums/:albumId/import" element={<ImportRoute />} /><Route path="/albums/:albumId/move/:photoId" element={<MoveRoute />} /><Route path="/albums/:albumId/duplicates" element={<DuplicatesRoute />} /><Route path="/albums/:albumId/trash/:photoId" element={<TrashPhotoRoute action="trash" />} /><Route path="/trash" element={<Trash />} /><Route path="/trash/photos/:photoId" element={<TrashPhotoRoute action="restore" />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></div>
}
