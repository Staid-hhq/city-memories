import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Album, Atlas } from '../../src/features/albums/types'

const shenzhen = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const guangzhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const recentRoute = '**/api/v1/me/albums?sort=recent&limit=3'

async function login(page: Page, username: string) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data
}

async function createAlbum(page: Page, cityId: string, year: number, notify = false) {
  if (notify) {
    return page.evaluate(async ({ cityId, year }) => {
      const modulePath = '/src/shared/api.ts'
      const { api } = await import(/* @vite-ignore */ modulePath)
      return api(`/cities/${cityId}/albums`, { method: 'POST', body: JSON.stringify({ year }) })
    }, { cityId, year })
  }
  const { csrf_token } = await read<{ csrf_token: string }>(page, '/auth/csrf')
  const response = await page.request.post(`/api/v1/cities/${cityId}/albums`, {
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf_token }, data: { year },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).data
}

function sidebar(page: Page) { return page.getByRole('complementary', { name: '我的旅行概览', exact: true }) }

async function assertStats(panel: Locator, atlas: Atlas) {
  for (const [label, value] of [
    ['已点亮城市', atlas.items.filter(item => item.lit && item.photo_count > 0).length],
    ['相册数', atlas.album_count], ['照片数', atlas.photo_count],
  ] as const) {
    await expect(panel.getByText(label, { exact: true }).locator('..').locator('dd')).toHaveText(String(value))
  }
}

async function assertRecent(page: Page) {
  const albums = (await read<{ items: Album[] }>(page, '/me/albums?sort=recent&limit=3')).items
  const links = sidebar(page).locator('.recent-album')
  await expect(links).toHaveCount(albums.length)
  for (const [index, album] of albums.entries()) {
    await expect(links.nth(index)).toHaveAttribute('href', `/albums/${album.id}`)
    await expect(links.nth(index)).toContainText(album.city.name)
    await expect(links.nth(index)).toContainText(album.year === null ? '未标年份' : `${album.year}`)
    await expect(links.nth(index)).toContainText(`${album.photo_count} 张照片`)
  }
  return albums
}

test('首页地图与旅行侧栏左右排列，最近整理按真实更新时间展示并返回首页，手机无横向溢出', async ({ page }, info) => {
  await login(page, 'Map_Return')
  for (const year of [2088, 2091, 2089, 2087]) await createAlbum(page, year % 2 ? shenzhen : guangzhou, year)
  // A real cover edit must bring the existing photographed album back to the top.
  const photographed = (await read<{ items: Album[] }>(page, '/me/albums')).items.find(album => album.cover_photo_id)!
  const { csrf_token } = await read<{ csrf_token: string }>(page, '/auth/csrf')
  const coverUpdate = await page.request.patch(`/api/v1/albums/${photographed.id}/cover`, {
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf_token },
    data: { photo_id: photographed.cover_photo_id, expected_revision: photographed.revision },
  })
  expect(coverUpdate.ok()).toBeTruthy()
  await page.reload()
  const panel = sidebar(page)
  await expect(panel.getByRole('heading', { name: '最近整理', exact: true })).toBeVisible()
  await expect(page.locator('[data-city-region]')).toHaveCount(391)
  await assertStats(panel, await read<Atlas>(page, '/me/atlas'))
  const recent = await assertRecent(page)
  expect(recent).toHaveLength(3)
  expect(recent[0].id).toBe(photographed.id)
  // Creation order differs from year order: the side panel must use recent API.
  expect(recent.map(album => album.year)).not.toEqual([...recent].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).map(album => album.year))
  const cover = panel.locator('.recent-album').filter({ has: page.locator('img') })
  await expect(cover).toHaveCount(1)
  await expect(cover.locator('img')).toBeVisible()
  const map = page.locator('.city-map')
  const mapBox = (await map.boundingBox())!, panelBox = (await panel.boundingBox())!
  expect(panelBox.x).toBeGreaterThan(mapBox.x + mapBox.width - 1)
  expect(Math.abs(panelBox.y - mapBox.y)).toBeLessThan(4)
  expect(panelBox.width).toBeGreaterThan(250)
  expect(panelBox.width).toBeLessThan(400)
  expect(mapBox.width / (mapBox.width + panelBox.width)).toBeGreaterThan(.6)
  expect(mapBox.width / (mapBox.width + panelBox.width)).toBeLessThan(.76)
  const stageBox = (await page.getByRole('region', { name: '中国城市地图', exact: true }).boundingBox())!
  expect(stageBox.height).toBeGreaterThan(500)
  expect(stageBox.height).toBeLessThan(600)
  await page.locator('.home-overview-grid').screenshot({ path: info.outputPath('home-sidebar-overview.png') })
  await page.screenshot({ path: info.outputPath('home-sidebar-desktop.png'), fullPage: true })
  await panel.locator('.recent-album').first().click()
  await expect(page).toHaveURL(new RegExp(`/albums/${recent[0].id}$`))
  await page.getByRole('link', { name: '← 返回首页', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(panel).toBeVisible()
  await panel.getByRole('link', { name: '我的相册', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的相册', exact: true })).toBeVisible()
  await page.goto('/')
  await panel.getByRole('link', { name: '选择城市', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择一座城市', exact: true })).toBeInViewport()
  for (const width of [1000, 360, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await page.evaluate(() => window.scrollTo(0, 0))
    const left = (await map.boundingBox())!, right = (await panel.boundingBox())!
    expect(right.y).toBeGreaterThanOrEqual(left.y + left.height - 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    if (width === 360) await page.screenshot({ path: info.outputPath('home-sidebar-mobile.png'), fullPage: true })
  }
})

test('旅行侧栏空态、加载和请求失败可手动重试，退出后迟到相册不串号', async ({ page }) => {
  await login(page, 'Map_Empty')
  const panel = sidebar(page)
  await assertStats(panel, await read<Atlas>(page, '/me/atlas'))
  await expect(panel.locator('.recent-album')).toHaveCount(0)
  await expect(panel).toContainText(/还没有|第一本|先选/)
  await page.route(recentRoute, route => route.abort('failed'))
  await page.reload()
  await expect(panel.getByRole('alert')).toContainText('暂时连接不上服务')
  await page.unroute(recentRoute)
  await panel.getByRole('button', { name: /重新加载|重试/ }).click()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel).toContainText(/还没有|第一本|先选/)
  await page.route('**/api/v1/me/atlas', route => route.abort('failed'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(panel).toContainText('足迹统计暂时不可用')
  await expect(panel.locator('dd')).toHaveCount(0)
  await page.unroute('**/api/v1/me/atlas')
  await panel.getByRole('button', { name: '重读足迹统计', exact: true }).click()
  await assertStats(panel, await read<Atlas>(page, '/me/atlas'))
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await login(page, 'Map_Return')
  let release!: () => void
  let captured = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(recentRoute, async route => {
    const response = await route.fetch()
    captured = true
    await held
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.reload()
    await expect.poll(() => captured).toBeTruthy()
    await expect(panel.getByRole('status').filter({ hasText: /读取|整理|相册|加载/ })).toBeVisible()
    await expect(panel.locator('.recent-album')).toHaveCount(0)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.unroute(recentRoute)
    await login(page, 'Map_Two')
  } finally { release() }
  await assertStats(panel, await read<Atlas>(page, '/me/atlas'))
  await expect(panel.locator('.recent-album')).toHaveCount(0)
  await expect(panel).toContainText(/还没有|第一本|先选/)
})

test('本人统计与最近整理在同页写入、跨窗口和回到页面时刷新', async ({ page, context }) => {
  await login(page, 'Map_Failure')
  const panel = sidebar(page)
  await assertRecent(page)
  let recentReads = 0
  await page.route(recentRoute, route => { recentReads++; return route.continue() })
  await createAlbum(page, guangzhou, 2081, true)
  await expect.poll(() => recentReads).toBeGreaterThan(0)
  await assertStats(panel, await read<Atlas>(page, '/me/atlas'))
  await assertRecent(page)
  const other = await context.newPage()
  await other.goto('/')
  await expect(sidebar(other)).toBeVisible()
  let before = recentReads
  await createAlbum(other, shenzhen, 2082, true)
  await expect.poll(() => recentReads).toBeGreaterThan(before)
  await assertStats(panel, await read<Atlas>(page, '/me/atlas'))
  await assertRecent(page)
  await other.close()
  before = recentReads
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => recentReads).toBeGreaterThan(before)
  before = recentReads
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => recentReads).toBeGreaterThan(before)
})
