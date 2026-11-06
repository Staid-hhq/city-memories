import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

type Field = 'current' | 'password' | 'confirmation'
const fields: Field[] = ['current', 'password', 'confirmation']
const ids = { current: 'current-password', password: 'new-password', confirmation: 'new-password-confirm' }
const seedPassword = 'E2E_T03_2026!'
const newPassword = 'Changed_2026!'
const currentLengthMessage = '当前密码长度须为 8–128 个字符。'
const unchangedMessage = '新密码不能与当前密码相同。'
const mismatchMessage = '两次输入的密码不一致，请重新核对。'
const charactersMessage = '密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。'
const loginAfterUnknown = '修改结果尚未确认，请先尝试新密码；若无法登录，再尝试原密码。'

function input(page: Page, field: Field) { return page.locator(`#${ids[field]}`) }
function error(page: Page, field: Field) { return page.locator(`#${ids[field]}-error`) }

async function expectFieldError(page: Page, field: Field, message: string) {
  await expect(input(page, field)).toHaveAttribute('aria-invalid', 'true')
  await expect(input(page, field)).toHaveAttribute('aria-describedby', `${ids[field]}-help ${ids[field]}-error`)
  await expect(error(page, field)).toHaveText(message)
}

async function expectFieldClear(page: Page, field: Field) {
  await expect(error(page, field)).toHaveCount(0)
  await expect(input(page, field)).not.toHaveAttribute('aria-invalid', /.*/)
  await expect(input(page, field)).toHaveAttribute('aria-describedby', `${ids[field]}-help`)
}

function passwordWrites(page: Page) {
  const requests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/auth/password') requests.push(request.url())
  })
  return requests
}

async function login(page: Page, username: string, password: string) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
}

async function signIn(page: Page, username = 'Albums_One', password = seedPassword) {
  await page.goto('/login')
  await login(page, username, password)
  await expect(page.getByRole('heading', { name: `你好，${username}`, exact: true })).toBeVisible()
}

async function registerAndLogin(page: Page, username: string, password: string) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await login(page, username, password)
  await expect(page.getByRole('heading', { name: `你好，${username}`, exact: true })).toBeVisible()
}

async function openPasswordPage(page: Page) {
  await page.getByRole('link', { name: '修改密码', exact: true }).click()
  await expect(page).toHaveURL(/\/account\/password$/)
}

async function fillPasswordChange(page: Page, current = seedPassword, password = newPassword, confirmation = password) {
  await page.getByLabel('当前密码', { exact: true }).fill(current)
  await page.getByLabel('新密码', { exact: true }).fill(password)
  await page.getByLabel('确认新密码', { exact: true }).fill(confirmation)
}

async function submit(page: Page) { await page.getByRole('button', { name: '确认修改密码', exact: true }).click() }

async function blockUnexpectedWrite(page: Page) {
  await page.route('**/api/v1/auth/password', route => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNEXPECTED_WRITE', message: '合成测试：本地错误或取消不应提交' } }),
  }))
}

async function expectUnknown(page: Page) {
  await expect(page.getByText('修改结果尚未确认', { exact: true })).toBeVisible()
  await expect(page.locator('.password-change-recovery')).toBeFocused()
  for (const field of fields) {
    await expect(input(page, field)).toHaveValue('')
    await expect(input(page, field)).toBeDisabled()
    await expect(input(page, field)).toHaveAttribute('type', 'password')
    await expect(input(page, field).locator('..').getByRole('button')).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: '确认修改密码', exact: true })).toBeDisabled()
  await expect(page.locator('.auth-field-error')).toHaveCount(0)
}

type BodyWaitWindow = Window & { passwordChangeBodyTarget?: boolean; passwordChangeBodyWaits?: number }

async function installBodyWait(page: Page) {
  await page.addInitScript(() => {
    const target = window as BodyWaitWindow
    const originalFetch = window.fetch.bind(window)
    target.passwordChangeBodyWaits = 0
    window.fetch = async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request), location.href)
      if (!target.passwordChangeBodyTarget || url.pathname !== '/api/v1/auth/password') return originalFetch(request, init)
      target.passwordChangeBodyTarget = false
      target.passwordChangeBodyWaits!++
      const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined)
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'))
        const abort = () => controller.error(signal?.reason ?? new DOMException('Synthetic body canceled', 'AbortError'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
}

async function authWakeups(page: Page) {
  await page.evaluate(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    const channel = new BroadcastChannel('city-memories-auth')
    channel.postMessage('changed'); channel.close()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

test('顶栏进入独立修改页，取消不提交且返回后重新进入不保留密码', async ({ page }) => {
  await page.goto('/account/password')
  await expect(page).toHaveURL(/\/login$/)
  await expect(input(page, 'current')).toHaveCount(0)
  await signIn(page)
  await page.setViewportSize({ width: 320, height: 850 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  const entry = await page.getByRole('link', { name: '修改密码', exact: true }).boundingBox()
  expect(entry).not.toBeNull()
  expect(entry!.x).toBeGreaterThanOrEqual(0)
  expect(entry!.x + entry!.width).toBeLessThanOrEqual(320)
  const requests = passwordWrites(page)
  await blockUnexpectedWrite(page)
  await openPasswordPage(page)
  await expect(page.locator('.home-header')).toHaveCount(0)
  for (const field of fields) {
    await expect(input(page, field)).toHaveValue('')
    await expect(input(page, field)).toHaveAttribute('type', 'password')
    await expectFieldClear(page, field)
  }
  await fillPasswordChange(page)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '你好，Albums_One', exact: true })).toBeVisible()
  await openPasswordPage(page)
  for (const field of fields) await expect(input(page, field)).toHaveValue('')
  expect(requests).toEqual([])
})

test('本地收集全部错误并聚焦首错，确认随新密码重算，相同新旧密码不发送修改', async ({ page }, testInfo) => {
  await signIn(page)
  const requests = passwordWrites(page)
  await blockUnexpectedWrite(page)
  await openPasswordPage(page)
  await fillPasswordChange(page, '1234567', ' Abcdefg', '1234567')
  await expect(page.locator('.auth-field-error')).toHaveCount(0)
  await submit(page)
  await expectFieldError(page, 'current', currentLengthMessage)
  await expectFieldError(page, 'password', charactersMessage)
  await expectFieldError(page, 'confirmation', '确认密码长度须为 8–16 位。')
  await expect(input(page, 'current')).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('password-change-errors-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 320, height: 850 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await page.screenshot({ path: testInfo.outputPath('password-change-errors-320.png'), fullPage: true })
  const legacy = '  旧密码专用短句 password 2026  '
  await input(page, 'current').fill(legacy)
  await expectFieldClear(page, 'current')
  await expect(input(page, 'current')).toHaveValue(legacy)
  await input(page, 'password').fill(newPassword)
  await input(page, 'confirmation').fill('Other_2026!')
  await expectFieldError(page, 'confirmation', mismatchMessage)
  await input(page, 'password').fill('Other_2026!')
  await expectFieldClear(page, 'confirmation')
  await expect(input(page, 'password')).toBeFocused()
  await input(page, 'current').fill('Other_2026!')
  await expectFieldError(page, 'password', unchangedMessage)
  await expect(input(page, 'current')).toBeFocused()
  await input(page, 'password').fill('short')
  await expectFieldError(page, 'password', '密码长度须为 8–16 位。')
  await expectFieldClear(page, 'confirmation')
  expect(requests).toEqual([])
})

test('三个密码框的键盘显隐独立，不清除错误、不改输入或提交', async ({ page }) => {
  await signIn(page)
  const requests = passwordWrites(page)
  await blockUnexpectedWrite(page)
  await openPasswordPage(page)
  await fillPasswordChange(page, '1234567', 'PaSsWoRd', 'PaSsWoRd')
  await submit(page)
  for (const [field, value, message] of [
    ['current', '1234567', currentLengthMessage],
    ['password', 'PaSsWoRd', '该密码过于常见，请换一个不易猜到的密码。'],
    ['confirmation', 'PaSsWoRd', '确认密码过于常见，请换一个不易猜到的密码。'],
  ] as const) {
    const control = input(page, field)
    const toggle = control.locator('..').getByRole('button')
    await control.focus(); await control.press('Tab')
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('type', 'button')
    await expect(toggle).toHaveAttribute('aria-controls', ids[field])
    await page.keyboard.press('Enter')
    await expect(control).toHaveAttribute('type', 'text')
    await expectFieldError(page, field, message)
    for (const other of fields.filter(item => item !== field)) await expect(input(page, other)).toHaveAttribute('type', 'password')
    await page.keyboard.press('Space')
    await expect(control).toHaveAttribute('type', 'password')
    await expect(control).toHaveValue(value)
    await expectFieldError(page, field, message)
  }
  expect(requests).toEqual([])
})

test('旧 Unicode 和空格当前密码原样提交，带当前账号ID且服务错误不清除输入', async ({ page }) => {
  const legacyPassword = '  测试专用的旅行短句 password 2026  '
  await signIn(page, 'Legacy_Traveler', legacyPassword)
  const currentUser = (await (await page.request.get('/api/v1/auth/me')).json()).data
  let payload: Record<string, unknown> | undefined
  await page.route('**/api/v1/auth/password', route => {
    payload = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CURRENT_PASSWORD_INCORRECT', message: '合成测试：当前密码不正确' } }) })
  })
  await openPasswordPage(page)
  await fillPasswordChange(page, legacyPassword)
  await submit(page)
  await expectFieldError(page, 'current', '合成测试：当前密码不正确')
  await expect(input(page, 'current')).toBeFocused()
  expect(payload).toEqual({ expected_user_id: currentUser.id, current_password: legacyPassword, password: newPassword, password_confirm: newPassword })
  await expect(input(page, 'current')).toHaveValue(legacyPassword)
  await expect(input(page, 'password')).toHaveValue(newPassword)
  await expect(input(page, 'confirmation')).toHaveValue(newPassword)
})

test('当前密码与新密码白名单按精确状态定位字段，编辑对应字段后重算', async ({ page }) => {
  const cases: Array<{ status: number; code: string; field: Field; message: string }> = [
    { status: 400, code: 'CURRENT_PASSWORD_INCORRECT', field: 'current', message: '合成测试：当前密码不正确' },
    { status: 422, code: 'PASSWORD_UNCHANGED', field: 'password', message: unchangedMessage },
    { status: 422, code: 'PASSWORD_LENGTH', field: 'password', message: '密码长度须为 8–16 位。' },
    { status: 422, code: 'PASSWORD_CHARACTERS', field: 'password', message: charactersMessage },
    { status: 422, code: 'PASSWORD_COMMON', field: 'password', message: '该密码过于常见，请换一个不易猜到的密码。' },
    { status: 422, code: 'PASSWORD_CONFIRM_LENGTH', field: 'confirmation', message: '确认密码长度须为 8–16 位。' },
    { status: 422, code: 'PASSWORD_CONFIRM_CHARACTERS', field: 'confirmation', message: '确认密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。' },
    { status: 422, code: 'PASSWORD_CONFIRM_COMMON', field: 'confirmation', message: '确认密码过于常见，请换一个不易猜到的密码。' },
    { status: 422, code: 'PASSWORD_MISMATCH', field: 'confirmation', message: mismatchMessage },
  ]
  await signIn(page)
  const requests = passwordWrites(page)
  let current = cases[0]
  await page.route('**/api/v1/auth/password', route => route.fulfill({ status: current.status, contentType: 'application/json', body: JSON.stringify({ error: { code: current.code, message: current.message } }) }))
  for (const [index, item] of cases.entries()) {
    current = item
    await openPasswordPage(page)
    await fillPasswordChange(page)
    await submit(page)
    await expectFieldError(page, item.field, item.message)
    await expect(input(page, item.field)).toBeFocused()
    await expect(page.locator('.auth-field-error')).toHaveCount(1)
    await expect(input(page, 'current')).toHaveValue(seedPassword)
    await expect(input(page, 'password')).toHaveValue(newPassword)
    await expect(input(page, 'confirmation')).toHaveValue(newPassword)
    if (item.field === 'current') await input(page, 'current').fill('OtherOld_2026!')
    else if (item.field === 'password') await input(page, 'password').fill('OtherNew_2026!')
    else {
      await input(page, 'confirmation').fill('OtherNew_2026!')
      await input(page, 'confirmation').fill(newPassword)
    }
    await expectFieldClear(page, item.field)
    expect(requests).toHaveLength(index + 1)
    await page.getByRole('button', { name: '取消', exact: true }).click()
  }
})

test('会话失效和账号变化回到登录而不猜字段，未知密码代码保持表单级', async ({ browser, baseURL }) => {
  for (const item of [
    { status: 401, code: 'SESSION_EXPIRED', message: '登录状态已失效，请重新登录。' },
    { status: 409, code: 'ACCOUNT_CHANGED', message: '浏览器账号已变化，请重新登录后再修改密码。' },
    { status: 422, code: 'PASSWORD_PROVIDER_DOWN', message: '合成测试：未知字段代码' },
  ]) {
    const context = await browser.newContext({ baseURL })
    const page = await context.newPage()
    try {
      await signIn(page)
      await openPasswordPage(page)
      const requests = passwordWrites(page)
      await page.route('**/api/v1/auth/password', route => route.fulfill({ status: item.status, contentType: 'application/json', body: JSON.stringify({ error: { code: item.code, message: item.message } }) }))
      await fillPasswordChange(page)
      await submit(page)
      await expect(page.locator('.auth-field-error')).toHaveCount(0)
      if (item.status === 422) {
        await expect(page.getByRole('alert')).toHaveText(item.message)
        for (const field of fields) await expectFieldClear(page, field)
      } else {
        await expect(page).toHaveURL(/\/login$/)
        await expect(page.getByText(item.message, { exact: true })).toBeVisible()
        await expect(page.locator('.home-header')).toHaveCount(0)
        await expect(input(page, 'current')).toHaveCount(0)
      }
      expect(requests).toHaveLength(1)
    } finally { await context.close() }
  }
})

test('真实修改成功撤销本人全部会话，旧密码失败、新密码可登录，其他账号保持登录', async ({ page, context, browser, baseURL }) => {
  const ownerPassword = 'Initial_2026!'
  const siblingContext = await browser.newContext({ baseURL })
  const otherContext = await browser.newContext({ baseURL })
  const sibling = await siblingContext.newPage()
  const other = await otherContext.newPage()
  try {
    await registerAndLogin(page, 'Change_Owner', ownerPassword)
    await signIn(sibling, 'Change_Owner', ownerPassword)
    await registerAndLogin(other, 'Change_Other', 'OtherAcct_2026!')
    await openPasswordPage(page)
    await fillPasswordChange(page, ownerPassword)
    await submit(page)
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByText('密码已修改，请使用新密码登录。', { exact: true })).toBeVisible()
    expect((await context.request.get('/api/v1/auth/me')).status()).toBe(401)
    expect((await siblingContext.request.get('/api/v1/auth/me')).status()).toBe(401)
    await sibling.reload()
    await expect(sibling).toHaveURL(/\/login$/)
    const otherIdentity = await otherContext.request.get('/api/v1/auth/me')
    expect(otherIdentity.status()).toBe(200)
    expect((await otherIdentity.json()).data.username).toBe('Change_Other')
    await expect(other.getByRole('heading', { name: '你好，Change_Other', exact: true })).toBeVisible()
    await login(page, 'Change_Owner', ownerPassword)
    await expect(page.getByRole('alert')).toHaveText('账号或密码不正确')
    await login(page, 'Change_Owner', newPassword)
    await expect(page.getByRole('heading', { name: '你好，Change_Owner', exact: true })).toBeVisible()
  } finally { await siblingContext.close(); await otherContext.close() }
})

test('预检失败可明确重试，POST或正文等待及503锁定未知结果且旧Cookie与晚响应不恢复私人页', async ({ page }, testInfo) => {
  await page.clock.install()
  await installBodyWait(page)
  await signIn(page)
  const requests = passwordWrites(page)
  await openPasswordPage(page)
  let preflightChecks = 0
  await page.route('**/api/v1/auth/csrf', route => {
    preflightChecks++
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_PREFLIGHT_UNAVAILABLE', message: '合成测试：预检服务不可用' } }) })
  })
  await fillPasswordChange(page)
  await submit(page)
  await expect(page.getByRole('alert')).toContainText('尚未提交修改')
  await expect(page.locator('.password-change-recovery')).toHaveCount(0)
  for (const field of fields) await expect(input(page, field)).toBeEnabled()
  await expect(input(page, 'current')).toHaveValue(seedPassword)
  await expect(input(page, 'password')).toHaveValue(newPassword)
  await expect(input(page, 'confirmation')).toHaveValue(newPassword)
  await expect(page.getByRole('button', { name: '确认修改密码', exact: true })).toBeEnabled()
  expect(requests).toEqual([])
  expect(preflightChecks).toBe(1)
  await page.unroute('**/api/v1/auth/csrf')
  for (const stage of ['post', 'body', 'service']) {
    // Retry the unchanged form explicitly after the failed preflight.
    if (stage !== 'post') await openPasswordPage(page)
    let release: () => void = () => {}
    let started = 0
    let finished = 0
    if (stage === 'post') {
      const gate = new Promise<void>(resolve => { release = resolve })
      await page.route('**/api/v1/auth/password', async route => {
        started++
        await gate
        await route.fulfill({ status: 204 }).catch(() => {})
        finished++
      })
    } else if (stage === 'body') await page.evaluate(() => { (window as BodyWaitWindow).passwordChangeBodyTarget = true })
    else await page.route('**/api/v1/auth/password', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PASSWORD_LENGTH', message: '合成测试：服务暂时不可用' } }) }))
    try {
      await fillPasswordChange(page)
      await submit(page)
      if (stage !== 'service') {
        await expect.poll(() => stage === 'post' ? started : page.evaluate(() => (window as BodyWaitWindow).passwordChangeBodyWaits)).toBe(1)
        await page.clock.fastForward(15_001)
      }
      await expectUnknown(page)
      if (stage === 'post') {
        await page.setViewportSize({ width: 320, height: 850 })
        await page.screenshot({ path: testInfo.outputPath('password-change-unknown-320.png'), fullPage: true })
      }
      await page.getByRole('button', { name: '前往登录核对', exact: true }).click()
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByText(loginAfterUnknown, { exact: true })).toBeVisible()
      await authWakeups(page)
      await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
      await expect(page.locator('.home-header')).toHaveCount(0)
      if (stage === 'post') { release(); await expect.poll(() => finished).toBe(1) }
      await expect(page).toHaveURL(/\/login$/)
      await page.unroute('**/api/v1/auth/password')
      await login(page, 'Albums_One', seedPassword)
      await expect(page.getByRole('heading', { name: '你好，Albums_One', exact: true })).toBeVisible()
      expect(requests).toHaveLength(stage === 'service' ? 2 : 1)
    } finally { release(); await page.unroute('**/api/v1/auth/password') }
  }
})

test('真实修改已提交后丢响应只转登录核对，不重放修改且旧新密码结果与服务端一致', async ({ page, context }) => {
  const originalPassword = 'LostOld_2026!'
  await registerAndLogin(page, 'Change_Lost', originalPassword)
  const requests = passwordWrites(page)
  let committed = false
  await page.route('**/api/v1/auth/password', async route => {
    // The context request writes any Set-Cookie response into the browser jar.
    const response = await context.request.fetch(route.request())
    committed = response.status() === 204
    await route.abort('failed')
  })
  await openPasswordPage(page)
  await fillPasswordChange(page, originalPassword)
  await submit(page)
  await expectUnknown(page)
  expect(committed).toBe(true)
  expect((await context.request.get('/api/v1/auth/me')).status()).toBe(401)
  await page.getByRole('button', { name: '前往登录核对', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText(loginAfterUnknown, { exact: true })).toBeVisible()
  await expect(page.getByText('密码已修改，请使用新密码登录。', { exact: true })).toHaveCount(0)
  await login(page, 'Change_Lost', originalPassword)
  await expect(page.getByRole('alert')).toHaveText('账号或密码不正确')
  await login(page, 'Change_Lost', newPassword)
  await expect(page.getByRole('heading', { name: '你好，Change_Lost', exact: true })).toBeVisible()
  expect(requests).toHaveLength(1)
})
