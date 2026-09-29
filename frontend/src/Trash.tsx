import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'
import { OriginalImage } from './OriginalImage'
import type { Album, City } from './Journal'
import type { Detail, Photo } from './photos'

type TrashPhoto = Omit<Photo, 'position'> & {
  city: City; year: number | null; album_revision: number; deleted_at: number
  purge_after: number; remaining_ms: number
}
type TrashDetail = TrashPhoto & { note: string }
type TimedPhoto = TrashPhoto & { until: number }
type TrashPage = { items: TrashPhoto[]; next_cursor: string | null; photo_count: number }
type Context = { kind: 'active'; photo: Detail; album: Album } | { kind: 'trashed'; photo: TrashDetail; until: number }

const place = (data: { city: City; year: number | null }) => `${data.city.name} · ${data.year === null ? '未标年份' : `${data.year} 年`}`
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const remainingText = (ms: number) => ms <= 0 ? '保留期限已到' : ms < 60_000 ? '剩余不足 1 分钟' : ms < 86_400_000 ? `剩余约 ${Math.ceil(ms / 3_600_000)} 小时` : `剩余约 ${Math.ceil(ms / 86_400_000)} 天`

// Use the server's duration, not the user's wall clock. Start at request dispatch
// so network latency cannot extend the displayed retention period.
function useRemaining(until?: number) {
  const [tick, setTick] = useState(() => performance.now())
  useEffect(() => {
    if (until === undefined) return
    let timer: ReturnType<typeof setTimeout>
    const update = () => {
      clearTimeout(timer)
      const now = performance.now()
      setTick(now)
      if (until > now) timer = setTimeout(update, Math.min(1000, until - now))
    }
    timer = setTimeout(update, 0)
    document.addEventListener('visibilitychange', update)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update) }
  }, [until])
  return until === undefined ? Infinity : Math.max(0, until - tick)
}

function TrashCard({ photo }: { photo: TimedPhoto }) {
  const remaining = useRemaining(photo.until)
  return <article className="photo-card trash-card" data-photo-id={photo.id}>
    {remaining > 0 ? <Link className="photo-open" to={`/trash/photos/${photo.id}`} aria-label={`查看与恢复：${photo.original_filename}`}>
      <OriginalImage photoId={photo.id} alt={`回收站原图：${photo.original_filename}`} scope="trash" />
      <span className="photo-caption"><strong>{photo.original_filename}</strong><small>{place(photo)}{photo.has_note ? ' · 有文字记录' : ''}</small></span>
    </Link> : <p className="photo-caption">{photo.original_filename} · 保留期限已到，不能查看或恢复。</p>}
    <div className="trash-deadline"><strong>{remainingText(remaining)}</strong><span>截止 {date(photo.purge_after)}（本地时间）</span>
      {remaining > 0 && <Link to={`/trash/photos/${photo.id}`}>查看与恢复 →</Link>}</div>
  </article>
}

export function Trash() {
  const [items, setItems] = useState<TimedPhoto[]>([])
  const [data, setData] = useState<TrashPage | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const request = useRef<AbortController | null>(null)
  const load = useCallback(async (cursor?: string) => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(undefined)
    if (!cursor) { setItems([]); setData(null) }
    const started = performance.now()
    try {
      const next = await api<TrashPage>(`/trash/photos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal })
      const timed = next.items.map((p) => ({ ...p, until: started + p.remaining_ms }))
      setItems((old) => cursor ? [...old, ...timed] : timed); setData(next)
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }, [])
  useEffect(() => { void load(); return () => request.current?.abort() }, [load])
  const stale = error instanceof ApiError && error.code === 'TRASH_CHANGED'
  return <main className="journal-main trash-page"><Link className="back-link" to="/">← 返回城市入口</Link>
    <div className="page-heading"><div><p className="eyebrow">A LITTLE TIME TO RECONSIDER</p><h1>回收站</h1><p className="muted">给回忆留一次反悔的机会。</p></div><button className="quiet-button" disabled={busy} onClick={() => void load()}>重新加载回收站</button></div>
    <p className="duplicate-explanation">照片从删除时起保留 30 天。期限内可查看原图、文字，并恢复到删除时所在影集的末尾；到期后不能再查看或恢复。这里只显示你的照片，不会自动合并重复内容。</p>
    {data && <p className="scope-note">已读取 {items.length} / {data.photo_count} 张 · 按删除时间从新到旧；数量为本次读取时的记录。</p>}
    {error !== undefined && <div className="load-error" role="alert">{errorMessage(error)}{stale && <p>请重新加载回收站，不会自动重放操作。</p>}</div>}
    {busy && <p role="status">正在读取回收站…</p>}
    {data?.photo_count === 0 && <div className="empty-note"><h2>回收站是空的</h2><p>没有仍在保留期限内的照片。</p></div>}
    <div className="photo-grid">{items.map((p) => <TrashCard key={`${p.id}:${p.revision}`} photo={p} />)}</div>
    {data?.next_cursor && <button className="quiet-button more-button" disabled={busy || stale} onClick={() => void load(data.next_cursor!)}>{error ? '重试加载更多回收站照片' : '加载更多回收站照片'}</button>}
  </main>
}

export function PhotoLifecycle({ photoId, albumId, action }: { photoId: string; albumId?: string; action: 'trash' | 'restore' }) {
  const [context, setContext] = useState<Context | null>(null)
  const [busy, setBusy] = useState(true)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState('')
  const [savedAlbum, setSavedAlbum] = useState<string>()
  const [duplicateCount, setDuplicateCount] = useState(0)
  const request = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setBusy(true); setContext(null); setError(undefined); setNotice(''); setDuplicateCount(0)
    const started = performance.now()
    try {
      let next: Context
      try {
        const photo = await api<TrashDetail>(`/trash/photos/${photoId}`, { signal: controller.signal })
        next = { kind: 'trashed', photo, until: started + photo.remaining_ms }
      } catch (reason) {
        if (!(reason instanceof ApiError && reason.code === 'PHOTO_NOT_TRASHED')) throw reason
        const photo = await api<Detail>(`/photos/${photoId}`, { signal: controller.signal })
        const album = await api<Album>(`/albums/${photo.album_id}`, { signal: controller.signal })
        next = { kind: 'active', photo, album }
      }
      setContext(next); setBlocked(false)
    } catch (reason) { if (!isAbort(reason)) { setError(reason); setBlocked(true) } }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }, [photoId])
  useEffect(() => { void load(); return () => request.current?.abort() }, [load])
  const remaining = useRemaining(context?.kind === 'trashed' ? context.until : undefined)
  const expired = remaining <= 0 || (error instanceof ApiError && error.status === 410)
  const canAct = context && !expired && !blocked && (action === 'trash'
    ? context.kind === 'active' && context.photo.album_id === albumId
    : context.kind === 'trashed')
  async function submit() {
    if (!context || !canAct || busy) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(undefined)
    const started = performance.now()
    try {
      const { photo } = context
      const body = JSON.stringify({ expected_photo_revision: photo.revision, expected_album_revision: photo.album_revision })
      if (action === 'trash') {
        const result = await api<TrashDetail>(`/photos/${photoId}/trash`, { method: 'POST', body, signal: controller.signal })
        setContext({ kind: 'trashed', photo: result, until: started + result.remaining_ms })
        setNotice('已移入回收站。只删除了选中的这一份，其他照片和空影集仍然保留。')
      } else {
        const result = await api<{ duplicate_count: number }>(`/trash/photos/${photoId}/restore`, { method: 'POST', body, signal: controller.signal })
        // Clear the old image immediately. Read current location separately; a
        // failed read must never trigger a second restore request.
        setSavedAlbum(photo.album_id); setContext(null); setBlocked(true)
        setDuplicateCount(result.duplicate_count)
        setNotice('恢复已保存。请打开原影集查看，或核对当前状态。')
      }
    } catch (reason) {
      if (!isAbort(reason)) { setError(reason); setBlocked(true); setNotice('操作结果尚未确认。请核对当前状态，再决定是否操作；不会自动重试。') }
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const photo = context?.photo
  const originalAlbum = context?.photo.album_id ?? savedAlbum ?? albumId
  return <main className="journal-main lifecycle-page"><Link className="back-link" to={action === 'trash' ? `/albums/${albumId}` : '/trash'}>{action === 'trash' ? '← 返回影集，取消删除' : '← 返回回收站'}</Link>
    <div className="page-heading"><div><p className="eyebrow">{action === 'trash' ? 'ONLY THIS PHOTO' : 'WELCOME BACK'}</p><h1>{action === 'trash' ? '确认移入回收站' : '查看与恢复'}</h1><p className="muted">{action === 'trash' ? '请核对照片；只有按下确认按钮后才会删除。' : '原图和文字原样保留，不需要重新上传。'}</p></div></div>
    {busy && <p role="status">正在核对照片状态…</p>}
    {notice && <p className="order-status" role="status">{notice}</p>}
    {duplicateCount > 1 && <p className="order-status">原影集内有 {duplicateCount} 份相同内容，全部独立保留，没有自动去重。<Link to={`/albums/${savedAlbum}/duplicates`}>查看重复照片</Link></p>}
    {error !== undefined && <p className="load-error" role="alert">{errorMessage(error)}</p>}
    {expired && <p className="empty-note" role="status">保留期限已到，不能再查看原图或恢复。</p>}
    {photo && context && <section className="lifecycle-content" aria-label="选中的照片">
      {!expired && !blocked && <div className="lifecycle-image"><OriginalImage key={`${context.kind}:${photo.id}`} photoId={photo.id} alt={`选中的原图：${photo.original_filename}`} scope={context.kind === 'trashed' ? 'trash' : 'active'} immediate retryable /></div>}
      <div className="lifecycle-details"><h2>{photo.original_filename}</h2><p>{place(context.kind === 'active' ? context.album : context.photo)}</p><p className="muted">{photo.width} × {photo.height} 像素 · 原始文件，未压缩</p>
        {!expired && <><h3>照片文字</h3><p className="preserved-note">{photo.note || '这张照片还没有文字记录。'}</p></>}
        {context.kind === 'trashed' ? <><p className="trash-deadline">删除于 {date(context.photo.deleted_at)}<br />截止 {date(context.photo.purge_after)}（本地时间）<br /><strong>{remainingText(remaining)}</strong></p>
          {action === 'trash' && <><p>照片当前在回收站中，不会重复删除或延长保留期限。</p><Link className="quiet-button" to={`/trash/photos/${photo.id}`}>查看回收站中的照片</Link></>}
        </> : action === 'restore' || photo.album_id !== albumId ? <p>照片当前已在{photo.album_id !== albumId && action === 'trash' ? '另一个' : ''}影集中。请先查看当前位置。</p> : <p className="duplicate-explanation">只将这一份照片和它的文字移入回收站。同内容的其他照片不受影响。30 天内可恢复到这个影集的末尾；到期后不能查看或恢复。空影集仍会保留。</p>}
        {canAct && <button className={action === 'trash' ? 'danger-button' : 'primary-button'} disabled={busy} onClick={() => void submit()}>{action === 'trash' ? '确认移入回收站' : '恢复到原影集末尾'}</button>}
        {context.kind === 'active' && (action === 'restore' || photo.album_id !== albumId) && <Link className="quiet-button" to={`/albums/${photo.album_id}?photo=${photo.id}`}>查看照片当前位置</Link>}
      </div>
    </section>}
    <div className="lifecycle-actions"><button className="quiet-button" disabled={busy} onClick={() => void load()}>核对当前状态</button>
      {originalAlbum && <Link className="quiet-button" to={`/albums/${originalAlbum}`}>打开原影集</Link>}<Link className="quiet-button" to="/trash">打开回收站</Link></div>
  </main>
}
