import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const password = 'Only for UI tests 2026!'

async function register(page: Page, username: string) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText('账号已创建，请使用新密码登录。')).toBeVisible()
}

async function login(page: Page, username: string) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

test('实际 Edge 注册、错误密码、网络失败、重名、重载和退出', async ({ page, context }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/login')
  console.log('Browser:', await page.evaluate(() => navigator.userAgent))
  await expect(page.getByRole('heading', { name: '翻开你的手帐' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true })
  await register(page, 'Ui_One')
  await page.getByLabel('密码', { exact: true }).fill('Deliberately wrong password')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('alert')).toHaveText('账号或密码不正确')
  await page.route('**/api/v1/auth/login', (route) => route.abort('failed'))
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('alert')).toContainText('暂时连接不上服务')
  await page.unroute('**/api/v1/auth/login')
  await login(page, 'Ui_One')
  await page.reload()
  await expect(page.getByRole('heading', { name: '你好，Ui_One' })).toBeVisible()
  const cookies = await context.cookies()
  expect(cookies.find((cookie) => cookie.name === 'city_memories_session')?.httpOnly).toBe(true)
  expect(await page.evaluate(() => document.cookie)).not.toContain('city_memories_session')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: '你好，Ui_One' })).toHaveCount(0)
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('ui_one')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByRole('alert')).toContainText('用户名已被使用')
  await expect(page).toHaveURL(/\/register$/)
  expect(errors).toEqual([])
})

test('两个独立账号与多窗口退出、换号不残留', async ({ page, context, browser }) => {
  await register(page, 'Ui_Alpha')
  await login(page, 'Ui_Alpha')
  const sibling = await context.newPage()
  await sibling.goto('/')
  await expect(sibling.getByRole('heading', { name: '你好，Ui_Alpha' })).toBeVisible()
  const separate = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' })
  const other = await separate.newPage()
  try {
    await register(other, 'Ui_Beta')
    await login(other, 'Ui_Beta')
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(sibling).toHaveURL(/\/login$/)
    await expect(sibling.getByText('Ui_Alpha', { exact: true })).toHaveCount(0)
    await other.reload()
    await expect(other.getByRole('heading', { name: '你好，Ui_Beta' })).toBeVisible()
    await login(page, 'Ui_Beta')
    await expect(sibling.getByRole('heading', { name: '你好，Ui_Beta' })).toBeVisible()
    await expect(page.getByText('Ui_Alpha', { exact: true })).toHaveCount(0)
  } finally {
    await separate.close()
  }
})

test('退出失败隐藏私人页面且允许重试，密码不匹配不提交', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_Recovery')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill('Different test password')
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致')
  await register(page, 'Ui_Recovery')
  await login(page, 'Ui_Recovery')
  await page.route('**/api/v1/auth/logout', (route) => route.abort('failed'))
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('alert')).toContainText('退出尚未完成')
  await expect(page.getByText('Ui_Recovery', { exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/auth/logout')
  await page.getByRole('button', { name: '重试退出' }).click()
  await expect(page).toHaveURL(/\/login$/)
})
