import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { api, errorMessage, isAbort } from '../../shared/api'
import { OriginalImage } from '../photos/OriginalImage'
import type { Album, CityAlbum } from './types'

type AlbumPage = { items: CityAlbum[]; next_cursor: string | null }
type AlbumFilters = { q: string; year: string; sort: 'year' | 'recent' }
const defaultFilters: AlbumFilters = { q: '', year: '', sort: 'year' }
type AlbumLibraryState = { count: number; scrollY: number; filters?: AlbumFilters }
export type AlbumLibraryMemory = { read: () => AlbumLibraryState; write: (next: AlbumLibraryState) => void }

function sameFilters(left: AlbumFilters, right: AlbumFilters) {
  return left.q === right.q && left.year === right.year && left.sort === right.sort
}

function albumPath(filters: AlbumFilters, cursor?: string) {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.year) params.set('year', filters.year)
  if (filters.sort !== 'year') params.set('sort', filters.sort)
  if (cursor) params.set('cursor', cursor)
  return `/me/city-albums${params.size ? `?${params}` : ''}`
}

export function AlbumCard({ album, origin, cityAlbumOrigin, onOpen }: {
  album: Album; origin?: string; cityAlbumOrigin?: string; onOpen?: () => void
}) {
  const year = album.year === null ? '未标年份' : `${album.year} 年`
  return <Link className="album-card year-album-card" to={`/albums/${album.id}`} state={{ albumOrigin: origin, cityAlbumOrigin }} onClick={onOpen}
    aria-label={`${album.city.name}，${year}，${album.photo_count} 张照片，打开相册`}>
    <div className={`album-cover${album.cover_photo_id ? ' has-cover' : ''}`} aria-hidden="true">
      {album.cover_photo_id ? <OriginalImage photoId={album.cover_photo_id} alt="" /> : <div className="album-cover-empty"><span>{album.city.name[0]}</span><i>等待第一张照片</i></div>}
    </div>
    <div className="album-card-info">
      <div className="album-caption"><strong>{year}</strong><span>{album.photo_count} 张照片</span></div>
      <p className="album-city-name" title={album.city.name}><span className="album-city-label">{album.city.name}</span><span className="album-card-arrow" aria-hidden="true">↗</span></p>
    </div>
  </Link>
}

function CityAlbumCard({ collection, onOpen }: { collection: CityAlbum; onOpen: () => void }) {
  const { city, album_count: albums, photo_count: photos, cover_photo_id: cover } = collection
  return <Link className="album-card city-album-card" to={`/cities/${city.id}`} state={{ cityAlbumOrigin: '/albums' }} onClick={onOpen}
    aria-label={`${city.name}，${albums} 本年份影集，${photos} 张照片，打开城市相册`}>
    <div className={`album-cover${cover ? ' has-cover' : ''}`} aria-hidden="true">
      {cover ? <OriginalImage photoId={cover} alt="" /> : <div className="album-cover-empty"><span>{city.name[0]}</span><i>等待第一张照片</i></div>}
    </div>
    <div className="album-card-info">
      <p className="album-city-name" title={city.name}><span className="album-city-label">{city.name}</span><span className="album-card-arrow" aria-hidden="true">↗</span></p>
      <div className="album-caption"><strong>{albums} 本年份影集</strong><span>{photos} 张照片</span></div>
    </div>
  </Link>
}

export function AlbumLibrary({ memory }: { memory: AlbumLibraryMemory }) {
  const [filters, setFilters] = useState<AlbumFilters>(() => ({ ...(memory.read().filters ?? defaultFilters) }))
  const [input, setInput] = useState(filters.q)
  const [years, setYears] = useState<{ data?: (number | null)[]; loading: boolean; error?: unknown }>({ loading: true })
  const [yearsAttempt, setYearsAttempt] = useState(0)
  const refreshYears = useCallback(() => {
    setYears(current => ({ ...current, loading: true, error: undefined }))
    setYearsAttempt(value => value + 1)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void api<{ years: (number | null)[] }>('/me/albums/options', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setYears({ data: result.years, loading: false })
    }).catch(error => { if (!isAbort(error)) setYears(current => ({ ...current, error, loading: false })) })
    return () => controller.abort()
  }, [yearsAttempt])
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') refreshYears() }
    const channel = new BroadcastChannel('city-memories-data')
    channel.onmessage = refreshYears
    window.addEventListener('city-memories:data-changed', refreshYears)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      channel.close(); window.removeEventListener('city-memories:data-changed', refreshYears)
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible)
    }
  }, [refreshYears])

  function apply(next: AlbumFilters) {
    setInput(next.q)
    if (sameFilters(next, filters)) return
    memory.write({ filters: { ...next }, count: 0, scrollY: 0 })
    setFilters(next)
  }
  function search(event: FormEvent) { event.preventDefault(); apply({ ...filters, q: input.trim() }) }
  const availableYears = (years.data ?? []).filter((year): year is number => year !== null)
  if (filters.year && filters.year !== 'unmarked' && !availableYears.includes(Number(filters.year))) availableYears.push(Number(filters.year))
  const changed = !sameFilters(filters, defaultFilters) || !!input
  return <main className="journal-main album-library">
    <div className="page-heading"><div><p className="eyebrow">A COLLECTION OF MOMENTS</p><h1>我的相册</h1>
      <p className="muted">一座城市，一本相册；每一年的回忆，都收在里面。</p></div>
      <Link className="quiet-button" to="/#choose-city-title">选择城市，创建影集</Link>
    </div>
    <form className="album-filters" aria-label="查找相册" onSubmit={search}>
      <div className="album-filter-search"><label htmlFor="album-city-search">搜索相册城市</label><div>
        <input id="album-city-search" type="search" maxLength={80} placeholder="城市或所属地区，例如 深圳" value={input} onChange={event => setInput(event.target.value)} />
        <button className="quiet-button" type="submit">搜索相册</button></div></div>
      <div className="album-filter-field"><label htmlFor="album-year-filter">筛选相册年份</label>
        <select id="album-year-filter" value={filters.year} aria-busy={years.loading} onChange={event => apply({ ...filters, q: input.trim(), year: event.target.value })}>
          <option value="">全部年份</option><option value="unmarked">未标年份</option>
          {years.loading && !years.data && <option value="loading" disabled>正在读取年份…</option>}
          {availableYears.map(year => <option key={year} value={year}>{year} 年</option>)}
        </select></div>
      <div className="album-filter-field"><label htmlFor="album-sort">相册排序</label>
        <select id="album-sort" value={filters.sort} onChange={event => apply({ ...filters, q: input.trim(), sort: event.target.value as AlbumFilters['sort'] })}>
          <option value="year">最新影集年份</option><option value="recent">最近整理</option>
        </select></div>
      {changed && <button className="quiet-button clear-album-filters" type="button" onClick={() => apply({ ...defaultFilters })}>清除筛选</button>}
    </form>
    {filters.year && <p className="album-filter-scope">显示包含{filters.year === 'unmarked' ? '未标年份' : `${filters.year} 年`}影集的城市；数量与封面包含这个城市的全部年份。</p>}
    {years.error !== undefined && <div className="album-options-error" role="alert"><span>年份选项暂时不可用，仍可搜索城市或切换排序。</span>
      <button className="quiet-button" disabled={years.loading} onClick={refreshYears}>重试读取年份</button></div>}
    <AlbumResults key={JSON.stringify(filters)} {...{ filters, memory }} onReset={() => apply({ ...defaultFilters })} />
  </main>
}

function AlbumResults({ filters, memory, onReset }: { filters: AlbumFilters; memory: AlbumLibraryMemory; onReset: () => void }) {
  const [data, setData] = useState<AlbumPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>()
  const [failedMore, setFailedMore] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const active = useRef<AbortController | null>(null)
  const desiredCount = useRef(memory.read().count)
  const restoreScroll = useRef(memory.read().scrollY)
  const pendingScroll = useRef<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    active.current?.abort(); active.current = controller
    async function load() {
      try {
        let fresh = await api<AlbumPage>(albumPath(filters), { signal: controller.signal })
        // Rebuild the previously opened window from fresh account-scoped data.
        // Remember positions only in this account's mounted Journal, never storage.
        while (fresh.next_cursor && fresh.items.length < desiredCount.current) {
          const next = await api<AlbumPage>(albumPath(filters, fresh.next_cursor), { signal: controller.signal })
          fresh = { ...next, items: [...fresh.items, ...next.items] }
        }
        if (controller.signal.aborted || !sameFilters(filters, memory.read().filters ?? defaultFilters)) return
        pendingScroll.current = restoreScroll.current
        setData(fresh); setError(undefined); memory.write({ ...memory.read(), count: fresh.items.length })
      } catch (reason) { if (!isAbort(reason)) setError(reason) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [attempt, memory, filters])

  useLayoutEffect(() => {
    if (!data || pendingScroll.current === null) return
    // Restore only after React commits the cards and their final layout height.
    window.scrollTo({ top: pendingScroll.current, behavior: 'instant' })
    pendingScroll.current = null
  }, [data])

  useEffect(() => () => active.current?.abort(), [])

  useEffect(() => {
    const refresh = () => {
      desiredCount.current = memory.read().count; restoreScroll.current = window.scrollY
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
      const next = await api<AlbumPage>(albumPath(filters, data.next_cursor), { signal: controller.signal })
      if (controller.signal.aborted || !sameFilters(filters, memory.read().filters ?? defaultFilters)) return
      const fresh = { ...next, items: [...data.items, ...next.items] }
      setData(fresh); memory.write({ ...memory.read(), count: fresh.items.length }); desiredCount.current = fresh.items.length
    } catch (reason) { if (!isAbort(reason)) setError(reason) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }

  function retry() {
    setLoading(true); setError(undefined); setFailedMore(false); restoreScroll.current = window.scrollY
    setAttempt(value => value + 1)
  }

  return <>
    {error !== undefined && <div className="load-error" role="alert"><p>{errorMessage(error)}</p>
      <button className="quiet-button" disabled={loading} onClick={failedMore ? () => void more() : retry}>{failedMore ? '重试加载更多相册' : '重新加载相册'}</button></div>}
    {!data && loading && <p role="status">正在翻开你的相册…</p>}
    {data && !data.items.length && (filters.q || filters.year ? <div className="album-empty"><h2>没有找到符合条件的相册</h2><p>试试其他城市或年份，也可以清除筛选查看全部相册。</p>
      <button className="quiet-button" onClick={onReset}>查看全部相册</button></div> : <div className="album-empty"><h2>第一本相册，从一座城市开始。</h2><p>选好城市，创建年份影集，再把喜欢的照片放进去。</p>
      <Link className="quiet-button" to="/#choose-city-title">选择一座城市</Link></div>)}
    {data && <div className="album-grid library-grid">{data.items.map(collection => <CityAlbumCard key={collection.city.id} collection={collection} onOpen={() => memory.write({ ...memory.read(), scrollY: window.scrollY })} />)}</div>}
    {data?.next_cursor && <button className="quiet-button more-button" disabled={loading} onClick={() => void more()}>{loading ? '正在读取…' : '加载更多相册'}</button>}
    {data && !data.next_cursor && data.items.length > 0 && <p className="gallery-end">每一段回忆，都有自己的位置。</p>}
  </>
}
