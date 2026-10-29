import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { geometryPath, parseBoundary, project, unproject } from '../../src/features/map/mapGeometry'
import type { Geometry, Point } from '../../src/features/map/mapGeometry'
import { joinChinaRegions } from '../../src/features/map/mapService'
import type { MapCity } from '../../src/features/map/mapService'

const sz = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const gz = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const catalog = JSON.parse(readFileSync(new URL('../../../backend/src/city_memories/city-catalog.json', import.meta.url), 'utf8'))
const cities: MapCity[] = catalog.cities.filter((c: { mapping_status: string }) => c.mapping_status === 'verified').map((c: MapCity) => ({ ...c, can_create: true }))
const wkt = 'MULTIPOLYGON (((113 22,115 22,115 24,113 24,113 22),(113.5 22.5,114.5 22.5,114.5 23,113.5 22.5)),((115.2 22,115.3 22,115.3 22.1,115.2 22)))'
const rectangle = (x: number, y: number): Geometry => [[[[x, y], [x + 1.4, y], [x + 1.4, y + 1.1], [x, y + 1.1], [x, y]]]]
// Synthetic rectangles exercise all reviewed business identities, never supplier data.
const asset = { schema_version: 1, revision: 'synthetic-test-only', background: [] as Geometry,
  province_borders: [[[113.2, 23.5], [115, 23.5]]] as Point[][],
  regions: cities.map((city, index) => {
  const center: Point = city.id === sz ? [114, 23] : city.id === gz ? [112, 25] : [74 + index % 26 * 2.2, 20 + Math.floor(index / 26) * 1.8]
  return { provider_code: city.provider_code, name: city.name, parent_name: city.parent_name, unit_kind: city.unit_kind,
    center, geometry: city.id === sz ? parseBoundary(wkt)! : rectangle(center[0] - 0.7, center[1] - 0.55) }
}) }

async function mockMaps(context: BrowserContext) {
  const calls = { assets: 0, external: 0, configuration: 0 }
  const state = { fail: false, hold: false, payload: structuredClone(asset), release: () => {} }
  const held = new Promise<void>(resolve => { state.release = resolve })
  await context.route('**/map-data/china-cities.v1.json', async route => {
    calls.assets++
    if (state.hold) await held
    if (state.fail) return route.abort('failed')
    await route.fulfill({ json: state.payload }).catch(() => {})
  })
  await context.route('**/api/v1/map/config', route => { calls.configuration++; return route.fulfill({ json: { data: { enabled: false, key: null, message: 'No map key in tests' } } }) })
  await context.route('https://*.tianditu.gov.cn/**', route => { calls.external++; return route.abort('failed') })
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
  return page.evaluate(async ({ path, data }) => {
    const modulePath = '/src/shared/api.ts'
    const { api } = await import(/* @vite-ignore */ modulePath)
    return api(path, { method: 'POST', body: JSON.stringify(data) })
  }, { path, data })
}
const litRegions = (page: Page) => page.locator('[data-city-region][data-lit="true"]')

test('市界逐条映射和台湾市县独立，拒绝重复编码和非法坐标', () => {
  const joined = joinChinaRegions(asset, cities)
  expect(joined.items).toHaveLength(391)
  expect(Object.keys(joined.regions)).toHaveLength(391)
  expect(joined.missing).toBe(0)
  expect(joined.missingRegions).toBe(0)
  expect(joined.provinceBorders).toEqual(asset.province_borders)
  expect(joined.provinceBorders[0]).toHaveLength(2) // Open province lines must not be closed as areas.
  const legacy = joinChinaRegions({ ...asset, province_borders: undefined }, cities)
  expect(legacy.provinceBorders).toEqual([])
  expect(Object.keys(legacy.regions)).toHaveLength(391)
  for (const province_borders of [null, 'invalid', [[]], [[[114, 23]]], [[[114, 23], [141, 23]]], [[[114, 23], [114, NaN]]], Array.from({ length: 10_001 }, () => [[114, 23], [115, 23]])]) {
    expect(() => joinChinaRegions({ ...asset, province_borders }, cities)).toThrow(/省界/)
  }
  const taiwan = cities.filter(city => city.unit_kind === 'taiwan-destination')
  expect(taiwan).toHaveLength(20)
  for (const city of taiwan) expect(joined.regions[city.id]).toBeTruthy()
  for (const change of [{ name: '错误城市' }, { parent_name: '错误省份' }, { unit_kind: 'municipality' }]) {
    const mismatch = cities.map(city => city.id === sz ? { ...city, ...change } : city)
    expect(joinChinaRegions(asset, mismatch).missing).toBe(1)
    expect(joinChinaRegions(asset, mismatch).regions[sz]).toBeUndefined()
  }
  expect(() => joinChinaRegions(asset, [...cities, cities[0]])).toThrow()
  const stopped = joinChinaRegions(asset, cities.filter(city => city.id !== sz))
  expect(stopped.items).toHaveLength(390)
  expect(stopped.regions[sz]).toBeUndefined()
  const partial = joinChinaRegions({ ...asset, regions: asset.regions.map(region => region.provider_code === cities.find(city => city.id === sz)!.provider_code ? { ...region, geometry: null } : region) }, cities)
  expect(partial.items).toHaveLength(391)
  expect(partial.missingRegions).toBe(1)
  expect(partial.regions[sz]).toBeUndefined()
  const duplicate = structuredClone(asset)
  duplicate.regions.push(duplicate.regions[0])
  expect(() => joinChinaRegions(duplicate, cities)).toThrow()
  const bad = structuredClone(asset)
  bad.regions[0].geometry[0][0][0][0] = 999
  expect(() => joinChinaRegions(bad, cities)).toThrow()
  expect(() => joinChinaRegions({ ...asset, schema_version: 999 }, cities)).toThrow()
})

test('地图投影与复合区域保持洞、离岛和坐标验证', () => {
  for (const point of [[73, 39], [114, 23], [135, 53]] as Point[]) {
    const result = unproject(project(point, 9), 9)
    expect(result[0]).toBeCloseTo(point[0], 8); expect(result[1]).toBeCloseTo(point[1], 8)
  }
  const geometry = parseBoundary(wkt)!
  expect(geometry.map(polygon => polygon.length)).toEqual([2, 1])
  expect(geometryPath(geometry, { center: [114, 23], zoom: 8 }, 800, 600).match(/M/g)).toHaveLength(3)
  for (const bad of ['SRID=3857;POLYGON((1 1,2 2,3 3))', 'POLYGON((999 1,2 2,3 3))', 'POLYGON((1 1,2 2))', 'POINT(1 1)', 'POLYGON((NaN 1,2 2,3 3))']) expect(parseBoundary(bad)).toBeNull()
})

test('完整城市入口灰底且没有世界瓦片，空影集不点亮，跨窗口导入和换号隔离', async ({ page, context }) => {
  const { calls } = await mockMaps(context)
  await login(page, 'Map_Empty')
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(litRegions(page)).toHaveCount(0)
  await expect(page.locator('.map-progress')).toHaveText('已点亮 0 座城市')
  await expect(page.locator('.tile-layer, .map-marker')).toHaveCount(0)
  await page.getByRole('region', { name: '中国城市地图', exact: true }).focus()
  await page.keyboard.press('Tab')
  await page.locator(`[data-city-region="${sz}"]`).focus()
  await expect(page.locator('.china-map-hover')).toContainText('广东省 · 深圳市')
  await expect(page.locator('.china-map-hover')).toContainText('0 张照片')
  await page.getByRole('region', { name: '中国城市地图', exact: true }).focus()
  const other = await context.newPage()
  await other.goto(`/cities/${sz}`)
  await other.getByLabel('影集年份', { exact: true }).fill('2040')
  await other.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(other).toHaveURL(/\/albums\//)
  await expect(page.locator('.saved-city')).toContainText('暂无照片 · 尚未点亮')
  await expect(litRegions(page)).toHaveCount(0)
  const png = Buffer.from(await other.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  const albumPath = new URL(other.url()).pathname
  await other.getByRole('link', { name: '添加照片', exact: true }).click()
  await other.getByLabel('选择照片', { exact: true }).setInputFiles({ name: 'synthetic-map-test.png', mimeType: 'image/png', buffer: png })
  await other.getByLabel('我已核对全部文件的城市、年份和顺序').check()
  await other.getByRole('button', { name: '确认队列', exact: true }).click()
  await other.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
  await other.getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveAttribute('data-lit', 'true')
  await expect(page.locator('.map-progress')).toHaveText('已点亮 1 座城市')
  await page.locator(`[data-city-region="${sz}"]`).focus()
  await expect(page.locator('.china-map-hover')).toContainText('1 张照片')
  const photo = (await read(other, `${albumPath}/photos`)).items[0]
  await other.close()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await login(page, 'Map_Two')
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(litRegions(page)).toHaveCount(0)
  expect((await page.request.get(`/api/v1/photos/${photo.id}/original`)).status()).toBe(404)
  expect(calls.external).toBe(0)
  expect(calls.configuration).toBe(0)
})

test('跨城移动、删除末张与恢复联动本人填色与市界，完整城市入口保留', async ({ page, context }) => {
  await mockMaps(context)
  await login(page, 'Map_One')
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveAttribute('data-lit', 'true')
  const boundaries = page.locator('[data-map-layer="main"] [data-city-boundary]')
  await page.mouse.move(8, 80)
  await expect(boundaries).toHaveAttribute('data-city-boundary', sz)
  const other = await context.newPage(); await other.goto('/')
  const album = (await read(page, `/cities/${sz}/albums`)).items[0]
  const photo = (await read(page, `/albums/${album.id}/photos`)).items[0]
  const target = await write(other, `/cities/${gz}/albums`, { year: 2051 })
  const current = await read(page, `/photos/${photo.id}`)
  await write(other, `/photos/${photo.id}/move`, { target_album_id: target.id, expected_photo_revision: current.revision, expected_source_revision: current.album_revision, expected_target_revision: target.revision })
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveAttribute('data-lit', 'false')
  await expect(page.locator(`[data-city-region="${gz}"]`)).toHaveAttribute('data-lit', 'true')
  await expect(boundaries).toHaveAttribute('data-city-boundary', gz)
  let detail = await read(page, `/photos/${photo.id}`)
  await write(other, `/photos/${photo.id}/trash`, { expected_photo_revision: detail.revision, expected_album_revision: detail.album_revision })
  await expect(litRegions(page)).toHaveCount(0)
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(boundaries).toHaveCount(0)
  detail = await read(page, `/trash/photos/${photo.id}`)
  await write(other, `/trash/photos/${photo.id}/restore`, { expected_photo_revision: detail.revision, expected_album_revision: detail.album_revision })
  await expect(page.locator(`[data-city-region="${gz}"]`)).toHaveAttribute('data-lit', 'true')
  await expect(boundaries).toHaveAttribute('data-city-boundary', gz)
  await other.close()
})

test('市界仅在有照片或临时查看时显示，鼠标移开和失焦复原，省界始终保留', async ({ page, context }, info) => {
  const { state } = await mockMaps(context)
  state.payload = JSON.parse(readFileSync(new URL('../../public/map-data/china-cities.v1.json', import.meta.url), 'utf8'))
  await login(page, 'Map_Return')
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  const main = page.locator('[data-map-layer="main"]')
  const stage = page.getByRole('region', { name: '中国城市地图', exact: true })
  const area = (id: string) => main.locator(`[data-city-region="${id}"]`)
  const boundary = (id: string) => main.locator(`[data-city-boundary="${id}"]`)
  await page.mouse.move(8, 80)
  await stage.focus()
  await expect(area(gz)).toHaveAttribute('data-lit', 'false')
  await expect(area(gz)).toHaveCSS('stroke', 'none')
  await expect(boundary(gz)).toHaveCount(0)
  await expect(boundary(sz)).toHaveCount(1)
  await expect(boundary(sz)).toHaveCSS('pointer-events', 'none')
  await expect(boundary(sz)).toHaveCSS('fill', 'none')
  await expect(boundary(sz)).toHaveCSS('vector-effect', 'non-scaling-stroke')
  await expect(page.locator(`[data-map-layer="south"] [data-city-boundary="${sz}"]`)).toHaveCount(1)
  const province = main.locator('.china-province-borders')
  const nation = main.locator('.china-national-borders')
  const provincePath = await province.getAttribute('d'), nationPath = await nation.getAttribute('d')
  const provinceStroke = await province.evaluate(element => getComputedStyle(element).stroke)
  expect(provinceStroke).not.toBe('none')
  await expect(province).toHaveCSS('pointer-events', 'none')
  await expect(province).toHaveCSS('vector-effect', 'non-scaling-stroke')
  expect(await boundary(sz).evaluate(element => !!(element.compareDocumentPosition(element.closest('svg')!.querySelector('.china-province-borders')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
  const plainFill = await area(gz).evaluate(element => getComputedStyle(element).fill)
  const litFill = await area(sz).evaluate(element => getComputedStyle(element).fill)
  await stage.screenshot({ path: info.outputPath('city-boundaries-overview.png') })
  await page.getByLabel('在地图中定位城市', { exact: true }).fill('广州')
  await page.getByRole('button', { name: '定位广州市', exact: true }).click()
  await page.getByRole('button', { name: '关闭城市定位', exact: true }).click()
  await stage.scrollIntoViewIfNeeded()
  await page.mouse.move(8, 80)
  await stage.focus()
  async function hover(id: string) {
    const point = await area(id).evaluate((element, cityId) => {
      const path = element as SVGPathElement, box = path.getBBox(), matrix = path.getScreenCTM()!
      // Use a real, visible interior point, respecting holes and nearby cities.
      for (const fraction of [.5, .35, .65, .2, .8]) for (const vertical of [.5, .35, .65, .2, .8]) {
        const local = new DOMPoint(box.x + box.width * fraction, box.y + box.height * vertical)
        const screen = local.matrixTransform(matrix)
        if (path.isPointInFill(local) && document.elementFromPoint(screen.x, screen.y)?.closest('[data-city-region]')?.getAttribute('data-city-region') === cityId) return { x: screen.x, y: screen.y }
      }
      return null
    }, id)
    expect(point, `visible interior point for ${id}`).not.toBeNull()
    await page.mouse.move(point!.x, point!.y)
    return point!
  }
  await hover(gz)
  await expect(boundary(gz)).toHaveClass(/is-hovered/)
  await expect(area(gz)).not.toHaveCSS('fill', plainFill)
  await expect(page.locator('.china-map-hover')).toContainText('广东省 · 广州市')
  await stage.screenshot({ path: info.outputPath('city-boundaries-hover.png') })
  await hover(sz)
  await expect(boundary(gz)).toHaveCount(0)
  await expect(area(gz)).toHaveCSS('fill', plainFill)
  await expect(boundary(sz)).toHaveClass(/is-hovered/)
  await page.mouse.move(8, 80)
  await expect(boundary(sz)).not.toHaveClass(/is-hovered/)
  await expect(area(sz)).toHaveCSS('fill', litFill)
  await expect(page.locator('.china-map-hover')).toHaveCount(0)
  await stage.screenshot({ path: info.outputPath('city-boundaries-restored.png') })
  await stage.focus(); await page.keyboard.press('Tab'); await area(gz).focus()
  await expect(boundary(gz)).toHaveClass(/is-hovered/)
  await hover(sz)
  await page.mouse.move(8, 80)
  await expect(boundary(gz)).toHaveClass(/is-hovered/) // The visible keyboard focus returns after a pointer preview ends.
  await stage.focus()
  await expect(boundary(gz)).toHaveCount(0)
  for (const city of cities.filter(city => city.unit_kind === 'municipality')) {
    await page.keyboard.press('Tab'); await area(city.id).focus()
    await expect(area(city.id)).toHaveAttribute('data-unit-kind', 'municipality')
    await expect(area(city.id)).toHaveClass(/is-hovered/)
    await expect(boundary(city.id)).toHaveCount(0)
    await expect(province).toHaveAttribute('d', provincePath!)
    await expect(nation).toHaveAttribute('d', nationPath!)
    await expect(province).toHaveCSS('stroke', provinceStroke)
    await stage.focus()
  }
  await page.keyboard.press('Tab'); await area(gz).focus()
  const start = await hover(gz)
  await page.mouse.down()
  await page.mouse.move(start.x + 48, start.y + 24, { steps: 4 })
  await page.mouse.up()
  await expect(page).toHaveURL(/\/$/)
  await expect(boundary(gz)).toHaveCount(0) // A real mouse drag takes over without leaving a focus-only highlight.
  await stage.focus()
  const lineWidth = await boundary(sz).evaluate(element => getComputedStyle(element).strokeWidth)
  await page.keyboard.press('+')
  await expect(boundary(sz)).toHaveCSS('stroke-width', lineWidth)
  await expect(boundary(sz)).toHaveCSS('vector-effect', 'non-scaling-stroke')
  await expect(province).toHaveCSS('stroke', provinceStroke)
})

test('小城定位、区域点击、拖动缩放和返回视角，窄屏没有横向溢出', async ({ page, context }) => {
  await mockMaps(context)
  await login(page, 'Map_Return')
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await page.getByLabel('在地图中定位城市', { exact: true }).fill('深圳')
  await page.getByRole('button', { name: '定位深圳市', exact: true }).click()
  await page.getByRole('button', { name: '关闭城市定位', exact: true }).click()
  const stage = page.getByRole('region', { name: '中国城市地图', exact: true })
  await stage.focus(); await page.keyboard.press('+'); await page.keyboard.press('ArrowLeft')
  await stage.scrollIntoViewIfNeeded()
  const before = await stage.getAttribute('data-center')
  const box = (await stage.boundingBox())!
  const zoomBeforeDrag = Number(await stage.getAttribute('data-zoom'))
  const centerBeforeDrag = before!.split(',').map(Number) as Point
  const point = project([114.8, 23.5], zoomBeforeDrag), projectedCenter = project(centerBeforeDrag, zoomBeforeDrag)
  const x = box.x + box.width / 2 + point[0] - projectedCenter[0], y = box.y + box.height / 2 + point[1] - projectedCenter[1]
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-city-region]')?.getAttribute('data-city-region'), { x, y })).toBe(sz)
  await page.mouse.move(x, y)
  await expect(page.locator('.china-map-hover')).toContainText('广东省 · 深圳市')
  await expect(page.locator('.china-map-hover')).toContainText('1 张照片')
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveAccessibleName('广东省 · 深圳市，1 张照片，打开相册')
  await page.mouse.down(); await page.mouse.move(x + 60, y + 40, { steps: 5 }); await page.mouse.up()
  await expect(stage).not.toHaveAttribute('data-center', before!)
  await expect(page).toHaveURL(/\/$/)
  const center = await stage.getAttribute('data-center'), zoom = await stage.getAttribute('data-zoom')
  await page.locator(`[data-city-region="${sz}"]`).focus(); await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/cities/${sz}$`))
  await page.getByRole('link', { name: '返回城市入口' }).click()
  await expect(stage).toHaveAttribute('data-center', center!)
  await expect(stage).toHaveAttribute('data-zoom', zoom!)
  for (const width of [1024, 360, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.getByRole('button', { name: '全国视图', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  }
})

test('地图内滚轮缩放、地图外滚动页面，缩放边界显示普通光标，按钮与键盘仍可缩放', async ({ page, context }) => {
  await mockMaps(context)
  await login(page, 'Map_Return')
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  const stage = page.getByRole('region', { name: '中国城市地图', exact: true })
  const zoomIn = page.getByRole('button', { name: '放大地图', exact: true })
  const zoomOut = page.getByRole('button', { name: '缩小地图', exact: true })
  await page.getByRole('button', { name: '全国视图', exact: true }).click()
  await expect(zoomOut).toBeDisabled()
  await zoomOut.hover()
  await expect(zoomOut).toHaveCSS('cursor', 'default')
  await stage.scrollIntoViewIfNeeded()
  const zoom = Number(await stage.getAttribute('data-zoom'))
  const scroll = await page.evaluate(() => window.scrollY)
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120))
  await page.mouse.wheel(0, -360)
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeGreaterThan(zoom)
  await expect(zoomOut).toBeEnabled()
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
  await page.mouse.wheel(0, 360)
  await expect(zoomOut).toBeDisabled()
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeCloseTo(zoom, 8)
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
  await page.mouse.wheel(0, 360)
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeCloseTo(zoom, 8)
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
  await zoomIn.click()
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeGreaterThan(zoom)
  const enlarged = Number(await stage.getAttribute('data-zoom'))
  await zoomOut.click()
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeLessThan(enlarged)
  await stage.focus()
  await page.keyboard.press('+')
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeGreaterThan(zoom)
  for (let step = 0; step < 24; step++) await page.keyboard.press('+')
  await expect(stage).toHaveAttribute('data-zoom', '10')
  await expect(zoomIn).toBeDisabled()
  await zoomIn.hover()
  await expect(zoomIn).toHaveCSS('cursor', 'default')
  await stage.focus()
  const maxBox = (await stage.boundingBox())!
  const maxScroll = await page.evaluate(() => window.scrollY)
  await page.mouse.move(maxBox.x + maxBox.width / 2, maxBox.y + Math.min(maxBox.height / 2, 120))
  await page.mouse.wheel(0, -360)
  await expect(stage).toHaveAttribute('data-zoom', '10')
  await expect(zoomIn).toBeDisabled()
  await page.mouse.wheel(0, 360)
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeLessThan(10)
  await expect(zoomIn).toBeEnabled()
  expect(await page.evaluate(() => window.scrollY)).toBe(maxScroll)
  const reduced = Number(await stage.getAttribute('data-zoom'))
  await page.keyboard.press('-')
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeLessThan(reduced)
  const outsideScroll = await page.evaluate(() => window.scrollY)
  await page.mouse.move(8, 120)
  await page.mouse.wheel(0, 360)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(outsideScroll + 100)
})

test('触屏默认滑动页面，移动模式可二维拖图，取消后仍可操作并轻点城市返回原视角', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    await mockMaps(context)
    const page = await context.newPage()
    const touch = await context.newCDPSession(page)
    const frame = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const settleScroll = () => page.evaluate(() => new Promise<void>(resolve => {
      let previous = window.scrollY, stable = 0
      function check() {
        const current = window.scrollY
        stable = current === previous ? stable + 1 : 0
        previous = current
        if (stable >= 8) resolve()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }))
    async function swipe(start: Point, delta: Point, cancel = false) {
      const contact = (x: number, y: number) => [{ x, y, id: 0, radiusX: 4, radiusY: 4, force: 1 }]
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contact(...start) })
      for (let step = 1; step <= 12; step++) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: contact(start[0] + delta[0] * step / 12, start[1] + delta[1] * step / 12) })
        await frame()
      }
      await touch.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
      await frame()
      await settleScroll()
    }
    await login(page, 'Map_Return')
    await expect(page.locator('[data-city-region]')).toHaveCount(391)
    const stage = page.getByRole('region', { name: '中国城市地图', exact: true })
    const toggle = page.getByRole('button', { name: '移动地图', exact: true })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await stage.scrollIntoViewIfNeeded()
    const center = await stage.getAttribute('data-center'), zoom = await stage.getAttribute('data-zoom')
    let box = (await stage.boundingBox())!
    let scroll = await page.evaluate(() => window.scrollY)
    await swipe([box.x + box.width * .35, box.y + box.height * .7], [0, -160])
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scroll + 60)
    await expect(stage).toHaveAttribute('data-center', center!)
    await expect(stage).toHaveAttribute('data-zoom', zoom!)
    await expect(page).toHaveURL(/\/$/)

    await toggle.tap()
    const done = page.getByRole('button', { name: '完成移动', exact: true })
    await expect(done).toHaveAttribute('aria-pressed', 'true')
    await stage.scrollIntoViewIfNeeded()
    await settleScroll()
    box = (await stage.boundingBox())!
    scroll = await page.evaluate(() => window.scrollY)
    await swipe([box.x + box.width * .3, box.y + box.height * .35], [50, 45], true)
    await expect(stage).toHaveAttribute('data-center', center!)
    await swipe([box.x + box.width * .3, box.y + box.height * .35], [65, 55])
    const moved = (await stage.getAttribute('data-center'))!.split(',').map(Number)
    const original = center!.split(',').map(Number)
    expect(moved[0]).not.toBeCloseTo(original[0], 6)
    expect(moved[1]).not.toBeCloseTo(original[1], 6)
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
    await expect(stage).toHaveAttribute('data-zoom', zoom!)
    await expect(page).toHaveURL(/\/$/)

    await done.tap()
    await expect(page.getByRole('button', { name: '移动地图', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await stage.scrollIntoViewIfNeeded()
    box = (await stage.boundingBox())!
    scroll = await page.evaluate(() => window.scrollY)
    await swipe([box.x + box.width * .35, box.y + box.height * .7], [0, -160])
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scroll + 60)

    await page.getByLabel('在地图中定位城市', { exact: true }).fill('深圳')
    await page.getByRole('button', { name: '定位深圳市', exact: true }).tap()
    await stage.scrollIntoViewIfNeeded()
    const locatedCenter = (await stage.getAttribute('data-center'))!, locatedZoom = (await stage.getAttribute('data-zoom'))!
    box = (await stage.boundingBox())!
    const point = project([114.8, 23.5], Number(locatedZoom)), projectedCenter = project(locatedCenter.split(',').map(Number) as Point, Number(locatedZoom))
    const x = box.x + box.width / 2 + point[0] - projectedCenter[0], y = box.y + box.height / 2 + point[1] - projectedCenter[1]
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-city-region]')?.getAttribute('data-city-region'), { x, y })).toBe(sz)
    await page.touchscreen.tap(x, y)
    await expect(page).toHaveURL(new RegExp(`/cities/${sz}$`))
    await page.getByRole('link', { name: '返回城市入口' }).tap()
    await expect(stage).toHaveAttribute('data-center', locatedCenter)
    await expect(stage).toHaveAttribute('data-zoom', locatedZoom)
  } finally {
    await context.close()
  }
})

test('数据失败和缺失明确降级重试，统计失败不假报零照片', async ({ page, context }) => {
  const { state } = await mockMaps(context)
  state.fail = true
  await login(page, 'Map_Failure')
  await expect(page.locator('[data-city-region]')).toHaveCount(0)
  await expect(page.locator('.map-session-note')).toContainText(/暂不可用|失败|未能|连接/)
  await page.getByLabel('搜索城市', { exact: true }).fill('深圳')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.city-card')).toHaveCount(1)
  state.fail = false
  state.payload.regions = state.payload.regions.filter(region => region.provider_code !== cities.find(city => city.id === gz)!.provider_code)
  await page.getByRole('button', { name: '重新核对地图', exact: true }).click()
  await expect(page.locator('[data-city-region]')).toHaveCount(390)
  await expect(page.locator('.map-session-note')).toContainText(/未匹配|缺少|缺失|暂未|暂不可用/)
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveAttribute('data-lit', 'true')
  state.payload = structuredClone(asset)
  await page.getByRole('button', { name: '重新核对地图', exact: true }).click()
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await page.route('**/api/v1/me/atlas', route => route.abort('failed'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.map-progress')).toHaveText('正在核对照片统计…')
  await expect(page.locator('.map-progress')).not.toContainText('0 座城市')
  await expect(litRegions(page)).toHaveCount(0)
  await page.unroute('**/api/v1/me/atlas')
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await expect(page.locator(`[data-city-region="${sz}"]`)).toHaveAttribute('data-lit', 'true')
})

test('退出时取消地图加载，迟到响应不能带回上一账号点亮', async ({ page, context }) => {
  const { state, calls } = await mockMaps(context)
  state.hold = true
  await login(page, 'Map_Failure')
  await expect.poll(() => calls.assets).toBe(1)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await login(page, 'Map_Two')
  state.hold = false; state.release()
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(litRegions(page)).toHaveCount(0)
  await expect(page.locator('.map-progress')).toHaveText('已点亮 0 座城市')
})
