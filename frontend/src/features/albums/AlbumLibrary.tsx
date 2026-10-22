import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, errorMessage, isAbort } from '../../shared/api'
import { OriginalImage } from '../photos/OriginalImage'
import type { Album } from './types'

type AlbumPage = { items: Album[]; next_cursor: string | null }
export type AlbumLibraryMemory = { count: number; scrollY: number }

export function AlbumCard({ album, origin, onOpen }: {
  album: Album; origin?: string; onOpen?: () => void
}) {
  return <Link className="album-card" to={`/albums/${album.id}`} state={{ albumOrigin: origin }} onClick={onOpen}>
    <div className={`album-cover${album.cover_photo_id ? ' has-cover' : ''}`} aria-hidden="true">
      {album.cover_photo_id ? <OriginalImage photoId={album.cover_photo_id} alt="" /> : <div className="album-cover-empty"><span>{album.city.name[0]}</span><i>CITY MEMORIES</i></div>}
      <div className="album-cover-title"><small>{album.city.name}</small><span>{album.year === null ? '未标年份' : `${album.year} 年`}</span></div>
    </div>
    <div className="album-caption"><strong>{album.year === null ? '未标年份' : `${album.year} 年`}</strong><span>{album.photo_count} 张照片</span></div>
    {origin === '/albums' && <p className="album-city-name">{album.city.name}<span aria-hidden="true">↗</span></p>}
  </Link>
}

export function AlbumLibrary({ memory }: { memory: AlbumLibraryMemory }) {
  const [data, setData] = useState<AlbumPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>()
  const [failedMore, setFailedMore] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const active = useRef<AbortController | null>(null)
  const desiredCount = useRef(memory.count)
  const restoreScroll = useRef(memory.scrollY)
  const pendingScroll = useRef<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    active.current?.abort(); active.current = controller
    async function load() {
      try {
        let fresh = await api<AlbumPage>('/me/albums', { signal: controller.signal })
        // Rebuild the previously opened window from fresh account-scoped data.
        // Remember positions only in this account's mounted Journal, never storage.
        while (fresh.next_cursor && fresh.items.length < desiredCount.current) {
          const next = await api<AlbumPage>(`/me/albums?cursor=${encodeURIComponent(fresh.next_cursor)}`, { signal: controller.signal })
          fresh = { ...next, items: [...fresh.items, ...next.items] }
        }
        pendingScroll.current = restoreScroll.current
        setData(fresh); setError(undefined); memory.count = fresh.items.length
      } catch (reason) { if (!isAbort(reason)) setError(reason) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [attempt, memory])

  useLayoutEffect(() => {
    if (!data || pendingScroll.current === null) return
    // Restore only after React commits the cards and their final layout height.
    window.scrollTo({ top: pendingScroll.current, behavior: 'instant' })
    pendingScroll.current = null
  }, [data])

  useEffect(() => () => active.current?.abort(), [])

  useEffect(() => {
    const refresh = () => {
      desiredCount.current = memory.count; restoreScroll.current = window.scrollY
      setLoading(true); setError(undefined); setFailedMore(false); setAttempt(value => value + 1)
    }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    const channel = new BroadcastChannel('city-memories-data')
    channel.onmessage = refresh
    window.addEventListener('city-memories:data-changed', refresh)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      channel.close(); window.removeEventListener('city-memories:data-changed', refresh)
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible)
    }
  }, [memory])

  async function more() {
    if (!data?.next_cursor || loading) return
    const controller = new AbortController()
    active.current?.abort(); active.current = controller
    setLoading(true); setError(undefined); setFailedMore(true)
    try {
      const next = await api<AlbumPage>(`/me/albums?cursor=${encodeURIComponent(data.next_cursor)}`, { signal: controller.signal })
      const fresh = { ...next, items: [...data.items, ...next.items] }
      setData(fresh); memory.count = fresh.items.length; desiredCount.current = fresh.items.length
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }

  function retry() {
    setLoading(true); setError(undefined); setFailedMore(false); restoreScroll.current = window.scrollY
    setAttempt(value => value + 1)
  }

  return <main className="journal-main album-library">
    <div className="page-heading"><div><p className="eyebrow">A COLLECTION OF MOMENTS</p><h1>我的相册</h1>
      <p className="muted">从一张封面，翻开一座城市、一年的回忆。</p></div>
      <Link className="quiet-button" to="/#choose-city-title">选择城市，创建影集</Link>
    </div>
    {error !== undefined && <div className="load-error" role="alert"><p>{errorMessage(error)}</p>
      <button className="quiet-button" disabled={loading} onClick={failedMore ? () => void more() : retry}>{failedMore ? '重试加载更多相册' : '重新加载相册'}</button></div>}
    {!data && loading && <p role="status">正在翻开你的相册…</p>}
    {data && !data.items.length && <div className="album-empty"><h2>第一本相册，从一座城市开始。</h2><p>选好城市，创建年份影集，再把喜欢的照片放进去。</p>
      <Link className="quiet-button" to="/#choose-city-title">选择一座城市</Link></div>}
    {data && <div className="album-grid library-grid">{data.items.map(album => <AlbumCard key={album.id} album={album} origin="/albums" onOpen={() => { memory.scrollY = window.scrollY }} />)}</div>}
    {data?.next_cursor && <button className="quiet-button more-button" disabled={loading} onClick={() => void more()}>{loading ? '正在读取…' : '加载更多相册'}</button>}
    {data && !data.next_cursor && data.items.length > 0 && <p className="gallery-end">每一段回忆，都有自己的位置。</p>}
  </main>
}
