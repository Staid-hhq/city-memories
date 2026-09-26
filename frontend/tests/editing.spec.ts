import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const city = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('Editing_One')
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: '你好，Editing_One' })).toBeVisible()
}
async function enter(page: Page, year = 2060) {
  await login(page)
  const response = await page.request.get(`/api/v1/cities/${city}/albums`)
  const album = (await response.json()).data.items.find((item: { year: number }) => item.year === year)
  await page.goto(`/albums/${album.id}`)
  await expect(page.locator('.photo-card')).toHaveCount(24)
  return album.id as string
}
async function view(page: Page, name: string) {
  await page.getByRole('button', { name: `查看原图：${name}`, exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page.getByLabel('照片文字', { exact: true })).toBeVisible()
}
async function headers(page: Page) {
  const result = await (await page.request.get('/api/v1/auth/csrf')).json()
  return { Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': result.data.csrf_token }
}
async function rows(page: Page, album: string) {
  const response = await page.request.get(`/api/v1/albums/${album}/photos?limit=100`)
  return (await response.json()).data as { items: { id: string; position: number; original_filename: string }[]; album_revision: number }
}
const card = (page: Page, id: string) => page.locator(`[data-photo-id="${id}"]`)

test('纯文本、Unicode 字数与留空保存，刷新后文字仍对应原照片', async ({ page }, testInfo) => {
  await enter(page)
  await view(page, 'journey-01.png')
  const input = page.getByLabel('照片文字', { exact: true })
  const text = '  深圳的风景 🌅\n<script>window.notExecuted=true</script>  '
  await input.fill(text)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'journey-01.png' })).toBeVisible()
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  expect(await page.evaluate(() => 'notExecuted' in window)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('note-saved.png') })
  await page.reload()
  await expect(input).toHaveValue(text)
  await input.fill('🌅'.repeat(2001))
  await expect(page.getByText('文字超过 2000 字，请缩短后保存；不会截断你的内容。')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存文字', exact: true })).toBeDisabled()
  await input.fill('🌅'.repeat(2000))
  await expect(page.getByText('2000 / 2000 字 · 未保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  await input.fill('')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  await page.reload()
  await expect(input).toHaveValue('')
})

test('多窗口真实文字冲突保留草稿，需比较最新内容后明确选择', async ({ page, context }, testInfo) => {
  const album = await enter(page)
  await view(page, 'journey-02.png')
  const other = await context.newPage()
  await other.goto(`/albums/${album}`)
  await view(other, 'journey-02.png')
  await page.getByLabel('照片文字', { exact: true }).fill('窗口 A 尚未保存的草稿')
  await other.getByLabel('照片文字', { exact: true }).fill('窗口 B 已保存的新内容')
  await other.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(other.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  await page.bringToFront()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('窗口 A 尚未保存的草稿')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('照片文字或状态已有更新')
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('窗口 A 尚未保存的草稿')
  await page.getByRole('button', { name: '读取最新文字核对', exact: true }).click()
  await expect(page.locator('.note-conflict')).toContainText('窗口 B 已保存的新内容')
  await page.screenshot({ path: testInfo.outputPath('note-conflict.png') })
  await page.getByRole('button', { name: '保留我的草稿，按最新版本继续编辑', exact: true }).click()
  const id = new URL(page.url()).searchParams.get('photo')!
  const before = (await (await page.request.get(`/api/v1/photos/${id}`)).json()).data
  expect(before.note).toBe('窗口 B 已保存的新内容')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  expect((await (await page.request.get(`/api/v1/photos/${id}`)).json()).data.note).toBe('窗口 A 尚未保存的草稿')
  await other.close()
})

test('未保存文字关闭、切图、Esc 和浏览器返回都需确认，切回页面不丢稿', async ({ page }) => {
  await enter(page)
  await view(page, 'journey-03.png')
  const original = page.url()
  const input = page.getByLabel('照片文字', { exact: true })
  await input.fill('这段草稿不能静默丢失')
  await page.getByRole('button', { name: '下一张 →', exact: true }).click()
  await expect(page.getByText('还有未保存文字。要继续编辑，还是放弃草稿并离开？')).toBeVisible()
  expect(page.url()).toBe(original)
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '放弃草稿并离开', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.goBack()
  await expect(page.getByRole('button', { name: '放弃草稿并离开', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(input).toHaveValue('这段草稿不能静默丢失')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(input).toHaveValue('这段草稿不能静默丢失')
  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(true)
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.getByRole('button', { name: '放弃草稿并离开', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await view(page, 'journey-03.png')
  await expect(input).toHaveValue('')
})

test('文字保存响应丢失保留草稿，查询采用服务端结果不重复覆盖', async ({ page }) => {
  await enter(page)
  await view(page, 'journey-04.png')
  const id = new URL(page.url()).searchParams.get('photo')!
  await page.getByLabel('照片文字', { exact: true }).fill('响应丢失仍可核对')
  await page.route('**/api/v1/photos/*/note', async (route) => { await route.fetch(); await route.abort('failed') })
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('未保存文字仍在本页')
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('响应丢失仍可核对')
  await page.unroute('**/api/v1/photos/*/note')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('照片文字或状态已有更新')
  await page.getByRole('button', { name: '读取最新文字核对', exact: true }).click()
  await page.getByRole('button', { name: '采用最新文字', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存文字', exact: true })).toBeDisabled()
  const detail = (await (await page.request.get(`/api/v1/photos/${id}`)).json()).data
  expect(detail.note).toBe('响应丢失仍可核对')
  expect(detail.revision).toBe(2)
})

test('跨未加载分页后移、置顶置底、实际拖动手柄，文字原图跟随 ID', async ({ page }, testInfo) => {
  const album = await enter(page, 2061)
  const original = await rows(page, album)
  const ids = original.items.map((item) => item.id)
  const source = ids[23]
  const bytes = await (await page.request.get(`/api/v1/photos/${source}/original`)).body()
  await view(page, original.items[23].original_filename)
  await page.getByLabel('照片文字', { exact: true }).fill('跟随稳定 ID 的文字')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.getByRole('button', { name: '整理顺序', exact: true }).click()
  await card(page, source).getByRole('button', { name: '后移一位', exact: true }).click()
  await expect(page.getByText(/顺序已保存：journey-24.png：后移一位/)).toBeVisible()
  await page.getByRole('button', { name: '查看刚调整的照片', exact: true }).click()
  await expect(page.getByText('第 25 / 27 张', { exact: true })).toBeVisible()
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('跟随稳定 ID 的文字')
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(27)
  await card(page, source).getByRole('button', { name: '置顶', exact: true }).click()
  await expect(page.locator('.photo-card').first()).toHaveAttribute('data-photo-id', source)
  const cover = (await (await page.request.get(`/api/v1/albums/${album}`)).json()).data.cover_photo_id
  expect(cover).toBe(source)
  await card(page, source).getByRole('button', { name: '置底', exact: true }).click()
  await expect(page.locator('.photo-card').last()).toHaveAttribute('data-photo-id', source)
  const dragSource = card(page, ids[2]).getByRole('button', { name: /拖动排序/ })
  const target = card(page, ids[0])
  await dragSource.dragTo(target)
  await expect(page.locator('.photo-card').first()).toHaveAttribute('data-photo-id', ids[2])
  expect(await (await page.request.get(`/api/v1/photos/${source}/original`)).body()).toEqual(bytes)
  expect((await rows(page, album)).items.map((item) => item.id)).toEqual([ids[2], ids[0], ids[1], ...ids.slice(3, 23), ...ids.slice(24), source])
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.locator('.photo-card').first().scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('ordering-1024.png') })
  await page.reload()
  await expect(page.locator('.photo-card').first()).toHaveAttribute('data-photo-id', ids[2])
})

test('排序响应丢失和真实版本冲突不自动重放，保留操作上下文后重新核对', async ({ page }) => {
  const album = await enter(page, 2062)
  const original = await rows(page, album)
  const ids = original.items.map((item) => item.id)
  await page.getByRole('button', { name: '整理顺序', exact: true }).click()
  let writes = 0
  await page.route('**/api/v1/albums/*/reorder', async (route) => { writes++; await route.fetch(); await route.abort('failed') })
  await card(page, ids[0]).getByRole('button', { name: '置底', exact: true }).click()
  await expect(page.getByText(/排序结果未确认：journey-01.png：置底/)).toBeVisible()
  await expect(card(page, ids[0]).getByRole('button', { name: '置底', exact: true })).toBeDisabled()
  expect(writes).toBe(1)
  await page.unroute('**/api/v1/albums/*/reorder')
  await page.getByRole('button', { name: '重新加载照片列表', exact: true }).click()
  await expect(page.locator('.photo-card').first()).toHaveAttribute('data-photo-id', ids[1])
  expect((await rows(page, album)).items.at(-1)!.id).toBe(ids[0])
  const current = await rows(page, album)
  const response = await page.request.post(`/api/v1/albums/${album}/reorder`, {
    headers: await headers(page), data: { photo_id: ids[3], before_photo_id: ids[1], expected_album_revision: current.album_revision },
  })
  expect(response.status()).toBe(200)
  await card(page, ids[1]).getByRole('button', { name: '置底', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('影集已有更新')
  await expect(page.getByText(/排序结果未确认：journey-02.png：置底/)).toBeVisible()
  expect((await rows(page, album)).items.at(-1)!.id).toBe(ids[0])
  await page.getByRole('button', { name: '重新加载照片列表', exact: true }).click()
  await expect(page.locator('.photo-card').first()).toHaveAttribute('data-photo-id', ids[3])
})

test('文字保存中另一窗口退出，草稿和晚到响应不残留到登录页', async ({ page, context }) => {
  await enter(page)
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByRole('heading', { name: '你好，Editing_One' })).toBeVisible()
  await view(page, 'journey-05.png')
  await page.getByLabel('照片文字', { exact: true }).fill('只属于旧账号的未保存文字')
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let seen = false
  await page.route('**/api/v1/photos/*/note', async (route) => {
    seen = true
    await held
    await route.fulfill({ status: 200, json: { data: {} } }).catch(() => {})
  })
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect.poll(() => seen).toBe(true)
  await other.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  release()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveCount(0)
  await other.close()
})
