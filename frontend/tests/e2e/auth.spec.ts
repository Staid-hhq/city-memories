import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const password = 'UiTest_2026!'

async function register(page: Page, username: string, registrationPassword = password) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(registrationPassword)
  await page.getByLabel('确认密码', { exact: true }).fill(registrationPassword)
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText('账号已创建，请使用新密码登录。')).toBeVisible()
}

async function login(page: Page, username: string, loginPassword = password) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(loginPassword)
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

function trackCredentialRequests(page: Page) {
  const requests: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (['/api/v1/auth/csrf', '/api/v1/auth/register', '/api/v1/auth/login'].includes(path)) requests.push(path)
  })
  return requests
}

test('注册密码长度和字符在提交前分类校验，不截断、不修改输入或发送请求', async ({ page }) => {
  const requests = trackCredentialRequests(page)
  await page.route('**/api/v1/auth/register', route => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNEXPECTED_REQUEST', message: '合成测试：此输入不应提交' } }),
  }))
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_Validation')
  const input = page.getByLabel('密码', { exact: true })
  const confirmation = page.getByLabel('确认密码', { exact: true })
  await expect(page.getByText('密码为 8–16 位，支持英文字母、数字和英文符号，不支持中文或空格。', { exact: true })).toBeVisible()
  for (const field of [input, confirmation]) {
    expect(await field.getAttribute('maxlength')).toBeNull()
    expect(await field.getAttribute('minlength')).toBeNull()
  }
  for (const value of ['', 'Ab_2026', 'Ab_2026!123456789']) {
    await input.fill(value)
    await confirmation.fill(value)
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('密码长度须为 8–16 位。')
    await expect(input).toHaveValue(value)
  }
  for (const value of ['ab中文12!x', ' abcdefgh', 'abcdefgh ', 'abc\tdefgh', 'abc\u00a0defgh', 'abc\u3000defgh', 'abcd\u200bEF!', 'abcédef!', 'abcdef🙂!', 'abcdＡB12']) {
    await input.fill(value)
    await confirmation.fill(value)
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。')
    await expect(input).toHaveValue(value)
  }
  expect(requests).toEqual([])
})

test('注册拒绝有界常见密码，确认密码按同规则检查后再核对一致性', async ({ page }) => {
  const requests = trackCredentialRequests(page)
  await page.route('**/api/v1/auth/register', route => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNEXPECTED_REQUEST', message: '合成测试：此输入不应提交' } }),
  }))
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_Weak')
  const input = page.getByLabel('密码', { exact: true })
  const confirmation = page.getByLabel('确认密码', { exact: true })
  const common = [
    '12345678', '123456789', '1234567890', '87654321', '00000000', '11111111', '88888888',
    'password', 'password1', 'password123', 'password123!', 'qwertyui', 'qwertyuiop', 'qwerty123',
    'abcd1234', 'abc12345', 'iloveyou', 'welcome1', 'admin123', 'admin12345', 'letmein1', 'changeme', 'cijianji',
    'PaSsWoRd', 'CIJIANJI',
  ]
  for (const value of common) {
    await input.fill(value)
    await confirmation.fill(value)
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('该密码过于常见，请换一个不易猜到的密码。')
    await expect(input).toHaveValue(value)
  }
  await input.fill(password)
  for (const [value, message] of [
    ['', '确认密码长度须为 8–16 位。'],
    ['Ab_2026', '确认密码长度须为 8–16 位。'],
    ['Ab_2026!123456789', '确认密码长度须为 8–16 位。'],
    ['ab中文12!x', '确认密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。'],
    ['PASSWORD', '确认密码过于常见，请换一个不易猜到的密码。'],
    ['uitest_2026!', '两次输入的密码不一致，请重新核对。'],
  ]) {
    await confirmation.fill(value)
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(message)
    await expect(confirmation).toHaveValue(value)
  }
  expect(requests).toEqual([])
})

test('密码与确认密码独立显隐，键盘可用且切换账号入口清空并隐藏', async ({ page }, testInfo) => {
  const requests = trackCredentialRequests(page)
  await page.route('**/api/v1/auth/register', route => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNEXPECTED_REQUEST', message: '合成测试：显隐按钮不应提交' } }),
  }))
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_Visibility')
  const input = page.getByLabel('密码', { exact: true })
  const confirmation = page.getByLabel('确认密码', { exact: true })
  await input.fill(password)
  await confirmation.fill(password)
  for (const field of [input, confirmation]) {
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toHaveAttribute('autocomplete', 'new-password')
  }
  const showPassword = page.getByRole('button', { name: '显示密码', exact: true })
  await expect(showPassword).toHaveAttribute('type', 'button')
  await expect(showPassword).toHaveAttribute('aria-controls', 'password')
  await expect(showPassword).toHaveAttribute('aria-pressed', 'false')
  await input.focus()
  await input.press('Tab')
  await expect(showPassword).toBeFocused()
  await page.keyboard.press('Enter')
  const hidePassword = page.getByRole('button', { name: '隐藏密码', exact: true })
  await expect(hidePassword).toBeFocused()
  await expect(hidePassword).toHaveAttribute('aria-pressed', 'true')
  await expect(input).toHaveAttribute('type', 'text')
  await expect(input).toHaveValue(password)
  await expect(confirmation).toHaveAttribute('type', 'password')
  await page.keyboard.press('Space')
  await expect(input).toHaveAttribute('type', 'password')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await confirmation.focus()
  await confirmation.press('Tab')
  const showConfirmation = page.getByRole('button', { name: '显示确认密码', exact: true })
  await expect(showConfirmation).toBeFocused()
  await expect(showConfirmation).toHaveAttribute('type', 'button')
  await expect(showConfirmation).toHaveAttribute('aria-controls', 'password-confirm')
  await expect(showConfirmation).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: '隐藏确认密码', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(confirmation).toHaveAttribute('type', 'text')
  await expect(confirmation).toHaveValue(password)
  await expect(input).toHaveAttribute('type', 'password')
  await page.getByRole('link', { name: '登录', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(input).toHaveAttribute('type', 'password')
  await expect(input).toHaveAttribute('autocomplete', 'current-password')
  await expect(page.getByText('请输入密码', { exact: true })).toBeVisible()
  await expect(confirmation).toHaveCount(0)
  await input.fill('  旧密码专用短句 2026  ')
  await page.getByRole('button', { name: '显示密码', exact: true }).click()
  await page.getByRole('link', { name: '注册', exact: true }).click()
  for (const field of [input, confirmation]) {
    await expect(field).toHaveValue('')
    await expect(field).toHaveAttribute('type', 'password')
  }
  expect(requests).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('register-password-controls.png'), fullPage: true })
})

test('登录只限制 8–128 个字符，保留 Unicode、空格及原始大小写', async ({ page }) => {
  const requests = trackCredentialRequests(page)
  const submitted: string[] = []
  await page.route('**/api/v1/auth/login', route => {
    submitted.push(route.request().postDataJSON().password as string)
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: '合成测试已收到登录请求' } }) })
  })
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_LegacyValidation')
  const input = page.getByLabel('密码', { exact: true })
  for (const value of ['', '1234567', 'x'.repeat(129)]) {
    await input.fill(value)
    await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('密码长度须为 8–128 个字符。')
    await expect(input).toHaveValue(value)
  }
  expect(requests).toEqual([])
  for (const value of [' 旧密码短句 A ', '🙂'.repeat(128), 'PaSsWoRd']) {
    await input.fill(value)
    await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('合成测试已收到登录请求')
    await expect.poll(() => submitted.at(-1)).toBe(value)
    await expect(input).toHaveValue(value)
  }
})

test('旧版 Unicode 空格密码与 128 字符密码仍可实际登录', async ({ page }) => {
  for (const [username, legacyPassword] of [
    ['Legacy_Traveler', '  测试专用的旅行短句 password 2026  '],
    ['Legacy_Long', `Legacy_2026!${'x'.repeat(116)}`],
  ]) {
    await page.goto('/login')
    await login(page, username, legacyPassword)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password')
  }
})

test('320px 窄屏密码框与显隐按钮不横向溢出，触控目标至少 44px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/register')
  await expect(page.getByRole('heading', { name: '创建你的手帐', exact: true })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill('~UiTest_2026!abC')
  await page.getByLabel('确认密码', { exact: true }).fill('~UiTest_2026!abC')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  for (const name of ['显示密码', '显示确认密码']) {
    const button = page.getByRole('button', { name, exact: true })
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
  }
  for (const name of ['密码', '确认密码']) {
    const box = await page.getByLabel(name, { exact: true }).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
  }
  await page.screenshot({ path: testInfo.outputPath('register-password-controls-320.png'), fullPage: true })
})

test('实际 Edge 注册、错误密码、网络失败、重名、重载和退出', async ({ page, context }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/login')
  console.log('Browser:', await page.evaluate(() => navigator.userAgent))
  await expect(page.getByRole('heading', { name: '翻开你的手帐' })).toBeVisible()
  await expect(page).toHaveTitle('此间集')
  await expect(page.getByRole('heading', { name: '此间集', exact: true })).toBeVisible()
  await expect(page.getByText('CIJIANJI · 私人旅行手帐', { exact: true })).toBeVisible()
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
  await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前未登录，可重新登录')
  await page.route('**/api/v1/auth/login', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }),
  }))
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('alert')).toHaveText('登录响应无法识别，请重新核对登录结果后再试。')
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/auth/login')
  await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前未登录，可重新登录')
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

test('8 位与 16 位新密码可注册登录，两个账号多窗口退出、换号不残留', async ({ page, context, browser }) => {
  const shortestPassword = '!aB_09~x'
  const longestPassword = '~UiTest_2026!abC'
  await register(page, 'Ui_Alpha', shortestPassword)
  await login(page, 'Ui_Alpha', shortestPassword)
  const sibling = await context.newPage()
  await sibling.goto('/')
  await expect(sibling.getByRole('heading', { name: '你好，Ui_Alpha' })).toBeVisible()
  const separate = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const other = await separate.newPage()
  try {
    await register(other, 'Ui_Beta', longestPassword)
    await login(other, 'Ui_Beta', longestPassword)
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(sibling).toHaveURL(/\/login$/)
    await expect(sibling.getByText('Ui_Alpha', { exact: true })).toHaveCount(0)
    await other.reload()
    await expect(other.getByRole('heading', { name: '你好，Ui_Beta' })).toBeVisible()
    await login(page, 'Ui_Beta', longestPassword)
    await expect(sibling.getByRole('heading', { name: '你好，Ui_Beta' })).toBeVisible()
    await expect(page.getByText('Ui_Alpha', { exact: true })).toHaveCount(0)
  } finally {
    await separate.close()
  }
})

test('退出中或退出失败不因页面恢复重显私人内容，可重试退出；密码不匹配不提交', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_Recovery')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill('Other_2026!')
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致')
  await register(page, 'Ui_Recovery')
  await login(page, 'Ui_Recovery')
  let sessionReads = 0
  await page.route('**/api/v1/auth/me', route => { sessionReads++; return route.continue() })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let logoutHeld = false
  await page.route('**/api/v1/auth/logout', async route => {
    logoutHeld = true
    await held
    await route.abort('failed').catch(() => {})
  })
  async function restorePage() {
    await page.evaluate(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
  }
  try {
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect.poll(() => logoutHeld).toBeTruthy()
    await expect(page.getByRole('status')).toHaveText('正在退出…')
    const before = sessionReads
    await restorePage()
    expect(sessionReads).toBe(before)
    await expect(page.getByRole('status')).toHaveText('正在退出…')
    await expect(page.getByText('Ui_Recovery', { exact: true })).toHaveCount(0)
    release()
    await expect(page.getByRole('alert')).toContainText('退出尚未完成')
    await restorePage()
    expect(sessionReads).toBe(before)
    await expect(page.getByRole('alert')).toContainText('退出尚未完成')
    await expect(page.getByRole('button', { name: '重试退出', exact: true })).toBeVisible()
    await expect(page.getByText('Ui_Recovery', { exact: true })).toHaveCount(0)
  } finally { release() }
  await page.unroute('**/api/v1/auth/logout')
  await page.getByRole('button', { name: '重试退出' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('启动遇到非 JSON 服务错误明确说明服务不可用，查看本机步骤后可手动重连', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({
    status: 503, contentType: 'text/html', body: '<html>Temporary test gateway failure</html>',
  }))
  await page.goto('/')
  await expect(page.getByText('服务暂时不可用', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toHaveCount(0)
  await page.getByText('查看本机启动步骤', { exact: true }).click()
  await expect(page.getByText('如果只启动了网页，请启动“此间集－后端”；已有服务时不用重复运行。', { exact: true })).toBeVisible()
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  }
  await page.unroute('**/api/v1/auth/me')
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
})

test('启动区分网络中断与非法成功响应，未核对成功前不放行登录或私人页面', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.abort('failed'))
  await page.goto('/')
  await expect(page.getByText('暂时无法连接此间集', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/auth/me')
  await page.route('**/api/v1/auth/me', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<html>Test proxy page, not a session</html>',
  }))
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(page.getByText('服务响应无法识别', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/auth/me')
  await page.route('**/api/v1/auth/me', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }),
  }))
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(page.getByText('服务响应无法识别', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/auth/me')
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
})

test('连接等待中可手动重连，旧响应不回写；会话读取超时后可再次连接', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let mode: 'held' | 'guest' | 'timeout' = 'held'
  let pendingReads = 0
  let settledReads = 0
  await page.route('**/api/v1/auth/me', async route => {
    if (mode === 'guest') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: 'Test guest session' } }) })
      return
    }
    pendingReads++
    await held
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      data: { id: 'late-test-user', username: 'Late_Test_User', created_at: '2026-10-23T00:00:00Z' },
    }) }).catch(() => {})
    settledReads++
  })
  try {
    await page.goto('/')
    await expect(page.getByText('正在连接此间集', { exact: true })).toBeVisible()
    await expect.poll(() => pendingReads).toBeGreaterThan(0)
    mode = 'guest'
    await page.getByRole('button', { name: '重新连接', exact: true }).click()
    await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
    release()
    await expect.poll(() => settledReads).toBe(pendingReads)
    await expect(page.getByRole('heading', { name: '你好，Late_Test_User', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()

    // Exercise the startup session check's actual deadline in this existing regression.
    const timeoutGate = new Promise<void>(resolve => { release = resolve })
    await page.unroute('**/api/v1/auth/me')
    let timeoutReads = 0
    await page.route('**/api/v1/auth/me', async route => {
      if (mode === 'guest') { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: 'Test guest session' } }) }); return }
      timeoutReads++
      await timeoutGate
      await route.abort('failed').catch(() => {})
    })
    mode = 'timeout'
    await page.reload()
    await expect(page.getByText('正在连接此间集', { exact: true })).toBeVisible()
    await expect.poll(() => timeoutReads).toBeGreaterThan(0)
    await expect(page.getByText('连接等待超时', { exact: true })).toBeVisible({ timeout: 20_000 })
    mode = 'guest'
    await page.getByRole('button', { name: '重新连接', exact: true }).click()
    await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
  } finally { release() }
})

test('后台会话核对失败保留编辑草稿，非 JSON 的 403 保留私人页而 401 立即隐藏', async ({ page }) => {
  await page.goto('/login')
  await login(page, 'Editing_One', 'E2E_T03_2026!')
  const response = await page.request.get('/api/v1/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301/albums')
  expect(response.ok()).toBeTruthy()
  const album = (await response.json()).data.items.find((item: { year: number }) => item.year === 2062)
  await page.goto(`/albums/${album.id}`)
  await expect(page.locator('.photo-card')).toHaveCount(24)
  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  const editor = page.getByLabel('照片文字', { exact: true })
  await expect(editor).toBeVisible()
  const originalNote = await editor.inputValue()
  const draft = '合成测试：连接核对失败也保留这段未保存文字'
  await editor.fill(draft)
  const sessionNotice = page.getByText('会话核对暂时失败，未保存内容仍在本页；请检查连接后再保存。', { exact: true })
  const failSessionRead = () => page.route('**/api/v1/auth/me', route => route.fulfill({ status: 500, contentType: 'text/html', body: '<html>Test service failure</html>' }))
  await failSessionRead()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(sessionNotice).toBeVisible()
  await expect(editor).toHaveValue(draft)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.unroute('**/api/v1/auth/me')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(sessionNotice).toHaveCount(0)
  await expect(editor).toHaveValue(draft)

  // The global recheck action sits behind the modal; leave through its normal draft guard first.
  await failSessionRead()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(sessionNotice).toBeVisible()
  await page.getByRole('button', { name: '关闭原图', exact: true }).click()
  await page.getByRole('button', { name: '放弃草稿并离开', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.unroute('**/api/v1/auth/me')
  await page.getByRole('button', { name: '重新核对登录状态', exact: true }).click()
  await expect(sessionNotice).toHaveCount(0)

  await page.getByRole('button', { name: '查看原图：journey-01.png', exact: true }).click()
  await expect(editor).toHaveValue(originalNote)
  await editor.fill(draft)
  const photoId = new URL(page.url()).searchParams.get('photo')!
  await page.route('**/api/v1/photos/*/note', route => route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Test permission denial</html>' }))
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('请求未获允许，请核对当前状态后重试。')
  await expect(editor).toHaveValue(draft)
  await expect(page.getByRole('dialog')).toBeVisible()
  expect((await (await page.request.get(`/api/v1/photos/${photoId}`)).json()).data.note).toBe(originalNote)
  await page.unroute('**/api/v1/photos/*/note')
  await page.route('**/api/v1/photos/*/note', route => route.fulfill({ status: 401, contentType: 'text/html', body: '<html>Test expired session</html>' }))
  await page.getByRole('button', { name: '保存文字', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.photo-card')).toHaveCount(0)
  await expect(page.getByText('Editing_One', { exact: true })).toHaveCount(0)
})
