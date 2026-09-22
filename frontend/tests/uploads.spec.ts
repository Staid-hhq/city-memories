import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'

async function enterAlbum(page: Page, year: string, username = 'Albums_One') {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
  await page.goto('/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301')
  await page.getByLabel('影集年份', { exact: true }).fill(year)
  await page.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(page.getByRole('heading', { name: `${year} 年`, exact: true })).toBeVisible()
}

async function syntheticImage(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 720; canvas.height = 420
    const context = canvas.getContext('2d')!
    context.fillStyle = '#e7d8b5'; context.fillRect(0, 0, 720, 420)
    context.fillStyle = '#829684'; context.fillRect(0, 220, 720, 200)
    context.fillStyle = '#bd7951'; context.beginPath(); context.arc(550, 95, 45, 0, Math.PI * 2); context.fill()
    context.fillStyle = '#394e44'; context.font = '24px sans-serif'; context.fillText('Synthetic test image - no private photo', 60, 350)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(data, 'base64')
}

async function stage(page: Page, buffer: Buffer, name = 'synthetic.png') {
  await page.getByLabel('选择原图', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer })
  await page.getByRole('button', { name: '上传并校验', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeEnabled()
  await expect(page.getByText('已传输，待保存到影集。', { exact: true })).toBeVisible()
}

test('单图原字节保存、刷新恢复与另一个账号无法读取', async ({ page, browser }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await enterAlbum(page, '2040')
  const buffer = await syntheticImage(page)
  await stage(page, buffer)
  await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('staged.png'), fullPage: true })
  await page.reload()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByText('已加入影集，原图已独立保存。', { exact: true })).toBeVisible()
  await expect(page.getByText('1 张照片 · 已保存的年份影集')).toBeVisible()
  const image = page.getByAltText('已独立保存的原图')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(720)
  const originalUrl = (await image.getAttribute('src'))!
  const raw = await page.request.get(originalUrl)
  expect(raw.status()).toBe(200)
  expect(createHash('sha256').update(await raw.body()).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'))
  await page.screenshot({ path: testInfo.outputPath('saved-original.png'), fullPage: true })
  await page.reload()
  await expect(page.getByAltText('已独立保存的原图')).toBeVisible()
  await expect(page.getByText('1 张照片 · 已保存的年份影集')).toBeVisible()
  const otherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' })
  try {
    const other = await otherContext.newPage()
    await enterAlbum(other, '2040', 'Albums_Two')
    expect((await other.request.get(originalUrl)).status()).toBe(404)
    await expect(other.getByAltText('已独立保存的原图')).toHaveCount(0)
  } finally { await otherContext.close() }
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get(originalUrl)).status()).toBe(401)
  await expect(page.getByAltText('已独立保存的原图')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('上传及提交响应丢失仍可重试，重复文件作为独立照片保留', async ({ page }) => {
  await enterAlbum(page, '2041')
  const buffer = await syntheticImage(page)
  await page.route('**/api/v1/imports/*/items/*/content', async (route) => {
    await route.fetch(); await route.abort('failed')
  })
  await page.getByLabel('选择原图', { exact: true }).setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer })
  await page.getByRole('button', { name: '上传并校验', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await page.unroute('**/api/v1/imports/*/items/*/content')
  await page.getByRole('button', { name: '上传并校验', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeEnabled()
  await page.route('**/api/v1/imports/*/commit', async (route) => {
    await route.fetch(); await route.abort('failed')
  })
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('未确认保存结果')
  await page.unroute('**/api/v1/imports/*/commit')
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByText('1 张照片 · 已保存的年份影集')).toBeVisible()
  const firstUrl = await page.getByAltText('已独立保存的原图').getAttribute('src')
  await page.getByRole('button', { name: '继续添加一张', exact: true }).click()
  await stage(page, buffer, 'retry.png')
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByText('2 张照片 · 已保存的年份影集')).toBeVisible()
  expect(await page.getByAltText('已独立保存的原图').getAttribute('src')).not.toBe(firstUrl)
})

test('损坏图片拒绝、取消暂存不增加照片、并发影集变更需要重新核对', async ({ page }) => {
  await enterAlbum(page, '2042')
  await page.getByLabel('选择原图', { exact: true }).setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await page.getByRole('button', { name: '上传并校验', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('图片已损坏')
  await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
  await page.getByRole('button', { name: '取消本次导入', exact: true }).click()
  await expect(page.getByText('已取消，未加入影集；电脑上的源文件没有改变。')).toBeVisible()
  const buffer = await syntheticImage(page)
  await stage(page, buffer)
  await page.getByRole('button', { name: '取消本次导入', exact: true }).click()
  await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
  await stage(page, buffer)
  await page.route('**/api/v1/imports/*/commit', (route) => route.fulfill({ status: 409, json: { error: { code: 'ALBUM_CHANGED', message: '影集已有更新，请重新核对后保存' } } }))
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeDisabled()
  await page.unroute('**/api/v1/imports/*/commit')
  await page.getByRole('button', { name: '重新核对影集', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByText('1 张照片 · 已保存的年份影集')).toBeVisible()
})
