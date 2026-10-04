import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, isAbort } from './api'
import type { Atlas } from './Journal'
import { boundedView, geometryPath, nationalView, project, screen, tilesFor, unproject } from './mapGeometry'
import type { Geometry, Point, View } from './mapGeometry'
import { MapFailure, MapService, tileUrl } from './mapService'
import type { Directory, LocatedCity, MapCity, MapConfig } from './mapService'

export type MapMemory = { read: () => View | undefined; write: (view: View) => void }
const southView: View = { center: [113, 12], zoom: 5 }
function overview(width: number): View { return width >= 770 ? { center: [104.5, 35], zoom: 4 } : nationalView }

function TileLayer({ view, width, height, config, layer, records, report }: {
  view: View; width: number; height: number; config: MapConfig; layer: 'vec' | 'cva'
  records: Record<string, { phase: 'ready' | 'error' | 'loading'; attempt: number }>
  report: (id: string, phase: 'ready' | 'error') => void
}) {
  return <div className={`tile-layer ${layer}`} aria-hidden="true">{tilesFor(view, width, height).map(tile => {
    const id = `${layer}:${tile.id}`, attempt = records[id]?.attempt ?? 0
    return <img key={`${id}:${attempt}`} draggable={false} alt="" width={256} height={256}
      src={tileUrl(tile, layer, config.key!)} referrerPolicy="strict-origin-when-cross-origin"
      style={{ left: tile.x, top: tile.y }} onLoad={() => report(id, 'ready')} onError={() => report(id, 'error')} />
  })}</div>
}

function TileViewport({ view, width, height, config, children, drag = [0, 0], name }: {
  view: View; width: number; height: number; config: MapConfig; children?: React.ReactNode; drag?: Point; name: string
}) {
  const [records, setRecords] = useState<Record<string, { phase: 'ready' | 'error' | 'loading'; attempt: number }>>({})
  const [late, setLate] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setLate(true), 8000); return () => clearTimeout(timer) }, [])
  const ids = tilesFor(view, width, height).flatMap(t => [`vec:${t.id}`, `cva:${t.id}`])
  const ready = ids.length > 0 && ids.every(id => records[id]?.phase === 'ready')
  const failed = ids.some(id => records[id]?.phase === 'error')
  const report = (id: string, phase: 'ready' | 'error') => setRecords(old => ({ ...old, [id]: { phase, attempt: old[id]?.attempt ?? 0 } }))
  return <div className="map-viewport" style={{ width, height }} data-map-layer={name} data-ready={ready}>
    <div className="map-moving" style={{ transform: `translate(${drag[0]}px,${drag[1]}px)` }}>
      <TileLayer {...{ view, width, height, config, records, report }} layer="vec" />
      {children}
      <TileLayer {...{ view, width, height, config, records, report }} layer="cva" />
    </div>
    {!ready && <div className="map-load-note" aria-live="polite">{failed || late ? '地图未完整加载，仍可使用下方城市搜索。' : '正在加载官方底图与注记…'}
      {(failed || late) && <button type="button" className="quiet-button" onClick={(event) => {
        event.stopPropagation()
        setRecords(old => Object.fromEntries(ids.map(id => [id, old[id]?.phase === 'ready' ? old[id] : { phase: 'loading', attempt: (old[id]?.attempt ?? 0) + 1 }])))
      }}>重试未完成图层</button>}
    </div>}
  </div>
}

type Group = { x: number; y: number; cities: LocatedCity[] }
function groupCities(cities: LocatedCity[], view: View, width: number, height: number): Group[] {
  const groups = new Map<string, Group>()
  for (const city of cities) {
    const [x, y] = screen(city.center, view, width, height)
    if (x < 20 || y < 20 || x > width - 20 || y > height - 20) continue
    const key = `${Math.floor(x / 52)}:${Math.floor(y / 52)}`
    const group = groups.get(key)
    if (group) { group.x = (group.x * group.cities.length + x) / (group.cities.length + 1); group.y = (group.y * group.cities.length + y) / (group.cities.length + 1); group.cities.push(city) }
    else groups.set(key, { x, y, cities: [city] })
  }
  return [...groups.values()]
}

function MapCanvas({ config, directory, atlas, service, memory }: {
  config: MapConfig; directory?: Directory; atlas?: Atlas; service: MapService; memory: MapMemory
}) {
  const navigate = useNavigate()
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 610 })
  const [view, setView] = useState<View>(memory.read() ?? nationalView)
  const [drag, setDrag] = useState<Point>([0, 0])
  const pointer = useRef<{ id: number; start: Point; delta: Point } | null>(null)
  const [chosen, setChosen] = useState<LocatedCity[]>([])
  const [regions, setRegions] = useState<Record<string, Geometry>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [retry, setRetry] = useState(0)
  const lit = useMemo(() => new Set(atlas?.items.filter(i => i.lit && i.photo_count > 0).map(i => i.city.id) ?? []), [atlas])
  const counts = new Map(atlas?.items.map(i => [i.city.id, i.photo_count]))
  const items = useMemo(() => directory?.items ?? [], [directory])
  const groups = groupCities(items, view, size.width, size.height)
  const visible = items.filter(city => { const [x, y] = screen(city.center, view, size.width, size.height); return lit.has(city.id) && x >= 0 && x <= size.width && y >= 0 && y <= size.height })
  const targets = visible.slice(0, 20)
  const targetKey = targets.map(c => c.id).join('|')
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  useEffect(() => {
    const element = stage.current!
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width), height = Math.round(entries[0].contentRect.height)
      if (!width || !height) return
      setSize({ width, height })
      if (!memory.read()) setView(overview(width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [memory])
  useEffect(() => {
    const controller = new AbortController()
    const wanted = new Set(targetKey.split('|'))
    for (const city of itemsRef.current.filter(c => wanted.has(c.id))) {
      void service.boundary(city, controller.signal).then(geometry => {
        if (!controller.signal.aborted) { setRegions(old => Object.fromEntries(Object.entries({ ...old, [city.id]: geometry }).slice(-64))); setFailures(old => { const copy = { ...old }; delete copy[city.id]; return copy }) }
      }).catch(error => { if (!controller.signal.aborted && !isAbort(error)) setFailures(old => ({ ...old, [city.id]: error instanceof MapFailure ? error.message : '区域暂不可用。' })) })
    }
    return () => controller.abort()
  }, [service, targetKey, retry])

  function change(next: View) { const bounded = boundedView(next); memory.write(bounded); setView(bounded); setChosen([]) }
  function zoom(delta: number) { change({ ...view, zoom: view.zoom + delta }) }
  useEffect(() => {
    const element = stage.current!
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (Math.abs(event.deltaY) < 5) return
      const zoom = Math.max(3, Math.min(10, view.zoom + (event.deltaY < 0 ? 1 : -1)))
      if (zoom === view.zoom) return
      const next = boundedView({ ...view, zoom }); memory.write(next); setView(next); setChosen([])
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [view, memory])
  function finish(event: ReactPointerEvent) {
    const p = pointer.current
    if (!p || event.pointerId !== p.id) return
    pointer.current = null; setDrag([0, 0])
    if (stage.current?.hasPointerCapture(p.id)) stage.current.releasePointerCapture(p.id)
    if (Math.hypot(...p.delta) > 3) { const c = project(view.center, view.zoom); change({ ...view, center: unproject([c[0] - p.delta[0], c[1] - p.delta[1]], view.zoom) }) }
  }
  const pending = targets.filter(c => !regions[c.id] && !failures[c.id]).length
  const failed = targets.filter(c => failures[c.id])
  return <>
    <div className="map-toolbar" aria-label="地图工具"><div>
      <button type="button" className="quiet-button" onClick={() => zoom(1)} disabled={view.zoom >= 10} aria-label="放大地图">＋</button>
      <button type="button" className="quiet-button" onClick={() => zoom(-1)} disabled={view.zoom <= 3} aria-label="缩小地图">−</button>
      <button type="button" className="quiet-button" onClick={() => change(overview(size.width))}>全国视图</button>
      <button type="button" className="quiet-button" onClick={() => change(southView)}>南海视图</button>
      <button type="button" className="quiet-button" onClick={() => change({ center: [123.6, 25.8], zoom: 8 })}>钓鱼岛相关区域</button>
    </div><span>拖动 / 滚轮缩放 · 可用方向键移动</span></div>
    <div className="map-composition">
      <div ref={stage} className="map-stage" tabIndex={0} role="region" aria-label="中国城市地图"
        data-zoom={view.zoom} data-center={view.center.join(',')}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          const moves: Record<string, Point> = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] }
          if (moves[event.key]) { event.preventDefault(); const c = project(view.center, view.zoom), d = moves[event.key]; change({ ...view, center: unproject([c[0] + d[0], c[1] + d[1]], view.zoom) }) }
          else if (event.key === '+' || event.key === '=') zoom(1)
          else if (event.key === '-') zoom(-1)
        }}
        onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest('button,a,[data-city-region]')) return; pointer.current = { id: event.pointerId, start: [event.clientX, event.clientY], delta: [0, 0] }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { const p = pointer.current; if (p?.id !== event.pointerId) return; p.delta = [event.clientX - p.start[0], event.clientY - p.start[1]]; setDrag(p.delta) }}
        onPointerUp={finish} onPointerCancel={() => { pointer.current = null; setDrag([0, 0]) }}>
        <TileViewport key={`${view.zoom}:${view.center}:${size.width}:${size.height}`} {...{ view, config, drag, ...size }} name="main">
          <svg className="city-regions" width={size.width} height={size.height} aria-label="本人照片城市范围">
            {items.filter(city => lit.has(city.id) && regions[city.id]).map(city => <path key={city.id} data-city-region={city.id}
              d={geometryPath(regions[city.id], view, size.width, size.height)} fillRule="evenodd" role="link" tabIndex={0}
              aria-label={`${city.name}，${counts.get(city.id)} 张照片，打开影集`} onClick={() => navigate(`/cities/${city.id}`)}
              onKeyDown={event => { if (event.key === 'Enter') navigate(`/cities/${city.id}`) }}><title>{city.name} · 我的照片</title></path>)}
          </svg>
        </TileViewport>
        <div className="city-markers" style={{ transform: `translate(${drag[0]}px,${drag[1]}px)` }}>
          {groups.map(group => <button type="button" key={group.cities.map(c => c.id).join(',')} style={{ left: group.x, top: group.y }}
            className={`map-marker ${group.cities.some(c => lit.has(c.id)) ? 'lit' : ''}`}
            aria-label={group.cities.length > 1 ? `选择附近 ${group.cities.length} 座城市` : `${group.cities[0].name}，${atlas ? counts.get(group.cities[0].id) ?? 0 : '统计核对中'} 张照片`}
            onClick={() => { if (group.cities.length === 1) navigate(`/cities/${group.cities[0].id}`); else setChosen(group.cities) }}>
            {group.cities.length > 1 ? group.cities.length : group.cities[0].name.replace(/市$/, '')}
          </button>)}
        </div>
      </div>
      <aside className="south-map" aria-label="南海诸岛附图"><h3>南海诸岛</h3>
        <TileViewport view={southView} width={260} height={500} config={config} name="south" />
        <p>附图保留官方底图和注记。<br />点击“南海视图”可在主图查看。</p>
        <div className="map-legend"><span className="lit-dot" />有照片的城市<br /><span className="empty-dot" />尚未点亮的入口</div>
      </aside>
    </div>
    <p className="map-attribution"><a href="https://www.tianditu.gov.cn/" target="_blank" rel="noreferrer">来源：天地图</a> · {config.review_number} · 核对日期 {config.review_date} · 城市填色仅表示本人有效照片</p>
    <div className="map-progress" aria-live="polite">{!atlas ? '照片统计核对中，暂不显示私人点亮。' : `${lit.size} 座城市已有照片；空影集不点亮。`}
      {pending > 0 && ` 当前视野 ${pending} 个区域加载中。`}{visible.length > 20 && ' 可见区域较多，最多加载前 20 个，请缩放后继续。'}
      {failed.length > 0 && <><span> {failed.length} 个区域暂未着色：{failures[failed[0].id]}</span><button type="button" className="quiet-button" onClick={() => { setFailures({}); setRetry(n => n + 1) }}>重试区域</button></>}
    </div>
    {chosen.length > 0 && <section className="map-city-choice" aria-label="附近城市列表"><h3>选择一座城市</h3><button type="button" className="quiet-button" onClick={() => setChosen([])}>关闭附近城市</button>
      <ul>{chosen.map(city => <li key={city.id}><Link to={`/cities/${city.id}`}>{city.name} · {city.parent_name ?? city.unit_kind}</Link>
        <button type="button" className="quiet-button" onClick={() => change({ center: city.center, zoom: Math.min(10, view.zoom + 2) })}>定位{city.name}</button></li>)}</ul>
    </section>}
  </>
}

function MapSession({ service, memory, atlas }: { service: MapService; memory: MapMemory; atlas?: Atlas }) {
  const [config, setConfig] = useState<MapConfig>()
  const [directory, setDirectory] = useState<Directory>()
  const [message, setMessage] = useState('正在连接地图；城市搜索可先使用。')
  useEffect(() => {
    let active = true
    void Promise.all([service.configuration(), api<MapCity[]>('/map/cities')]).then(async ([configuration, cities]) => {
      if (!active) return
      setConfig(configuration)
      if (!configuration.enabled) { setMessage(configuration.message ?? '地图配置暂不可用。'); return }
      setMessage('正在核对城市位置，搜索和影集不受影响。')
      const result = await service.loadDirectory(cities)
      if (active) { setDirectory(result); setMessage(result.missing ? `${result.missing} 个已审核城市的位置暂未匹配，仍可使用文字入口。` : '城市位置已核对。') }
    }).catch(error => { if (active && !isAbort(error)) setMessage(error instanceof MapFailure ? error.message : '地图暂不可用，仍可搜索城市和查看自己的影集。') })
    return () => { active = false; service.cancel() }
  }, [service])
  return <><p className="map-session-note">{message}</p>{config?.enabled && <MapCanvas {...{ config, directory, service, memory, atlas }} />}</>
}

export function CityMap(props: { service: MapService; memory: MapMemory; atlas?: Atlas }) {
  const [attempt, setAttempt] = useState(0)
  return <section className="city-map" aria-labelledby="city-map-title"><div className="section-heading"><h2 id="city-map-title">走过的城市，留下的光影</h2>
    <button type="button" className="quiet-button" onClick={() => { props.service.cancel(); props.service.resetConfiguration(); setAttempt(n => n + 1) }}>重新核对地图</button></div>
    <MapSession key={attempt} {...props} />
  </section>
}
