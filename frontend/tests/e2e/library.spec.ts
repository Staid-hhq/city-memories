import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const shenzhen = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const guangzhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const password = 'Only for T03 browser tests!'

async function login(page: Page, username: string) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

async function read(page: Page, path: string) {
  const response = await page.request.get(`/api/v1${path}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data
}

async function token(page: Page) {
  return { Origin: new URL(page.url()).origin, 'X-CSRF-Token': (await read(page, '/auth/csrf')).csrf_token }
}

test('城市相册与年份影集分别分页、失败重试及两级返回已读位置', async ({ page }, info) => {
  await login(page, 'Albums_One')
  const headers = await token(page)
  const catalog = (await read(page, '/cities?limit=100')).items as { id: string; name: string }[]
  const cities = [{ id: shenzhen }, { id: guangzhou }, ...catalog.filter(city => ![shenzhen, guangzhou].includes(city.id)).slice(0, 25)]
  expect(cities).toHaveLength(27)
  for (const [index, city] of cities.entries()) {
    const response = await page.request.post(`/api/v1/cities/${city.id}/albums`, { headers, data: { year: 2100 + index } })
    expect(response.status()).toBe(201)
  }
  for (let year = 2128; year <= 2152; year++) {
    expect((await page.request.post(`/api/v1/cities/${shenzhen}/albums`, { headers, data: { year } })).status()).toBe(201)
  }
  expect((await page.request.post(`/api/v1/cities/${shenzhen}/albums`, { headers, data: { year: null } })).status()).toBe(201)
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的相册', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的相册', exact: true })).toBeVisible()
  await expect(page.locator('.album-card')).toHaveCount(24)
  await expect(page.locator('.city-map')).toHaveCount(0)
  await expect(page.locator('.city-album-card').first().locator('.album-city-name')).toContainText('深圳市')
  await expect(page.locator('.album-caption strong').first()).toHaveText('27 本年份影集')
  await expect(page.locator('.album-caption span').first()).toHaveText('0 张照片')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(255, 255, 255)')
  await page.locator('.city-album-card').first().click()
  await expect(page.getByRole('heading', { name: '深圳市', exact: true })).toBeVisible()
  await expect(page.locator('.year-album-card')).toHaveCount(24)
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.locator('.year-album-card')).toHaveCount(27)
  await expect(page.locator('.year-album-card .album-caption strong')).toHaveText([
    ...Array.from({ length: 25 }, (_, index) => `${2152 - index} 年`), '2100 年', '未标年份',
  ])
  await expect(page.locator('.year-album-card .album-caption span')).toHaveText(Array.from({ length: 27 }, () => '0 张照片'))
  await page.locator('.year-album-card').last().scrollIntoViewIfNeeded()
  const cityScroll = await page.evaluate(() => window.scrollY)
  await page.locator('.year-album-card').last().click()
  await expect(page.getByRole('heading', { name: '未标年份', exact: true })).toBeVisible()
  await page.locator('.back-link').click()
  await expect(page.getByRole('heading', { name: '深圳市', exact: true })).toBeVisible()
  await expect(page.locator('.year-album-card')).toHaveCount(27)
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - cityScroll)).toBeLessThan(3)
  await page.getByRole('link', { name: '← 返回我的相册', exact: true }).click()
  await expect(page.locator('.city-album-card')).toHaveCount(24)
  await page.route('**/api/v1/me/city-albums?cursor=*', route => route.abort('failed'))
  await page.getByRole('button', { name: '加载更多相册', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.locator('.album-card')).toHaveCount(24)
  await page.unroute('**/api/v1/me/city-albums?cursor=*')
  await page.getByRole('button', { name: '重试加载更多相册', exact: true }).click()
  await expect(page.locator('.album-card')).toHaveCount(27)
  expect(new Set(await page.locator('.city-album-card').evaluateAll(cards => cards.map(card => card.getAttribute('href')))).size).toBe(27)
  const last = page.locator('.album-card').last()
  await last.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => window.scrollY)
  await last.click()
  await expect(page.getByRole('heading', { name: '广州市', exact: true })).toBeVisible()
  await page.locator('.year-album-card').click()
  await expect(page.getByRole('heading', { name: '2101 年', exact: true })).toBeVisible()
  await page.locator('.back-link').click()
  await expect(page.getByRole('heading', { name: '广州市', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '← 返回我的相册', exact: true }).click()
  await expect(page.locator('.album-card')).toHaveCount(27)
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThan(3)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('library-desktop.png') })
})

test('相册空状态、首次加载失败和退出后的迟到响应不会串号', async ({ page }) => {
  await login(page, 'Albums_Two')
  await page.goto('/albums')
  await expect(page.getByRole('heading', { name: '第一本相册，从一座城市开始。' })).toBeVisible()
  await page.route('**/api/v1/me/city-albums', route => route.abort('failed'))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.getByText('第一本相册，从一座城市开始。', { exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/me/city-albums')
  await page.getByRole('button', { name: '重新加载相册', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第一本相册，从一座城市开始。' })).toBeVisible()
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  }
  await page.setViewportSize({ width: 1360, height: 940 })
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await login(page, 'Albums_One')
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/me/city-albums', async route => {
    const response = await route.fetch()
    await paused
    await route.fulfill({ response }).catch(() => {})
  })
  await page.goto('/albums')
  await expect(page.getByText('正在翻开你的相册…', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.unroute('**/api/v1/me/city-albums')
  await login(page, 'Albums_Two')
  await page.goto('/albums')
  release()
  await expect(page.getByRole('heading', { name: '第一本相册，从一座城市开始。' })).toBeVisible()
  await expect(page.locator('.album-card')).toHaveCount(0)
})

test('跨分页更换封面、刷新后保持、并发冲突核对与恢复自动封面', async ({ page }, info) => {
  await login(page, 'Photos_One')
  expect((await page.request.post(`/api/v1/cities/${shenzhen}/albums`, { headers: await token(page), data: { year: 2036 } })).status()).toBe(201)
  await page.goto('/albums')
  await expect(page.locator('.city-album-card')).toHaveCount(1)
  await expect(page.locator('.city-album-card .album-caption strong')).toHaveText('2 本年份影集')
  await expect(page.locator('.city-album-card .album-caption span')).toHaveText('27 张照片')
  await expect(page.locator('.city-album-card img')).toBeVisible()
  await page.locator('.city-album-card').click()
  await expect(page.locator('.year-album-card')).toHaveCount(2)
  await expect(page.locator('.year-album-card .album-caption strong')).toHaveText(['2036 年', '2035 年'])
  await page.locator('.year-album-card').filter({ hasText: '2035 年' }).click()
  const albumPath = new URL(page.url()).pathname
  const original = await read(page, albumPath)
  const initialPhotos = await read(page, `${albumPath}/photos`)
  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.reload()
  await expect(page.locator('.back-link')).toHaveAttribute('href', `/cities/${shenzhen}`)
  await page.getByRole('link', { name: '批量导入原图 全部加入当前影集 →', exact: true }).click()
  await page.reload()
  await page.getByLabel('选择多张原图', { exact: true }).setInputFiles({ name: 'origin-check.png', mimeType: 'image/png', buffer: Buffer.from('synthetic navigation file') })
  await page.getByLabel('我已核对全部文件的城市、年份和顺序').check()
  await page.getByRole('button', { name: '确认队列', exact: true }).click()
  await expect(page).toHaveURL(/\?queue=/)
  await page.getByRole('link', { name: '查看这个影集 ↗', exact: true }).click()
  await expect(page.locator('.back-link')).toHaveAttribute('href', `/cities/${shenzhen}`)
  await page.getByRole('link', { name: '批量导入原图 全部加入当前影集 →', exact: true }).click()
  await page.getByRole('link', { name: '← 返回年份影集', exact: true }).click()
  await expect(page.locator('.back-link')).toHaveAttribute('href', `/cities/${shenzhen}`)
  await page.getByRole('button', { name: '更换封面', exact: true }).click()
  let release!: () => void
  let refreshing = false
  const paused = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/v1${albumPath}/photos`, async route => {
    const response = await route.fetch()
    refreshing = true
    await paused
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '设为影集封面：journey-02.png', exact: true }).click()
  try {
    await expect.poll(() => refreshing).toBeTruthy()
    await expect(page.getByRole('status').filter({ hasText: '封面已保存' })).toBeVisible()
    await expect(page.getByText('封面已更新，照片顺序和原图保持不变。', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '查看原图：journey-01.png', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '加载更多照片', exact: true })).toBeDisabled()
  } finally { release() }
  await expect(page.getByRole('status').filter({ hasText: '封面已更新' })).toBeVisible()
  await page.unroute(`**/api/v1${albumPath}/photos`)
  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('第 1 / 27 张', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
  await expect(page.locator('.photo-card')).toHaveCount(27)
  const lastCard = page.locator('.photo-card').last()
  const coverId = await lastCard.getAttribute('data-photo-id')
  await lastCard.getByRole('button', { name: '设为影集封面：journey-27.png', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '封面已更新' })).toBeVisible()
  expect((await read(page, albumPath)).cover_photo_id).toBe(coverId)
  expect((await read(page, `${albumPath}/photos`)).items.map((p: { id: string }) => p.id)).toEqual(initialPhotos.items.map((p: { id: string }) => p.id))
  const cityCoverRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/photos/${coverId}/original` && response.ok())
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的相册', exact: true }).click()
  const cityAlbums = await read(page, '/me/city-albums')
  expect(cityAlbums.items).toHaveLength(1)
  expect(cityAlbums.items[0].cover_photo_id).toBe(coverId)
  expect(cityAlbums.items[0].album_count).toBe(2)
  expect(cityAlbums.items[0].photo_count).toBe(27)
  await cityCoverRead
  await expect(page.locator('.city-album-card img')).toBeVisible()
  await page.locator('.city-album-card').click()
  await page.locator('.year-album-card').filter({ hasText: '2035 年' }).click()
  await page.reload()
  expect((await read(page, albumPath)).cover_photo_id).toBe(coverId)
  await page.getByRole('button', { name: '更换封面', exact: true }).click()
  const current = await read(page, albumPath)
  const concurrentId = initialPhotos.items[2].id
  const concurrent = await page.request.patch(`/api/v1${albumPath}/cover`, { headers: await token(page), data: { photo_id: concurrentId, expected_revision: current.revision } })
  expect(concurrent.ok()).toBeTruthy()
  await page.getByRole('button', { name: '设为影集封面：journey-02.png', exact: true }).click()
  await expect(page.getByText('封面结果尚未确认，请重新加载照片列表核对后再选择。')).toBeVisible()
  expect((await read(page, albumPath)).cover_photo_id).toBe(concurrentId)
  await page.getByRole('button', { name: '重新加载照片列表', exact: true }).click()
  await expect(page.getByText('已读取 24 / 27 张', { exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '封面状态已核对' })).toBeVisible()
  await expect(page.getByText('封面结果尚未确认，请重新加载照片列表核对后再选择。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '恢复自动封面', exact: true }).click()
  await expect(page.getByText('已恢复自动封面，按影集顺序选择第一张有效照片。')).toBeVisible()
  expect((await read(page, albumPath)).cover_photo_id).toBe(original.cover_photo_id)
  for (const [entry, heading, back] of [
    ['查看重复照片', '重复照片查看', '← 返回影集，全部保留'],
    ['移动照片：journey-01.png', '移动到其他影集', '← 返回原影集'],
    ['删除照片：journey-01.png', '确认移入回收站', '← 返回影集，取消删除'],
  ]) {
    await page.getByRole('link', { name: entry, exact: true }).click()
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await page.getByRole('link', { name: back, exact: true }).click()
    await expect(page.getByRole('heading', { name: '2035 年', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => history.state?.usr?.cityAlbumOrigin)).toBe('/albums')
    await expect(page.getByRole('link', { name: '← 返回深圳市年份影集', exact: true })).toBeVisible()
  }
  expect((await read(page, albumPath)).photo_count).toBe(27)
  expect((await read(page, `${albumPath}/photos`)).items.map((p: { id: string }) => p.id)).toEqual(initialPhotos.items.map((p: { id: string }) => p.id))
  await page.getByRole('link', { name: '← 返回深圳市年份影集', exact: true }).click()
  await expect(page.getByRole('heading', { name: '深圳市', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '← 返回我的相册', exact: true }).click()
  await expect(page.locator('.album-card')).toHaveCount(1)
  for (const width of [1024, 360, 320]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    if (width === 360) await page.screenshot({ path: info.outputPath('library-mobile.png') })
  }
})
