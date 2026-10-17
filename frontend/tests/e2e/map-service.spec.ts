import { expect, test } from '@playwright/test'
import { MapFailure, MapService } from '../../src/features/map/mapService'

test('地图行政请求只有一路、等待队列有界、取消清空且不自动重试', async () => {
  const previousFetch = globalThis.fetch
  let transfers = 0
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    transfers++
    init!.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic abort', 'AbortError')), { once: true })
  })
  const service = new MapService()
  service.configuration = async () => ({ enabled: true, key: '0'.repeat(32), review_number: 'TEST', review_date: '2026-10-04', message: null })
  try {
    const controller = new AbortController()
    const jobs = Array.from({ length: 24 }, (_, index) => service.boundary({ id: `synthetic-${index}`, provider_code: `156${String(index).padStart(6, '0')}`,
      name: 'Synthetic', parent_name: null, unit_kind: 'municipality', can_create: true }, controller.signal)
      .then(() => null, error => error))
    await expect.poll(() => transfers).toBe(1)
    service.cancel()
    const results = await Promise.all(jobs)
    expect(transfers).toBe(1)
    expect(results.filter(error => error instanceof MapFailure)).toHaveLength(3)
    expect(results.filter(error => error instanceof DOMException && error.name === 'AbortError')).toHaveLength(21)
  } finally { service.cancel(); globalThis.fetch = previousFetch }
})
