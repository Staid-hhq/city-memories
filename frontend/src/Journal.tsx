import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'
import type { User } from './api'
import { UploadPanel } from './UploadPanel'
import { BatchImport } from './BatchImport'
import { PhotoGallery } from './PhotoGallery'
import { OriginalImage } from './OriginalImage'

type City = { id: string; name: string; parent_name: string; unit_kind: string; can_create: boolean }
type Album = {
  id: string; city: City; year: number | null; revision: number; photo_count: number
  cover_photo_id: string | null; original_url: string | null
}
type PageData<T> = { items: T[]; next_cursor: string | null }
type CityAlbums = PageData<Album> & { city: City }
type Atlas = { items: { city: City; album_count: number; photo_count: number; lit: boolean }[]; album_count: number; photo_count: number }
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
  return { ...state, retry: () => { setState({ loading: true }); setAttempt((value) => value + 1) } }
}

function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const missing = error instanceof ApiError && error.status === 404
  return <div className="load-error" role="alert">
    <p>{missing ? '这里暂时无法打开，内容可能不存在或不属于当前账号。' : errorMessage(error)}</p>
    {!missing && <button className="quiet-button" onClick={retry}>重新加载</button>}
    {missing && <Link to="/">返回城市入口</Link>}
  </div>
}

function Paged<T>({ initial, path, children }: {
  initial: PageData<T>; path: string; children: (items: T[]) => React.ReactNode
}) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  async function more() {
    if (!data.next_cursor) return
    setBusy(true)
    setError(undefined)
    const controller = new AbortController()
    active.current = controller
    try {
      const next = await api<PageData<T>>(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.next_cursor)}`, { signal: controller.signal })
      setData({ items: [...data.items, ...next.items], next_cursor: next.next_cursor })
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <>{children(data.items)}
    {error !== undefined && <p className="form-error" role="alert">{errorMessage(error)}</p>}
    {data.next_cursor && <button className="quiet-button more-button" disabled={busy} onClick={() => void more()}>{busy ? '正在加载…' : '加载更多'}</button>}
  </>
}

function CitySearch({ query }: { query: string }) {
  const path = `/cities?q=${encodeURIComponent(query)}`
  const result = useResource<PageData<City>>(path)
  if (result.loading) return <p role="status">正在查找城市…</p>
  if (!result.data) return <LoadError error={result.error} retry={result.retry} />
  return <Paged initial={result.data} path={path}>{(items) => items.length ?
    <div className="city-grid">{items.map((city) => <Link className="city-card" key={city.id} to={`/cities/${city.id}`}>
      <span className="city-initial" aria-hidden="true">{city.name[0]}</span>
      <span><strong>{city.name}</strong><small>{city.parent_name} · 地级城市</small></span>
      <span className="card-arrow" aria-hidden="true">↗</span>
    </Link>)}</div> : <div className="empty-note" role="status">当前开放的城市中没有“{query}”。试试深圳、广州或贺州。</div>
  }</Paged>
}

function Home({ user }: { user: User }) {
  const atlas = useResource<Atlas>('/me/atlas')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  function search(event: FormEvent) { event.preventDefault(); setQuery(input.trim()) }
  return <main className="journal-main">
    <div className="page-heading"><div><p className="eyebrow">YOUR TRAVEL JOURNAL</p><h1>你好，{user.username}</h1>
      <p className="muted">从一座城市开始，给每一年的回忆留个位置。</p></div><span className="chapter-mark">第一章 / 城市</span></div>
    <section className="journal-section" aria-labelledby="my-cities-title">
      <div className="section-heading"><h2 id="my-cities-title">我的城市手帐</h2>{atlas.data && <span>{atlas.data.items.length} 座城市 · {atlas.data.album_count} 本影集 · {atlas.data.photo_count} 张照片</span>}</div>
      {atlas.loading ? <p role="status">正在读取你的手帐…</p> : !atlas.data ? <LoadError error={atlas.error} retry={atlas.retry} /> :
        atlas.data.items.length ? <div className="saved-cities">{atlas.data.items.map((item) => <Link key={item.city.id} className="saved-city" to={`/cities/${item.city.id}`}>
          <strong>{item.city.name}</strong><span>{item.album_count} 本影集 · {item.photo_count} 张照片</span>
          <small>{item.lit ? '已有旅行照片' : '空影集 · 尚未点亮'}{!item.city.can_create ? ' · 暂停新建' : ''}</small>
        </Link>)}</div> : <div className="empty-note"><strong>你的第一本手帐，还在等一个目的地。</strong><p>先选一座城市，再创建年份影集。没有照片也可以先留好位置。</p></div>}
    </section>
    <section className="journal-section" aria-labelledby="choose-city-title">
      <div className="section-heading"><h2 id="choose-city-title">选择一座城市</h2><span>已核对的首批城市</span></div>
      <form className="search-form" onSubmit={search}>
        <label className="sr-only" htmlFor="city-search">搜索城市</label>
        <input id="city-search" type="search" maxLength={80} placeholder="搜索城市或所属地区，例如 深圳" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="quiet-button" type="submit">搜索</button>
        {query && <button className="quiet-button" type="button" onClick={() => { setInput(''); setQuery('') }}>查看全部</button>}
      </form>
      <CitySearch key={query} query={query} />
      <p className="scope-note">目前开放深圳、广州、贺州三个城市，尚非全国目录。全国地图将在后续接入；空影集不会点亮城市。</p>
    </section>
  </main>
}

function NewAlbum({ city }: { city: City }) {
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
      navigate(`/albums/${result.id}`)
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

function CityPage({ cityId }: { cityId: string }) {
  const path = `/cities/${encodeURIComponent(cityId)}/albums`
  const result = useResource<CityAlbums>(path)
  return <main className="journal-main">
    <Link className="back-link" to="/">← 返回城市入口</Link>
    {result.loading ? <p role="status">正在翻开城市手帐…</p> : !result.data ? <LoadError error={result.error} retry={result.retry} /> : <>
      <div className="page-heading"><div><p className="eyebrow">{result.data.city.parent_name} · 城市手帐</p><h1>{result.data.city.name}</h1><p className="muted">按年份翻开回忆，未标年份收在最后。</p></div><span className="chapter-mark">第二章 / 年份</span></div>
      {result.data.city.can_create && <Link className="batch-entry" to={`/cities/${cityId}/import`}>批量导入原图 <span>核对年份，分组放入影集 →</span></Link>}
      <div className="years-layout"><section aria-labelledby="years-title"><div className="section-heading"><h2 id="years-title">我的年份影集</h2><span>从新到旧</span></div>
        <Paged initial={result.data} path={path}>{(items) => items.length ? <div className="album-grid">{items.map((album) => <Link className="album-card" key={album.id} to={`/albums/${album.id}`}>
          <div className="album-cover" aria-hidden="true">{album.cover_photo_id ? <OriginalImage photoId={album.cover_photo_id} alt="" /> : <><span>{album.year ?? '…'}</span><i>TRAVEL MEMORIES</i></>}</div>
          <div className="album-caption"><strong>{album.year === null ? '未标年份' : `${album.year} 年`}</strong><span>{album.photo_count} 张照片</span></div>
        </Link>)}</div> : <div className="empty-note"><strong>这座城市，还没有你的年份影集。</strong><p>在右侧选一个年份，或留下“未标年份”的位置。</p></div>}</Paged>
      </section><NewAlbum city={result.data.city} /></div>
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
    <Link className="back-link" to={`/cities/${album.city.id}`}>← 返回{album.city.name}年份影集</Link>
    <div className="page-heading"><div><p className="eyebrow">{album.city.name} · 私人影集</p><h1>{album.year === null ? '未标年份' : `${album.year} 年`}</h1><p className="muted">{album.photo_count} 张照片 · 已保存的年份影集</p></div><span className="chapter-mark">第三章 / 影集</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <Link className="batch-entry" to={`/albums/${album.id}/import`}>批量导入原图 <span>全部加入当前影集 →</span></Link>
    <UploadPanel albumId={album.id} cityName={album.city.name} year={album.year} onSaved={saved} />
    <PhotoGallery key={refreshKey} albumId={album.id} savedPhotoId={savedPhotoId} onRead={readPhotos} />
  </main>
}

function CityRoute() { const { cityId = '' } = useParams(); return <CityPage key={cityId} cityId={cityId} /> }
function AlbumRoute() { const { albumId = '' } = useParams(); return <AlbumPage key={albumId} albumId={albumId} /> }

function ImportPage({ cityId, albumId }: { cityId?: string; albumId?: string }) {
  const result = useResource<Album | CityAlbums>(albumId ? `/albums/${albumId}` : `/cities/${cityId}/albums`)
  if (result.loading) return <main className="journal-main"><p role="status">正在打开批量导入…</p></main>
  if (!result.data) return <main className="journal-main"><LoadError error={result.error} retry={result.retry} /></main>
  const data = result.data
  return <main className="journal-main"><Link className="back-link" to={albumId ? `/albums/${albumId}` : `/cities/${cityId}`}>← 返回{albumId ? '年份影集' : '城市手帐'}</Link>
    <BatchImport cityId={data.city.id} cityName={data.city.name} albumId={albumId} year={'year' in data ? data.year : undefined} />
  </main>
}
function ImportRoute() { const { cityId, albumId } = useParams(); return <ImportPage key={cityId ?? albumId} cityId={cityId} albumId={albumId} /> }

export function Journal({ user, onLogout }: { user: User; onLogout: () => void }) {
  return <div className="home-page"><header className="home-header"><Link to="/" className="brand-link"><span className="wordmark">城影记</span><small>CITY MEMORIES</small></Link>
    <div className="account-menu"><span>{user.username}</span><button className="quiet-button" onClick={onLogout}>退出登录</button></div>
  </header><Routes><Route path="/" element={<Home user={user} />} /><Route path="/cities/:cityId" element={<CityRoute />} /><Route path="/albums/:albumId" element={<AlbumRoute />} /><Route path="/cities/:cityId/import" element={<ImportRoute />} /><Route path="/albums/:albumId/import" element={<ImportRoute />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></div>
}
