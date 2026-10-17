export type Point = [number, number]
export type Geometry = Point[][][] // polygons -> rings -> positions; holes retained
export type View = { center: Point; zoom: number }
export const nationalView: View = { center: [104, 29], zoom: 3 }

export function project([lng, lat]: Point, zoom: number): Point {
  const scale = 256 * 2 ** zoom
  const phi = Math.max(-85, Math.min(85, lat)) * Math.PI / 180
  return [(lng + 180) / 360 * scale, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * scale]
}
export function unproject([x, y]: Point, zoom: number): Point {
  const scale = 256 * 2 ** zoom
  return [x / scale * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI]
}
export function boundedView(view: View): View {
  return { zoom: Math.max(3, Math.min(10, Math.round(view.zoom))),
    center: [Math.max(70, Math.min(140, view.center[0])), Math.max(0, Math.min(60, view.center[1]))] }
}
export function screen(point: Point, view: View, width: number, height: number): Point {
  const p = project(point, view.zoom), c = project(view.center, view.zoom)
  return [p[0] - c[0] + width / 2, p[1] - c[1] + height / 2]
}
export function centerOf(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const center = value as { lng?: unknown; lat?: unknown }
  const numeric = (n: unknown) => typeof n === 'number' || (typeof n === 'string' && n.trim()) ? Number(n) : NaN
  const lng = numeric(center.lng), lat = numeric(center.lat)
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 85 ? [lng, lat] : null
}
export function parseBoundary(value: unknown): Geometry | null {
  if (typeof value !== 'string' || value.length > 8_000_000) return null
  let source = value.trim()
  const srid = source.match(/^SRID\s*=\s*(\d+)\s*;\s*/i)
  if (srid) { if (!['4326', '4490'].includes(srid[1])) return null; source = source.slice(srid[0].length) }
  const prefix = source.match(/^(MULTIPOLYGON|POLYGON)\s*/i)
  if (!prefix) return null
  source = source.slice(prefix[0].length)
  let cursor = 0, count = 0
  const space = () => { while (cursor < source.length && /\s/.test(source[cursor])) cursor++ }
  const next = () => { space(); return source[cursor] }
  const numberPattern = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/iy
  const number = () => {
    space()
    numberPattern.lastIndex = cursor
    const match = numberPattern.exec(source)
    if (!match) throw new Error('invalid')
    cursor += match[0].length
    return Number(match[0])
  }
  const group = (depth: number): unknown[] => {
    if (depth > 3 || next() !== '(') throw new Error('invalid')
    cursor++
    const result: unknown[] = []
    while (cursor < source.length) {
      if (next() === '(') result.push(group(depth + 1))
      else {
        const point: Point = [number(), number()]
        if (++count > 150_000 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85) throw new Error('invalid')
        result.push(point)
      }
      const delimiter = next(); cursor++
      if (delimiter === ')') return result
      if (delimiter !== ',') throw new Error('invalid')
    }
    throw new Error('invalid')
  }
  try {
    const parsed = group(0); space()
    if (cursor !== source.length) return null
    const polygons = prefix[1].toUpperCase() === 'POLYGON' ? [parsed] : parsed
    if (!polygons.length) return null
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length) return null
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 3 || !ring.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null
        if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]])
        if (ring.length < 4) return null
      }
    }
    return polygons as Geometry
  } catch { return null }
}
export function geometryPath(geometry: Geometry, view: View, width: number, height: number): string {
  return geometry.flatMap(polygon => polygon.map(ring => ring.map((p, i) => {
    const [x, y] = screen(p, view, width, height)
    return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join('') + 'Z')).join('')
}
export type Tile = { id: string; x: number; y: number; column: number; row: number; zoom: number }
export function tilesFor(view: View, width: number, height: number): Tile[] {
  const [x, y] = project(view.center, view.zoom), left = x - width / 2, top = y - height / 2
  const result: Tile[] = [], count = 2 ** view.zoom
  for (let col = Math.floor(left / 256); col <= Math.floor((left + width - 1) / 256); col++) {
    for (let row = Math.max(0, Math.floor(top / 256)); row <= Math.min(count - 1, Math.floor((top + height - 1) / 256)); row++) {
      if (result.length >= 80) return [] // bounded viewport, no background prefetch
      const column = ((col % count) + count) % count
      result.push({ id: `${view.zoom}/${column}/${row}`, x: col * 256 - left, y: row * 256 - top, column, row, zoom: view.zoom })
    }
  }
  return result
}
