import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'
import { OriginalImage } from './OriginalImage'
import { PhotoViewer } from './PhotoGallery'
import type { Album } from './Journal'
import type { Note, Photo } from './photos'

type Group = { group_id: string; total: number; photos: Photo[] }
type DuplicatePage = { items: Group[]; next_cursor: string | null; album_revision: number; group_count: number; photo_count: number }

export function Duplicates({ albumId }: { albumId: string }) {
  const [search, setSearch] = useSearchParams()
  const photoId = search.get('photo')
  const [album, setAlbum] = useState<Album | null>(null)
  const [data, setData] = useState<DuplicatePage | null>(null)
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    void Promise.all([
      api<Album>(`/albums/${albumId}`, { signal: controller.signal }),
      api<DuplicatePage>(`/albums/${albumId}/duplicates`, { signal: controller.signal }),
    ]).then(([a, d]) => { setAlbum(a); setData(d); setError(undefined) })
      .catch((reason) => { if (!isAbort(reason)) setError(reason) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => request.current?.abort()
  }, [albumId, attempt])
  async function more() {
    if (!data?.next_cursor || busy) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(undefined)
    try {
      const next = await api<DuplicatePage>(`/albums/${albumId}/duplicates?cursor=${encodeURIComponent(data.next_cursor)}`, { signal: controller.signal })
      const merged = data.items.map((group) => ({ ...group, photos: [...group.photos] }))
      for (const group of next.items) {
        const previous = merged.at(-1)
        if (previous?.group_id === group.group_id) previous.photos.push(...group.photos)
        else merged.push(group)
      }
      setData({ ...next, items: merged })
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function open(id: string | null, replace = false) {
    setSearch((value) => { const next = new URLSearchParams(value); if (id) next.set('photo', id); else next.delete('photo'); return next }, { replace })
  }
  function noteSaved(note: Note) {
    setData((value) => value ? { ...value, items: value.items.map((group) => ({ ...group, photos: group.photos.map((p) => p.id === note.id ? { ...p, revision: note.revision, has_note: note.has_note } : p) })) } : null)
  }
  const stale = error instanceof ApiError && error.code === 'ALBUM_CHANGED'
  return <main className="journal-main duplicates-page"><Link className="back-link" to={`/albums/${albumId}`}>← 返回影集，全部保留</Link>
    <div className="page-heading"><div><p className="eyebrow">KEEP EVERY MEMORY</p><h1>重复照片查看</h1>{album && <p className="muted">{album.city.name} · {album.year === null ? '未标年份' : `${album.year} 年`}</p>}</div></div>
    <p className="duplicate-explanation">只比较本影集内文件内容完全相同的照片，不按文件名或相似画面判断。每份原图和文字都独立保留，查看或离开不会合并、覆盖或删除。移入回收站前会再次确认，只影响你选中的这一份，30 天内可恢复。</p>
    {data && <p className="scope-note">{data.group_count} 组 · {data.photo_count} 张相同内容的照片；已读取 {data.items.reduce((sum, group) => sum + group.photos.length, 0)} 张。每次最多读取 24 条照片资料，原图按需加载。</p>}
    {error !== undefined && <div className="load-error" role="alert"><p>{errorMessage(error)}</p><button className="quiet-button" disabled={busy} onClick={() => { setBusy(true); setData(null); setError(undefined); setAttempt((n) => n + 1) }}>重新核对重复列表</button></div>}
    {busy && <p role="status">正在读取重复照片…</p>}
    {data?.items.length === 0 && <div className="empty-note">当前影集没有文件内容完全相同的有效照片。</div>}
    {data?.items.map((group, index) => <section className="duplicate-group" key={group.group_id} data-group-id={group.group_id}>
      <div className="section-heading"><h2>相同内容 · 第 {index + 1} 组</h2><span>共 {group.total} 份，已读取 {group.photos.length} 份</span></div>
      <div className="photo-grid">{group.photos.map((photo) => <article className="photo-card" key={photo.id} data-photo-id={photo.id}><button className="photo-open" onClick={() => open(photo.id)} aria-label={`查看重复原图：${photo.original_filename}`}>
        <OriginalImage photoId={photo.id} alt={`重复原图：${photo.original_filename}`} suspended={!!photoId} />
        <span className="photo-caption"><strong>{photo.original_filename}</strong><small>{photo.width} × {photo.height}{photo.has_note ? ' · 有文字记录' : ''}</small></span>
      </button><Link className="move-link" to={`/albums/${albumId}/move/${photo.id}`} aria-label={`移动照片：${photo.original_filename}`}>移动到其他影集 →</Link>
        <Link className="trash-link" to={`/albums/${albumId}/trash/${photo.id}`} aria-label={`删除照片：${photo.original_filename}`}>移入回收站</Link></article>)}</div>
    </section>)}
    {data?.next_cursor && <button className="quiet-button more-button" disabled={busy || stale} onClick={() => void more()}>{error ? '重试加载更多重复照片' : '加载更多重复照片'}</button>}
    {photoId && <PhotoViewer photoId={photoId} albumId={albumId} initialRevision={data?.album_revision} close={() => open(null, true)} navigate={(id) => open(id, true)} onNoteSaved={noteSaved} />}
  </main>
}
