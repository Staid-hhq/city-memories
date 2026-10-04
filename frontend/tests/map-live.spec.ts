import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

// Opt in only. Uses synthetic accounts/photos and the existing local browser key.
// No response dumps, request URLs, cookies, secrets or raw geometry are logged.
test('T13 live 官方目录逐条匹配、真实底图与深圳区域、冷暖加载', async ({ page, context }, info) => {
  test.skip(process.env.CITY_MEMORIES_LIVE_MAP !== '1', 'Real map calls require explicit opt-in')
  test.setTimeout(180_000)
  let directoryCalls = 0, boundaryCalls = 0, tiles = 0
  let pageErrors = 0
  page.on('pageerror', () => pageErrors++)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'api.tianditu.gov.cn' && url.pathname.endsWith('/administrative')) {
      if (url.searchParams.get('keyword') === '中华人民共和国') directoryCalls++
      else boundaryCalls++
    }
    if (/^t\d\.tianditu.gov.cn$/.test(url.hostname)) tiles++
  })
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('Map_Return')
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.locator('.map-session-note')).toHaveText('城市位置已核对。', { timeout: 35_000 })
  await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
  await expect(page.locator('[data-map-layer=south]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
  await expect(page.locator('[data-city-region]')).toHaveCount(1, { timeout: 35_000 })
  await page.screenshot({ path: info.outputPath('official-national.png'), fullPage: true })
  const timings: { kind: string; milliseconds: number }[] = []
  const network = await context.newCDPSession(page)
  await network.send('Network.enable')
  for (let index = 0; index < 5; index++) {
    await network.send('Network.setCacheDisabled', { cacheDisabled: true })
    const start = Date.now()
    await page.reload()
    await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
    await expect(page.locator('[data-map-layer=south]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
    await expect(page.locator('.map-session-note')).toHaveText('城市位置已核对。', { timeout: 35_000 })
    await expect(page.locator('[data-city-region]')).toHaveCount(1, { timeout: 35_000 })
    timings.push({ kind: 'fresh-page-http-cache-disabled', milliseconds: Date.now() - start })
    await network.send('Network.setCacheDisabled', { cacheDisabled: false })
    await page.locator('.saved-city').first().click()
    const warm = Date.now()
    await page.getByRole('link', { name: '返回城市入口' }).click()
    await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
    await expect(page.locator('[data-map-layer=south]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
    await expect(page.locator('[data-city-region]')).toHaveCount(1, { timeout: 35_000 })
    timings.push({ kind: 'same-account-return', milliseconds: Date.now() - warm })
  }
  for (const name of ['南海视图', '钓鱼岛相关区域']) {
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
    await page.screenshot({ path: info.outputPath(name === '南海视图' ? 'official-south.png' : 'official-islands.png'), fullPage: true })
  }
  await page.getByRole('button', { name: '全国视图', exact: true }).click()
  await page.locator('.map-marker.lit').click()
  await page.getByRole('button', { name: '定位深圳市', exact: true }).click()
  await page.getByRole('button', { name: '放大地图', exact: true }).click()
  await page.getByRole('button', { name: '放大地图', exact: true }).click()
  await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
  await expect(page.locator('[data-city-region]')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('official-shenzhen-region.png'), fullPage: true })
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.getByRole('button', { name: '全国视图', exact: true }).click()
  await expect(page.locator('[data-map-layer=main]')).toHaveAttribute('data-ready', 'true', { timeout: 35_000 })
  await page.screenshot({ path: info.outputPath('official-1024.png'), fullPage: true })
  expect(pageErrors).toBe(0)
  const summary = JSON.stringify({ timings, directoryCalls, boundaryCalls, tiles, pageErrors,
    note: 'Request events, not provider billing. Fresh pages disable browser HTTP cache; returns enable it and retain in-memory directory/geometry. Each timing waits for both map panels, directory and the one synthetic account photo region; not nationwide geometry or a cleared DNS/TLS/network cache.' }, null, 2)
  await writeFile(info.outputPath('map-live-summary.json'), summary)
  await info.attach('map-live-summary', { body: summary, contentType: 'application/json' })
})
