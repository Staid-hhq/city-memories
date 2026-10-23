import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'

// These accounts exist only in serve_e2e.py's temporary database. All writes
// in the owner journey use the real UI; API reads independently verify results.
const password = 'Only for isolated T14 journey!'
const guangzhou = 'a03b8f10-06dd-4b56-aef1-33cfc3696302'
const note = 'T14 合成旅行记录 🌅\n文字跟随原图，不随顺序或城市丢失。'
const card = (page: Page, id: string) => page.locator(`[data-photo-id="${id}"]`)

async function register(page: Page, username: string) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
}

async function login(page: Page, username: string) {
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
  await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible()
}

async function read(page: Page, path: string) {
  const response = await page.request.get(`/api/v1${path}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}

async function originalUnchanged(page: Page, id: string, source: Buffer, trash = false) {
  const response = await page.request.get(`/api/v1/${trash ? 'trash/' : ''}photos/${id}/original`)
  expect(response.status()).toBe(200)
  const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
  expect(hash(await response.body())).toBe(hash(source))
}

async function syntheticImage(page: Page, color: string) {
  return Buffer.from(await page.evaluate((fill) => {
    const canvas = document.createElement('canvas')
    canvas.width = 720; canvas.height = 420
    const context = canvas.getContext('2d')!
    context.fillStyle = fill; context.fillRect(0, 0, 720, 420)
    context.fillStyle = '#fff'; context.font = '28px sans-serif'
    context.fillText('T14 synthetic fixture - no private photo', 40, 210)
    return canvas.toDataURL('image/png').split(',')[1]
  }, color), 'base64')
}

test('T14 新账号连续流程：空影集→批量原图→文字排序→重复查看→跨城移动→删除恢复→退出重登', async ({ page, browser }, info) => {
  test.setTimeout(120_000)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.name))
  await page.goto('/login')
  expect(await page.evaluate(() => navigator.userAgent)).toContain('Edg/')
  console.log(`T14 Microsoft Edge ${browser.version()}; headed=${info.project.use.headless === false}`)
  let albumUrl = '', targetUrl = '', id = '', duplicateId = '', secondId = ''
  const green = await syntheticImage(page, '#668875')
  const orange = await syntheticImage(page, '#ae7858')
  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const other = await secondContext.newPage()
  try {
    await test.step('两个全新账号；搜索城市并持久保存空影集', async () => {
      await register(other, 'Journey_Visitor')
      await login(other, 'Journey_Visitor')
      await register(page, 'Journey_Owner')
      await login(page, 'Journey_Owner')
      await expect(page.getByText('你的第一本手帐，还在等一个目的地。')).toBeVisible()
      await page.getByLabel('搜索城市', { exact: true }).fill('深圳')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await page.getByRole('link', { name: '深圳市 广东省 · 地级城市' }).click()
      await page.getByLabel('影集年份', { exact: true }).fill('2026')
      await page.getByRole('button', { name: '创建或进入影集', exact: true }).click()
      await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
      albumUrl = page.url()
      await page.reload()
      await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
      await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
      await page.getByRole('link', { name: '返回城市入口' }).click()
      await expect(page.getByText('1 本城市相册 · 1 本年份影集 · 0 张照片')).toBeVisible()
      await expect(page.getByText('暂无照片 · 尚未点亮', { exact: true })).toBeVisible()
      await page.goto(albumUrl)
    })

    await test.step('批量核对并保存两种合成原图、三份独立照片', async () => {
      await page.getByRole('link', { name: /批量导入原图/ }).click()
      await page.getByLabel('选择多张原图').setInputFiles([
        { name: '26-2.png', mimeType: 'image/png', buffer: orange },
        { name: '26-1.png', mimeType: 'image/png', buffer: green },
        { name: '26-3.png', mimeType: 'image/png', buffer: green },
      ])
      await expect(page.locator('.queue-table tbody tr strong')).toHaveText(['26-1.png', '26-2.png', '26-3.png'])
      await page.getByLabel('我已核对全部文件的城市、年份和顺序').check()
      await page.getByRole('button', { name: '确认队列', exact: true }).click()
      await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
      await expect(page.getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: '保存本批全部照片', exact: true }).click()
      await expect(page.getByText('已加入影集 3 项。', { exact: true })).toBeVisible()
      await page.goto(albumUrl)
      await expect(page.locator('.photo-card')).toHaveCount(3)
      id = (await page.locator('.photo-card').nth(0).getAttribute('data-photo-id'))!
      secondId = (await page.locator('.photo-card').nth(1).getAttribute('data-photo-id'))!
      duplicateId = (await page.locator('.photo-card').nth(2).getAttribute('data-photo-id'))!
      expect(new Set([id, secondId, duplicateId]).size).toBe(3)
      await originalUnchanged(page, id, green)
      await originalUnchanged(page, secondId, orange)
      await originalUnchanged(page, duplicateId, green)
    })

    await test.step('打开原图写文字、置底、刷新与重复查看均保留独立副本', async () => {
      await page.getByRole('button', { name: '查看原图：26-1.png', exact: true }).click()
      const image = page.getByRole('dialog').getByAltText('原图：26-1.png')
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(720)
      await page.getByLabel('照片文字', { exact: true }).fill(note)
      await page.getByRole('button', { name: '保存文字', exact: true }).click()
      await expect(page.getByText('文字已保存。原图和文件名没有改变。')).toBeVisible()
      await page.screenshot({ path: info.outputPath('journey-original-note.png') })
      await page.getByRole('button', { name: '关闭原图', exact: true }).click()
      await page.getByRole('button', { name: '整理顺序', exact: true }).click()
      await card(page, id).getByRole('button', { name: '置底', exact: true }).click()
      await expect(page.locator('.photo-card').last()).toHaveAttribute('data-photo-id', id)
      await page.reload()
      await expect(page.locator('.photo-card')).toHaveCount(3)
      expect(await page.locator('.photo-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-photo-id')))).toEqual([secondId, duplicateId, id])
      await page.getByRole('link', { name: '查看重复照片', exact: true }).click()
      await expect(page.locator('.duplicate-group')).toHaveCount(1)
      await expect(page.locator('.photo-card')).toHaveCount(2)
      expect((await read(page, `/photos/${duplicateId}`)).note).toBe('')
      await page.getByRole('link', { name: '← 返回影集，全部保留', exact: true }).click()
      await expect(page.locator('.photo-card')).toHaveCount(3)
    })

    await test.step('跨城新建目标影集、移动原 ID 与文字；另一账号不能读取或修改', async () => {
      await card(page, id).getByRole('link', { name: /移动照片/ }).click()
      const select = page.getByLabel('目标城市', { exact: true })
      await expect(select).toBeVisible()
      for (let count = 0; count < 4 && !await select.locator(`option[value="${guangzhou}"]`).count(); count++) {
        const previous = await select.locator('option').count()
        await page.getByRole('button', { name: '加载更多目标城市', exact: true }).click()
        await expect.poll(() => select.locator('option').count()).toBeGreaterThan(previous)
      }
      await select.selectOption(guangzhou)
      await page.getByLabel('目标年份', { exact: true }).fill('2025')
      await page.getByRole('button', { name: '创建并选择目标影集', exact: true }).click()
      await page.getByRole('button', { name: '确认移动到目标影集末尾', exact: true }).click()
      await expect(page.getByRole('heading', { name: '移动已保存' })).toBeVisible()
      await page.getByRole('link', { name: '打开目标影集中的照片', exact: true }).click()
      await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue(note)
      await page.getByRole('button', { name: '关闭原图', exact: true }).click()
      targetUrl = page.url()
      await originalUnchanged(page, id, green)
      const moved = await read(page, `/photos/${id}`)
      expect(moved.original_filename).toBe('26-1.png')
      expect(moved.ordinal).toBe(1)
      for (const path of [`/albums/${moved.album_id}`, `/albums/${moved.album_id}/photos`, `/photos/${id}`, `/photos/${id}/original`]) {
        expect((await other.request.get(`/api/v1${path}`)).status()).toBe(404)
      }
      const csrf = await read(other, '/auth/csrf')
      const denied = await other.request.patch(`/api/v1/photos/${id}/note`, {
        headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf.csrf_token },
        data: { note: 'Must not overwrite owner', expected_photo_revision: moved.revision },
      })
      expect(denied.status()).toBe(404)
      expect((await read(page, `/photos/${id}`)).note).toBe(note)
      await other.goto(targetUrl)
      await expect(other.getByRole('alert')).toContainText('不属于当前账号')
      await expect(other.locator('.photo-card')).toHaveCount(0)
    })

    await test.step('删除最后一张仍保留空影集，回收站原图受隔离并可恢复', async () => {
      await card(page, id).getByRole('link', { name: /删除照片/ }).click()
      await page.getByRole('button', { name: '确认移入回收站', exact: true }).click()
      await expect(page.getByText(/已移入回收站。只删除了选中的这一份/)).toBeVisible()
      await page.goto(targetUrl)
      await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
      await page.getByRole('link', { name: '回收站', exact: true }).click()
      await expect(page.locator('.trash-card')).toHaveCount(1)
      await page.getByRole('link', { name: '查看与恢复：26-1.png', exact: true }).click()
      await expect(page.getByText(note, { exact: true })).toBeVisible()
      await originalUnchanged(page, id, green, true)
      for (const path of [`/trash/photos/${id}`, `/trash/photos/${id}/original`]) {
        expect((await other.request.get(`/api/v1${path}`)).status()).toBe(404)
      }
      await page.screenshot({ path: info.outputPath('journey-trash-restore.png'), fullPage: true })
      await page.getByRole('button', { name: '恢复到原影集末尾', exact: true }).click()
      await expect(page.getByText('恢复已保存。请打开原影集查看，或核对当前状态。', { exact: true })).toBeVisible()
      await page.getByRole('link', { name: '打开原影集', exact: true }).click()
      await expect(page.locator('.photo-card')).toHaveCount(1)
      await expect(page.locator('.photo-card')).toHaveAttribute('data-photo-id', id)
      await originalUnchanged(page, id, green)
    })

    await test.step('退出立即撤销原图访问，重新登录保留两城归属、文字与顺序', async () => {
      await page.getByRole('button', { name: '退出登录', exact: true }).click()
      await expect(page).toHaveURL(/\/login$/)
      expect((await page.request.get(`/api/v1/photos/${id}/original`)).status()).toBe(401)
      await expect(page.locator('.photo-card')).toHaveCount(0)
      await login(page, 'Journey_Owner')
      await expect(page.getByText('2 本城市相册 · 2 本年份影集 · 3 张照片')).toBeVisible()
      await expect(page.getByText('已有旅行照片', { exact: true })).toHaveCount(2)
      await page.screenshot({ path: info.outputPath('journey-relogin-home.png'), fullPage: true })
      await page.goto(albumUrl)
      await expect(page.locator('.photo-card')).toHaveCount(2)
      expect(await page.locator('.photo-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-photo-id')))).toEqual([secondId, duplicateId])
      await originalUnchanged(page, duplicateId, green)
      await page.goto(targetUrl)
      await page.getByRole('button', { name: '查看原图：26-1.png', exact: true }).click()
      await expect(page.getByLabel('照片文字', { exact: true })).toHaveValue(note)
      await originalUnchanged(page, id, green)
      await other.goto('/')
      await expect(other.getByText('你的第一本手帐，还在等一个目的地。')).toBeVisible()
      expect(pageErrors).toEqual([])
    })
  } finally { await secondContext.close() }
})
