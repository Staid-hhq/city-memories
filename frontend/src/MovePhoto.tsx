import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { api, errorMessage, isAbort } from './api'
import { OriginalImage } from './OriginalImage'
import type { Album, City } from './Journal'
import type { Detail, Photo } from './photos'

type Page<T> = { items: T[]; next_cursor: string | null }
type MoveResult = { photo: Photo; source_album_id: string; source_revision: number; target_album_id: string; target_revision: number; target_duplicate_count: number }
const albumLabel = (album: Album) => `${album.city.name} · ${album.year === null ? '未标年份' : `${album.year} 年`}`

function TargetAlbums({ cityId, sourceId, onChoose }: { cityId: string; sourceId: string; onChoose: (album: Album) => void }) {
  const [data, setData] = useState<(Page<Album> & { city: City }) | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [year, setYear] = useState('')
  const [unmarked, setUnmarked] = useState(false)
  const request = useRef<AbortController | null>(null)
  async function load(more = false) {
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    setBusy(true); setError('')
    try {
      const next = await api<Page<Album> & { city: City }>(`/cities/${cityId}/albums${more && data?.next_cursor ? `?cursor=${encodeURIComponent(data.next_cursor)}` : ''}`, { signal: controller.signal })
      setData(more && data ? { ...next, items: [...data.items, ...next.items] } : next)
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    void api<Page<Album> & { city: City }>(`/cities/${cityId}/albums`, { signal: controller.signal }).then(setData)
      .catch((reason) => { if (!isAbort(reason)) setError(errorMessage(reason)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => request.current?.abort()
  }, [cityId])
  async function create(event: FormEvent) {
    event.preventDefault()
    if (!unmarked && (!/^\d{1,4}$/.test(year) || Number(year) < 1)) { setError('请输入 1–9999 的整数年份，或选择未标年份。'); return }
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try {
      const album = await api<Album>(`/cities/${cityId}/albums`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ year: unmarked ? null : Number(year) }) })
      if (album.id === sourceId) setError('这是原影集，请选择另一个年份或城市。')
      else { await load(); onChoose(album) }
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason) + ' 创建结果不明时可重试同一年份，不会重复新建。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <div className="target-albums">
    {busy && <p role="status">正在读取或准备目标影集…</p>}
    {error && <div role="alert" className="form-error"><p>{error}</p><button className="quiet-button" disabled={busy} onClick={() => void load(!!data)}>重试读取年份</button></div>}
    {data && <><div className="target-year-list">{data.items.filter((a) => a.id !== sourceId).map((album) => <button key={album.id} className="quiet-button" disabled={busy} onClick={() => onChoose(album)}>{album.year === null ? '未标年份' : `${album.year} 年`} · {album.photo_count} 张</button>)}</div>
      {!data.items.some((a) => a.id !== sourceId) && <p className="scope-note">这一页没有其他年份影集，可继续加载或先创建。</p>}
      {data.next_cursor && <button className="quiet-button" disabled={busy} onClick={() => void load(true)}>加载更多目标年份</button>}
      {data.city.can_create && <form className="target-create" onSubmit={create}><h3>没有目标年份？先创建</h3>
        <label htmlFor="target-year">目标年份</label><input id="target-year" inputMode="numeric" maxLength={4} value={year} disabled={busy || unmarked} onChange={(event) => setYear(event.target.value)} placeholder="例如 2026" />
        <label className="checkbox-label"><input type="checkbox" checked={unmarked} disabled={busy} onChange={(event) => setUnmarked(event.target.checked)} />目标未标年份</label>
        <button className="quiet-button" disabled={busy}>创建并选择目标影集</button>
        <p className="scope-note">相同年份使用原影集；新建后即使取消移动，空影集也会保留。此步不移动照片。</p>
      </form>}
    </>}
  </div>
}

function TargetPicker({ sourceId, onChoose }: { sourceId: string; onChoose: (album: Album) => void }) {
  const [cities, setCities] = useState<Page<City> | null>(null)
  const [cityId, setCityId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    void Promise.all([
      api<Page<City>>('/cities?limit=100', { signal: controller.signal }),
      api<{ items: { city: City }[] }>('/me/atlas', { signal: controller.signal }),
    ]).then(([available, saved]) => {
      const unique = new Map([...available.items, ...saved.items.map((item) => item.city)].map((city) => [city.id, city]))
      setCities({ ...available, items: [...unique.values()] }); setError('')
    }).catch((reason) => { if (!isAbort(reason)) setError(errorMessage(reason)) })
    return () => request.current?.abort()
  }, [attempt])
  async function more() {
    if (!cities?.next_cursor) return
    const controller = new AbortController(); request.current = controller; setBusy(true)
    try {
      const next = await api<Page<City>>(`/cities?limit=100&cursor=${encodeURIComponent(cities.next_cursor)}`, { signal: controller.signal })
      setCities({ ...next, items: [...new Map([...cities.items, ...next.items].map((city) => [city.id, city])).values()] }); setError('')
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <section><h2>选择目标城市与年份</h2>
    {error && <p className="form-error" role="alert">{error} <button className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>重试读取城市</button></p>}
    {!cities && !error && <p role="status">正在读取可选城市…</p>}
    {cities && <><label htmlFor="move-city">目标城市</label><select id="move-city" value={cityId} onChange={(event) => setCityId(event.target.value)}><option value="">请选择城市</option>{cities.items.map((city) => <option key={city.id} value={city.id}>{city.name} · {city.parent_name}</option>)}</select>
      {cities.next_cursor && <button className="quiet-button" disabled={busy} onClick={() => void more()}>加载更多目标城市</button>}
      {cityId && <TargetAlbums key={cityId} cityId={cityId} sourceId={sourceId} onChoose={onChoose} />}
    </>}
  </section>
}

export function MovePhoto({ albumId, photoId }: { albumId: string; photoId: string }) {
  const [photo, setPhoto] = useState<Detail | null>(null)
  const [source, setSource] = useState<Album | null>(null)
  const [target, setTarget] = useState<Album | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [result, setResult] = useState<MoveResult | null>(null)
  const [current, setCurrent] = useState<Album | null>(null)
  const [attempt, setAttempt] = useState(0)
  const request = useRef<AbortController | null>(null)
  const confirmPanel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    void Promise.all([
      api<Detail>(`/photos/${photoId}?album_id=${albumId}`, { signal: controller.signal }),
      api<Album>(`/albums/${albumId}`, { signal: controller.signal }),
    ]).then(([p, a]) => { setPhoto(p); setSource(a); setError('') })
      .catch((reason) => { if (!isAbort(reason)) setError(errorMessage(reason)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => request.current?.abort()
  }, [albumId, photoId, attempt])
  useEffect(() => { if (target) { confirmPanel.current?.focus(); confirmPanel.current?.scrollIntoView({ block: 'nearest' }) } }, [target])
  async function choose(album: Album) {
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setNotice(''); setTarget(null)
    try { setTarget(await api<Album>(`/albums/${album.id}`, { signal: controller.signal })) }
    catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason) + ' 请重新选择目标影集。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function submit() {
    if (!photo || !target || busy || blocked || result || current) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      setResult(await api<MoveResult>(`/photos/${photoId}/move`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ target_album_id: target.id, expected_photo_revision: photo.revision, expected_source_revision: photo.album_revision, expected_target_revision: target.revision }) }))
    } catch (reason) { if (!isAbort(reason)) { setError(errorMessage(reason) + ' 移动结果未确认，请先核对当前位置，不会自动重试。'); setBlocked(true) } }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function reconcile() {
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('')
    try {
      const p = await api<Detail>(`/photos/${photoId}`, { signal: controller.signal })
      const a = await api<Album>(`/albums/${p.album_id}`, { signal: controller.signal })
      if (p.album_id !== albumId) {
        setCurrent(a); setNotice(`已核对：照片当前位于 ${albumLabel(a)}。请打开当前位置查看，不会再次移动。`)
      } else {
        const latestTarget = target ? await api<Album>(`/albums/${target.id}`, { signal: controller.signal }) : null
        setPhoto(p); setSource(a); setTarget(latestTarget); setBlocked(false)
        setNotice('已核对最新位置、文字与影集版本；照片仍在原影集。请检查下方信息，再明确确认移动。')
      }
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason) + ' 尚未核对成功，原选择仍保留。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <main className="journal-main move-page"><Link className="back-link" to={`/albums/${albumId}`}>← 返回原影集</Link>
    <div className="page-heading"><div><p className="eyebrow">A DIFFERENT CHAPTER</p><h1>移动到其他影集</h1><p className="muted">只改变归属，原图、文件名和已保存文字保持不变。</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {busy && <p role="status">正在核对或保存，请稍候…</p>}
    {notice && <p className="staged-notice" role="status">{notice}</p>}
    {(!photo || !source) && !busy && <div className="upload-actions"><button className="quiet-button" onClick={() => { setBusy(true); setAttempt((n) => n + 1) }}>重试读取移动资料</button><button className="quiet-button" onClick={() => void reconcile()}>核对照片当前位置</button></div>}
    {current && <Link className="batch-entry" to={`/albums/${current.id}?photo=${photoId}`}>打开当前位置：{albumLabel(current)}</Link>}
    {photo && source && <>
      <div className="move-summary"><div className="move-preview"><OriginalImage photoId={photoId} alt={`待移动原图：${photo.original_filename}`} /></div><div><h2>{photo.original_filename}</h2><p>原影集：{albumLabel(source)}</p><p className="photo-note">{photo.note || '（没有文字记录）'}</p></div></div>
      {result && target ? <section className="move-result" role="status"><h2>移动已保存</h2><p>已移到 {albumLabel(target)} 的末尾，原图和文字均保留。原影集即使变空也不会删除。</p>
        {result.target_duplicate_count > 1 && <p>目标影集内有 {result.target_duplicate_count} 份相同内容，已全部保留，没有自动去重。</p>}
        <div className="upload-actions"><Link className="quiet-button" to={`/albums/${albumId}`}>留在原影集</Link><Link className="quiet-button" to={`/albums/${target.id}?photo=${photoId}`}>打开目标影集中的照片</Link><Link className="quiet-button" to={`/albums/${target.id}/duplicates`}>查看目标影集重复照片</Link></div>
      </section> : !current && <>
        <fieldset className="move-picker" disabled={busy || blocked}><TargetPicker sourceId={albumId} onChoose={(album) => void choose(album)} /></fieldset>
        {target && <div className="move-confirm" ref={confirmPanel} tabIndex={-1}><h2>核对这次移动</h2><p>{albumLabel(source)} → <strong>{albumLabel(target)}</strong>（末尾）</p><p className="scope-note">目标目前 {target.photo_count} 张；相同内容也正常保留。确认成功后才算完成，离开页面不会撤销已发出的移动。</p><button className="primary-button" disabled={busy || blocked} onClick={() => void submit()}>确认移动到目标影集末尾</button></div>}
        {blocked && <button className="quiet-button" disabled={busy} onClick={() => void reconcile()}>核对照片当前位置和版本</button>}
      </>}
    </>}
  </main>
}
