import { api } from './api'
import type { City } from './Journal'
import { centerOf, parseBoundary } from './mapGeometry'
import type { Geometry, Point, Tile } from './mapGeometry'

export type MapCity = City & { provider_code: string }
export type LocatedCity = MapCity & { center: Point }
export type MapConfig = { enabled: boolean; key: string | null; review_number: string | null; review_date: string | null; message: string | null }
export type Directory = { items: LocatedCity[]; missing: number }
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

  configuration() {
    this.config ??= api<MapConfig>('/map/config').catch(error => { this.config = undefined; throw error })
    return this.config
  }
  resetConfiguration() { this.config = undefined }
  cancel() {
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
