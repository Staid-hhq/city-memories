import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const city = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
async function login(page: Page, name = 'Trash_One') {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(name)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${name}` })).toBeVisible()
}
async function headers(page: Page) {
  const result = await (await page.request.get('/api/v1/auth/csrf')).json()
  return { Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': result.data.csrf_token }
}
async function read(page: Page, path: string) { return (await (await page.request.get(`/api/v1${path}`)).json()).data }
async function enter(page: Page, year: number, name = 'Trash_One') {
  await login(page, name)
  const albums = await read(page, `/cities/${city}/albums?limit=100`)
  const album = albums.items.find((a: { year: number }) => a.year === year)
  const photos = (await read(page, `/albums/${album.id}/photos?limit=100`)).items
  await page.goto(`/albums/${album.id}`)
  await expect(page.locator('.photo-card').first()).toBeVisible()
  return { album, photos }
}
async function change(page: Page, id: string, restore = false) {
  const path = restore ? `/trash/photos/${id}` : `/photos/${id}`
  const data = await read(page, path)
  const result = await page.request.post(`/api/v1${path}/${restore ? 'restore' : 'trash'}`, {
    headers: await headers(page), data: { expected_photo_revision: data.revision, expected_album_revision: data.album_revision },
  })
  expect(result.status()).toBe(200)
  return (await result.json()).data
}
async function confirmPage(page: Page, album: string, id: string) {
  await page.goto(`/albums/${album}/trash/${id}`)
  await expect(page.getByRole('button', { name: '确认移入回收站', exact: true })).toBeEnabled()
}

test('重复页明确选择一份删除，核对原图文字、取消及恢复到末尾', async ({ page }, info) => {
  const { album, photos } = await enter(page, 2090)
  const id = photos[0].id
  const bytes = await (await page.request.get(`/api/v1/photos/${id}/original`)).body()
  await page.request.patch(`/api/v1/photos/${id}/note`, { headers: await headers(page), data: { note: '只属于这一份的旅行文字 🌅', expected_photo_revision: 1 } })
  await page.getByRole('link', { name: '查看重复照片', exact: true }).click()
  await page.locator(`[data-photo-id="${id}"]`).getByRole('link', { name: /删除照片/ }).click()
  await expect(page.getByText('只属于这一份的旅行文字 🌅', { exact: true })).toBeVisible()
  expect((await read(page, `/albums/${album.id}`)).photo_count).toBe(4)
  await page.getByRole('link', { name: '← 返回影集，取消删除', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(4)
  await page.locator(`[data-photo-id="${id}"]`).getByRole('link', { name: /删除照片/ }).click()
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('.lifecycle-image img')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('trash-confirm-1024.png'), fullPage: true })
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click()
  await expect(page.getByText(/已移入回收站。只删除了选中的这一份/)).toBeVisible()
  expect((await read(page, `/albums/${album.id}`)).photo_count).toBe(3)
  expect((await read(page, `/albums/${album.id}/duplicates`)).items).toEqual([])
  expect(await (await page.request.get(`/api/v1/photos/${photos[3].id}/original`)).body()).toEqual(bytes)
  await page.getByRole('link', { name: '查看回收站中的照片', exact: true }).click()
  await expect(page.locator('.lifecycle-image img')).toBeVisible()
  await expect(page.getByText('只属于这一份的旅行文字 🌅', { exact: true })).toBeVisible()
  await expect(page.getByText(/剩余约 30 天/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('trash-restore-1024.png'), fullPage: true })
  await page.reload()
  await page.getByRole('button', { name: '恢复到原影集末尾', exact: true }).click()
  await expect(page.getByText('恢复已保存。请打开原影集查看，或核对当前状态。', { exact: true })).toBeVisible()
  await expect(page.getByText(/原影集内有 2 份相同内容/)).toBeVisible()
  await page.getByRole('link', { name: '打开原影集', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(4)
  expect(await page.locator('.photo-card').last().getAttribute('data-photo-id')).toBe(id)
  expect((await read(page, `/photos/${id}`)).note).toBe('只属于这一份的旅行文字 🌅')
  expect(await (await page.request.get(`/api/v1/photos/${id}/original`)).body()).toEqual(bytes)
})

test('删除前另一窗口更新文字，拒绝旧版本，核对后重新明确确认', async ({ page }) => {
  const { album, photos } = await enter(page, 2091)
  const id = photos[0].id
  await confirmPage(page, album.id, id)
  await page.request.patch(`/api/v1/photos/${id}/note`, { headers: await headers(page), data: { note: '另一窗口最新内容', expected_photo_revision: 1 } })
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click()
  await expect(page.getByText(/操作结果尚未确认/)).toBeVisible()
  await expect(page.getByRole('button', { name: '确认移入回收站', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '核对当前状态', exact: true }).click()
  await expect(page.getByText('另一窗口最新内容', { exact: true })).toBeVisible()
  expect((await read(page, `/photos/${id}`)).revision).toBe(2)
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click()
  await expect(page.getByText(/已移入回收站。只删除/)).toBeVisible()
  await change(page, id, true)
})

test('删除和恢复响应丢失，核对发现已完成且不会自动重放', async ({ page }) => {
  const { album, photos } = await enter(page, 2092)
  const id = photos[0].id
  await confirmPage(page, album.id, id)
  let deleted = 0
  await page.route(`**/api/v1/photos/${id}/trash`, async (route) => { deleted++; await route.fetch(); await route.abort('failed') })
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click()
  await expect(page.getByText(/操作结果尚未确认/)).toBeVisible()
  const deadline = (await read(page, `/trash/photos/${id}`)).purge_after
  await page.getByRole('button', { name: '核对当前状态', exact: true }).click()
  await expect(page.getByText(/照片当前在回收站中/)).toBeVisible()
  expect(deleted).toBe(1)
  expect((await read(page, `/trash/photos/${id}`)).purge_after).toBe(deadline)
  await page.getByRole('link', { name: '查看回收站中的照片', exact: true }).click()
  let restored = 0
  await page.route(`**/api/v1/trash/photos/${id}/restore`, async (route) => { restored++; await route.fetch(); await route.abort('failed') })
  await page.getByRole('button', { name: '恢复到原影集末尾', exact: true }).click()
  await expect(page.getByText(/操作结果尚未确认/)).toBeVisible()
  await page.getByRole('button', { name: '核对当前状态', exact: true }).click()
  await expect(page.getByText('照片当前已在影集中。请先查看当前位置。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复到原影集末尾', exact: true })).toHaveCount(0)
  expect(restored).toBe(1)
  expect((await read(page, `/photos/${id}`)).ordinal).toBe(3)
})

test('删除入口沿用未保存文字离开保护，选择继续编辑不丢草稿', async ({ page }) => {
  const { photos } = await enter(page, 2093)
  await page.locator(`[data-photo-id="${photos[0].id}"] .photo-open`).click()
  await page.getByLabel('照片文字', { exact: true }).fill('未保存的删除前草稿')
  await page.getByRole('link', { name: '移入回收站', exact: true }).last().click()
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('未保存的删除前草稿')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  await page.getByRole('link', { name: '移入回收站', exact: true }).last().click()
  await expect(page.getByText('未保存的删除前草稿', { exact: true })).toBeVisible()
  expect((await read(page, `/photos/${photos[0].id}`)).note).toBe('未保存的删除前草稿')
})

test('恢复前影集变化必须核对，删除最后一张保留空未标年份影集', async ({ page }) => {
  const { album, photos } = await enter(page, 2094)
  const id = photos[0].id
  const target = (await (await page.request.post(`/api/v1/cities/${city}/albums`, { headers: await headers(page), data: { year: null } })).json()).data
  const moved = await page.request.post(`/api/v1/photos/${id}/move`, { headers: await headers(page), data: { target_album_id: target.id, expected_photo_revision: 1, expected_source_revision: album.revision, expected_target_revision: target.revision } })
  expect(moved.status()).toBe(200)
  await change(page, id)
  expect((await read(page, `/albums/${target.id}`)).photo_count).toBe(0)
  await page.goto(`/trash/photos/${id}`)
  await expect(page.getByRole('button', { name: '恢复到原影集末尾', exact: true })).toBeEnabled()
  const current = await read(page, `/photos/${photos[1].id}`)
  const targetNow = await read(page, `/albums/${target.id}`)
  await page.request.post(`/api/v1/photos/${photos[1].id}/move`, { headers: await headers(page), data: { target_album_id: target.id, expected_photo_revision: current.revision, expected_source_revision: current.album_revision, expected_target_revision: targetNow.revision } })
  await page.getByRole('button', { name: '恢复到原影集末尾', exact: true }).click()
  await expect(page.getByText(/操作结果尚未确认/)).toBeVisible()
  await page.getByRole('button', { name: '核对当前状态', exact: true }).click()
  await expect(page.getByText('深圳市 · 未标年份', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复到原影集末尾', exact: true }).click()
  await expect(page.getByText(/恢复已保存/)).toBeVisible()
  expect((await read(page, `/photos/${id}`)).ordinal).toBe(2)
})

test('27 张回收站分页、变化使旧分页失效、换账号看不到上一人照片', async ({ page }, info) => {
  const { photos } = await enter(page, 2095, 'Trash_Pages')
  for (const photo of photos) await change(page, photo.id)
  await page.getByRole('link', { name: '回收站', exact: true }).click()
  await expect(page.locator('.trash-card')).toHaveCount(24)
  await page.getByRole('button', { name: '加载更多回收站照片', exact: true }).click()
  await expect(page.locator('.trash-card')).toHaveCount(27)
  await page.getByRole('heading', { name: '回收站', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.locator('.trash-card').first().locator('img')).toBeVisible()
  await expect.poll(() => page.locator('.trash-card').first().locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.screenshot({ path: info.outputPath('trash-list-1360.png') })
  await page.reload()
  await expect(page.locator('.trash-card')).toHaveCount(24)
  await change(page, photos[0].id, true)
  await page.getByRole('button', { name: '加载更多回收站照片', exact: true }).click()
  await expect(page.getByText('回收站内容或保留期限已有变化，请重新加载')).toBeVisible()
  await page.getByRole('button', { name: '重新加载回收站', exact: true }).click()
  await expect(page.getByText('已读取 24 / 26 张', { exact: false })).toBeVisible()
  const hiddenId = photos[1].id
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await login(page, 'Trash_Two')
  await page.goto('/trash')
  await expect(page.getByRole('heading', { name: '回收站是空的', exact: true })).toBeVisible()
  await page.goto(`/trash/photos/${hiddenId}`)
  await expect(page.getByText('请求的内容不存在', { exact: true })).toBeVisible()
  await expect(page.locator('.lifecycle-image img')).toHaveCount(0)
})

test('到期界面停止显示图片和恢复入口，不依赖浏览器墙钟', async ({ page }) => {
  const { photos } = await enter(page, 2096)
  const id = photos[0].id
  await change(page, id)
  // Controlled short server duration tests the UI only; exact 30-day authority
  // is independently tested against the real backend clock in test_trash.py.
  await page.route(`**/api/v1/trash/photos/${id}`, async (route) => {
    const response = await route.fetch(); const json = await response.json()
    json.data.remaining_ms = 1800
    await route.fulfill({ response, json })
  })
  await page.goto(`/trash/photos/${id}`)
  await expect(page.locator('.lifecycle-image img')).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复到原影集末尾', exact: true })).toBeEnabled()
  await expect(page.getByText('保留期限已到，不能再查看原图或恢复。', { exact: true })).toBeVisible()
  await expect(page.locator('.lifecycle-image img')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '恢复到原影集末尾', exact: true })).toHaveCount(0)
})

test('照片已被移动时旧删除页面不直接删除新影集照片', async ({ page }) => {
  const { album, photos } = await enter(page, 2097)
  const id = photos[0].id
  await confirmPage(page, album.id, id)
  const target = (await (await page.request.post(`/api/v1/cities/${city}/albums`, { headers: await headers(page), data: { year: 2100 } })).json()).data
  expect((await page.request.post(`/api/v1/photos/${id}/move`, { headers: await headers(page), data: { target_album_id: target.id, expected_photo_revision: 1, expected_source_revision: album.revision, expected_target_revision: target.revision } })).status()).toBe(200)
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click()
  await expect(page.getByText(/操作结果尚未确认/)).toBeVisible()
  await page.getByRole('button', { name: '核对当前状态', exact: true }).click()
  await expect(page.getByText('照片当前已在另一个影集中。请先查看当前位置。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认移入回收站', exact: true })).toHaveCount(0)
  expect((await read(page, `/photos/${id}`)).album_id).toBe(target.id)
})

test('回收站原图晚到时退出清除，换账号不会显示旧图片', async ({ page }) => {
  const { photos } = await enter(page, 2098)
  const id = photos[0].id
  await change(page, id)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested!: () => void
  const pending = new Promise<void>((resolve) => { requested = resolve })
  await page.route(`**/api/v1/trash/photos/${id}/original`, async (route) => {
    const response = await route.fetch(); requested(); await gate
    await route.fulfill({ response }).catch(() => {})
  })
  await page.goto(`/trash/photos/${id}`)
  await pending
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '翻开你的手帐' })).toBeVisible()
  release()
  await login(page, 'Trash_Two')
  await page.goto('/trash')
  await expect(page.getByRole('heading', { name: '回收站是空的' })).toBeVisible()
  await expect(page.locator('img')).toHaveCount(0)
})
