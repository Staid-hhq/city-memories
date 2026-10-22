import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, isAbort } from '../../shared/api'
import type { Atlas } from '../albums/types'
import { project, unproject } from './mapGeometry'
import type { Geometry, Point, View } from './mapGeometry'
import { MapFailure, MapService } from './mapService'
import type { ChinaMapData, LocatedCity, MapCity } from './mapService'

export type MapMemory = { read: () => View | undefined; write: (view: View) => void }
type Size = { width: number; height: number }
const initialSize: Size = { width: 900, height: 540 }
const sourceUrl = '/map-data/NOTICE.md'

function fitView({ width, height }: Size): View {
  const northwest = project([72, 55], 0), southeast = project([136, 17], 0)
  const padding = width < 500 ? 20 : 42
  const scale = Math.min(Math.max(40, width - padding * 2) / (southeast[0] - northwest[0]), Math.max(40, height - padding * 2) / (southeast[1] - northwest[1]))
  return { center: unproject([(northwest[0] + southeast[0]) / 2, (northwest[1] + southeast[1]) / 2], 0), zoom: Math.log2(scale) }
}

// Paths stay at one fixed world scale; dragging and zooming update one SVG group.
function fixedPath(geometry: Geometry) {
  return geometry.flatMap(polygon => polygon.map(ring => ring.map((position, index) => {
    const [x, y] = project(position, 0)
    return `${index ? 'L' : 'M'}${x.toFixed(6)},${y.toFixed(6)}`
  }).join('') + 'Z')).join('')
}

function fixedLines(lines: Point[][]) {
  return lines.map(line => line.map((position, index) => {
    const [x, y] = project(position, 0)
    return `${index ? 'L' : 'M'}${x.toFixed(6)},${y.toFixed(6)}`
  }).join('')).join('')
}

function worldTransform(view: View, size: Size, drag: Point = [0, 0]) {
  const [x, y] = project(view.center, view.zoom)
  return `translate(${size.width / 2 - x + drag[0]} ${size.height / 2 - y + drag[1]}) scale(${2 ** view.zoom})`
}

function MapCanvas({ data, atlas, memory }: { data: ChinaMapData; atlas?: Atlas; memory: MapMemory }) {
  const navigate = useNavigate()
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>(initialSize)
  const [view, setView] = useState<View>(() => memory.read() ?? fitView(initialSize))
  const [drag, setDrag] = useState<Point>([0, 0])
  const [hovered, setHovered] = useState<LocatedCity | null>(null)
  const [query, setQuery] = useState('')
  const interacted = useRef(!!memory.read())
  const pointer = useRef<{ id: number; start: Point; delta: Point; cityId?: string } | null>(null)
  const ignoreClickUntil = useRef(0)
  const overview = fitView(size)
  const counts = useMemo(() => new Map(atlas?.items.map(item => [item.city.id, item.photo_count])), [atlas])
  const lit = useMemo(() => new Set(atlas?.items.filter(item => item.lit && item.photo_count > 0).map(item => item.city.id) ?? []), [atlas])
  const paths = useMemo(() => ({ outline: fixedPath(data.outline), borders: fixedLines(data.borders ?? []), cities: data.items.filter(city => data.regions[city.id]).map(city => ({ city, path: fixedPath(data.regions[city.id]) })) }), [data])
  const matches = useMemo(() => query.trim() ? data.items.filter(city => `${city.name}${city.parent_name ?? ''}`.includes(query.trim())).slice(0, 8) : [], [data.items, query])
  const photoLabel = (city: LocatedCity) => atlas ? `${counts.get(city.id) ?? 0} 张照片` : '照片统计核对中'

  useEffect(() => {
    const element = stage.current!
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width), height = Math.round(entries[0].contentRect.height)
      if (!width || !height) return
      const next = { width, height }
      setSize(next)
      if (!interacted.current) setView(fitView(next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function change(next: View) {
    const bounded: View = { center: [Math.max(70, Math.min(140, next.center[0])), Math.max(0, Math.min(60, next.center[1]))], zoom: Math.max(overview.zoom, Math.min(10, next.zoom)) }
    interacted.current = true
    memory.write(bounded); setView(bounded); setHovered(null)
  }
  function zoom(delta: number) { change({ ...view, zoom: view.zoom + delta }) }
  function finish(event: ReactPointerEvent) {
    const current = pointer.current
    if (!current || event.pointerId !== current.id) return
    pointer.current = null; setDrag([0, 0]); ignoreClickUntil.current = event.timeStamp + 350
    if (stage.current?.hasPointerCapture(current.id)) stage.current.releasePointerCapture(current.id)
    if (Math.hypot(...current.delta) > 4) {
      const center = project(view.center, view.zoom)
      change({ ...view, center: unproject([center[0] - current.delta[0], center[1] - current.delta[1]], view.zoom) })
    } else if (current.cityId) navigate(`/cities/${current.cityId}`)
  }
  function locate(city: LocatedCity) {
    change({ center: city.center, zoom: Math.max(view.zoom, overview.zoom + 2.5) })
    stage.current?.focus({ preventScroll: true })
    setHovered(city)
  }

  const insetSize = { width: 136, height: 174 }
  const insetView: View = { center: [114, 13], zoom: 3.45 }
  return <>
    <div className="map-toolbar" aria-label="地图工具"><div>
      <button type="button" className="quiet-button" onClick={() => zoom(.5)} disabled={view.zoom >= 10} aria-label="放大地图">＋</button>
      <button type="button" className="quiet-button" onClick={() => zoom(-.5)} disabled={view.zoom <= overview.zoom + .001} aria-label="缩小地图">−</button>
      <button type="button" className="quiet-button" onClick={() => change(overview)}>全国视图</button>
    </div><span>拖动查看 · ＋／－缩放 · 滚轮滚动页面</span></div>
    <div ref={stage} className="map-stage china-map-stage" tabIndex={0} role="region" aria-label="中国城市地图"
      data-zoom={view.zoom} data-center={view.center.join(',')}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        const moves: Record<string, Point> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }
        if (moves[event.key]) { event.preventDefault(); const center = project(view.center, view.zoom), delta = moves[event.key]; change({ ...view, center: unproject([center[0] + delta[0], center[1] + delta[1]], view.zoom) }) }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(.5) }
        else if (event.key === '-') { event.preventDefault(); zoom(-.5) }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('button,a,.china-map-inset')) return
        const cityId = (event.target as Element).closest('[data-city-region]')?.getAttribute('data-city-region') ?? undefined
        pointer.current = { id: event.pointerId, start: [event.clientX, event.clientY], delta: [0, 0], cityId }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = pointer.current
        if (current?.id !== event.pointerId) return
        current.delta = [event.clientX - current.start[0], event.clientY - current.start[1]]
        setDrag(current.delta)
        if (Math.hypot(...current.delta) > 4) setHovered(null)
      }} onPointerUp={finish} onPointerCancel={() => { pointer.current = null; setDrag([0, 0]) }}>
      <svg className="china-map-svg" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} data-map-layer="main" data-ready="true" aria-label="按城市划分的中国足迹地图">
        <g transform={worldTransform(view, size, drag)}>
          <path className="china-map-outline" d={paths.outline} fillRule="nonzero" />
          {paths.cities.map(({ city, path }) => <path key={city.id} className={`china-city-area${lit.has(city.id) ? ' is-lit' : ''}${hovered?.id === city.id ? ' is-hovered' : ''}`}
            data-city-region={city.id} data-lit={lit.has(city.id)} d={path} fillRule="evenodd" role="link" tabIndex={0}
            aria-label={`${city.name}，${photoLabel(city)}，打开相册`}
            onPointerEnter={() => { if (!pointer.current) setHovered(city) }} onPointerLeave={() => { if (!pointer.current) setHovered(null) }}
            onFocus={() => setHovered(city)} onBlur={() => setHovered(null)}
            onClick={event => { if (event.timeStamp >= ignoreClickUntil.current) navigate(`/cities/${city.id}`) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); navigate(`/cities/${city.id}`) } }}><title>{city.name} · {photoLabel(city)}</title></path>)}
          <path className="china-national-borders" d={paths.borders} />
        </g>
      </svg>
      <div className="china-map-heading" aria-hidden="true"><span>CHINA</span><small>城市里的回忆</small></div>
      {hovered && <div className="china-map-hover" role="status"><strong>{hovered.name}</strong><span>{photoLabel(hovered)}</span></div>}
      <aside className="china-map-inset" aria-label="南海诸岛附图">
        <svg viewBox={`0 0 ${insetSize.width} ${insetSize.height}`} data-map-layer="south" data-ready="true" aria-hidden="true"><g transform={worldTransform(insetView, insetSize)}>
          <path className="china-map-outline" d={paths.outline} fillRule="nonzero" />
          {paths.cities.map(({ city, path }) => <path key={city.id} className={`china-city-area${lit.has(city.id) ? ' is-lit' : ''}`} d={path} fillRule="evenodd" />)}
          <path className="china-national-borders" d={paths.borders} />
        </g></svg><span>南海诸岛</span>
      </aside>
    </div>
    <div className="china-map-footer"><div className="china-map-legend" aria-label="地图图例"><span><i />还未点亮</span><span><i className="is-lit" />有照片的城市</span></div>
      <p className="map-progress" aria-live="polite">{atlas ? `已点亮 ${lit.size} 座城市` : '正在核对照片统计…'}</p></div>
    <div className="china-map-find"><label htmlFor="map-city-search">定位一座城市</label><input id="map-city-search" aria-label="在地图中定位城市" type="search" placeholder="搜索城市名称" value={query} onChange={event => setQuery(event.target.value)} />
      <span>小区域可搜索后放大查看，也可使用方向键移动地图。</span></div>
    {query.trim() && <div className="china-map-results" aria-label="地图城市搜索结果">{matches.length ? <ul>{matches.map(city => <li key={city.id}><div><strong>{city.name}</strong><small>{city.parent_name ?? '中国'}</small></div>
      <button type="button" className="quiet-button" onClick={() => locate(city)}>定位{city.name}</button><Link to={`/cities/${city.id}`}>打开相册 →</Link></li>)}</ul> : <p>没有找到这座城市，可换一个名称搜索。</p>}</div>}
    <p className="map-attribution">足迹记录用图 · <a href={sourceUrl} target="_blank" rel="noreferrer">市界数据来源</a> · 填色表示本账号的有效照片</p>
  </>
}

function MapSession({ service, memory, atlas }: { service: MapService; memory: MapMemory; atlas?: Atlas }) {
  const [data, setData] = useState<ChinaMapData>()
  const [message, setMessage] = useState('正在展开中国城市地图…')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void api<MapCity[]>('/map/cities', { signal: controller.signal }).then(cities => service.loadChinaMap(cities, controller.signal)).then(result => {
      if (controller.signal.aborted) return
      setData(result)
      setMessage(result.missing || result.missingRegions ? `部分城市资料仍待核对：${result.missing} 个城市位置、${result.missingRegions} 个市界暂不可用，仍可使用下方城市搜索。` : '每一块城市区域，都可以收藏一段回忆。')
    }).catch(error => {
      if (!controller.signal.aborted && !isAbort(error)) { setFailed(true); setMessage(error instanceof MapFailure ? error.message : '地图暂时未能展开，可以重新核对，或使用下方城市搜索。') }
    })
    return () => { controller.abort(); service.cancel() }
  }, [service])
  return <><p className="map-session-note" role={failed ? 'alert' : undefined}>{message}</p>{data && <MapCanvas {...{ data, memory, atlas }} />}</>
}

export function CityMap(props: { service: MapService; memory: MapMemory; atlas?: Atlas }) {
  const [attempt, setAttempt] = useState(0)
  return <section className="city-map china-city-map" aria-labelledby="city-map-title"><div className="section-heading"><div><p className="eyebrow">YOUR CITY FOOTPRINTS</p><h2 id="city-map-title">走过的城市，留下的光影</h2></div>
    <button type="button" className="quiet-button" onClick={() => { props.service.cancel(); props.service.resetConfiguration(); setAttempt(value => value + 1) }}>重新核对地图</button></div>
    <MapSession key={attempt} {...props} />
  </section>
}
