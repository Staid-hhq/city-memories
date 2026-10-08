import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { centerOf, geometryPath, parseBoundary, project, tilesFor, unproject } from '../src/mapGeometry'
import { joinDirectory } from '../src/mapService'
import type { MapCity } from '../src/mapService'

const sz = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const gz = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const catalog = JSON.parse(readFileSync(new URL('../../backend/src/city_memories/city-catalog.json', import.meta.url), 'utf8'))
const cities: MapCity[] = catalog.cities.filter((c: { mapping_status: string }) => c.mapping_status === 'verified').map((c: MapCity) => ({ ...c, can_create: true }))
type Node = { gb: string; name: string; level: number; center: { lng: number; lat: number }; children?: Node[] }
// Deliberately synthetic positions and polygons, not supplier responses or borders.
const provinces = new Map<string, Node>()
const roots: Node[] = []
for (const city of cities) {
  const node: Node = { gb: city.provider_code, name: city.name, level: city.parent_name ? (city.unit_kind === 'prefecture' ? 3 : 2) : 4,
    center: city.id === sz || city.id === gz ? { lng: 114, lat: 23 } : { lng: 75, lat: 54 } }
  if (!city.parent_name) roots.push(node)
  else {
    let parent = provinces.get(city.parent_name)
    if (!parent) { parent = { gb: `${city.provider_code.slice(0, 5)}0000`, name: city.parent_name, level: 4, center: { lng: 100, lat: 30 }, children: [] }; provinces.set(city.parent_name, parent); roots.push(parent) }
    parent.children!.push(node)
  }
}
const directory = { status: 200, data: { district: [{ gb: '156000000', name: '中华人民共和国', level: 5, center: { lng: 100, lat: 30 }, children: roots }] } }
const wkt = 'MULTIPOLYGON (((113 22,115 22,115 24,113 24,113 22),(113.5 22.5,114.5 22.5,114.5 23,113.5 22.5)),((115.2 22,115.3 22,115.3 22.1,115.2 22)))'

async function mockMaps(context: BrowserContext) {
  const calls: { keyword: string; time: number }[] = []
  const state = { tilesFail: false, directoryFail: false, boundaryFail: false, holdBoundary: false, release: () => {} }
  const held = new Promise<void>(resolve => { state.release = resolve })
  await context.route('**/api/v1/map/config', route => route.fulfill({ json: { data: { enabled: true, key: '0'.repeat(32), review_number: '合成测试，不是正式地图', review_date: '2026-10-04' } } }))
  await context.route('https://*.tianditu.gov.cn/**', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'api.tianditu.gov.cn') {
      if (state.tilesFail) return route.abort('failed')
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path d="M0 0H256V256H0Z" fill="#f4eddd" stroke="#ddd"/></svg>' })
    }
    const keyword = url.searchParams.get('keyword')!
    calls.push({ keyword, time: Date.now() })
    if (keyword === '中华人民共和国') return route.fulfill({ json: state.directoryFail ? { status: 302010 } : directory })
    if (state.holdBoundary) await held
    const city = cities.find(c => c.provider_code === keyword)!
    await route.fulfill({ json: { status: 200, data: { district: [{ gb: keyword, name: city.name, boundary: state.boundaryFail ? 'invalid' : wkt }] } } }).catch(() => {})
  })
  return { state, calls }
}
async function login(page: Page, name: string) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(name)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${name}` })).toBeVisible()
}
async function read(page: Page, path: string) { return (await (await page.request.get(`/api/v1${path}`)).json()).data }
async function write(page: Page, path: string, data: unknown) {
  // Exercise the application's real CSRF/session and cross-tab update notification.
  return page.evaluate(async ({ path, data }) => {
    const modulePath = '/src/api.ts'
    const { api } = await import(/* @vite-ignore */ modulePath)
    return api(path, { method: 'POST', body: JSON.stringify(data) })
  }, { path, data })
}

test('地图投影、复合区域与洞、非法坐标及瓦片数量有界', () => {
  for (const point of [[73, 39], [114, 23], [135, 53]] as [number, number][]) {
    const result = unproject(project(point, 9), 9)
    expect(result[0]).toBeCloseTo(point[0], 8); expect(result[1]).toBeCloseTo(point[1], 8)
  }
  const geometry = parseBoundary(wkt)!
  expect(geometry.map(p => p.length)).toEqual([2, 1])
  expect(geometryPath(geometry, { center: [114, 23], zoom: 8 }, 800, 600).match(/M/g)).toHaveLength(3)
  for (const bad of ['SRID=3857;POLYGON((1 1,2 2,3 3))', 'POLYGON((999 1,2 2,3 3))', 'POLYGON((1 1,2 2))', 'POINT(1 1)', 'POLYGON((NaN 1,2 2,3 3))']) expect(parseBoundary(bad)).toBeNull()
  expect(centerOf({ lng: null, lat: 0 })).toBeNull()
  expect(centerOf({ lng: true, lat: 0 })).toBeNull()
  expect(tilesFor({ center: [114, 23], zoom: 5 }, 10000, 10000)).toEqual([])
  expect(tilesFor({ center: [114, 23], zoom: 5 }, 800, 610).length).toBeLessThan(25)
})

test('业务目录逐条匹配，不接受重名错码、层级冲突或重复编码', () => {
  expect(joinDirectory(directory, cities).items).toHaveLength(391)
  const mismatch = cities.map(c => c.id === sz ? { ...c, name: '错误名称' } : c)
  expect(joinDirectory(directory, mismatch).missing).toBe(1)
  const duplicate = structuredClone(directory)
  duplicate.data.district[0].children.push(duplicate.data.district[0].children[0])
  expect(() => joinDirectory(duplicate, cities)).toThrow('编码有冲突')
  expect(joinDirectory(directory, cities.map(c => c.id === sz ? { ...c, parent_name: '错误省份' } : c)).missing).toBe(1)
})

test('空影集不点亮，真实导入通知另一窗口，换号不残留区域或照片数', async ({ page, context }) => {
  const { calls } = await mockMaps(context)
  await login(page, 'Map_Empty')
  await expect(page.locator('.map-session-note')).toHaveText('城市位置已核对。')
  await expect(page.locator('.map-progress')).toContainText('0 座城市已有照片')
  const other = await context.newPage()
  await other.goto(`/cities/${sz}`)
  await other.getByLabel('影集年份', { exact: true }).fill('2040')
  await other.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(other).toHaveURL(/\/albums\//)
  await expect(page.locator('.saved-city')).toContainText('空影集 · 尚未点亮')
  expect(calls.filter(c => c.keyword !== '中华人民共和国')).toHaveLength(0)
  const png = Buffer.from(await other.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  await other.locator('input[type=file]').setInputFiles({ name: 'synthetic-map-test.png', mimeType: 'image/png', buffer: png })
  await other.getByRole('button', { name: '上传并校验', exact: true }).click()
  await other.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveCount(1)
  await expect(page.locator('.map-progress')).toContainText('1 座城市已有照片')
  const photo = (await read(other, `/albums/${other.url().split('/albums/')[1].split('?')[0]}/photos`)).items[0]
  await other.close()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await login(page, 'Map_Two')
  await expect(page.locator('.map-progress')).toContainText('0 座城市已有照片')
  await expect(page.locator('[data-city-region]')).toHaveCount(0)
  expect((await page.request.get(`/api/v1/photos/${photo.id}/original`)).status()).toBe(404)
})

test('跨城移动、删除末张与恢复实时改变本人地图，几何保持完整', async ({ page, context }) => {
  const { calls } = await mockMaps(context)
  await login(page, 'Map_One')
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveCount(1)
  expect((await page.locator('[data-city-region]').getAttribute('d'))?.match(/M/g)).toHaveLength(3)
  const other = await context.newPage(); await other.goto('/')
  const album = (await read(page, `/cities/${sz}/albums`)).items[0]
  const photo = (await read(page, `/albums/${album.id}/photos`)).items[0]
  const target = await write(other, `/cities/${gz}/albums`, { year: 2051 })
  const current = await read(page, `/photos/${photo.id}`)
  await write(other, `/photos/${photo.id}/move`, { target_album_id: target.id, expected_photo_revision: current.revision, expected_source_revision: current.album_revision, expected_target_revision: target.revision })
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-city-region="${gz}"]`)).toHaveCount(1)
  let detail = await read(page, `/photos/${photo.id}`)
  await write(other, `/photos/${photo.id}/trash`, { expected_photo_revision: detail.revision, expected_album_revision: detail.album_revision })
  await expect(page.locator('[data-city-region]')).toHaveCount(0)
  await expect(page.locator('.map-progress')).toContainText('0 座城市已有照片')
  detail = await read(page, `/trash/photos/${photo.id}`)
  await write(other, `/trash/photos/${photo.id}/restore`, { expected_photo_revision: detail.revision, expected_album_revision: detail.album_revision })
  await expect(page.locator(`[data-city-region="${gz}"]`)).toHaveCount(1)
  const starts = calls.filter(c => c.keyword !== '中华人民共和国').map(c => c.keyword)
  expect(new Set(starts)).toEqual(new Set(['156440300', '156440100']))
  await other.close()
})

test('密集入口选择、点击区域、拖动缩放及返回保留视角，1024 不溢出', async ({ page, context }) => {
  await mockMaps(context)
  await login(page, 'Map_Return')
  await expect(page.locator('[data-city-region]')).toHaveCount(1)
  await page.locator('.map-marker.lit').click()
  await expect(page.getByRole('region', { name: '附近城市列表' })).toBeVisible()
  await expect(page.locator('.map-city-choice').getByRole('link', { name: /深圳市/ })).toBeVisible()
  await page.getByRole('button', { name: '定位深圳市', exact: true }).click()
  const stage = page.getByRole('region', { name: '中国城市地图', exact: true })
  await stage.focus(); await page.keyboard.press('+'); await page.keyboard.press('ArrowLeft')
  const before = await stage.getAttribute('data-center')
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + 70, box.y + 70)
  await page.mouse.down(); await page.mouse.move(box.x + 130, box.y + 110, { steps: 5 }); await page.mouse.up()
  await expect(stage).not.toHaveAttribute('data-center', before!)
  const center = await stage.getAttribute('data-center'), zoom = await stage.getAttribute('data-zoom')
  await page.locator('[data-city-region]').focus(); await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/cities/${sz}$`))
  await page.getByRole('link', { name: '返回城市入口' }).click()
  await expect(stage).toHaveAttribute('data-center', center!)
  await expect(stage).toHaveAttribute('data-zoom', zoom!)
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
})

test('目录、瓦片、边界失败分别降级和手动重试，统计失败不伪装零照片', async ({ page, context }) => {
  const { state, calls } = await mockMaps(context)
  state.tilesFail = true; state.directoryFail = true
  await login(page, 'Map_Failure')
  await expect(page.locator('.map-session-note')).toContainText('地图请求受限')
  await expect(page.locator('[data-map-layer=main]')).toContainText('地图未完整加载')
  await page.getByLabel('搜索城市', { exact: true }).fill('深圳')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.city-card')).toHaveCount(1)
  await page.locator('.city-card').click()
  await expect(page.getByRole('link', { name: '2050 年 1 张照片', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '返回城市入口' }).click()
  await expect(page.locator('.map-session-note')).toContainText('地图请求受限')
  const failedCalls = calls.length
  state.directoryFail = false; state.boundaryFail = true; state.tilesFail = false
  await page.getByRole('button', { name: '重新核对地图', exact: true }).click()
  await expect(page.locator('.map-session-note')).toHaveText('城市位置已核对。')
  await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('.map-progress')).toContainText('暂未着色')
  expect(calls.length).toBe(failedCalls + 2)
  await expect(page.locator('[data-city-region]')).toHaveCount(0)
  state.boundaryFail = false
  await page.getByRole('button', { name: '重试区域', exact: true }).click()
  await expect(page.locator('[data-city-region]')).toHaveCount(1)
  await page.route('**/api/v1/me/atlas', route => route.abort('failed'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.map-progress')).toContainText('照片统计核对中')
  await expect(page.locator('.map-progress')).not.toContainText('0 座城市')
  await expect(page.locator('[data-city-region]')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('暂时连接不上')
  await page.unroute('**/api/v1/me/atlas')
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await expect(page.locator('[data-city-region]')).toHaveCount(1)
})

test('退出时取消边界请求，迟到响应不能污染另一账号', async ({ page, context }) => {
  const { state, calls } = await mockMaps(context)
  state.holdBoundary = true
  await login(page, 'Map_Failure')
  await expect.poll(() => calls.some(c => c.keyword === '156440300')).toBe(true)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await login(page, 'Map_Two')
  state.release()
  await expect(page.locator('.map-session-note')).toHaveText('城市位置已核对。')
  await expect(page.locator('.map-progress')).toContainText('0 座城市已有照片')
  await expect(page.locator('[data-city-region]')).toHaveCount(0)
  await expect(page.locator('.map-marker.lit')).toHaveCount(0)
})
