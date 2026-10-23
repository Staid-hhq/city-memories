import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { joinChinaRegions } from '../../src/features/map/mapService'
import type { MapCity } from '../../src/features/map/mapService'

// Real bundled public geometry, isolated synthetic accounts. No online map key.
test('正式静态市界覆盖全部入口，实际页面无在线地图请求且窄屏可用', async ({ page, context }, info) => {
  const catalog = JSON.parse(readFileSync(new URL('../../../backend/src/city_memories/city-catalog.json', import.meta.url), 'utf8'))
  const cities: MapCity[] = catalog.cities.filter((city: { mapping_status: string }) => city.mapping_status === 'verified').map((city: MapCity) => ({ ...city, can_create: true }))
  const asset = JSON.parse(readFileSync(new URL('../../public/map-data/china-cities.v1.json', import.meta.url), 'utf8'))
  const joined = joinChinaRegions(asset, cities)
  expect(joined.items).toHaveLength(391)
  expect(Object.keys(joined.regions)).toHaveLength(391)
  expect(joined.provinceBorders.length).toBeGreaterThan(0)
  expect(joined.missing + joined.missingRegions).toBe(0)
  expect(cities.filter(city => city.unit_kind === 'taiwan-destination').every(city => !!joined.regions[city.id])).toBeTruthy()
  let externalCalls = 0, configCalls = 0, pageErrors = 0
  await context.route('https://**/*', route => { externalCalls++; return route.abort('failed') })
  page.on('pageerror', () => pageErrors++)
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/map/config') configCalls++ })
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('Map_Return')
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(page.locator('[data-city-region][data-lit="true"]')).toHaveCount(1)
  await expect(page.locator('.tile-layer, .map-marker')).toHaveCount(0)
  const stage = page.getByRole('region', { name: '中国城市地图', exact: true })
  await expect(stage).toBeVisible()
  await expect(page.locator('[data-map-layer="main"] .china-province-borders')).not.toHaveAttribute('d', '')
  await page.screenshot({ path: info.outputPath('china-city-map-desktop.png'), fullPage: true })
  await stage.screenshot({ path: info.outputPath('china-province-boundaries-overview.png') })
  await page.getByRole('button', { name: '放大地图', exact: true }).click()
  await page.getByRole('button', { name: '放大地图', exact: true }).click()
  await stage.screenshot({ path: info.outputPath('china-province-boundaries-enlarged.png') })
  await page.reload()
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await expect(page.locator('[data-city-region][data-lit="true"]')).toHaveCount(1)
  for (const width of [1024, 360, 320]) {
    await page.setViewportSize({ width, height: 940 })
    await page.getByRole('button', { name: '全国视图', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    if (width === 360) await page.screenshot({ path: info.outputPath('china-city-map-mobile.png'), fullPage: true })
  }
  expect(externalCalls).toBe(0)
  expect(configCalls).toBe(0)
  expect(pageErrors).toBe(0)
})
