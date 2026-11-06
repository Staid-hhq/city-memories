import { expect, test } from '@playwright/test'
import type { BrowserContext, Page, Route } from '@playwright/test'

const password = 'E2E_T03_2026!'
const timeoutMessage = '等待服务响应超过 15 秒，尚不能确认本次操作结果。'
const lateLogin = { data: { user: { id: 'late-synthetic-user', username: 'Albums_One', created_at: '2026-11-07T00:00:00Z' }, csrf_token: 'late-synthetic-csrf' } }

function credentialPosts(page: Page) {
  const counts = { login: 0, register: 0, logout: 0 }
  page.on('request', request => {
    const name = new URL(request.url()).pathname.split('/').at(-1)
    if (request.method() === 'POST' && name && Object.hasOwn(counts, name)) counts[name as keyof typeof counts]++
  })
  return counts
}

async function fillLogin(page: Page, username = 'Albums_One', loginPassword = password) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(loginPassword)
  await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
}

async function signIn(page: Page, username = 'Albums_One') {
  await page.goto('/login')
  await fillLogin(page, username)
  await expect(page.getByRole('heading', { name: `你好，${username}`, exact: true })).toBeVisible()
}

async function fillRegistration(page: Page, username: string) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
}

async function holdFirstResponse(page: Page, endpoint: string, body: object, method = 'POST') {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const state = { started: 0, finished: 0 }
  const pattern = `**/api/v1/auth/${endpoint}`
  const handler = async (route: Route) => {
    if (route.request().method() !== method || state.started) { await route.fallback(); return }
    state.started++
    await gate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {})
    state.finished++
  }
  await page.route(pattern, handler)
  return { state, release, remove: () => page.unroute(pattern, handler) }
}

type BodyWaitWindow = Window & { authRecoveryBodyTarget?: string; authRecoveryBodyRequests?: string[] }

async function installBodyWait(page: Page) {
  // Unlike a held route, this resolves headers first and stalls response.json().
  await page.addInitScript(() => {
    const target = window as BodyWaitWindow
    const originalFetch = window.fetch.bind(window)
    target.authRecoveryBodyRequests = []
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname !== target.authRecoveryBodyTarget) return originalFetch(input, init)
      target.authRecoveryBodyTarget = undefined
      target.authRecoveryBodyRequests!.push(url.pathname)
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'))
          const abort = () => controller.error(signal?.reason ?? new DOMException('Synthetic body canceled', 'AbortError'))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
}

async function armBodyWait(page: Page, endpoint: string) {
  await page.evaluate(path => { (window as BodyWaitWindow).authRecoveryBodyTarget = path }, `/api/v1/auth/${endpoint}`)
}

async function bodyWaitCount(page: Page) {
  return page.evaluate(() => (window as BodyWaitWindow).authRecoveryBodyRequests?.length ?? 0)
}

async function assertPrivatePageHidden(page: Page) {
  await expect(page.locator('.home-header')).toHaveCount(0)
  await expect(page.locator('.photo-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
}

async function restoreAndBroadcast(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    const channel = new BroadcastChannel('city-memories-auth')
    channel.postMessage('changed'); channel.close()
  })
}

async function changeBrowserSession(context: BrowserContext, page: Page, username: string) {
  const origin = new URL(page.url()).origin
  const csrf = await context.request.get(`${origin}/api/v1/auth/csrf`)
  expect(csrf.status()).toBe(200)
  const token = (await csrf.json()).data.csrf_token as string
  const response = await context.request.post(`${origin}/api/v1/auth/login`, {
    headers: { Origin: origin, 'X-CSRF-Token': token }, data: { username, password },
  })
  expect(response.status()).toBe(200)
}

test('登录 CSRF 准备及 POST 等待均有期限，核对失败可重试且不自动重发登录', async ({ page }, testInfo) => {
  await page.clock.install()
  await page.setViewportSize({ width: 320, height: 850 })
  const posts = credentialPosts(page)
  for (const stage of ['csrf', 'login']) {
    const held = await holdFirstResponse(page, stage, stage === 'csrf' ? { data: { csrf_token: 'late-synthetic-csrf' } } : lateLogin, stage === 'csrf' ? 'GET' : 'POST')
    try {
      await page.goto('/login')
      await fillLogin(page)
      await expect.poll(() => held.state.started).toBe(1)
      await page.clock.fastForward(15_001)
      await expect(page.getByText('登录结果尚未确认', { exact: true })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveText(timeoutMessage)
      await expect(page.getByRole('button', { name: '登录我的手帐', exact: true })).toBeDisabled()
      await assertPrivatePageHidden(page)
      if (stage === 'login') {
        await page.getByLabel('密码', { exact: true }).fill('')
        await page.screenshot({ path: testInfo.outputPath('login-unknown-320.png'), fullPage: true })
      }

      await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 503, contentType: 'text/html', body: '<html>Synthetic check unavailable</html>' }))
      await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('服务暂时无法处理请求')
      await expect(page.getByText('登录结果尚未确认', { exact: true })).toBeVisible()
      await page.unroute('**/api/v1/auth/me')
      await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText('当前未登录，可重新登录；这不代表之前的请求未被处理。')
      await expect(page.getByRole('button', { name: '登录我的手帐', exact: true })).toBeEnabled()
      held.release()
      await expect.poll(() => held.state.finished).toBe(1)
      await assertPrivatePageHidden(page)
      expect(posts.login).toBe(stage === 'csrf' ? 0 : 1)
    } finally { held.release(); await held.remove() }
  }
})

test('登录正文及核对 GET 正文挂起仍按总期限结束，并保留手动恢复入口', async ({ page }) => {
  await page.clock.install()
  await installBodyWait(page)
  await page.goto('/login')
  await armBodyWait(page, 'login')
  await fillLogin(page)
  await expect.poll(() => bodyWaitCount(page)).toBe(1)
  await page.clock.fastForward(15_001)
  await expect(page.getByText('登录结果尚未确认', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText(timeoutMessage)
  await armBodyWait(page, 'me')
  await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
  await expect.poll(() => bodyWaitCount(page)).toBe(2)
  await page.clock.fastForward(15_001)
  await expect(page.getByRole('alert')).toHaveText(timeoutMessage)
  await expect(page.getByRole('button', { name: '核对登录状态', exact: true })).toBeEnabled()
  await assertPrivatePageHidden(page)
  await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前未登录，可重新登录')
  expect(await bodyWaitCount(page)).toBe(2)
})

test('真实登录已提交后丢响应或坏 JSON，保留 Cookie 并仅靠 GET 核对恢复账号', async ({ page, context }) => {
  const posts = credentialPosts(page)
  for (const mode of ['abort', 'bad-json']) {
    let committed = false
    let cookieHeader = false
    await page.route('**/api/v1/auth/login', async route => {
      // The context request shares the browser cookie jar, including Set-Cookie.
      const response = await context.request.fetch(route.request())
      committed = response.status() === 200
      cookieHeader = Object.hasOwn(response.headers(), 'set-cookie')
      if (mode === 'abort') await route.abort('failed')
      else {
        const headers = response.headers(); delete headers['content-length']
        await route.fulfill({ response, headers, body: '{"data":' })
      }
    })
    await page.goto('/login')
    await fillLogin(page)
    await expect(page.getByText('登录结果尚未确认', { exact: true })).toBeVisible()
    expect(committed && cookieHeader).toBe(true)
    await assertPrivatePageHidden(page)
    await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
    await expect(page.getByRole('heading', { name: '你好，Albums_One', exact: true })).toBeVisible()
    expect(posts.login).toBe(mode === 'abort' ? 1 : 2)
    await page.unroute('**/api/v1/auth/login')
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
  }
})

test('注册 POST 与正文挂起只提示结果不明并转登录，不重放注册或误报账号已创建', async ({ page }) => {
  await page.clock.install()
  const posts = credentialPosts(page)
  for (const stage of ['post', 'body']) {
    const username = stage === 'post' ? 'Recovery_Held' : 'Recovery_Body'
    const held = stage === 'post' ? await holdFirstResponse(page, 'register', { data: { id: 'late-register-user', username, created_at: '2026-11-07T00:00:00Z' } }) : null
    if (stage === 'body') await installBodyWait(page)
    try {
      await page.goto('/register')
      if (stage === 'body') await armBodyWait(page, 'register')
      await fillRegistration(page, username)
      await expect.poll(() => held ? held.state.started : bodyWaitCount(page)).toBe(1)
      await page.clock.fastForward(15_001)
      await expect(page.getByText('注册结果尚未确认', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '创建账号', exact: true })).toBeDisabled()
      await expect(page.getByText('账号已创建，请使用新密码登录。', { exact: true })).toHaveCount(0)
      await page.getByRole('link', { name: '前往登录', exact: true }).click()
      await expect(page.getByText('注册结果尚未确认，请尝试登录。', { exact: true })).toBeVisible()
      await expect(page.getByLabel('用户名', { exact: true })).toHaveValue(username)
      await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
      if (held) { held.release(); await expect.poll(() => held.state.finished).toBe(1) }
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByText('账号已创建，请使用新密码登录。', { exact: true })).toHaveCount(0)
      expect(posts.register).toBe(1)
    } finally { if (held) { held.release(); await held.remove() } }
  }
})

test('真实注册已提交但成功正文损坏，转登录能使用该账号且没有再次注册', async ({ page, context }) => {
  const posts = credentialPosts(page)
  let committed = false
  await page.route('**/api/v1/auth/register', async route => {
    const response = await context.request.fetch(route.request())
    committed = response.status() === 201
    const headers = response.headers(); delete headers['content-length']
    await route.fulfill({ response, headers, body: '{"data":' })
  })
  await page.goto('/register')
  await fillRegistration(page, 'Recovery_Registered')
  await expect(page.getByText('注册结果尚未确认', { exact: true })).toBeVisible()
  expect(committed).toBe(true)
  await expect(page.getByText('账号已创建，请使用新密码登录。', { exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: '前往登录', exact: true }).click()
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('Recovery_Registered')
  await fillLogin(page, 'Recovery_Registered')
  await expect(page.getByRole('heading', { name: '你好，Recovery_Registered', exact: true })).toBeVisible()
  expect(posts.register).toBe(1)
})

test('退出 POST 超时后私人内容持续隐藏，核对失败可重试，同账号仍登录时需明确重试退出', async ({ page }, testInfo) => {
  await page.clock.install()
  await page.setViewportSize({ width: 320, height: 850 })
  const posts = credentialPosts(page)
  await signIn(page)
  const held = await holdFirstResponse(page, 'logout', {})
  try {
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect.poll(() => held.state.started).toBe(1)
    await assertPrivatePageHidden(page)
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await page.clock.fastForward(15_001)
    await expect(page.getByRole('alert')).toContainText('退出尚未完成，退出结果尚未确认')
    await assertPrivatePageHidden(page)
    await page.screenshot({ path: testInfo.outputPath('logout-unknown-320.png'), fullPage: true })
    await restoreAndBroadcast(page)
    await expect(page.getByRole('alert')).toHaveText('浏览器登录状态已变化，退出结果尚未确认，请先核对退出状态。')
    await assertPrivatePageHidden(page)
    await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 503, contentType: 'text/html', body: '<html>Synthetic logout check unavailable</html>' }))
    await page.getByRole('button', { name: '核对退出状态', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('退出结果尚未确认')
    await expect(page.getByRole('button', { name: '核对退出状态', exact: true })).toBeEnabled()
    await page.unroute('**/api/v1/auth/me')
    await restoreAndBroadcast(page)
    await expect(page.getByRole('alert')).toHaveText('浏览器登录状态已变化，退出结果尚未确认，请先核对退出状态。')
    await assertPrivatePageHidden(page)
    await page.getByRole('button', { name: '核对退出状态', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('当前仍处于登录状态，请选择重试退出。')
    held.release()
    await expect.poll(() => held.state.finished).toBe(1)
    await assertPrivatePageHidden(page)
    expect(posts.logout).toBe(1)
    await page.getByRole('button', { name: '重试退出', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(posts.logout).toBe(2)
  } finally { held.release(); await held.remove() }
})

test('退出响应正文挂起也会释放等待，核对前后都不能重新显示私人页', async ({ page }) => {
  await page.clock.install()
  await installBodyWait(page)
  await signIn(page)
  await armBodyWait(page, 'logout')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect.poll(() => bodyWaitCount(page)).toBe(1)
  await page.clock.fastForward(15_001)
  await expect(page.getByRole('alert')).toContainText('退出结果尚未确认')
  await restoreAndBroadcast(page)
  await assertPrivatePageHidden(page)
  await page.getByRole('button', { name: '核对退出状态', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('当前仍处于登录状态，请选择重试退出。')
  await assertPrivatePageHidden(page)
  await page.getByRole('button', { name: '重试退出', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await bodyWaitCount(page)).toBe(1)
})

test('真实退出已提交并清除 Cookie 后丢响应，只核对 GET 即确认退出而不重发 POST', async ({ page, context }) => {
  const posts = credentialPosts(page)
  await signIn(page)
  let committed = false
  let cookieHeader = false
  await page.route('**/api/v1/auth/logout', async route => {
    const response = await context.request.fetch(route.request())
    committed = response.status() === 204
    cookieHeader = Object.hasOwn(response.headers(), 'set-cookie')
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('退出结果尚未确认')
  expect(committed && cookieHeader).toBe(true)
  await assertPrivatePageHidden(page)
  await page.getByRole('button', { name: '核对退出状态', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: '翻开你的手帐', exact: true })).toBeVisible()
  expect(posts.logout).toBe(1)
})

test('挂起登录切到注册再登录另一账号后，旧响应不会改写新账号或新页面', async ({ page }) => {
  const held = await holdFirstResponse(page, 'login', lateLogin)
  const posts = credentialPosts(page)
  try {
    await page.goto('/login')
    await fillLogin(page)
    await expect.poll(() => held.state.started).toBe(1)
    await page.getByRole('link', { name: '注册', exact: true }).click()
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('确认密码', { exact: true })).toHaveValue('')
    await page.getByRole('link', { name: '登录', exact: true }).click()
    await fillLogin(page, 'Albums_Two')
    await expect(page.getByRole('heading', { name: '你好，Albums_Two', exact: true })).toBeVisible()
    held.release()
    await expect.poll(() => held.state.finished).toBe(1)
    await expect(page.getByRole('heading', { name: '你好，Albums_Two', exact: true })).toBeVisible()
    await expect(page.getByText('Albums_One', { exact: true })).toHaveCount(0)
    expect(posts.login).toBe(2)
  } finally { held.release(); await held.remove() }
})

test('核对发现账号不一致不会误登录，退出前核对也不会退出后来切换的另一个账号', async ({ page, context }) => {
  const posts = credentialPosts(page)
  await page.route('**/api/v1/auth/login', route => route.abort('failed'))
  await page.goto('/login')
  await fillLogin(page)
  await expect(page.getByText('登录结果尚未确认', { exact: true })).toBeVisible()
  await page.unroute('**/api/v1/auth/login')
  await changeBrowserSession(context, page, 'Albums_Two')
  await page.getByRole('button', { name: '核对登录状态', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前浏览器登录的账号与本次输入不一致')
  await assertPrivatePageHidden(page)
  expect(posts.login).toBe(1)
  await page.getByRole('button', { name: '重新填写并登录', exact: true }).click()
  await fillLogin(page, 'Albums_Two')
  await expect(page.getByRole('heading', { name: '你好，Albums_Two', exact: true })).toBeVisible()
  await changeBrowserSession(context, page, 'Albums_One')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('当前浏览器的账号已变化，未退出另一个账号。请重新连接核对。')
  await assertPrivatePageHidden(page)
  await expect(page.getByRole('button', { name: '重试退出', exact: true })).toHaveCount(0)
  expect(posts.logout).toBe(0)
  await page.getByRole('button', { name: '重新连接并核对账号', exact: true }).click()
  await expect(page.getByRole('heading', { name: '你好，Albums_One', exact: true })).toBeVisible()
  expect(posts.logout).toBe(0)
})
