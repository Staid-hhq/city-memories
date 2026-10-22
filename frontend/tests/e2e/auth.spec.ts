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

async function login(page: Page, username: string, loginPassword = password) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(loginPassword)
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
  await page.route('**/api/v1/auth/login', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }),
  }))
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('alert')).toHaveText('登录响应无法识别，请重新核对登录结果后再试。')
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
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
  const separate = await browser.newContext({ baseURL: new URL(page.url()).origin })
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

test('退出中或退出失败不因页面恢复重显私人内容，可重试退出；密码不匹配不提交', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill('Ui_Recovery')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill('Different test password')
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
  await expect(page.getByText('如果只启动了网页，请启动“城影记－后端”；已有服务时不用重复运行。', { exact: true })).toBeVisible()
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
  await expect(page.getByText('暂时无法连接城影记', { exact: true })).toBeVisible()
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
    await expect(page.getByText('正在连接城影记', { exact: true })).toBeVisible()
    await expect.poll(() => pendingReads).toBeGreaterThan(0)
    mode = 'guest'
    await page.getByRole('button', { name: '重新连接', exact: true }).click()
    await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
    release()
    await expect.poll(() => settledReads).toBe(pendingReads)
    await expect(page.getByRole('heading', { name: '你好，Late_Test_User', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()

    // Native AbortSignal.timeout uses the browser clock, so exercise its actual deadline.
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
    await expect(page.getByText('正在连接城影记', { exact: true })).toBeVisible()
    await expect.poll(() => timeoutReads).toBeGreaterThan(0)
    await expect(page.getByText('连接等待超时', { exact: true })).toBeVisible({ timeout: 20_000 })
    mode = 'guest'
    await page.getByRole('button', { name: '重新连接', exact: true }).click()
    await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
  } finally { release() }
})

test('后台会话核对失败保留编辑草稿，非 JSON 的 403 保留私人页而 401 立即隐藏', async ({ page }) => {
  await page.goto('/login')
  await login(page, 'Editing_One', 'Only for T03 browser tests!')
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
