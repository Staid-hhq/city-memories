import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

type Field = 'username' | 'password' | 'confirmation'
const fields: Field[] = ['username', 'password', 'confirmation']
const fieldIds = { username: 'username', password: 'password', confirmation: 'password-confirm' }
const password = 'CaseMix_2026!'
const usernameMessage = '用户名须为 3–32 位英文字母、数字或下划线。'
const passwordCharacters = '密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。'
const confirmationCharacters = '确认密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。'
const mismatchMessage = '两次输入的密码不一致，请重新核对。'

function fieldInput(page: Page, field: Field) { return page.locator(`#${fieldIds[field]}`) }
function fieldError(page: Page, field: Field) { return page.locator(`#${fieldIds[field]}-error`) }
function helpId(field: Field) { return field === 'username' ? 'username-help' : 'password-help' }

function credentialRequests(page: Page) {
  const requests: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (['/api/v1/auth/csrf', '/api/v1/auth/register', '/api/v1/auth/login'].includes(path)) requests.push(path)
  })
  return requests
}

async function expectFieldError(page: Page, field: Field, message: string) {
  await expect(fieldInput(page, field)).toHaveAttribute('aria-invalid', 'true')
  await expect(fieldInput(page, field)).toHaveAttribute('aria-describedby', `${helpId(field)} ${fieldIds[field]}-error`)
  await expect(fieldError(page, field)).toHaveText(message)
  await expect(fieldError(page, field)).toHaveClass(/\bauth-field-error\b/)
  await expect(fieldError(page, field)).not.toHaveAttribute('role', 'alert')
}

async function expectFieldClear(page: Page, field: Field) {
  await expect(fieldError(page, field)).toHaveCount(0)
  await expect(fieldInput(page, field)).not.toHaveAttribute('aria-invalid', /.*/)
  await expect(fieldInput(page, field)).toHaveAttribute('aria-describedby', helpId(field))
}

async function fillValidRegistration(page: Page) {
  await fieldInput(page, 'username').fill('Fields_Traveler')
  await fieldInput(page, 'password').fill(password)
  await fieldInput(page, 'confirmation').fill(password)
}

async function fillInvalidRegistration(page: Page) {
  await fieldInput(page, 'username').fill(' bad name ')
  await fieldInput(page, 'password').fill(' Abcdefg')
  await fieldInput(page, 'confirmation').fill('1234567')
}

async function register(page: Page) {
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
}

async function denyUnexpectedRegistration(page: Page) {
  await page.route('**/api/v1/auth/register', route => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNEXPECTED_REQUEST', message: '合成测试：本地错误不应提交' } }),
  }))
}

async function expectVisibleFormError(page: Page, message: string) {
  const alert = page.getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toHaveText(message)
  const box = await alert.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(2)
  expect(box!.height).toBeGreaterThan(2)
  await expect(page.locator('.auth-field-error')).toHaveCount(0)
}

test('注册一次收集三个字段错误，首错聚焦并关联帮助和就近文案，不发送凭据请求', async ({ page }) => {
  const requests = credentialRequests(page)
  await denyUnexpectedRegistration(page)
  await page.goto('/register')
  await fillInvalidRegistration(page)
  await expect(page.locator('.auth-field-error')).toHaveCount(0)
  for (const field of fields) await expectFieldClear(page, field)
  await register(page)
  await expectFieldError(page, 'username', usernameMessage)
  await expectFieldError(page, 'password', passwordCharacters)
  await expectFieldError(page, 'confirmation', '确认密码长度须为 8–16 位。')
  await expect(fieldInput(page, 'username')).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveText(usernameMessage)
  for (const [field, value] of [['username', ' bad name '], ['password', ' Abcdefg'], ['confirmation', '1234567']] as const) {
    await expect(fieldInput(page, field)).toHaveValue(value)
  }
  const inputs = await Promise.all(fields.map(field => fieldInput(page, field).boundingBox()))
  const errors = await Promise.all(fields.map(field => fieldError(page, field).boundingBox()))
  for (let index = 0; index < fields.length; index++) {
    expect(inputs[index]).not.toBeNull(); expect(errors[index]).not.toBeNull()
    expect(errors[index]!.y).toBeGreaterThanOrEqual(inputs[index]!.y + inputs[index]!.height - 1)
    if (index < fields.length - 1) expect(errors[index]!.y).toBeLessThan(inputs[index + 1]!.y)
  }
  expect(requests).toEqual([])
})

test('首次失败后编辑逐字段修正，其他错误保留且编辑不抢焦点或提交', async ({ page }) => {
  const requests = credentialRequests(page)
  await denyUnexpectedRegistration(page)
  await page.goto('/register')
  await fillInvalidRegistration(page)
  await register(page)
  await fieldInput(page, 'username').fill('Fields_Corrected')
  await expectFieldClear(page, 'username')
  await expect(fieldInput(page, 'username')).toBeFocused()
  await expectFieldError(page, 'password', passwordCharacters)
  await expectFieldError(page, 'confirmation', '确认密码长度须为 8–16 位。')
  await fieldInput(page, 'password').fill(password)
  await expectFieldClear(page, 'password')
  await expect(fieldInput(page, 'password')).toBeFocused()
  await expectFieldError(page, 'confirmation', '确认密码长度须为 8–16 位。')
  await fieldInput(page, 'confirmation').fill(password)
  for (const field of fields) await expectFieldClear(page, field)
  await expect(fieldInput(page, 'confirmation')).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await fieldInput(page, 'username').fill(' bad name ')
  await expectFieldError(page, 'username', usernameMessage)
  await expect(fieldInput(page, 'username')).toBeFocused()
  expect(requests).toEqual([])
})

test('确认不一致随原密码变化重新校验，原密码无效时不叠加不一致错误', async ({ page }) => {
  const requests = credentialRequests(page)
  await denyUnexpectedRegistration(page)
  await page.goto('/register')
  await fillValidRegistration(page)
  await fieldInput(page, 'confirmation').fill('Other_2026!')
  await register(page)
  await expectFieldError(page, 'confirmation', mismatchMessage)
  await expect(fieldInput(page, 'confirmation')).toBeFocused()
  await fieldInput(page, 'password').fill('Other_2026!')
  await expectFieldClear(page, 'confirmation')
  await expect(fieldInput(page, 'password')).toBeFocused()
  await fieldInput(page, 'password').fill(password)
  await expectFieldError(page, 'confirmation', mismatchMessage)
  await expect(fieldInput(page, 'password')).toBeFocused()
  await fieldInput(page, 'password').fill('short')
  await expectFieldError(page, 'password', '密码长度须为 8–16 位。')
  await expectFieldClear(page, 'confirmation')
  await expect(fieldInput(page, 'confirmation')).toHaveValue('Other_2026!')
  await fieldInput(page, 'password').fill('Other_2026!')
  for (const field of fields) await expectFieldClear(page, field)
  expect(requests).toEqual([])
})

test('错误存在时键盘显隐保持原值和错误，Enter 与 Space 不会提交表单', async ({ page }) => {
  const requests = credentialRequests(page)
  await denyUnexpectedRegistration(page)
  await page.goto('/register')
  await fillValidRegistration(page)
  await fieldInput(page, 'password').fill(' Abcdefg')
  await fieldInput(page, 'confirmation').fill('Abcdefg ')
  await register(page)
  for (const [field, show, hide, message, value] of [
    ['password', '显示密码', '隐藏密码', passwordCharacters, ' Abcdefg'],
    ['confirmation', '显示确认密码', '隐藏确认密码', confirmationCharacters, 'Abcdefg '],
  ] as const) {
    const input = fieldInput(page, field)
    await input.focus(); await input.press('Tab')
    await expect(page.getByRole('button', { name: show, exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(input).toHaveAttribute('type', 'text')
    await expect(page.getByRole('button', { name: hide, exact: true })).toBeFocused()
    await expectFieldError(page, field, message)
    await page.keyboard.press('Space')
    await expect(input).toHaveAttribute('type', 'password')
    await expect(input).toHaveValue(value)
    await expectFieldError(page, field, message)
  }
  await expect(page.getByRole('alert')).toHaveCount(1)
  expect(requests).toEqual([])
})

test('注册仅按状态和明确白名单定位服务端字段错误，对应字段编辑后交回本地校验', async ({ page }) => {
  const cases: Array<{ status: number; code: string; field: Field; message: string }> = [
    { status: 409, code: 'USERNAME_TAKEN', field: 'username', message: '这个用户名已被使用，请换一个' },
    { status: 422, code: 'PASSWORD_LENGTH', field: 'password', message: '密码长度须为 8–16 位。' },
    { status: 422, code: 'PASSWORD_CHARACTERS', field: 'password', message: passwordCharacters },
    { status: 422, code: 'PASSWORD_COMMON', field: 'password', message: '该密码过于常见，请换一个不易猜到的密码。' },
    { status: 422, code: 'PASSWORD_CONFIRM_LENGTH', field: 'confirmation', message: '确认密码长度须为 8–16 位。' },
    { status: 422, code: 'PASSWORD_CONFIRM_CHARACTERS', field: 'confirmation', message: confirmationCharacters },
    { status: 422, code: 'PASSWORD_CONFIRM_COMMON', field: 'confirmation', message: '确认密码过于常见，请换一个不易猜到的密码。' },
    { status: 422, code: 'PASSWORD_MISMATCH', field: 'confirmation', message: mismatchMessage },
  ]
  let current = cases[0]
  let submissions = 0
  await page.route('**/api/v1/auth/register', route => {
    submissions++
    return route.fulfill({ status: current.status, contentType: 'application/json', body: JSON.stringify({ error: { code: current.code, message: current.message } }) })
  })
  for (const [index, item] of cases.entries()) {
    current = item
    await page.goto('/register')
    await fillValidRegistration(page)
    await register(page)
    await expectFieldError(page, item.field, item.message)
    await expect(fieldInput(page, item.field)).toBeFocused()
    await expect(page.locator('.auth-field-error')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveText(item.message)
    await expect(fieldInput(page, 'username')).toHaveValue('Fields_Traveler')
    await expect(fieldInput(page, 'password')).toHaveValue(password)
    await expect(fieldInput(page, 'confirmation')).toHaveValue(password)
    if (item.field === 'username') {
      await fieldInput(page, 'confirmation').fill('Other_2026!')
      await expectFieldError(page, 'username', item.message)
      await fieldInput(page, 'username').fill('Fields_NewName')
    } else {
      await fieldInput(page, 'username').fill('Fields_NewName')
      await expectFieldError(page, item.field, item.message)
      if (item.code === 'PASSWORD_MISMATCH') {
        await fieldInput(page, 'password').fill('short')
        await expectFieldError(page, 'password', '密码长度须为 8–16 位。')
      } else if (item.field === 'password') await fieldInput(page, 'password').fill('Other_2026!')
      else {
        await fieldInput(page, 'confirmation').fill('Other_2026!')
        await fieldInput(page, 'confirmation').fill(password)
      }
    }
    await expectFieldClear(page, item.field)
    expect(submissions).toBe(index + 1)
  }
})

test('未知代码、错误状态和登录认证失败保持表单级，503仍进入结果核对且不自动重放', async ({ page }) => {
  const cases = [
    { path: 'register', status: 422, code: 'PASSWORD_PROVIDER_DOWN', message: '合成测试：未知密码错误代码' },
    { path: 'register', status: 400, code: 'USERNAME_TAKEN', message: '合成测试：状态不匹配的用户名错误' },
    { path: 'register', status: 503, code: 'PASSWORD_LENGTH', message: '合成测试：注册服务暂时不可用' },
    { path: 'register', status: 503, code: 'USERNAME_TAKEN', message: '合成测试：注册服务暂时不可用' },
    { path: 'login', status: 401, code: 'INVALID_CREDENTIALS', message: '账号或密码不正确' },
    { path: 'login', status: 503, code: 'PASSWORD_LENGTH', message: '合成测试：服务暂时不可用' },
  ]
  let current = cases[0]
  let submissions = 0
  for (const endpoint of ['login', 'register']) await page.route(`**/api/v1/auth/${endpoint}`, route => {
    submissions++
    return route.fulfill({ status: current.status, contentType: 'application/json', body: JSON.stringify({ error: { code: current.code, message: current.message } }) })
  })
  for (const [index, item] of cases.entries()) {
    current = item
    await page.goto(`/${item.path}`)
    await fieldInput(page, 'username').fill('Fields_Traveler')
    await fieldInput(page, 'password').fill(password)
    if (item.path === 'register') { await fieldInput(page, 'confirmation').fill(password); await register(page) }
    else await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
    await expectVisibleFormError(page, item.message)
    await expect(fieldInput(page, 'username')).toHaveValue('Fields_Traveler')
    await expect(fieldInput(page, 'password')).toHaveValue(password)
    for (const field of item.path === 'register' ? fields : fields.slice(0, 2)) await expectFieldClear(page, field)
    if (item.status === 503) {
      await expect(page.locator('.auth-recovery')).toBeFocused()
      for (const field of item.path === 'register' ? fields : fields.slice(0, 2)) await expect(fieldInput(page, field)).not.toBeFocused()
      if (item.path === 'register') {
        await expect(page.getByText('注册结果尚未确认', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '创建账号', exact: true })).toBeDisabled()
        await page.getByRole('link', { name: '前往登录', exact: true }).click()
        await expect(page).toHaveURL(/\/login$/)
        await expect(page.getByText('注册结果尚未确认，请尝试登录。', { exact: true })).toBeVisible()
      } else {
        await expect(page.getByText('登录结果尚未确认', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '登录我的手帐', exact: true })).toBeDisabled()
        await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
        await expectVisibleFormError(page, '当前未登录，可重新登录；这不代表之前的请求未被处理。')
        await expect(page.getByRole('button', { name: '登录我的手帐', exact: true })).toBeEnabled()
      }
    }
    expect(submissions).toBe(index + 1)
  }
})

test('登录字段只限制长度并原样提交旧 Unicode 空格密码，注册弱密码规则和真实登录仍有效', async ({ page }) => {
  const requests = credentialRequests(page)
  const legacyPassword = '  测试专用的旅行短句 password 2026  '
  let submitted = ''
  await page.route('**/api/v1/auth/login', route => {
    submitted = route.request().postDataJSON().password as string
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: '账号或密码不正确' } }) })
  })
  await page.goto('/login')
  await fieldInput(page, 'username').fill('Legacy_Traveler')
  await fieldInput(page, 'password').fill('1234567')
  await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
  await expectFieldError(page, 'password', '密码长度须为 8–128 个字符。')
  expect(requests).toEqual([])
  await fieldInput(page, 'password').fill(legacyPassword)
  await expectFieldClear(page, 'password')
  await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
  await expectVisibleFormError(page, '账号或密码不正确')
  expect(submitted).toBe(legacyPassword)
  await expect(fieldInput(page, 'password')).toHaveValue(legacyPassword)
  await page.unroute('**/api/v1/auth/login')
  await fieldInput(page, 'username').fill('Albums_One')
  await fieldInput(page, 'password').fill('E2E_T03_2026!')
  await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
  await expect(page.getByRole('heading', { name: '你好，Albums_One', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/register')
  await fillValidRegistration(page)
  await fieldInput(page, 'password').fill('PaSsWoRd')
  await fieldInput(page, 'confirmation').fill('PaSsWoRd')
  const before = requests.length
  await register(page)
  await expectFieldError(page, 'password', '该密码过于常见，请换一个不易猜到的密码。')
  await expectFieldError(page, 'confirmation', '确认密码过于常见，请换一个不易猜到的密码。')
  expect(requests).toHaveLength(before)
})

test('桌面与320px多字段错误在字段附近完整显示，密码隐藏且无横向溢出', async ({ page }, testInfo) => {
  await denyUnexpectedRegistration(page)
  for (const width of [1360, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto('/register')
    await fillInvalidRegistration(page)
    await register(page)
    await expect(page.locator('.auth-field-error')).toHaveCount(3)
    await expect(fieldInput(page, 'username')).toBeFocused()
    for (const field of ['password', 'confirmation'] as const) await expect(fieldInput(page, field)).toHaveAttribute('type', 'password')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const visibleErrors: Locator[] = fields.map(field => fieldError(page, field))
    for (const error of visibleErrors) {
      const box = await error.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    await page.screenshot({ path: testInfo.outputPath(`register-fields-${width === 320 ? '320' : 'desktop'}.png`), fullPage: true })
  }
})
