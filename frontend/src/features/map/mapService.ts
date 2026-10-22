import { api } from '../../shared/api'
import type { City } from '../albums/types'
import { centerOf, parseBoundary } from './mapGeometry'
import type { Geometry, Point, Tile } from './mapGeometry'

export type MapCity = City & { provider_code: string }
export type LocatedCity = MapCity & { center: Point }
export type MapConfig = { enabled: boolean; key: string | null; review_number: string | null; review_date: string | null; message: string | null }
export type Directory = { items: LocatedCity[]; missing: number }
export type ChinaMapData = Directory & { outline: Geometry; borders: Point[][]; regions: Record<string, Geometry>; missingRegions: number }

type ChinaRegion = {
  provider_code: string; name: string; parent_name: string | null; unit_kind: string
  center: Point; geometry: Geometry | null
}
type ChinaAsset = { schema_version: 1; revision: string; regions: ChinaRegion[]; background: Geometry; borders?: Point[][] }

function checkedGeometry(value: unknown, allowEmpty = false): Geometry {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new MapFailure('市界数据格式无效，请重新加载地图。')
  let count = 0
  for (const polygon of value) {
    if (!Array.isArray(polygon) || !polygon.length) throw new MapFailure('市界数据格式无效，请重新加载地图。')
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) throw new MapFailure('市界数据格式无效，请重新加载地图。')
      for (const point of ring) {
        if (++count > 500_000 || !Array.isArray(point) || point.length !== 2 || !point.every(p => typeof p === 'number' && Number.isFinite(p))
          || point[0] < 70 || point[0] > 140 || point[1] < 0 || point[1] > 60) throw new MapFailure('市界坐标无效，未显示地图。')
      }
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new MapFailure('市界轮廓不完整，未显示地图。')
    }
  }
  return value as Geometry
}

export function joinChinaRegions(payload: unknown, cities: MapCity[]): ChinaMapData {
  const data = payload as Partial<ChinaAsset> | null
  if (!data || data.schema_version !== 1 || typeof data.revision !== 'string' || !data.revision || !Array.isArray(data.regions)
    || !data.regions.length || data.regions.length > 500) throw new MapFailure('中国市界数据版本或格式无效，请重新加载地图。')
  const outline = [...checkedGeometry(data.background, true)]
  const borders: Point[][] = []
  if (data.borders !== undefined) {
    if (!Array.isArray(data.borders) || data.borders.length > 10_000) throw new MapFailure('国界背景数据格式无效，未显示地图。')
    let points = 0
    for (const line of data.borders) {
      if (!Array.isArray(line) || line.length < 2 || line.some(p => ++points > 500_000 || !Array.isArray(p) || p.length !== 2
        || !p.every(v => typeof v === 'number' && Number.isFinite(v)) || p[0] < 70 || p[0] > 140 || p[1] < 0 || p[1] > 60)) throw new MapFailure('国界背景坐标无效，未显示地图。')
      borders.push(line)
    }
  }
  const byCode = new Map<string, ChinaRegion>()
  for (const region of data.regions) {
    if (!region || !/^156\d{6}$/.test(region.provider_code) || byCode.has(region.provider_code)
      || typeof region.name !== 'string' || !region.name || !(region.parent_name === null || typeof region.parent_name === 'string')
      || typeof region.unit_kind !== 'string' || !Array.isArray(region.center) || region.center.length !== 2
      || !region.center.every(p => typeof p === 'number' && Number.isFinite(p))
      || region.center[0] < 70 || region.center[0] > 140 || region.center[1] < 0 || region.center[1] > 60) throw new MapFailure('市界编码或城市资料有冲突，未显示地图。')
    if (region.geometry !== null) outline.push(...checkedGeometry(region.geometry))
    byCode.set(region.provider_code, region)
  }
  if (!outline.length) throw new MapFailure('市界轮廓为空，未显示地图。')
  const ids = new Set<string>(), codes = new Set<string>()
  const items: LocatedCity[] = [], regions: Record<string, Geometry> = {}
  for (const city of cities) {
    if (ids.has(city.id) || codes.has(city.provider_code)) throw new MapFailure('城市目录有重复项，未显示地图。')
    ids.add(city.id); codes.add(city.provider_code)
    const match = byCode.get(city.provider_code)
    if (!match || match.name !== city.name || match.parent_name !== city.parent_name || match.unit_kind !== city.unit_kind) continue
    items.push({ ...city, center: match.center })
    if (match.geometry) regions[city.id] = match.geometry
  }
  return { items, regions, outline, borders, missing: cities.length - items.length, missingRegions: items.length - Object.keys(regions).length }
}
type District = { gb: string; name: string; level: number; center?: unknown; children?: District[]; boundary?: unknown }
type Payload = { status?: number; data?: { district?: District[] } }
export class MapFailure extends Error {}
const aborted = () => new DOMException('Map request cancelled', 'AbortError')

export function joinDirectory(payload: Payload, cities: MapCity[]): Directory {
  const countries = payload.data?.district?.filter(d => Number(d.level) === 5 && d.gb === '156000000')
  if (countries?.length !== 1 || !Array.isArray(countries[0].children)) throw new MapFailure('城市位置目录不完整，可继续使用文字入口。')
  const byCode = new Map<string, { node: District; parent: string | null }>()
  const seen = new Set<string>()
  const visit = (node: District, parent: District | null) => {
    const code = String(node.gb)
    if (!/^156\d{6}$/.test(code) || seen.has(code)) throw new MapFailure('地图目录编码有冲突，未显示位置。')
    seen.add(code)
    if (parent && Number(parent.level) === 4 && code.slice(3, 5) !== String(parent.gb).slice(3, 5)) throw new MapFailure('地图目录归属不一致，未显示位置。')
    byCode.set(code, { node, parent: Number(node.level) === 4 ? null : parent?.name ?? null })
    if (node.children) { if (!Array.isArray(node.children)) throw new MapFailure('地图目录格式无效。'); node.children.forEach(child => visit(child, node)) }
  }
  visit(countries[0], null)
  const items: LocatedCity[] = []
  for (const city of cities) {
    const match = byCode.get(city.provider_code), center = centerOf(match?.node.center)
    const expected = ['municipality', 'special-region'].includes(city.unit_kind) ? [4] : city.unit_kind === 'prefecture' ? [3] : [2, 3]
    if (match && center && match.node.name === city.name && match.parent === city.parent_name
      && expected.includes(Number(match.node.level))) items.push({ ...city, center })
  }
  return { items, missing: cities.length - items.length }
}

export function tileUrl(tile: Tile, layer: 'vec' | 'cva', key: string) {
  const params = new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: layer,
    STYLE: 'default', TILEMATRIXSET: 'w', FORMAT: 'tiles', TILEMATRIX: String(tile.zoom),
    TILEROW: String(tile.row), TILECOL: String(tile.column), tk: key })
  return `https://t0.tianditu.gov.cn/${layer}_w/wmts?${params}`
}

type Job = { run: (signal: AbortSignal) => Promise<Payload>; resolve: (p: Payload) => void; reject: (e: unknown) => void; signal?: AbortSignal; abort: () => void }
export class MapService {
  private config?: Promise<MapConfig>
  private directory?: Promise<Directory>
  private queue: Job[] = []
  private current: AbortController | null = null
  private lastStart = -Infinity
  private draining = false
  private cache = new Map<string, Geometry>()
  private inFlight = new Map<string, Promise<Geometry>>()
  private chinaPayload?: unknown
  private chinaRequest: AbortController | null = null

  async loadChinaMap(cities: MapCity[], signal: AbortSignal): Promise<ChinaMapData> {
    signal.throwIfAborted()
    if (this.chinaPayload) return joinChinaRegions(this.chinaPayload, cities)
    const controller = new AbortController()
    this.chinaRequest?.abort(); this.chinaRequest = controller
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(25_000)])
    try {
      const response = await fetch('/map-data/china-cities.v1.json', { signal: combined, credentials: 'omit' })
      if (!response.ok) throw new MapFailure('市界数据暂时无法读取，仍可使用下方城市搜索。')
      const reader = response.body?.getReader()
      if (!reader) throw new MapFailure('市界数据为空，请重新加载地图。')
      const chunks: Uint8Array[] = []; let size = 0
      try {
        for (;;) {
          const result = await reader.read(); if (result.done) break
          size += result.value.byteLength
          if (size > 8_000_000) { await reader.cancel(); throw new MapFailure('市界数据超出读取上限，已停止加载。') }
          chunks.push(result.value)
        }
      } finally { reader.releaseLock() }
      combined.throwIfAborted()
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
      const result = joinChinaRegions(payload, cities)
      combined.throwIfAborted()
      this.chinaPayload = payload
      return result
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw aborted()
      if (error instanceof MapFailure) throw error
      throw new MapFailure('市界数据加载失败，仍可使用下方城市搜索。')
    } finally { if (this.chinaRequest === controller) this.chinaRequest = null }
  }

  configuration() {
    this.config ??= api<MapConfig>('/map/config').catch(error => { this.config = undefined; throw error })
    return this.config
  }
  resetConfiguration() { this.config = undefined; this.chinaPayload = undefined }
  cancel() {
    this.chinaRequest?.abort()
    this.current?.abort()
    for (const job of [...this.queue]) job.abort()
  }
  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        job.signal?.removeEventListener('abort', job.abort)
        if (job.signal?.aborted) { job.reject(aborted()); continue }
        const controller = new AbortController()
        this.current = controller
        const signal = job.signal ? AbortSignal.any([job.signal, controller.signal]) : controller.signal
        try {
          const delay = Math.max(0, 1500 - (Date.now() - this.lastStart))
          if (delay) await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(aborted()) }
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
          signal.throwIfAborted()
          this.lastStart = Date.now()
          job.resolve(await job.run(signal))
        } catch (error) { job.reject(error) }
        finally { this.current = null }
      }
    } finally { this.draining = false }
  }
  private request(keyword: string, childLevel: number, extensions: boolean, signal?: AbortSignal): Promise<Payload> {
    if (signal?.aborted) return Promise.reject(aborted())
    if (this.queue.length >= 20) return Promise.reject(new MapFailure('部分区域等待加载，请缩小查看范围。'))
    return new Promise((resolve, reject) => {
      const job: Job = { resolve, reject, signal, abort: () => {
        const i = this.queue.indexOf(job)
        if (i >= 0) this.queue.splice(i, 1)
        signal?.removeEventListener('abort', job.abort)
        reject(aborted())
      }, run: async requestSignal => {
        const config = await this.configuration()
        if (!config.enabled || !config.key) throw new MapFailure('地图配置暂不可用。')
        const params = new URLSearchParams({ keyword, childLevel: String(childLevel), extensions: String(extensions), tk: config.key })
        try {
          const response = await fetch(`https://api.tianditu.gov.cn/v2/administrative?${params}`, {
            signal: AbortSignal.any([requestSignal, AbortSignal.timeout(25_000)]), credentials: 'omit', cache: 'no-store',
            referrerPolicy: 'strict-origin-when-cross-origin',
          })
          if (!response.ok) throw new MapFailure(response.status === 403 || response.status === 401 ? '地图授权不可用，请核对配置。' : '地图服务暂不可用，可稍后重试。')
          const reader = response.body?.getReader()
          if (!reader) throw new MapFailure('地图响应为空。')
          const chunks: Uint8Array[] = []; let size = 0
          try {
            for (;;) {
              const result = await reader.read(); if (result.done) break
              size += result.value.byteLength
              if (size > 8_000_000) { await reader.cancel(); throw new MapFailure('地图区域数据过大，已停止读取。') }
              chunks.push(result.value)
            }
          } finally { reader.releaseLock() }
          const bytes = new Uint8Array(size); let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
          const payload: Payload = JSON.parse(new TextDecoder().decode(bytes))
          if (Number(payload.status) !== 200) throw new MapFailure(Number(payload.status) === 302010 ? '地图请求受限，请稍后手动重试。' : '地图服务拒绝了本次请求，请核对授权或额度。')
          return payload
        } catch (error) {
          if (requestSignal.aborted) throw aborted()
          if (error instanceof MapFailure) throw error
          throw new MapFailure('地图连接超时或响应无效，可继续使用文字入口。')
        }
      } }
      signal?.addEventListener('abort', job.abort, { once: true })
      this.queue.push(job)
      void this.drain()
    })
  }
  loadDirectory(cities: MapCity[]) {
    this.directory ??= this.request('中华人民共和国', 2, false).then(p => joinDirectory(p, cities))
      .catch(error => { this.directory = undefined; throw error })
    return this.directory
  }
  boundary(city: MapCity, signal: AbortSignal): Promise<Geometry> {
    const id = JSON.stringify([city.id, city.provider_code, city.name, city.parent_name])
    const cached = this.cache.get(id)
    if (cached) return Promise.resolve(cached)
    // Canceled consumers must not borrow a prior aborted request when revisiting.
    const previous = this.inFlight.get(id)
    if (previous) return previous.catch(error => {
      signal.throwIfAborted()
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
      return this.boundary(city, signal)
    })
    const promise = this.request(city.provider_code, 0, true, signal).then(payload => {
      const exact = payload.data?.district?.filter(d => String(d.gb) === city.provider_code)
      const geometry = exact?.length === 1 && exact[0].name === city.name ? parseBoundary(exact[0].boundary) : null
      if (!geometry) throw new MapFailure('城市边界与已核对映射不一致或缺失，暂不着色。')
      this.cache.set(id, geometry)
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
      return geometry
    }).finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, promise)
    return promise
  }
}
