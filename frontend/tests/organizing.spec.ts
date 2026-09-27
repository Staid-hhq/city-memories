import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const shenzhen = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const guangzhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
async function login(page: Page, username = 'Organize_One') {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}
async function headers(page: Page) {
  const result = await (await page.request.get('/api/v1/auth/csrf')).json()
  return { Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': result.data.csrf_token }
}
async function enter(page: Page, year: number) {
  await login(page)
  const albums = (await (await page.request.get(`/api/v1/cities/${shenzhen}/albums?limit=100`)).json()).data.items
  const album = albums.find((a: { year: number }) => a.year === year)
  await page.goto(`/albums/${album.id}`)
  await expect(page.locator('.photo-card').first()).toBeVisible()
  const photos = (await (await page.request.get(`/api/v1/albums/${album.id}/photos`)).json()).data.items
  return { album, photos }
}
async function startMove(page: Page, id: string) {
  await page.locator(`[data-photo-id="${id}"]`).getByRole('link', { name: /移动照片/ }).click()
  await expect(page.getByLabel('目标城市', { exact: true })).toBeVisible()
}
async function chooseExisting(page: Page, city: string, year: string) {
  await page.getByLabel('目标城市', { exact: true }).selectOption(city)
  await page.locator('.target-year-list').getByRole('button', { name: new RegExp(`^${year}`) }).click()
  await expect(page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true })).toBeEnabled()
}
async function createTarget(page: Page, city: string, year: number | null) {
  await page.getByLabel('目标城市', { exact: true }).selectOption(city)
  if (year === null) await page.getByLabel('目标未标年份', { exact: true }).check()
  else await page.getByLabel('目标年份', { exact: true }).fill(String(year))
  await page.getByRole('button', { name: '创建并选择目标影集', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true })).toBeEnabled()
}
async function photo(page: Page, id: string) {
  return (await (await page.request.get(`/api/v1/photos/${id}`)).json()).data
}

test('跨城新建年份后确认移动，原图文字和 ID 不变，返回两边数量正确', async ({ page }, info) => {
  const { album, photos } = await enter(page, 2070)
  const id = photos[0].id
  const original = await (await page.request.get(`/api/v1/photos/${id}/original`)).body()
  await page.request.patch(`/api/v1/photos/${id}/note`, { headers: await headers(page), data: { note: '跨城保留的文字 🌅', expected_photo_revision: 1 } })
  await startMove(page, id)
  await createTarget(page, guangzhou, 2080)
  expect((await photo(page, id)).album_id).toBe(album.id)
  await page.setViewportSize({ width: 1024, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.locator('.target-year-list')).toContainText('2080 年')
  await page.screenshot({ path: info.outputPath('move-confirm-1024.png'), fullPage: true })
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect(page.getByRole('heading', { name: '移动已保存' })).toBeVisible()
  const moved = await photo(page, id)
  expect(moved.album_id).not.toBe(album.id)
  expect(moved.note).toBe('跨城保留的文字 🌅')
  expect(moved.ordinal).toBe(1)
  expect(await (await page.request.get(`/api/v1/photos/${id}/original`)).body()).toEqual(original)
  await page.getByRole('link', { name: '打开目标影集中的照片', exact: true }).click()
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue(moved.note)
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await expect(page.getByText('1 张照片 · 已保存的年份影集', { exact: true })).toBeVisible()
  await page.goto(`/albums/${album.id}`)
  await expect(page.locator('.photo-card')).toHaveCount(1)
})

test('移入已有相同内容仍全部保留，逐份查看和文字独立，关闭不删除', async ({ page }, info) => {
  const { photos } = await enter(page, 2071)
  await startMove(page, photos[0].id)
  await chooseExisting(page, guangzhou, '2080 年')
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect(page.getByText(/目标影集内有 2 份相同内容/)).toBeVisible()
  await page.getByRole('link', { name: '查看目标影集重复照片', exact: true }).click()
  await expect(page.locator('.duplicate-group')).toHaveCount(1)
  await expect(page.locator('.photo-card')).toHaveCount(2)
  expect(await page.getByRole('button', { name: /删除|去重/ }).count()).toBe(0)
  await page.locator(`[data-photo-id="${photos[0].id}"]`).getByRole('button').click()
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('')
  await page.getByLabel('照片文字', { exact: true }).fill('第二份自己的文字')
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.locator('.photo-card').first().getByRole('button').click()
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('跨城保留的文字 🌅')
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await expect(page.locator('.photo-card img')).toHaveCount(2)
  await expect.poll(() => page.locator('.photo-card img').evaluateAll((images) => images.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true)
  await page.screenshot({ path: info.outputPath('duplicate-copies.png') })
  await page.getByRole('link', { name: '← 返回影集，全部保留', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(2)
})

test('未标年份移动响应丢失，查询当前位置确认结果且不自动重放', async ({ page }) => {
  const { album, photos } = await enter(page, 2073)
  await startMove(page, photos[0].id)
  await createTarget(page, shenzhen, null)
  let writes = 0
  await page.route('**/api/v1/photos/*/move', async (route) => { writes++; await route.fetch(); await route.abort('failed') })
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('移动结果未确认')
  await expect(page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true })).toBeDisabled()
  await page.unroute('**/api/v1/photos/*/move')
  await page.getByRole('button', { name: '核对照片当前位置和版本', exact: true }).click()
  await expect(page.getByText(/已核对：照片当前位于 深圳市 · 未标年份/)).toBeVisible()
  expect(writes).toBe(1)
  expect((await photo(page, photos[0].id)).album_id).not.toBe(album.id)
  await page.getByRole('link', { name: /打开当前位置/ }).click()
  await expect(page.getByText('第 1 / 1 张', { exact: true })).toBeVisible()
})

test('目标顺序与照片文字真实并发更新需重新核对，不能静默覆盖', async ({ page }) => {
  const { album, photos } = await enter(page, 2074)
  await startMove(page, photos[0].id)
  await chooseExisting(page, guangzhou, '2080 年')
  const targets = (await (await page.request.get(`/api/v1/cities/${guangzhou}/albums`)).json()).data.items
  const target = targets.find((a: { year: number }) => a.year === 2080)
  const list = (await (await page.request.get(`/api/v1/albums/${target.id}/photos`)).json()).data
  expect((await page.request.post(`/api/v1/albums/${target.id}/reorder`, { headers: await headers(page), data: { photo_id: list.items[0].id, before_photo_id: null, expected_album_revision: list.album_revision } })).status()).toBe(200)
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('目标影集已有更新')
  expect((await photo(page, photos[0].id)).album_id).toBe(album.id)
  await page.getByRole('button', { name: '核对照片当前位置和版本', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true })).toBeEnabled()
  await page.request.patch(`/api/v1/photos/${photos[0].id}/note`, { headers: await headers(page), data: { note: '别的窗口刚保存的文字', expected_photo_revision: 1 } })
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('照片已有更新或移动')
  await page.getByRole('button', { name: '核对照片当前位置和版本', exact: true }).click()
  await expect(page.locator('.move-summary')).toContainText('别的窗口刚保存的文字')
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect(page.getByRole('heading', { name: '移动已保存' })).toBeVisible()
  expect((await photo(page, photos[0].id)).note).toBe('别的窗口刚保存的文字')
})

test('重复分组跨分页、失败保留已读项、移动使旧游标失效且不会漏项', async ({ page }) => {
  const { album, photos } = await enter(page, 2072)
  await page.getByRole('link', { name: '查看重复照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.route('**/duplicates?cursor=*', (route) => route.abort('failed'))
  await page.getByRole('button', { name: '加载更多重复照片', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上')
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.unroute('**/duplicates?cursor=*')
  await page.getByRole('button', { name: '重试加载更多重复照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(29)
  await expect(page.locator('.duplicate-group')).toHaveCount(2)
  const ids = await page.locator('.photo-card').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-photo-id')))
  expect(new Set(ids).size).toBe(29)
  await page.reload()
  await expect(page.locator('.photo-card')).toHaveCount(24)
  const destination = (await (await page.request.post(`/api/v1/cities/${guangzhou}/albums`, { headers: await headers(page), data: { year: 2090 } })).json()).data
  const p = await photo(page, photos[0].id)
  expect((await page.request.post(`/api/v1/photos/${p.id}/move`, { headers: await headers(page), data: { target_album_id: destination.id, expected_photo_revision: p.revision, expected_source_revision: p.album_revision, expected_target_revision: destination.revision } })).status()).toBe(200)
  await page.getByRole('button', { name: '加载更多重复照片', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('影集已有更新')
  await expect(page.getByRole('button', { name: '重试加载更多重复照片', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重新核对重复列表', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.getByRole('button', { name: '加载更多重复照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(28)
  expect((await (await page.request.get(`/api/v1/albums/${album.id}`)).json()).data.photo_count).toBe(29)
})

test('未保存文字阻止进入移动页，目标年份超过一页仍可选择，取消不移动', async ({ page }) => {
  const { album, photos } = await enter(page, 2075)
  const auth = await headers(page)
  for (let year = 2100; year < 2126; year++) await page.request.post(`/api/v1/cities/${guangzhou}/albums`, { headers: auth, data: { year } })
  await page.locator(`[data-photo-id="${photos[0].id}"]`).getByRole('button').click()
  await page.getByLabel('照片文字', { exact: true }).fill('尚未保存的移动前草稿')
  await page.getByRole('dialog').getByRole('link', { name: '移动到其他影集', exact: true }).click()
  await expect(page.getByText('还有未保存文字。要继续编辑，还是放弃草稿并离开？')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue('尚未保存的移动前草稿')
  await page.getByRole('dialog').getByRole('link', { name: '移动到其他影集', exact: true }).click()
  await page.getByRole('button', { name: '放弃草稿并离开', exact: true }).click()
  await page.getByLabel('目标城市', { exact: true }).selectOption(guangzhou)
  await page.getByRole('button', { name: '加载更多目标年份', exact: true }).click()
  await page.locator('.target-year-list').getByRole('button', { name: /^2100 年/ }).click()
  await expect(page.locator('.move-confirm')).toContainText('2100 年')
  await page.getByRole('link', { name: '← 返回原影集', exact: true }).click()
  expect((await photo(page, photos[0].id)).album_id).toBe(album.id)
  expect((await photo(page, photos[0].id)).note).toBe('')
})

test('读取失败不冒充无重复，移动在途退出清理且其他账号不能读旧资源', async ({ page, context }) => {
  const { album, photos } = await enter(page, 2076)
  await page.route('**/api/v1/albums/*/duplicates', (route) => route.abort('failed'))
  await page.getByRole('link', { name: '查看重复照片', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上')
  await expect(page.getByText('当前影集没有文件内容完全相同的有效照片。')).toHaveCount(0)
  await page.unroute('**/api/v1/albums/*/duplicates')
  await page.getByRole('button', { name: '重新核对重复列表', exact: true }).click()
  await expect(page.getByText('当前影集没有文件内容完全相同的有效照片。')).toBeVisible()
  await page.getByRole('link', { name: '← 返回影集，全部保留', exact: true }).click()
  await startMove(page, photos[0].id)
  await chooseExisting(page, shenzhen, '未标年份')
  const other = await context.newPage(); await other.goto('/')
  await expect(other.getByRole('heading', { name: '你好，Organize_One' })).toBeVisible()
  let release: () => void = () => {}; let seen = false
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/photos/*/move', async (route) => { seen = true; await held; await route.fulfill({ status: 200, json: { data: {} } }).catch(() => {}) })
  await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
  await expect.poll(() => seen).toBe(true)
  await other.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  release()
  await expect(page.locator('.move-summary')).toHaveCount(0)
  await login(page, 'Organize_Two')
  expect((await page.request.get(`/api/v1/albums/${album.id}/duplicates`)).status()).toBe(404)
  expect((await page.request.get(`/api/v1/photos/${photos[0].id}/original`)).status()).toBe(404)
  await other.close()
})
