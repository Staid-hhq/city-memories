import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Album } from '../../src/features/albums/types'

const shenzhen = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const guangzhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const password = 'Only for T03 browser tests!'
type AlbumPage = { items: Album[]; next_cursor: string | null }

async function login(page: Page, username: string) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

async function register(page: Page, username: string) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await login(page, username)
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data
}

async function createAlbums(page: Page, entries: { city: string; year: number | null }[]) {
  const { csrf_token } = await read<{ csrf_token: string }>(page, '/auth/csrf')
  const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf_token }
  for (const entry of entries) {
    const response = await page.request.post(`/api/v1/cities/${entry.city}/albums`, {
      headers, data: { year: entry.year },
    })
    expect(response.status()).toBe(201)
  }
}

async function search(page: Page, value: string) {
  await page.getByLabel('搜索相册城市', { exact: true }).fill(value)
  await page.getByRole('button', { name: '搜索相册', exact: true }).click()
}

async function allAlbums(page: Page, query = '') {
  const path = `/me/albums${query ? `?${query}` : ''}`
  let result = await read<AlbumPage>(page, path)
  const items = [...result.items]
  while (result.next_cursor) {
    result = await read<AlbumPage>(page, `${path}${query ? '&' : '?'}cursor=${encodeURIComponent(result.next_cursor)}`)
    items.push(...result.items)
  }
  return items
}

async function assertCards(page: Page, albums: Album[]) {
  const cards = page.locator('.album-card')
  await expect(cards).toHaveCount(albums.length)
  for (const [index, album] of albums.entries()) {
    await expect(cards.nth(index)).toHaveAttribute('href', `/albums/${album.id}`)
    await expect(cards.nth(index).locator('.album-city-name')).toContainText(album.city.name)
    await expect(cards.nth(index).locator('.album-caption strong')).toHaveText(album.year === null ? '未标年份' : `${album.year} 年`)
  }
}

const isList = (url: URL) => url.pathname === '/api/v1/me/albums'

test('相册筛选查遍未加载页，组合城市与年份、最近排序、清除及返回位置，手机无溢出', async ({ page }, info) => {
  await register(page, 'Filters_Catalog')
  await createAlbums(page, [
    ...Array.from({ length: 25 }, (_, index) => ({ city: shenzhen, year: 2200 + index })),
    { city: guangzhou, year: 2229 }, { city: guangzhou, year: 2228 },
    { city: guangzhou, year: 2199 }, { city: shenzhen, year: null },
  ])
  await page.goto('/albums')
  await expect(page.locator('.album-card')).toHaveCount(24)
  await expect(page.getByLabel('相册排序', { exact: true })).toHaveValue('year')
  await expect(page.getByRole('button', { name: '清除筛选', exact: true })).toHaveCount(0)
  // The oldest year is outside the first page, but must still be selectable.
  const years = page.getByLabel('筛选相册年份', { exact: true })
  await expect(years.locator('option[value="2199"]')).toHaveCount(1)
  await expect(years.locator('option[value="unmarked"]')).toHaveCount(1)
  await years.selectOption('2199')
  await assertCards(page, await allAlbums(page, 'year=2199'))
  const trimmedSearch = page.waitForRequest(request => {
    const url = new URL(request.url())
    return isList(url) && url.searchParams.get('q') === '广州' && url.searchParams.get('year') === '2199'
  })
  await search(page, '  广州  ')
  await trimmedSearch
  await assertCards(page, await allAlbums(page, `q=${encodeURIComponent('广州')}&year=2199`))
  await expect(page.locator('.album-card')).toHaveCount(1)
  await years.selectOption('unmarked')
  await expect(page.getByRole('heading', { name: '没有找到符合条件的相册', exact: true })).toBeVisible()
  await search(page, '深圳')
  await assertCards(page, await allAlbums(page, `q=${encodeURIComponent('深圳')}&year=unmarked`))
  await expect(page.locator('.album-caption strong')).toHaveText('未标年份')
  await years.selectOption('')
  await expect(page.locator('.album-card')).toHaveCount(24)
  await page.getByLabel('相册排序', { exact: true }).selectOption('recent')
  const recent = await allAlbums(page, `q=${encodeURIComponent('深圳')}&sort=recent`)
  expect(recent).toHaveLength(26)
  expect(recent[0].year).toBeNull()
  await assertCards(page, recent.slice(0, 24))
  await page.getByRole('button', { name: '加载更多相册', exact: true }).click()
  await assertCards(page, recent)
  const last = page.locator('.album-card').last()
  await last.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => window.scrollY)
  await last.click()
  await expect(page).toHaveURL(new RegExp(`/albums/${recent.at(-1)!.id}$`))
  await page.getByRole('link', { name: '← 返回我的相册', exact: true }).click()
  await assertCards(page, recent)
  await expect(page.getByLabel('搜索相册城市', { exact: true })).toHaveValue('深圳')
  await expect(years).toHaveValue('')
  await expect(page.getByLabel('相册排序', { exact: true })).toHaveValue('recent')
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThan(3)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await assertCards(page, (await allAlbums(page)).slice(0, 24))
  await expect(page.getByLabel('搜索相册城市', { exact: true })).toHaveValue('')
  await expect(years).toHaveValue('')
  await expect(page.getByLabel('相册排序', { exact: true })).toHaveValue('year')
  await expect(page.getByRole('button', { name: '清除筛选', exact: true })).toHaveCount(0)
  // Searching a parent region also uses the entire account's matching catalog.
  await search(page, '广东')
  await assertCards(page, (await allAlbums(page, `q=${encodeURIComponent('广东')}`)).slice(0, 24))
  await page.getByRole('button', { name: '加载更多相册', exact: true }).click()
  await expect(page.locator('.album-card')).toHaveCount(29)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('library-filters-desktop.png') })
  for (const width of [1024, 360, 320]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await expect(page.getByRole('button', { name: '搜索相册', exact: true })).toBeVisible()
    if (width === 360) await page.screenshot({ path: info.outputPath('library-filters-mobile.png') })
  }
})

test('筛选无结果有独立空态，组合条件请求失败后原条件重试', async ({ page }) => {
  await register(page, 'Filters_Recovery')
  await createAlbums(page, [{ city: shenzhen, year: 2301 }, { city: guangzhou, year: 2302 }])
  await page.goto('/albums')
  await expect(page.locator('.album-card')).toHaveCount(2)
  await page.route('**/api/v1/me/albums/options', route => route.abort('failed'))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('年份选项暂时不可用')
  await search(page, '广州')
  await assertCards(page, await allAlbums(page, `q=${encodeURIComponent('广州')}`))
  await page.unroute('**/api/v1/me/albums/options')
  await page.getByRole('button', { name: '重试读取年份', exact: true }).click()
  await expect(page.getByLabel('筛选相册年份', { exact: true }).locator('option[value="2301"]')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await search(page, '没有这个城市')
  await expect(page.getByRole('heading', { name: '没有找到符合条件的相册', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '第一本相册，从一座城市开始。', exact: true })).toHaveCount(0)
  await expect(page.locator('.album-card')).toHaveCount(0)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await expect(page.locator('.album-card')).toHaveCount(2)
  await search(page, '深圳')
  await page.getByLabel('筛选相册年份', { exact: true }).selectOption('2301')
  let failed = false
  const combination = (url: URL) => isList(url) && url.searchParams.get('q') === '深圳' && url.searchParams.get('year') === '2301' && url.searchParams.get('sort') === 'recent'
  await page.route(combination, route => { failed = true; return route.abort('failed') })
  await page.getByLabel('相册排序', { exact: true }).selectOption('recent')
  await expect.poll(() => failed).toBeTruthy()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.locator('.album-card')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '没有找到符合条件的相册', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('搜索相册城市', { exact: true })).toHaveValue('深圳')
  await expect(page.getByLabel('筛选相册年份', { exact: true })).toHaveValue('2301')
  await expect(page.getByLabel('相册排序', { exact: true })).toHaveValue('recent')
  await page.unroute(combination)
  await page.getByRole('button', { name: '重新加载相册', exact: true }).click()
  await assertCards(page, await allAlbums(page, `q=${encodeURIComponent('深圳')}&year=2301&sort=recent`))
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('筛选切换立即清掉旧卡，迟到响应不覆盖新筛选，换号后条件与年份不残留', async ({ page }) => {
  await register(page, 'Filters_Race')
  await createAlbums(page, [{ city: shenzhen, year: 2401 }, { city: guangzhou, year: 2402 }])
  await page.goto('/albums')
  await expect(page.locator('.album-card')).toHaveCount(2)
  function holdResponses() {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    return { captured: 0, ready: 0, delivered: 0, held, release }
  }
  const first = holdResponses()
  let phase = first
  const oldFilter = (url: URL) => isList(url) && url.searchParams.get('q') === '深圳'
  await page.route(oldFilter, async route => {
    // StrictMode can start and abort an extra request. Each handler belongs to
    // the phase that received it, even if route.fetch finishes after a switch.
    const batch = phase
    batch.captured++
    const response = await route.fetch()
    batch.ready++
    await batch.held
    await route.fulfill({ response }).catch(() => {})
    batch.delivered++
  })
  try {
    await search(page, '深圳')
    await expect.poll(() => first.ready).toBeGreaterThan(0)
    await expect(page.locator('.album-card')).toHaveCount(0)
    await search(page, '广州')
    await assertCards(page, await allAlbums(page, `q=${encodeURIComponent('广州')}`))
  } finally { first.release() }
  await expect.poll(() => first.delivered === first.captured).toBeTruthy()
  expect(first.captured).toBeGreaterThan(0)
  await expect(page.locator('.album-card')).toHaveCount(1)
  await expect(page.locator('.album-city-name')).toContainText('广州')
  const second = holdResponses()
  phase = second
  try {
    await search(page, '深圳')
    await expect.poll(() => second.ready).toBeGreaterThan(0)
    await expect(page.locator('.album-card')).toHaveCount(0)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.unroute(oldFilter)
    await login(page, 'Albums_Two')
    await page.goto('/albums')
  } finally { second.release() }
  await expect.poll(() => second.delivered === second.captured).toBeTruthy()
  expect(second.captured).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: '第一本相册，从一座城市开始。', exact: true })).toBeVisible()
  await expect(page.locator('.album-card')).toHaveCount(0)
  await expect(page.getByLabel('搜索相册城市', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('筛选相册年份', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('筛选相册年份', { exact: true }).locator('option[value="2401"], option[value="2402"]')).toHaveCount(0)
  await expect(page.getByLabel('相册排序', { exact: true })).toHaveValue('year')
  await expect(page.getByRole('button', { name: '清除筛选', exact: true })).toHaveCount(0)
})
