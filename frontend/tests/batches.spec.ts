import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { canCommit, filenameNumbering, planJobs, prepare } from '../src/importQueue'
import type { Job } from '../src/importQueue'

const city = 'a03b8f10-06dd-4b56-aef1-33cfc3696301'
// Generated 32x24 solid-color PNG, verified by Pillow; no private photo.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAANElEQVR4nGOUr9nFQEvARFPTGUYtIAKMxgFBMBpEBMFoEBEEo0FEEIwGEUEwGkQEAc2DCAD9vwGFvVB69QAAAABJRU5ErkJggg==', 'base64')
const photo = (name: string, buffer = png) => ({ name, mimeType: 'image/png', buffer })

async function login(page: Page, name = 'Batch_One') {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(name)
  await page.getByLabel('密码', { exact: true }).fill('Only for T03 browser tests!')
  await page.getByRole('button', { name: '登录我的手帐' }).click()
  await expect(page.getByRole('heading', { name: `你好，${name}` })).toBeVisible()
}
async function album(page: Page, year: number) {
  await login(page)
  await page.goto(`/cities/${city}`)
  await page.getByLabel('影集年份', { exact: true }).fill(String(year))
  await page.getByRole('button', { name: '创建或进入影集' }).click()
  await expect(page.getByRole('heading', { name: `${year} 年`, exact: true })).toBeVisible()
  const id = page.url().split('/albums/')[1]
  await page.getByRole('link', { name: /批量导入原图/ }).click()
  return id
}
async function confirm(page: Page) {
  await page.getByLabel('我已核对全部文件的城市、年份和顺序').check()
  await page.getByRole('button', { name: '确认队列', exact: true }).click()
}
async function upload(page: Page) {
  await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
  await expect(page.getByText('本轮上传已结束。请逐批检查结果并保存；失败项可重试，部分保存需要你明确选择。')).toBeVisible()
}
async function names(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/albums/${id}/photos?limit=100`)
  expect(response.status()).toBe(200)
  return (await response.json()).data.items.map((item: { original_filename: string }) => item.original_filename)
}
const job = (page: Page, index: number) => page.locator(`[data-job-index="${index}"]`)

test('编号纯规则：数字顺序、重复编号稳定、无编号不强排和非法年份', () => {
  expect(filenameNumbering('24-10.jpg')).toEqual({ year: 2024, order: 10 })
  expect(filenameNumbering('1999-2 sunset.png')).toEqual({ year: 1999, order: 2 })
  for (const name of ['photo.png', '0000-1.png', '1-2.jpg', '24-999999999999999999.png']) expect(filenameNumbering(name)).toBeNull()
  const files = ['24-10.png', '24-2.png', '24-1.png', '24-9.png', '24-2 copy.png'].map((name) => new File(['synthetic'], name))
  expect(prepare(files).map((row) => row.file.name)).toEqual(['24-1.png', '24-2.png', '24-2 copy.png', '24-9.png', '24-10.png'])
  expect(prepare([...files, new File(['x'], 'no-year.png')]).map((row) => row.file.name)).toEqual([...files.map((file) => file.name), 'no-year.png'])
  expect(prepare([files[0]], null)[0].year).toBe('unmarked')
  expect(prepare([files[0]], 2049)[0].year).toBe('2049')
})

test('400/401/3000 拆批计划保持手动顺序，不代表真实大图性能验收', () => {
  for (const count of [400, 401, 3000]) {
    const rows = prepare(Array.from({ length: count }, (_, index) => new File(['synthetic'], `24-${index + 1}.png`)))
    rows.reverse()
    const jobs = planJobs(rows, 'album')
    expect(jobs.map((value) => value.entries.length)).toEqual(Array.from({ length: Math.ceil(count / 400) }, (_, index) => Math.min(400, count - index * 400)))
    expect(jobs.flatMap((value) => value.entries.map((entry) => entry.name))).toEqual(rows.map((row) => row.file.name))
    if (jobs.length > 1) {
      jobs[1].batch = { state: 'open' } as Job['batch']
      expect(canCommit(jobs[1], jobs)).toBe(false)
      jobs[0].batch = { state: 'committed' } as Job['batch']
      expect(canCommit(jobs[1], jobs)).toBe(true)
    }
  }
  const rows = prepare([new File(['x'], 'unknown.png')])
  expect(() => planJobs(rows)).toThrow()
  rows[0].year = 'unmarked'
  expect(planJobs(rows)[0].year).toBeNull()
})

test('城市跨年份核对、未知年份手动指定、独立失败与刷新恢复', async ({ page }, testInfo) => {
  await login(page)
  await page.goto(`/cities/${city}`)
  await page.getByRole('link', { name: /批量导入原图/ }).click()
  await page.getByLabel('选择多张原图').setInputFiles([photo('24-10.png'), photo('24-2.png'), photo('25-1.png', Buffer.from('not an image')), photo('unknown.png')])
  await page.getByLabel('我已核对全部文件的城市、年份和顺序').check()
  await expect(page.getByRole('button', { name: '确认队列', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '未识别项设为未标年份' }).click()
  await page.getByRole('button', { name: '上移第 2 项', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('batch-review.png'), fullPage: true })
  await confirm(page)
  await upload(page)
  await expect(job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
  await expect(job(page, 1).getByRole('alert')).toContainText('图片已损坏')
  await expect(job(page, 1).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeDisabled()
  await expect(job(page, 2).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
  const links = await page.locator('.import-job > a').evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).pathname.split('/').pop()!))
  expect(await names(page, links[0])).toEqual([])
  await job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await job(page, 2).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  expect(await names(page, links[0])).toEqual(['24-2.png', '24-10.png'])
  expect(await names(page, links[1])).toEqual([])
  expect(await names(page, links[2])).toEqual(['unknown.png'])
  const url = page.url()
  await page.reload()
  await expect(page.locator('.import-job')).toHaveCount(3)
  await expect(job(page, 0).getByText('已加入影集 2 项。')).toBeVisible()
  await expect(job(page, 1).getByLabel('第 2 批第 1 项重选原图')).toBeVisible()
  expect(page.url()).toBe(url)
  await job(page, 1).getByRole('button', { name: '取消本批', exact: true }).click()
  await expect(job(page, 1).getByText('本批已取消。')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('batch-results.png'), fullPage: true })
})

test('固定影集不改归属、数字排序后手动调整、并发完成不乱序、重名保留', async ({ page }) => {
  const id = await album(page, 2050)
  const completion: string[] = []
  let first = true
  let parallel = 0
  let maximum = 0
  await page.route('**/api/v1/imports/*/items/*/content', async (route) => {
    parallel++; maximum = Math.max(maximum, parallel)
    const delay = first; first = false
    const response = await route.fetch()
    if (delay) await new Promise((resolve) => setTimeout(resolve, 400))
    completion.push(route.request().url()); parallel--
    await route.fulfill({ response })
  })
  await page.getByLabel('选择多张原图').setInputFiles([photo('24-10.png'), photo('24-2.png'), photo('24-1.png'), photo('24-9.png'), photo('24-2.png')])
  await expect(page.getByText(/文件名年份与当前影集不同/)).toBeVisible()
  await expect(page.getByText(/发现重复编号/)).toBeVisible()
  await expect(page.locator('.queue-table tbody tr strong')).toHaveText(['24-1.png', '24-2.png', '24-2.png', '24-9.png', '24-10.png'])
  await page.getByRole('button', { name: '下移第 1 项', exact: true }).click()
  await confirm(page)
  await upload(page)
  expect(maximum).toBe(2)
  expect(completion).toHaveLength(5)
  await job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await expect(job(page, 0).getByText('已加入影集 5 项。')).toBeVisible()
  expect(await names(page, id)).toEqual(['24-2.png', '24-1.png', '24-2.png', '24-9.png', '24-10.png'])
  expect((await (await page.request.get(`/api/v1/albums/${id}`)).json()).data.year).toBe(2050)
})

test('创建、上传、提交响应丢失后恢复和重试不重复入库', async ({ page }) => {
  const id = await album(page, 2051)
  await page.getByLabel('选择多张原图').setInputFiles([photo('51-1.png'), photo('51-2.png')])
  await confirm(page)
  await page.route('**/api/v1/albums/*/imports', async (route) => { await route.fetch(); await route.abort('failed') })
  await upload(page)
  await expect(job(page, 0).getByRole('alert')).toContainText('暂时连接不上服务')
  await page.unroute('**/api/v1/albums/*/imports')
  await page.reload()
  await expect(job(page, 0)).toBeVisible()
  await page.getByLabel('重新选择未完成原图（可多选）', { exact: true }).setInputFiles([photo('51-1.png'), photo('51-2.png')])
  await expect(page.getByText(/已匹配 2 个文件/)).toBeVisible()
  await page.route('**/api/v1/imports/*/items/*/content', async (route) => { await route.fetch(); await route.abort('failed') })
  await upload(page)
  await expect(job(page, 0).getByRole('alert')).toHaveCount(2)
  await page.unroute('**/api/v1/imports/*/items/*/content')
  await page.getByRole('button', { name: '查询队列状态', exact: true }).click()
  await expect(job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
  await page.route('**/api/v1/imports/*/commit', async (route) => { await route.fetch(); await route.abort('failed') })
  await job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await expect(job(page, 0).getByRole('alert')).toContainText('未确认保存结果')
  await page.unroute('**/api/v1/imports/*/commit')
  await job(page, 0).getByRole('button', { name: '重试本批保存（相同参数）', exact: true }).click()
  await expect(job(page, 0).getByText('已加入影集 2 项。')).toBeVisible()
  expect(await names(page, id)).toEqual(['51-1.png', '51-2.png'])
  await page.reload()
  await expect(job(page, 0).getByText('已加入影集 2 项。')).toBeVisible()
  expect(await names(page, id)).toHaveLength(2)
})

test('逐项重试与明确选择部分保存，失败文件不能悄悄入库', async ({ page }) => {
  const id = await album(page, 2052)
  let once = true
  await page.route('**/api/v1/imports/*/items/*/content', async (route) => {
    if (once) { once = false; await route.fulfill({ status: 429, headers: { 'Retry-After': '2' }, json: { error: { code: 'UPLOAD_BUSY', message: '请稍后重试' } } }); return }
    await route.continue()
  })
  await page.getByLabel('选择多张原图').setInputFiles([photo('52-1.png'), photo('52-2.png', Buffer.from('not an image')), photo('52-3.png')])
  await confirm(page); await upload(page)
  await expect(job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeDisabled()
  expect(await names(page, id)).toEqual([])
  await job(page, 0).getByRole('button', { name: '重试此项', exact: true }).first().click()
  await expect(job(page, 0).getByRole('button', { name: '先保存成功项（2 项），放弃其余项', exact: true })).toBeEnabled()
  await page.getByLabel('第 1 批第 2 项重选原图').setInputFiles(photo('wrong.png'))
  await expect(job(page, 0).getByRole('alert')).toContainText('同名、同大小')
  await job(page, 0).getByRole('button', { name: '先保存成功项（2 项），放弃其余项', exact: true }).click()
  await expect(job(page, 0).getByText(/另有 1 项未保存且已废弃/)).toBeVisible()
  expect(await names(page, id)).toEqual(['52-1.png', '52-3.png'])
})

test('停止传输、查询暂存、取消批次，以及账号退出后隔离恢复标识', async ({ page }) => {
  const id = await album(page, 2053)
  let complete: () => void = () => {}
  const held = new Promise<void>((resolve) => { complete = resolve })
  let seen = 0
  await page.route('**/api/v1/imports/*/items/*/content', async (route) => {
    const response = await route.fetch()
    seen++
    await held
    await route.fulfill({ response }).catch(() => {})
  })
  await page.getByLabel('选择多张原图').setInputFiles([photo('53-1.png'), photo('53-2.png'), photo('53-3.png')])
  await confirm(page)
  await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
  await expect.poll(() => seen).toBe(2)
  await expect(page.getByRole('progressbar')).toHaveCount(2)
  await page.getByRole('button', { name: '停止传输', exact: true }).click()
  await expect(page.getByText(/传输已停止，暂存不等于保存/)).toBeVisible()
  complete()
  await page.unroute('**/api/v1/imports/*/items/*/content')
  await page.getByRole('button', { name: '查询队列状态', exact: true }).click()
  await expect(job(page, 0).getByRole('button', { name: '先保存成功项（2 项），放弃其余项', exact: true })).toBeEnabled()
  expect(await names(page, id)).toEqual([])
  const queueId = new URL(page.url()).searchParams.get('queue')
  await job(page, 0).getByRole('button', { name: '取消本批', exact: true }).click()
  await expect(job(page, 0).getByText('本批已取消。')).toBeVisible()
  expect(await names(page, id)).toEqual([])
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get(`/api/v1/imports/queue/${queueId}`)).status()).toBe(401)
  await login(page, 'Batch_Two')
  expect((await (await page.request.get(`/api/v1/imports/queue/${queueId}`)).json()).data.items).toEqual([])
  await expect(page.locator('.import-job')).toHaveCount(0)
})

test('影集并发更新要求重新核对，过期批次仍可取消清理', async ({ page }) => {
  await album(page, 2054)
  await page.setViewportSize({ width: 1024, height: 820 })
  await page.getByLabel('选择多张原图').setInputFiles([photo('54-1.png'), photo('54-2.png')])
  await confirm(page); await upload(page)
  await page.route('**/api/v1/imports/*/commit', (route) => route.fulfill({ status: 409, json: { error: { code: 'ALBUM_CHANGED', message: '影集已有更新，请重新核对后保存' } } }))
  await job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await expect(job(page, 0).getByRole('button', { name: '重试本批保存（相同参数）' })).toBeDisabled()
  await page.unroute('**/api/v1/imports/*/commit')
  await page.getByRole('button', { name: '查询队列状态 / 重新核对影集', exact: true }).click()
  await expect(job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
  await page.route('**/api/v1/imports/queue/*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.data.items[0].state = 'expired'
    await route.fulfill({ response, json })
  })
  await page.reload()
  await expect(page.getByText('本批已过期，不能继续上传或保存，可取消并清理暂存。')).toBeVisible()
  await expect(job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true })).toHaveCount(0)
  await job(page, 0).getByRole('button', { name: '取消本批并清理', exact: true }).click()
  await expect(job(page, 0).getByText('本批已取消。')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('401 张小型合成 PNG 真实上传拆成两批，后批不能先保存', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await album(page, 2055)
  const count = 401
  await page.getByLabel('选择多张原图').setInputFiles(Array.from({ length: count }, (_, index) => photo(`55-${index + 1}.png`)))
  await expect(page.locator('.queue-table tbody tr')).toHaveCount(50)
  await confirm(page)
  await expect(page.locator('.import-job')).toHaveCount(2)
  await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
  await expect(page.getByText('本轮上传已结束。请逐批检查结果并保存；失败项可重试，部分保存需要你明确选择。')).toBeVisible({ timeout: 90_000 })
  await expect(job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
  await expect(job(page, 1).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeDisabled()
  await job(page, 0).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await expect(job(page, 0).getByText('已加入影集 400 项。')).toBeVisible({ timeout: 20_000 })
  await expect(job(page, 1).getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
  await job(page, 1).getByRole('button', { name: '保存本批全部照片', exact: true }).click()
  await expect(page.getByText('共 401 项 · 已保存 401 项')).toBeVisible()
  let cursor: string | null = null
  const filenames: string[] = []
  do {
    const response = await page.request.get(`/api/v1/albums/${id}/photos?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
    const data = (await response.json()).data
    filenames.push(...data.items.map((item: { original_filename: string }) => item.original_filename))
    cursor = data.next_cursor
  } while (cursor)
  expect(filenames).toEqual(Array.from({ length: count }, (_, index) => `55-${index + 1}.png`))
})

test('上传中退出取消在途请求，晚到响应不污染下一账号', async ({ page }) => {
  await album(page, 2056)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let entered = 0
  await page.route('**/api/v1/imports/*/items/*/content', async (route) => {
    entered++
    await held
    await route.fulfill({ status: 200, json: { data: { state: 'staged' } } }).catch(() => {})
  })
  await page.getByLabel('选择多张原图').setInputFiles([photo('56-1.png'), photo('56-2.png')])
  await confirm(page)
  await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
  await expect.poll(() => entered).toBe(2)
  const queueId = new URL(page.url()).searchParams.get('queue')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  release()
  await login(page, 'Batch_Two')
  await expect(page.locator('.import-job')).toHaveCount(0)
  expect((await (await page.request.get(`/api/v1/imports/queue/${queueId}`)).json()).data.items).toEqual([])
  expect(errors).toEqual([])
})
