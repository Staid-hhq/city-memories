import { project, unproject } from './mapGeometry'
import type { Geometry, Point, View } from './mapGeometry'

export function cityView(geometry: Geometry | undefined, size: { width: number; height: number }, minimumZoom: number, fallback: Point): View {
  const minimum = Number.isFinite(minimumZoom) ? Math.max(0, Math.min(10, minimumZoom)) : 3
  const fallbackView: View = {
    center: [Number.isFinite(fallback[0]) ? Math.max(70, Math.min(140, fallback[0])) : 104,
      Number.isFinite(fallback[1]) ? Math.max(0, Math.min(60, fallback[1])) : 29],
    zoom: Math.min(10, minimum + 2.5),
  }
  if (!geometry?.length || !Number.isFinite(size.width) || !Number.isFinite(size.height)
    || size.width <= 0 || size.height <= 0) return fallbackView

  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (const polygon of geometry) for (const ring of polygon) for (const point of ring) {
    if (!point.every(Number.isFinite)) return fallbackView
    const [x, y] = project(point, 0)
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  const width = right - left, height = bottom - top
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fallbackView

  const compact = size.width < 500
  const padding = compact ? 24 : 56
  const reserved = compact ? 132 : 106
  const availableWidth = Math.max(1, size.width - padding * 2)
  const availableHeight = Math.max(1, size.height - padding * 2 - reserved)
  const zoom = Math.max(minimum, Math.min(10, Math.log2(Math.min(availableWidth / width, availableHeight / height))))
  // The selected-city card occupies the bottom of the canvas. Keep the actual
  // geometry centered in the usable space above it, including outlying islands.
  return { center: unproject([(left + right) / 2, (top + bottom) / 2 + reserved / 2 / 2 ** zoom], 0), zoom }
}
