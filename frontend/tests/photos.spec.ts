import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'

async function login(page: Page, username = 'Photos_One') {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

async function enterAlbum(page: Page) {
  await login(page)
  await page.goto('/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301')
  await page.getByRole('link', { name: '2035 年 27 张照片' }).click()
  await expect(page.locator('.photo-card')).toHaveCount(24)
}

async function loadedViewer(page: Page, name: string) {
  const image = page.getByRole('dialog').getByAltText(`原图：${name}`)
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(720)
}

test('分页、视野原图卸载、跨页前后浏览、Esc 和浏览器返回保留位置', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL.bind(URL)
    Object.assign(window, { revokedOriginals: 0 })
    URL.revokeObjectURL = (url: string) => { (window as unknown as { revokedOriginals: number }).revokedOriginals += 1; original(url) }
  })
  await enterAlbum(page)
  const first = page.getByRole('button', { name: '查看原图：journey-01.png', exact: true })
  await first.scrollIntoViewIfNeeded()
  await expect(first.locator('img')).toBeVisible()
  expect(await page.locator('.photo-grid img').count()).toBeLessThan(24)
  const lastInPage = page.getByRole('button', { name: '查看原图：journey-24.png', exact: true })
  await lastInPage.scrollIntoViewIfNeeded()
  await expect(lastInPage.locator('img')).toBeVisible()
  await expect(first.locator('img')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { revokedOriginals: number }).revokedOriginals)).toBeGreaterThan(0)
  const scroll = await page.evaluate(() => window.scrollY)
  await lastInPage.click()
  await loadedViewer(page, 'journey-24.png')
  await expect(page.locator('.photo-grid img')).toHaveCount(0)
  await page.getByRole('button', { name: '下一张 →', exact: true }).click()
  await loadedViewer(page, 'journey-25.png')
  await expect(page.getByText('第 25 / 27 张', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await loadedViewer(page, 'journey-26.png')
  await page.keyboard.press('ArrowRight')
  await loadedViewer(page, 'journey-27.png')
  await expect(page.getByRole('button', { name: '下一张 →', exact: true })).toBeDisabled()
  await page.keyboard.press('ArrowLeft')
  await loadedViewer(page, 'journey-26.png')
  await page.screenshot({ path: testInfo.outputPath('original-viewer.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThan(2)
  await expect(lastInPage).toBeFocused()
  await lastInPage.click()
  await loadedViewer(page, 'journey-24.png')
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThan(2)
  await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(27)
  const ids = await page.locator('.photo-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-photo-id')))
  expect(new Set(ids).size).toBe(27)
  await page.setViewportSize({ width: 1024, height: 900 })
  await first.scrollIntoViewIfNeeded()
  await expect(first.locator('img')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('gallery-1024.png') })
  await first.click()
  await loadedViewer(page, 'journey-01.png')
  await expect(page.getByRole('button', { name: '← 上一张', exact: true })).toBeDisabled()
  await page.reload()
  await loadedViewer(page, 'journey-01.png')
  expect(errors).toEqual([])
})

test('列表、续页、详情和原图失败均能重试且不冒充空影集', async ({ page }) => {
  await login(page)
  const years = await page.request.get('/api/v1/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301/albums')
  const albumId = (await years.json()).data.items.find((album: { year: number }) => album.year === 2035).id
  await page.route('**/api/v1/albums/*/photos', (route) => route.abort('failed'))
  await page.goto(`/albums/${albumId}`)
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.getByText('位置已经留好，故事慢慢填满。')).toHaveCount(0)
  await page.unroute('**/api/v1/albums/*/photos')
  await page.getByRole('button', { name: '重新加载照片列表', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.route('**/api/v1/albums/*/photos?cursor=*', (route) => route.abort('failed'))
  await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.unroute('**/api/v1/albums/*/photos?cursor=*')
  await page.getByRole('button', { name: '重试加载更多照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(27)
  await page.route('**/api/v1/photos/*?*', (route) => route.abort('failed'))
  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('暂时连接不上服务')
  await page.unroute('**/api/v1/photos/*?*')
  await page.getByRole('button', { name: '重试读取照片资料', exact: true }).click()
  await loadedViewer(page, 'journey-01.png')
  await page.route('**/api/v1/photos/*/original', (route) => route.fulfill({ status: 503, json: { error: { code: 'ORIGINAL_UNAVAILABLE' } } }))
  await page.getByRole('button', { name: '下一张 →', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('原图暂时无法读取')
  await page.unroute('**/api/v1/photos/*/original')
  await page.getByRole('button', { name: '重试读取原图', exact: true }).click()
  await loadedViewer(page, 'journey-02.png')
})

test('真实新导入使旧分页和前后浏览失效，需要明确重新核对', async ({ page }) => {
  await enterAlbum(page)
  const albumId = new URL(page.url()).pathname.split('/').at(-1)!
  const list = (await (await page.request.get(`/api/v1/albums/${albumId}/photos`)).json()).data
  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  await loadedViewer(page, 'journey-01.png')
  const buffer = await (await page.request.get(list.items[0].original_url)).body()
  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrf_token
  const headers = { Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': csrf }
  const batch = (await (await page.request.post(`/api/v1/albums/${albumId}/imports`, { headers: { ...headers, 'Idempotency-Key': 't05-concurrent-import' }, data: { items: [{ original_filename: 'concurrent.png', byte_size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }] } })).json()).data
  expect((await page.request.put(`/api/v1/imports/${batch.id}/items/${batch.items[0].id}/content`, { headers, multipart: { file: { name: 'concurrent.png', mimeType: 'image/png', buffer } } })).status()).toBe(200)
  expect((await page.request.post(`/api/v1/imports/${batch.id}/commit`, { headers, data: { expected_album_revision: list.album_revision } })).status()).toBe(200)
  await page.getByRole('button', { name: '下一张 →', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('影集已有更新')
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(0)
  await page.getByRole('button', { name: '重新核对照片', exact: true }).click()
  await loadedViewer(page, 'journey-02.png')
  await expect(page.getByText('第 2 / 28 张', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('影集已有更新')
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.getByRole('button', { name: '重新加载照片列表', exact: true }).click()
  await expect(page.getByText('已读取 24 / 28 张', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(28)
})

test('原图加载中退出和切换账号会撤销图片地址并拒绝旧资源', async ({ page, context }) => {
  await login(page)
  const years = (await (await page.request.get('/api/v1/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301/albums')).json()).data.items
  const album = years.find((item: { year: number }) => item.year === 2035)
  await page.goto(`/albums/${album.id}`)
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  await loadedViewer(page, 'journey-01.png')
  const photoId = new URL(page.url()).searchParams.get('photo')!
  const objectUrl = await page.getByRole('dialog').locator('img').getAttribute('src')
  let release = () => {}
  let waiting = false
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/photos/*/original', async (route) => {
    waiting = true
    await held
    await route.continue().catch(() => {})
  })
  await page.getByRole('button', { name: '下一张 →', exact: true }).click()
  await expect.poll(() => waiting).toBe(true)
  const another = await context.newPage()
  await another.goto('/')
  await expect(another.getByRole('heading', { name: '你好，Photos_One' })).toBeVisible()
  await another.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('img')).toHaveCount(0)
  release()
  await page.unroute('**/api/v1/photos/*/original')
  expect(await page.evaluate(async (url) => { try { await fetch(url!); return true } catch { return false } }, objectUrl)).toBe(false)
  await login(page, 'Photos_Two')
  expect((await page.request.get(`/api/v1/albums/${album.id}/photos`)).status()).toBe(404)
  expect((await page.request.get(`/api/v1/photos/${photoId}`)).status()).toBe(404)
  expect((await page.request.get(`/api/v1/photos/${photoId}/original`)).status()).toBe(404)
  await page.goto(`/albums/${album.id}?photo=${photoId}`)
  await expect(page.getByRole('alert')).toContainText('不属于当前账号')
  await expect(page.locator('img')).toHaveCount(0)
  await another.close()
})

test('原图最多同时传输两张，会话过期响应清理私人页面', async ({ page }) => {
  await login(page)
  const years = (await (await page.request.get('/api/v1/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301/albums')).json()).data.items
  const album = years.find((item: { year: number }) => item.year === 2035)
  let active = 0
  let peak = 0
  let count = 0
  await page.route('**/api/v1/photos/*/original', async (route) => {
    active += 1; count += 1; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.continue().catch(() => {})
    active -= 1
  })
  await page.goto(`/albums/${album.id}`)
  await page.locator('.photo-card').first().scrollIntoViewIfNeeded()
  await expect.poll(() => count).toBeGreaterThanOrEqual(3)
  expect(peak).toBe(2)
  await page.unroute('**/api/v1/photos/*/original')
  const targetId = await page.locator('.photo-card').nth(23).getAttribute('data-photo-id')
  await page.route(`**/api/v1/photos/${targetId}/original`, (route) => route.fulfill({ status: 401, json: { error: { code: 'SESSION_EXPIRED' } } }))
  // Scrolling triggers the 401 and intentionally unmounts this very element.
  await page.getByRole('button', { name: '查看原图：journey-24.png', exact: true }).evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('.photo-card, img')).toHaveCount(0)
  await expect(page.getByText('登录已过期，请重新登录。', { exact: true })).toBeVisible()
})
