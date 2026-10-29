import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, isAbort } from '../../shared/api'
import type { Atlas } from '../albums/types'
import { project, unproject } from './mapGeometry'
import { cityView } from './mapCityView'
import type { Geometry, Point, View } from './mapGeometry'
import { MapFailure, MapService } from './mapService'
import type { ChinaMapData, LocatedCity, MapCity } from './mapService'

export type MapMemory = { read: () => View | undefined; write: (view: View) => void }
type Size = { width: number; height: number }
const initialSize: Size = { width: 900, height: 640 }
const sourceUrl = '/map-data/NOTICE.md'
const isProvinceCity = (city: LocatedCity) => city.unit_kind === 'municipality' || city.unit_kind === 'special-region'
const cityShortcuts = [
  { code: '156810000', label: '香港' },
  { code: '156820000', label: '澳门' },
  { code: '156440400', label: '珠海' },
]

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
  const citySearch = useRef<HTMLInputElement>(null)
  const searchBox = useRef<HTMLDivElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const autoFitCity = useRef<LocatedCity | null>(null)
  const [size, setSize] = useState<Size>(initialSize)
  const [view, setView] = useState<View>(() => memory.read() ?? fitView(initialSize))
  const [drag, setDrag] = useState<Point>([0, 0])
  const [touchPan, setTouchPan] = useState(false)
  const [hovered, setHovered] = useState<LocatedCity | null>(null)
  const [focused, setFocused] = useState<LocatedCity | null>(null)
  const [selectedCity, setSelectedCity] = useState<LocatedCity | null>(null)
  const [query, setQuery] = useState('')
  const interacted = useRef(!!memory.read())
  const pointer = useRef<{ id: number; start: Point; delta: Point; cityId?: string } | null>(null)
  const ignoreClickUntil = useRef(0)
  const overview = fitView(size)
  const counts = useMemo(() => new Map(atlas?.items.map(item => [item.city.id, item.photo_count])), [atlas])
  const lit = useMemo(() => new Set(atlas?.items.filter(item => item.lit && item.photo_count > 0).map(item => item.city.id) ?? []), [atlas])
  const activeCity = hovered ?? focused ?? selectedCity
  const paths = useMemo(() => ({ outline: fixedPath(data.outline), borders: fixedLines(data.borders), provinceBorders: fixedLines(data.provinceBorders), cities: data.items.filter(city => data.regions[city.id]).map(city => ({ city, path: fixedPath(data.regions[city.id]) })) }), [data])
  // Draw visible city edges above every area fill; province-level cities already
  // have their outer edges in the permanent province/coastline layers.
  const litBoundaries = paths.cities.filter(({ city }) => lit.has(city.id) && !isProvinceCity(city))
  const visibleBoundaries = paths.cities.filter(({ city }) => !isProvinceCity(city) && (lit.has(city.id) || activeCity?.id === city.id))
    .sort((a, b) => Number(a.city.id === activeCity?.id) - Number(b.city.id === activeCity?.id))
  const matches = useMemo(() => query.trim() ? data.items.filter(city => `${city.name}${city.parent_name ?? ''}`.includes(query.trim())).slice(0, 8) : [], [data.items, query])
  const shortcuts = cityShortcuts.flatMap(shortcut => {
    const city = data.items.find(item => item.provider_code === shortcut.code && data.regions[item.id])
    return city ? [{ city, label: shortcut.label }] : []
  })
  const photoLabel = (city: LocatedCity) => atlas ? `${counts.get(city.id) ?? 0} 张照片` : '照片统计核对中'
  const cityLabel = (city: LocatedCity) => city.parent_name && city.parent_name !== city.name ? `${city.parent_name} · ${city.name}` : city.name

  useEffect(() => {
    if (!searchOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!searchBox.current?.contains(event.target as Node)) setSearchOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [searchOpen])

  useEffect(() => {
    const element = stage.current!
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width), height = Math.round(entries[0].contentRect.height)
      if (!width || !height) return
      const next = { width, height }
      setSize(next)
      const city = autoFitCity.current
      if (city) {
        const fitted = cityView(data.regions[city.id], next, fitView(next).zoom, city.center)
        memory.write(fitted); setView(fitted)
      } else if (!interacted.current) setView(fitView(next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [data, memory])

  function change(next: View) {
    autoFitCity.current = null
    const bounded: View = { center: [Math.max(70, Math.min(140, next.center[0])), Math.max(0, Math.min(60, next.center[1]))], zoom: Math.max(overview.zoom, Math.min(10, next.zoom)) }
    interacted.current = true
    memory.write(bounded); setView(bounded); setHovered(null)
  }
  function zoom(delta: number) { change({ ...view, zoom: view.zoom + delta }) }
  useEffect(() => {
    const element = stage.current!
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY) return
      event.preventDefault()
      const zoom = Math.max(fitView(size).zoom, Math.min(10, view.zoom + (event.deltaY < 0 ? .35 : -.35)))
      if (zoom === view.zoom) return
      const next = { ...view, zoom }
      autoFitCity.current = null
      interacted.current = true; memory.write(next); setView(next); setHovered(null)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [view, memory, size])

  function clearPointer(timeStamp: number, pointerId?: number) {
    const current = pointer.current
    if (!current || (pointerId !== undefined && pointerId !== current.id)) return
    pointer.current = null; setDrag([0, 0]); ignoreClickUntil.current = timeStamp + 350
    if (stage.current?.hasPointerCapture(current.id)) stage.current.releasePointerCapture(current.id)
    return current
  }
  function cancel(event: ReactPointerEvent) { clearPointer(event.timeStamp, event.pointerId) }
  function finish(event: ReactPointerEvent) {
    const current = clearPointer(event.timeStamp, event.pointerId)
    if (!current) return
    if (Math.hypot(...current.delta) > 4) {
      const center = project(view.center, view.zoom)
      change({ ...view, center: unproject([center[0] - current.delta[0], center[1] - current.delta[1]], view.zoom) })
    } else if (current.cityId) navigate(`/cities/${current.cityId}`)
  }
  function locate(city: LocatedCity) {
    change(cityView(data.regions[city.id], size, overview.zoom, city.center))
    autoFitCity.current = city
    setSelectedCity(city); setFocused(null); setSearchOpen(false)
    stage.current?.focus({ preventScroll: true })
    stage.current?.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  function closeSelection() {
    autoFitCity.current = null
    setSelectedCity(null); setHovered(null); setFocused(null)
    stage.current?.focus({ preventScroll: true })
  }

  const insetSize = { width: 136, height: 174 }
  const insetView: View = { center: [114, 13], zoom: 3.45 }
  return <>
    <div className="map-toolbar map-controls" aria-label="地图工具">
      <div ref={searchBox} className="map-search-box" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false)
      }} onKeyDown={event => {
        if (event.key === 'Escape' && searchOpen) {
          event.preventDefault(); event.stopPropagation(); citySearch.current?.focus(); setSearchOpen(false)
        }
      }}>
        <label className="sr-only" htmlFor="map-city-search">在地图中定位城市</label>
        <input ref={citySearch} id="map-city-search" type="search" placeholder="搜索城市，如广州、香港" autoComplete="off" maxLength={80}
          value={query} onFocus={() => setSearchOpen(true)} onClick={() => setSearchOpen(true)} onChange={event => { setQuery(event.target.value); setSearchOpen(true) }} />
        {searchOpen && <section className="map-search-popover" aria-label="城市查找">
          <div className="map-search-heading"><span>{query.trim() ? '搜索结果' : '小区域快捷放大'}</span>
            <button type="button" aria-label="收起城市查找" onClick={() => { citySearch.current?.focus(); setSearchOpen(false) }}>×</button></div>
          {query.trim() ? <div className="china-map-results" aria-label="地图城市搜索结果">{matches.length ? <ul>{matches.map(city => <li key={city.id}><div><strong>{city.name}</strong><small>{city.parent_name ?? '中国'}</small></div>
            <button type="button" className="quiet-button" onClick={() => locate(city)}>定位{city.name}</button><Link to={`/cities/${city.id}`}>打开相册 →</Link></li>)}</ul> : <p role="status">没有找到这座城市，可换一个名称搜索。</p>}</div>
            : <><div className="map-city-shortcuts" role="group" aria-label="小区域快捷放大">
              {shortcuts.map(({ city, label }) => <button key={city.id} type="button" className="quiet-button" aria-label={`放大查看${label}`} onClick={() => locate(city)}>{label}<span aria-hidden="true"> ↗</span></button>)}
            </div><p className="map-search-help">输入城市名称，可放大定位或打开相册。</p></>}
        </section>}
      </div>
      <div className="map-zoom-controls">
      <button type="button" className="quiet-button" onClick={() => zoom(.5)} disabled={view.zoom >= 10} title={view.zoom >= 10 ? '已放大到最大' : '放大地图'} aria-label="放大地图">＋</button>
      <button type="button" className="quiet-button" onClick={() => zoom(-.5)} disabled={view.zoom <= overview.zoom + .001} title={view.zoom <= overview.zoom + .001 ? '已是全国视图' : '缩小地图'} aria-label="缩小地图">−</button>
      <button type="button" className="quiet-button" onClick={() => { setSelectedCity(null); setFocused(null); change(overview) }}>全国视图</button>
      <button type="button" className="quiet-button map-touch-toggle" aria-pressed={touchPan} onClick={event => { clearPointer(event.timeStamp); setTouchPan(value => !value); setHovered(null) }}>{touchPan ? '完成移动' : '移动地图'}</button>
      </div>
    </div>
    <div ref={stage} className={`map-stage china-map-stage${touchPan ? ' is-touch-panning' : ''}`} tabIndex={0} role="region" aria-label="中国城市地图"
      data-zoom={view.zoom} data-center={view.center.join(',')}
      onKeyDown={event => {
        if (event.key === 'Escape' && selectedCity) { event.preventDefault(); event.stopPropagation(); closeSelection(); return }
        if (event.target !== event.currentTarget) return
        const moves: Record<string, Point> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }
        if (moves[event.key]) { event.preventDefault(); const center = project(view.center, view.zoom), delta = moves[event.key]; change({ ...view, center: unproject([center[0] + delta[0], center[1] + delta[1]], view.zoom) }) }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(.5) }
        else if (event.key === '-') { event.preventDefault(); zoom(-.5) }
      }}
      onPointerDown={event => {
        setFocused(null)
        if (pointer.current || event.button !== 0 || (event.pointerType === 'touch' && (!event.isPrimary || !touchPan)) || (event.target as Element).closest('button,a,.china-map-inset,[data-map-control]')) return
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
      }} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onPointerLeave={() => { if (!pointer.current) setHovered(null) }}>
      {selectedCity && <div className="china-map-selection" role="region" aria-label="当前定位城市" data-map-control>
        <div className="map-selection-heading"><strong title={cityLabel(selectedCity)}>{selectedCity.name}</strong><button type="button" aria-label="关闭城市定位" onClick={closeSelection}>×</button></div>
        <div className="map-selection-actions"><span>{photoLabel(selectedCity)}</span><Link to={`/cities/${selectedCity.id}`} aria-label={`打开${selectedCity.name}相册`}>打开相册 <span aria-hidden="true">→</span></Link></div>
      </div>}
      <svg className="china-map-svg" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} data-map-layer="main" data-ready="true" aria-label="按城市划分的中国足迹地图">
        <g transform={worldTransform(view, size, drag)}>
          <path className="china-map-outline" d={paths.outline} fillRule="nonzero" />
          {paths.cities.map(({ city, path }) => <path key={city.id} className={`china-city-area${lit.has(city.id) ? ' is-lit' : ''}${activeCity?.id === city.id ? ' is-hovered' : ''}`}
            data-city-region={city.id} data-unit-kind={city.unit_kind} data-lit={lit.has(city.id)} d={path} fillRule="evenodd" role="link" tabIndex={0}
            aria-label={`${cityLabel(city)}，${photoLabel(city)}，打开相册`}
            onPointerEnter={event => { if (!pointer.current && event.pointerType !== 'touch') setHovered(city) }} onPointerLeave={() => { if (!pointer.current) setHovered(null) }}
            onFocus={event => setFocused(event.currentTarget.matches(':focus-visible') ? city : null)} onBlur={() => setFocused(null)}
            onClick={event => { if (event.timeStamp >= ignoreClickUntil.current) navigate(`/cities/${city.id}`) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); navigate(`/cities/${city.id}`) } }}><title>{cityLabel(city)} · {photoLabel(city)}</title></path>)}
          {visibleBoundaries.map(({ city, path }) => <path key={city.id} className={`china-city-boundary${lit.has(city.id) ? ' is-lit' : ''}${activeCity?.id === city.id ? ' is-hovered' : ''}`}
            data-city-boundary={city.id} d={path} aria-hidden="true" />)}
          <path className="china-province-borders" d={paths.provinceBorders} aria-hidden="true" />
          <path className="china-national-borders" d={paths.borders} />
        </g>
      </svg>
      <div className="china-map-heading" aria-hidden="true"><span>CHINA</span><small>城市里的回忆</small></div>
      {activeCity && (!selectedCity || activeCity.id !== selectedCity.id) && <div className={`china-map-hover${selectedCity ? ' has-selection' : ''}`} role="status"><strong>{cityLabel(activeCity)}</strong><span>{photoLabel(activeCity)}</span></div>}
      <aside className="china-map-inset" aria-label="南海诸岛附图">
        <svg viewBox={`0 0 ${insetSize.width} ${insetSize.height}`} data-map-layer="south" data-ready="true" aria-hidden="true"><g transform={worldTransform(insetView, insetSize)}>
          <path className="china-map-outline" d={paths.outline} fillRule="nonzero" />
          {paths.cities.map(({ city, path }) => <path key={city.id} className={`china-city-area${lit.has(city.id) ? ' is-lit' : ''}`} d={path} fillRule="evenodd" />)}
          {litBoundaries.map(({ city, path }) => <path key={city.id} className="china-city-boundary is-lit" data-city-boundary={city.id} d={path} aria-hidden="true" />)}
          <path className="china-province-borders" d={paths.provinceBorders} aria-hidden="true" />
          <path className="china-national-borders" d={paths.borders} />
        </g></svg><span>南海诸岛</span>
      </aside>
    </div>
    <div className="china-map-footer"><div className="china-map-legend" aria-label="地图图例"><span><i />还未点亮</span><span><i className="is-lit" />有照片的城市</span></div>
      <p className="map-progress" aria-live="polite">{atlas ? `已点亮 ${lit.size} 座城市` : '正在核对照片统计…'}</p></div>
    <p className="map-interaction-hint"><span className="map-pointer-hint">拖动查看 · 滚轮或＋／－缩放</span><span className="map-touch-hint">{touchPan ? '拖动地图 · 完成后点“完成移动”' : '滑动页面 · 点＋／－缩放，移动地图可拖动'}</span></p>
    <p className="map-attribution">足迹记录用图 · <a href={sourceUrl} target="_blank" rel="noreferrer">市界数据来源</a> · 填色表示本账号的有效照片</p>
  </>
}

function MapSession({ service, memory, atlas, retry }: { service: MapService; memory: MapMemory; atlas?: Atlas; retry: () => void }) {
  const [data, setData] = useState<ChinaMapData>()
  const [message, setMessage] = useState('正在展开中国城市地图…')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void api<MapCity[]>('/map/cities', { signal: controller.signal }).then(cities => service.loadChinaMap(cities, controller.signal)).then(result => {
      if (controller.signal.aborted) return
      setData(result)
      setMessage(result.missing || result.missingRegions ? `部分城市资料仍待核对：${result.missing} 个城市位置、${result.missingRegions} 个市界暂不可用，仍可使用城市搜索。` : '')
    }).catch(error => {
      if (!controller.signal.aborted && !isAbort(error)) { setFailed(true); setMessage(error instanceof MapFailure ? error.message : '地图暂时未能展开，可以重新核对，或使用下方城市搜索。') }
    })
    return () => { controller.abort(); service.cancel() }
  }, [service])
  return <>{message && <div className="map-session-feedback"><p className="map-session-note" role={failed ? 'alert' : 'status'}>{message}</p>
    {(failed || data) && <button type="button" className="quiet-button" onClick={retry}>重新核对地图</button>}</div>}{data && <MapCanvas {...{ data, memory, atlas }} />}</>
}

export function CityMap(props: { service: MapService; memory: MapMemory; atlas?: Atlas }) {
  const [attempt, setAttempt] = useState(0)
  const options = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (options.current && !options.current.contains(event.target as Node)) options.current.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  function retry() { props.service.cancel(); props.service.resetConfiguration(); setAttempt(value => value + 1) }
  return <section className="city-map china-city-map" aria-labelledby="city-map-title"><div className="section-heading"><h2 id="city-map-title">走过的城市，留下的光影</h2>
    <details ref={options} className="map-options" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false
    }} onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
    }}><summary aria-label="更多地图选项">更多 <span aria-hidden="true">···</span></summary>
      <div className="map-options-panel"><button type="button" className="quiet-button" onClick={() => {
        if (options.current) { options.current.open = false; options.current.querySelector('summary')?.focus() }
        retry()
      }}>重新核对地图</button><p>地图未完整显示时，可重新加载。</p></div>
    </details></div>
    <MapSession key={attempt} {...props} retry={retry} />
  </section>
}
