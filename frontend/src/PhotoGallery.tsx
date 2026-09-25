import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'
import { OriginalImage } from './OriginalImage'

type Photo = {
  id: string; album_id: string; original_filename: string; width: number; height: number
  byte_size: number; position: number; revision: number; has_note: boolean; original_url: string
}
type PhotoPage = { items: Photo[]; next_cursor: string | null; album_revision: number; photo_count: number }
type Detail = Photo & { note: string; album_revision: number; previous_photo_id: string | null; next_photo_id: string | null; ordinal: number; photo_count: number }
const changed = (error: unknown) => error instanceof ApiError && error.code === 'ALBUM_CHANGED'

function PhotoViewer({ photoId, albumId, initialRevision, close, navigate }: {
  photoId: string; albumId: string; initialRevision?: number; close: () => void; navigate: (id: string) => void
}) {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const revision = useRef(initialRevision)
  const [read, setRead] = useState<{ id: string; data?: Detail; error?: unknown }>({ id: photoId })
  const [attempt, setAttempt] = useState(0)
  const data = read.id === photoId ? read.data : undefined
  const error = read.id === photoId ? read.error : undefined
  useEffect(() => {
    const element = dialog.current!
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const scroll = window.scrollY
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => {
      element.close()
      document.body.style.overflow = overflow
      previousFocus?.focus({ preventScroll: true })
      window.scrollTo({ top: scroll, behavior: 'instant' })
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({ album_id: albumId })
    if (revision.current !== undefined) query.set('expected_album_revision', String(revision.current))
    void api<Detail>(`/photos/${encodeURIComponent(photoId)}?${query}`, { signal: controller.signal }).then((value) => {
      revision.current = value.album_revision
      setRead({ id: photoId, data: value })
    }).catch((reason) => { if (!isAbort(reason)) setRead({ id: photoId, error: reason }) })
    return () => controller.abort()
  }, [photoId, albumId, attempt])
  function retry() {
    if (changed(error)) revision.current = undefined
    setRead({ id: photoId }); setAttempt((value) => value + 1)
  }
  function turn(id: string) {
    // Navigation controls disappear while the next metadata request is pending.
    // Keep focus in the persistent dialog so subsequent arrow/Escape keys work.
    dialog.current?.focus({ preventScroll: true })
    navigate(id)
  }
  return <dialog className="photo-viewer" ref={dialog} tabIndex={-1} aria-labelledby="viewer-title" onCancel={(event) => { event.preventDefault(); close() }} onKeyDown={(event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !data) return
    if (event.key === 'ArrowLeft' && data.previous_photo_id) { event.preventDefault(); turn(data.previous_photo_id) }
    if (event.key === 'ArrowRight' && data.next_photo_id) { event.preventDefault(); turn(data.next_photo_id) }
  }}>
    <header className="viewer-header"><div><p className="eyebrow">ORIGINAL · 原图</p><h2 id="viewer-title">{data?.original_filename ?? '查看原图'}</h2></div>
      <button className="quiet-button" autoFocus onClick={close}>关闭原图</button></header>
    {!data && !error && <p className="viewer-message" role="status">正在读取照片资料…</p>}
    {error !== undefined && <div className="viewer-message" role="alert"><p>{errorMessage(error)}</p>
      <button className="quiet-button" onClick={retry}>{changed(error) ? '重新核对照片' : '重试读取照片资料'}</button></div>}
    {data && <>
      <div className="viewer-image"><OriginalImage key={data.id} photoId={data.id} alt={`原图：${data.original_filename}`} immediate retryable /></div>
      <nav className="viewer-navigation" aria-label="照片前后浏览">
        <button className="quiet-button" disabled={!data.previous_photo_id} onClick={() => data.previous_photo_id && turn(data.previous_photo_id)}>← 上一张</button>
        <span aria-live="polite">第 {data.ordinal} / {data.photo_count} 张</span>
        <button className="quiet-button" disabled={!data.next_photo_id} onClick={() => data.next_photo_id && turn(data.next_photo_id)}>下一张 →</button>
      </nav>
      <p className="viewer-metadata">{data.width} × {data.height} 像素 · {(data.byte_size / 1024 / 1024).toFixed(2)} MiB · 原始文件，未压缩</p>
      {data.note && <p className="photo-note">{data.note}</p>}
    </>}
    <p className="scope-note">左右方向键切换，Esc 关闭；关闭后回到打开时的列表位置。</p>
  </dialog>
}

export function PhotoGallery({ albumId, savedPhotoId, onRead }: {
  albumId: string; savedPhotoId: string | null; onRead: (count: number, revision: number) => void
}) {
  const [search, setSearch] = useSearchParams()
  const photoId = search.get('photo')
  const [data, setData] = useState<PhotoPage | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const request = useRef<AbortController | null>(null)
  const section = useRef<HTMLElement | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    void api<PhotoPage>(`/albums/${albumId}/photos`, { signal: controller.signal }).then((value) => {
      setData(value); setError(undefined)
      onRead(value.photo_count, value.album_revision)
    }).catch((reason) => { if (!isAbort(reason)) setError(reason) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [albumId, reload, onRead])
  useEffect(() => () => request.current?.abort(), [])
  const close = useCallback(() => setSearch((value) => { value.delete('photo'); return value }, { replace: true }), [setSearch])
  function open(id: string, replace = false) {
    setSearch((value) => { value.set('photo', id); return value }, { replace })
  }
  async function more() {
    if (!data?.next_cursor || busy) return
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    setBusy(true); setError(undefined)
    try {
      const value = await api<PhotoPage>(`/albums/${albumId}/photos?cursor=${encodeURIComponent(data.next_cursor)}`, { signal: controller.signal })
      setData({ ...value, items: [...data.items, ...value.items] })
      onRead(value.photo_count, value.album_revision)
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function refresh() {
    setBusy(true); setError(undefined); setData(null); setReload((value) => value + 1)
    section.current?.scrollIntoView({ block: 'start' })
  }
  return <section className="photo-section" ref={section} aria-labelledby="photos-title">
    <div className="section-heading"><h2 id="photos-title">影集里的照片</h2><span>{data ? `已读取 ${data.items.length} / ${data.photo_count} 张` : '按保存顺序浏览'}</span></div>
    <div className="gallery-tools"><p className="scope-note">原图按需读取；点开查看完整画面，不生成缩略图。</p>
      {savedPhotoId && <button className="quiet-button" onClick={() => open(savedPhotoId)}>查看刚保存的照片</button>}</div>
    {error !== undefined && <div className="load-error" role="alert"><p>{errorMessage(error)}</p>
      {(!data || changed(error)) && <button className="quiet-button" disabled={busy} onClick={refresh}>重新加载照片列表</button>}</div>}
    {!data && busy && <p role="status">正在读取照片列表…</p>}
    {data && data.items.length === 0 && <div className="album-empty compact-empty"><h3>位置已经留好，故事慢慢填满。</h3><p>选好一张照片，确认保存后就能在这里重新打开。</p></div>}
    {data && <div className="photo-grid">{data.items.map((photo) => <article className="photo-card" key={photo.id} data-photo-id={photo.id}>
      <button className="photo-open" onClick={() => open(photo.id)} aria-label={`查看原图：${photo.original_filename}`}>
        <OriginalImage photoId={photo.id} alt={`原图：${photo.original_filename}`} suspended={!!photoId} />
        <span className="photo-caption"><strong>{photo.original_filename}</strong><small>{photo.width} × {photo.height}{photo.has_note ? ' · 有文字记录' : ''}</small></span>
      </button>
    </article>)}</div>}
    {data?.next_cursor && <button className="quiet-button more-button" disabled={busy || changed(error)} onClick={() => void more()}>{busy ? '正在读取…' : error ? '重试加载更多照片' : '加载更多照片'}</button>}
    {data && !data.next_cursor && data.items.length > 0 && <p className="gallery-end">这一年的回忆，都收在这里了。</p>}
    {photoId && <PhotoViewer photoId={photoId} albumId={albumId} initialRevision={data?.album_revision} close={close} navigate={(id) => open(id, true)} />}
  </section>
}
