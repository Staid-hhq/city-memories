import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const shenzhen = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
const guangzhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const password = 'Only for T03 browser tests!'

async function login(page: Page, username = 'Albums_One') {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

async function create(page: Page, year: string | null) {
  if (year === null) await page.getByLabel('未标年份', { exact: true }).check()
  else await page.getByLabel('影集年份', { exact: true }).fill(year)
  await page.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(page).toHaveURL(/\/albums\/[a-f\d-]+$/)
  await expect(page.getByRole('heading', { name: year === null ? '未标年份' : `${year} 年`, exact: true })).toBeVisible()
  return page.url()
}

test('省级入口完整按城市拼音排列，搜索仍可找到其他城市，失败可重试', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const defaultRoute = '**/api/v1/cities?view=province-centers&limit=100'
  await page.route(defaultRoute, route => route.abort('failed'))
  await login(page, 'Map_Empty')
  const section = page.getByRole('region', { name: '选择一座城市', exact: true })
  const cards = section.locator('.city-card')
  await expect(section.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(cards).toHaveCount(0)
  await page.unroute(defaultRoute)
  await section.getByRole('button', { name: '重新加载', exact: true }).click()
  const names = [
    '澳门特别行政区', '北京市', '长春市', '长沙市', '成都市', '重庆市', '福州市', '广州市', '贵阳市',
    '哈尔滨市', '海口市', '杭州市', '合肥市', '呼和浩特市', '济南市', '昆明市', '兰州市', '拉萨市',
    '南昌市', '南京市', '南宁市', '上海市', '沈阳市', '石家庄市', '台北市', '太原市', '天津市',
    '武汉市', '乌鲁木齐市', '西安市', '香港特别行政区', '西宁市', '银川市', '郑州市',
  ]
  const regions = [
    '澳门特别行政区', '北京市', '吉林省', '湖南省', '四川省', '重庆市', '福建省', '广东省', '贵州省',
    '黑龙江省', '海南省', '浙江省', '安徽省', '内蒙古自治区', '山东省', '云南省', '甘肃省', '西藏自治区',
    '江西省', '江苏省', '广西壮族自治区', '上海市', '辽宁省', '河北省', '台湾省', '山西省', '天津市',
    '湖北省', '新疆维吾尔自治区', '陕西省', '香港特别行政区', '青海省', '宁夏回族自治区', '河南省',
  ]
  await expect(cards.locator('strong')).toHaveText(names)
  expect(await cards.locator('small').allTextContents().then(values => values.map(text => text.split(' · ')[0]))).toEqual(regions)
  expect(new Set(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('href')))).size).toBe(34)
  await expect(cards.filter({ hasText: '广东省' }).locator('strong')).toHaveText(['广州市'])
  await expect(section.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0)
  await section.getByRole('heading').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('province-entries-desktop.png') })
  await page.setViewportSize({ width: 360, height: 800 })
  await section.getByRole('heading').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('province-entries-mobile.png') })
  await page.setViewportSize({ width: 1360, height: 940 })
  await cards.filter({ hasText: '广州市' }).click()
  await expect(page).toHaveURL(new RegExp(`/cities/${guangzhou}$`))
  await expect(page.getByRole('heading', { name: '广州市', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '返回城市入口' }).click()
  await expect(cards).toHaveCount(34)
  await page.getByLabel('搜索城市', { exact: true }).fill('广东')
  await section.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(cards).toHaveCount(21)
  for (const name of ['广州市', '深圳市', '东莞市']) await expect(cards.filter({ hasText: name })).toHaveCount(1)
  await page.getByLabel('搜索城市', { exact: true }).fill('新疆')
  await section.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(cards).toHaveCount(24)
  await section.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(cards).toHaveCount(26)
  await expect(cards.filter({ hasText: '草湖市' })).toHaveCount(0)
  await page.getByLabel('搜索城市', { exact: true }).fill('深圳')
  await section.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(cards.locator('strong')).toHaveText(['深圳市'])
  await cards.first().click()
  await expect(page).toHaveURL(new RegExp(`/cities/${shenzhen}$`))
  await page.getByRole('link', { name: '返回城市入口' }).click()
  await page.getByLabel('搜索城市', { exact: true }).fill('广东')
  await section.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(cards).toHaveCount(21)
  await section.getByRole('button', { name: '返回省会列表', exact: true }).click()
  await expect(page.getByLabel('搜索城市', { exact: true })).toHaveValue('')
  await expect(cards.locator('strong')).toHaveText(names)
  expect(errors).toEqual([])
})

test('城市搜索、空年份、重复进入、未标年份唯一和重载保存', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await login(page)
  await expect(page.getByText('你的第一本手帐，还在等一个目的地。')).toBeVisible()
  await expect(page.getByText('城市搜索独立于地图服务', { exact: false })).toBeVisible()
  await page.getByLabel('搜索城市', { exact: true }).fill('不存在')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('当前开放的城市中没有')
  await page.getByLabel('搜索城市', { exact: true }).fill('深圳')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('link', { name: '深圳市 广东省 · 地级城市' }).click()
  await expect(page.getByText('这座城市，还没有你的年份影集。')).toBeVisible()
  await page.getByLabel('影集年份', { exact: true }).fill('0')
  await page.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(page.getByRole('alert')).toContainText('请输入 1–9999')
  const original = await create(page, '2026')
  await expect(page.getByRole('link', { name: '选择第一张照片', exact: true })).toBeVisible()
  await expect(page.locator('.upload-panel')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('empty-album.png'), fullPage: true })
  await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
  expect(await create(page, '2026')).toBe(original)
  await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
  await create(page, '2024')
  await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
  const unmarked = await create(page, null)
  await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
  expect(await create(page, null)).toBe(unmarked)
  await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
  await expect(page.locator('.album-caption strong')).toHaveText(['2026 年', '2024 年', '未标年份'])
  await page.reload()
  await expect(page.locator('.album-caption strong')).toHaveText(['2026 年', '2024 年', '未标年份'])
  await page.screenshot({ path: testInfo.outputPath('city-years.png'), fullPage: true })
  await page.getByRole('link', { name: '返回城市入口' }).click()
  await expect(page.getByText('1 本城市相册 · 3 本年份影集 · 0 张照片')).toBeVisible()
  await expect(page.getByText('暂无照片 · 尚未点亮')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('city-home.png'), fullPage: true })
  expect(errors).toEqual([])
})

test('保存响应丢失重试不重复、读取失败不冒充空列表', async ({ page }) => {
  await login(page)
  await page.goto(`/cities/${guangzhou}`)
  await page.route(`**/api/v1/cities/${guangzhou}/albums`, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    await route.fetch() // The server committed, but the browser loses the response.
    await route.abort('failed')
  })
  await page.getByLabel('影集年份', { exact: true }).fill('2025')
  await page.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.getByLabel('影集年份')).toHaveValue('2025')
  await page.unroute(`**/api/v1/cities/${guangzhou}/albums`)
  await create(page, '2025')
  await page.getByRole('link', { name: '返回广州市年份影集' }).click()
  await expect(page.locator('.album-card')).toHaveCount(1)
  await page.route(`**/api/v1/cities/${guangzhou}/albums`, (route) => route.abort('failed'))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.getByText('这座城市，还没有你的年份影集。')).toHaveCount(0)
  await page.unroute(`**/api/v1/cities/${guangzhou}/albums`)
  await page.getByRole('button', { name: '重新加载' }).click()
  await expect(page.locator('.album-card')).toHaveCount(1)
})

test('两个账号同城市年份隔离，退出和换号不残留私人影集', async ({ page, browser }) => {
  await login(page)
  await page.goto(`/cities/${shenzhen}`)
  const firstAlbum = await create(page, '2031')
  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const second = await secondContext.newPage()
  try {
    await login(second, 'Albums_Two')
    await second.goto(firstAlbum)
    await expect(second.getByRole('alert')).toContainText('不属于当前账号')
    await expect(second.getByRole('heading', { name: '2031 年' })).toHaveCount(0)
    await second.goto(`/cities/${shenzhen}`)
    await expect(second.getByText('这座城市，还没有你的年份影集。')).toBeVisible()
    expect(await create(second, '2031')).not.toBe(firstAlbum)
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.goBack()
    await expect(page.locator('.album-card')).toHaveCount(0)
    await login(page, 'Albums_Two')
    await page.goto(firstAlbum)
    await expect(page.getByRole('alert')).toContainText('不属于当前账号')
  } finally { await secondContext.close() }
})

test('超过一页的年份按序加载，失败重试保留已读影集', async ({ page }, testInfo) => {
  await login(page)
  const hezhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696303'
  const token = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrf_token
  for (let year = 2000; year <= 2024; year += 1) {
    const response = await page.request.post(`/api/v1/cities/${hezhou}/albums`, {
      headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': token }, data: { year },
    })
    expect(response.status()).toBe(201)
  }
  await page.goto(`/cities/${hezhou}`)
  await expect(page.locator('.album-card')).toHaveCount(24)
  await page.route('**/api/v1/cities/*/albums?cursor=*', (route) => route.abort('failed'))
  await page.getByRole('button', { name: '加载更多' }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await expect(page.locator('.album-card')).toHaveCount(24)
  await page.unroute('**/api/v1/cities/*/albums?cursor=*')
  await page.getByRole('button', { name: '加载更多' }).click()
  await expect(page.locator('.album-card')).toHaveCount(25)
  await expect(page.locator('.album-caption strong').first()).toHaveText('2024 年')
  await expect(page.locator('.album-caption strong').last()).toHaveText('2000 年')
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0)
  await page.setViewportSize({ width: 1024, height: 768 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('years-1024.png') })
})
