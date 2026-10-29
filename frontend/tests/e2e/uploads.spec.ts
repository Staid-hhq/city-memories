import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'

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
  await expect(page.getByRole('button', { name: '上传并校验', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '上传并校验', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeEnabled()
  await expect(page.getByText('已传输，待保存到影集。', { exact: true })).toBeVisible()
}

async function resumeLegacyImport(page: Page, buffer: Buffer, name = 'synthetic.png') {
  const albumPath = new URL(page.url()).pathname
  const albumId = albumPath.split('/').at(-1)!
  const csrfResponse = await page.request.get('/api/v1/auth/csrf')
  expect(csrfResponse.status()).toBe(200)
  const csrf = (await csrfResponse.json()).data.csrf_token
  const response = await page.request.post(`/api/v1/albums/${albumId}/imports`, {
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': `legacy-upload-${randomUUID()}` },
    data: { items: [{ original_filename: name, byte_size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }] },
  })
  expect(response.status()).toBe(201)
  const batch = (await response.json()).data
  expect(batch.items).toHaveLength(1)
  await page.goto(`${albumPath}?import=${batch.id}`)
  await expect(page.getByRole('region', { name: '添加一张原图', exact: true })).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByLabel('选择原图', { exact: true })).toBeEnabled()
}

test('旧单张任务原字节保存、刷新恢复与另一个账号无法读取', async ({ page, browser }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await enterAlbum(page, '2040')
  const buffer = await syntheticImage(page)
  await resumeLegacyImport(page, buffer)
  await stage(page, buffer)
  await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('staged.png'), fullPage: true })
  await page.reload()
  await expect(page.getByRole('button', { name: '保存到影集', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByText('已加入影集，原图已独立保存。', { exact: true })).toBeVisible()
  await expect(page.getByText('1 张照片 · 已保存的年份影集')).toBeVisible()
  await page.getByRole('button', { name: '查看刚保存的照片', exact: true }).click()
  const image = page.getByRole('dialog').getByAltText('原图：synthetic.png')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(720)
  const originalUrl = `/api/v1/photos/${new URL(page.url()).searchParams.get('photo')}/original`
  const raw = await page.request.get(originalUrl)
  expect(raw.status()).toBe(200)
  expect(createHash('sha256').update(await raw.body()).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'))
  await page.screenshot({ path: testInfo.outputPath('saved-original.png'), fullPage: true })
  await page.reload()
  await expect(page.getByRole('dialog').getByAltText('原图：synthetic.png')).toBeVisible()
  await expect(page.getByText('1 张照片 · 已保存的年份影集')).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const other = await otherContext.newPage()
    await enterAlbum(other, '2040', 'Albums_Two')
    expect((await other.request.get(originalUrl)).status()).toBe(404)
    await expect(other.locator('.photo-card')).toHaveCount(0)
  } finally { await otherContext.close() }
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get(originalUrl)).status()).toBe(401)
  await expect(page.locator('.photo-card')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('旧单张任务上传及提交响应丢失仍可重试，重复文件作为独立照片保留', async ({ page }) => {
  await enterAlbum(page, '2041')
  const buffer = await syntheticImage(page)
  await resumeLegacyImport(page, buffer, 'retry.png')
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
  await expect(page.locator('.photo-card')).toHaveCount(1)
  const firstId = await page.locator('.photo-card').first().getAttribute('data-photo-id')
  await page.getByRole('button', { name: '继续添加一张', exact: true }).click()
  const uploadPanel = page.getByRole('region', { name: '添加一张原图', exact: true })
  const uploadButton = uploadPanel.getByRole('button', { name: '上传并校验', exact: true })
  await expect(uploadPanel).toHaveAttribute('aria-busy', 'false')
  await expect(uploadButton).toBeDisabled()
  await expect(uploadButton).toHaveCSS('cursor', 'default')
  await expect(uploadPanel.getByText('请先选择一张图片，再点击“上传并校验”。', { exact: true })).toBeVisible()
  await expect(uploadPanel.getByRole('link', { name: '一次上传多张照片', exact: true })).toBeVisible()
  await stage(page, buffer, 'retry.png')
  await page.getByRole('button', { name: '保存到影集', exact: true }).click()
  await expect(page.getByText('2 张照片 · 已保存的年份影集')).toBeVisible()
  await expect(page.locator('.photo-card')).toHaveCount(2)
  expect(await page.locator('.photo-card').last().getAttribute('data-photo-id')).not.toBe(firstId)
})

test('旧单张任务损坏图片拒绝、取消暂存不增加照片、并发影集变更需要重新核对', async ({ page }) => {
  await enterAlbum(page, '2042')
  const invalid = Buffer.from('not an image')
  await resumeLegacyImport(page, invalid, 'invalid.png')
  await page.getByLabel('选择原图', { exact: true }).setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: invalid })
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

test('统一添加照片入口支持单张原图，保存后回到图库并保留原始字节', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await enterAlbum(page, '2043')
  const albumPath = new URL(page.url()).pathname
  const buffer = await syntheticImage(page)
  const filename = 'unified-single.png'
  await expect(page.locator('.photo-card')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '添加一张原图', exact: true })).toHaveCount(0)
  const entry = page.getByRole('link', { name: '添加照片', exact: true }).first()
  await expect(entry).toHaveAttribute('href', `${albumPath}/import`)
  await entry.click()
  await expect(page.getByRole('heading', { name: '添加照片', exact: true })).toBeVisible()
  const fileInput = page.getByLabel('选择照片', { exact: true })
  await expect(fileInput).toHaveAttribute('multiple', '')
  await fileInput.setInputFiles({ name: filename, mimeType: 'image/png', buffer })
  await expect(page.getByRole('heading', { name: '核对 1 张照片', exact: true })).toBeVisible()
  await page.getByLabel('我已核对全部文件的城市、年份和顺序').check()
  await page.getByRole('button', { name: '确认队列', exact: true }).click()
  await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
  const save = page.getByRole('button', { name: '保存本批全部照片', exact: true })
  await expect(save).toBeEnabled()
  const beforeSave = await page.request.get(`/api/v1${albumPath}/photos`)
  expect(beforeSave.status()).toBe(200)
  expect((await beforeSave.json()).data.photo_count).toBe(0)
  await save.click()
  await expect(page.getByText('已加入影集 1 项。', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '← 返回年份影集', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${albumPath}$`))
  await expect(page.getByText('1 张照片 · 已保存的年份影集', { exact: true })).toBeVisible()
  await expect(page.locator('.photo-card')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '添加一张原图', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('选择原图', { exact: true })).toHaveCount(0)
  const original = page.getByRole('button', { name: `查看原图：${filename}`, exact: true })
  await expect(original).toBeInViewport()
  await expect.poll(() => original.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(720)
  await page.screenshot({ path: testInfo.outputPath('unified-single-gallery-desktop.png'), fullPage: true })
  await original.click()
  const image = page.getByRole('dialog').getByAltText(`原图：${filename}`)
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(720)
  const photoId = new URL(page.url()).searchParams.get('photo')
  expect(photoId).toBeTruthy()
  const raw = await page.request.get(`/api/v1/photos/${photoId}/original`)
  expect(raw.status()).toBe(200)
  expect(createHash('sha256').update(await raw.body()).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'))
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.setViewportSize({ width: 360, height: 800 })
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await expect(original).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('unified-single-gallery-mobile.png'), fullPage: true })
  await page.getByRole('link', { name: '添加照片', exact: true }).click()
  await expect(fileInput).toHaveAttribute('multiple', '')
  await expect(page.getByRole('heading', { name: '添加照片', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
