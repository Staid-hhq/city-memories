import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'
import { OriginalImage } from './OriginalImage'
import { NoteEditor } from './NoteEditor'
import type { Detail, Note, Photo, PhotoPage } from './photos'

const changed = (error: unknown) => error instanceof ApiError && error.code === 'ALBUM_CHANGED'

function PhotoViewer({ photoId, albumId, initialRevision, close, navigate, onNoteSaved }: {
  photoId: string; albumId: string; initialRevision?: number; close: () => void; navigate: (id: string) => void; onNoteSaved: (note: Note) => void
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
    if (event.altKey || event.ctrlKey || event.metaKey || !data || (event.target instanceof HTMLElement && event.target.closest('textarea,input,select,[contenteditable="true"]'))) return
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
      <NoteEditor key={data.id} initial={data} onSaved={(note) => { setRead({ id: data.id, data: { ...data, ...note } }); onNoteSaved(note) }} />
    </>}
    <p className="scope-note">编辑框外可用左右方向键切换，Esc 关闭；未保存文字离开前需要确认。</p>
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
  const [sorting, setSorting] = useState(false)
  const [orderBlocked, setOrderBlocked] = useState(false)
  const [orderStatus, setOrderStatus] = useState('')
  const [movedId, setMovedId] = useState<string | null>(null)
  const dragged = useRef<Photo | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    void api<PhotoPage>(`/albums/${albumId}/photos`, { signal: controller.signal }).then((value) => {
      setData(value); setError(undefined)
      setOrderBlocked(false)
      onRead(value.photo_count, value.album_revision)
    }).catch((reason) => { if (!isAbort(reason)) setError(reason) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [albumId, reload, onRead])
  useEffect(() => () => request.current?.abort(), [])
  // Never mutate the current search object: navigation can be blocked by a draft.
  const close = useCallback(() => setSearch((value) => { const next = new URLSearchParams(value); next.delete('photo'); return next }, { replace: true }), [setSearch])
  function open(id: string, replace = false) {
    setSearch((value) => { const next = new URLSearchParams(value); next.set('photo', id); return next }, { replace })
  }
  const noteSaved = useCallback((note: Note) => {
    setData((current) => current ? { ...current, items: current.items.map((photo) => photo.id === note.id ? { ...photo, revision: note.revision, has_note: note.has_note } : photo) } : null)
  }, [])
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
  async function reorder(photo: Photo, kind: 'previous' | 'next' | 'first' | 'last' | 'before', before?: string) {
    if (!data || busy || orderBlocked) return
    const labels = { previous: '前移一位', next: '后移一位', first: '置顶', last: '置底', before: '移到目标照片之前' }
    const context = `${photo.original_filename}：${labels[kind]}`
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(true); setError(undefined); setMovedId(null); setOrderStatus(`正在调整 ${context}`)
    let committed = false
    try {
      let anchor: string | null = kind === 'first' ? data.items[0].id : before ?? null
      if (kind === 'previous' || kind === 'next') {
        const query = `album_id=${albumId}&expected_album_revision=${data.album_revision}`
        const detail = await api<Detail>(`/photos/${photo.id}?${query}`, { signal: controller.signal })
        if (kind === 'previous') {
          if (!detail.previous_photo_id) { setOrderStatus('已经是第一张，无需移动。'); return }
          anchor = detail.previous_photo_id
        } else {
          if (!detail.next_photo_id) { setOrderStatus('已经是最后一张，无需移动。'); return }
          const next = await api<Detail>(`/photos/${detail.next_photo_id}?${query}`, { signal: controller.signal })
          anchor = next.next_photo_id
        }
      }
      const result = await api<{ album_revision: number; changed: boolean }>(`/albums/${albumId}/reorder`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ photo_id: photo.id, before_photo_id: anchor, expected_album_revision: data.album_revision }),
      })
      committed = true
      setOrderStatus(result.changed ? `顺序已保存：${context}。原图和文字保持不变。` : '顺序未变化，无需重复移动。')
      setMovedId(photo.id)
      // Re-read only the previously loaded window. The server, not this partial
      // list, owns the complete ordering and neighbors across page boundaries.
      let fresh = await api<PhotoPage>(`/albums/${albumId}/photos`, { signal: controller.signal })
      while (fresh.next_cursor && fresh.items.length < data.items.length) {
        const next = await api<PhotoPage>(`/albums/${albumId}/photos?cursor=${encodeURIComponent(fresh.next_cursor)}`, { signal: controller.signal })
        fresh = { ...next, items: [...fresh.items, ...next.items] }
      }
      setData(fresh); onRead(fresh.photo_count, fresh.album_revision)
      requestAnimationFrame(() => { if (focus?.isConnected) focus.focus({ preventScroll: true }); else section.current?.focus({ preventScroll: true }) })
    } catch (reason) {
      if (!isAbort(reason)) {
        setError(reason); setOrderBlocked(true)
        setOrderStatus(`${committed ? '排序已保存，但列表刷新失败' : '排序结果未确认'}：${context}。请重新加载列表核对，再决定下一次操作；不会自动重放或覆盖。`)
      }
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <section className="photo-section" ref={section} tabIndex={-1} aria-labelledby="photos-title">
    <div className="section-heading"><h2 id="photos-title">影集里的照片</h2><span>{data ? `已读取 ${data.items.length} / ${data.photo_count} 张` : '按保存顺序浏览'}</span></div>
    <div className="gallery-tools"><p className="scope-note">原图按需读取；点开查看完整画面，不生成缩略图。</p>
      <div className="gallery-buttons">{savedPhotoId && <button className="quiet-button" onClick={() => open(savedPhotoId)}>查看刚保存的照片</button>}
        {!!data?.items.length && <button className="quiet-button" disabled={busy} onClick={() => setSorting(!sorting)}>{sorting ? '完成排序' : '整理顺序'}</button>}</div></div>
    {sorting && <p className="scope-note">拖动手柄到目标照片上方，或使用前移/后移、置顶/置底。操作针对完整影集，跨分页有效；每次成功后立即保存。需要更多目标时先加载下一批照片。</p>}
    {orderStatus && <div className="order-status" role="status"><p>{orderStatus}</p>{movedId && <button className="quiet-button" disabled={busy} onClick={() => open(movedId)}>查看刚调整的照片</button>}</div>}
    {error !== undefined && <div className="load-error" role="alert"><p>{errorMessage(error)}</p>
      {(!data || changed(error) || orderBlocked) && <button className="quiet-button" disabled={busy} onClick={refresh}>重新加载照片列表</button>}</div>}
    {!data && busy && <p role="status">正在读取照片列表…</p>}
    {data && data.items.length === 0 && <div className="album-empty compact-empty"><h3>位置已经留好，故事慢慢填满。</h3><p>选好一张照片，确认保存后就能在这里重新打开。</p></div>}
    {data && <div className="photo-grid">{data.items.map((photo, index) => <article className={`photo-card${dropTarget === photo.id ? ' drop-target' : ''}`} key={photo.id} data-photo-id={photo.id}
      onDragOver={(event) => { if (dragged.current && sorting && !busy && !orderBlocked) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(photo.id) } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
      onDrop={(event) => { event.preventDefault(); const source = dragged.current; dragged.current = null; setDropTarget(null); if (source && sorting) void reorder(source, 'before', photo.id) }}>
      <button className="photo-open" disabled={busy} onClick={() => open(photo.id)} aria-label={`查看原图：${photo.original_filename}`}>
        <OriginalImage photoId={photo.id} alt={`原图：${photo.original_filename}`} suspended={!!photoId} />
        <span className="photo-caption"><strong>{photo.original_filename}</strong><small>{photo.width} × {photo.height}{photo.has_note ? ' · 有文字记录' : ''}</small></span>
      </button>
      {sorting && <div className="photo-order-controls">
        <button className="drag-handle quiet-button" draggable={!busy && !orderBlocked} disabled={busy || orderBlocked} aria-label={`拖动排序：${photo.original_filename}`} title="拖到目标照片上方"
          onDragStart={(event) => { dragged.current = photo; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-city-memories-photo', photo.id) }}
          onDragEnd={() => { dragged.current = null; setDropTarget(null) }}>⠿ 拖动</button>
        <button className="quiet-button" disabled={busy || orderBlocked || index === 0} onClick={() => void reorder(photo, 'previous')}>前移一位</button>
        <button className="quiet-button" disabled={busy || orderBlocked || index === data.photo_count - 1} onClick={() => void reorder(photo, 'next')}>后移一位</button>
        <button className="quiet-button" disabled={busy || orderBlocked || index === 0} onClick={() => void reorder(photo, 'first')}>置顶</button>
        <button className="quiet-button" disabled={busy || orderBlocked || index === data.photo_count - 1} onClick={() => void reorder(photo, 'last')}>置底</button>
      </div>}
    </article>)}</div>}
    {data?.next_cursor && <button className="quiet-button more-button" disabled={busy || changed(error) || orderBlocked} onClick={() => void more()}>{busy ? '正在读取…' : error ? '重试加载更多照片' : '加载更多照片'}</button>}
    {data && !data.next_cursor && data.items.length > 0 && <p className="gallery-end">这一年的回忆，都收在这里了。</p>}
    {photoId && <PhotoViewer photoId={photoId} albumId={albumId} initialRevision={data?.album_revision} close={close} navigate={(id) => open(id, true)} onNoteSaved={noteSaved} />}
  </section>
}
