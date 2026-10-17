import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const results = path.join(root, 'validation/local-delivery/results')
const execute = promisify(execFile)

test('T16 空库启动、构建产物、深链接刷新和同源 API 代理', async ({ page, browser }) => {
  const startup = JSON.parse(await readFile(path.join(results, 'startup.json'), 'utf8'))
  expect(startup.initial_counts).toEqual({ users: 0, albums: 0, photos: 0 })
  expect(startup.migration).toBe('b61e24f803a7')
  expect(startup.map_enabled).toBe(false)

  const errors: string[] = []
  const external: string[] = []
  page.on('pageerror', error => errors.push(error.name))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== 'http://127.0.0.1:5173') {
      external.push(url.origin)
      return route.abort()
    }
    return route.continue()
  })
  const index = await readFile(path.join(root, 'frontend/dist/index.html'), 'utf8')
  const response = await page.goto('/login')
  expect(response?.status()).toBe(200)
  expect(await response!.text()).toBe(index)
  expect(index).not.toContain('/@vite/client')
  expect(index).not.toContain('/src/main.tsx')
  expect(await page.evaluate(() => navigator.userAgent)).toContain('Edg/')
  await expect(page.getByRole('button', { name: '登录我的手帐', exact: true })).toBeVisible()

  const assets = [...index.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1])
  expect(assets.some(asset => asset.endsWith('.js'))).toBe(true)
  expect(assets.some(asset => asset.endsWith('.css'))).toBe(true)
  const manifest = []
  for (const asset of assets) {
    const response = await page.request.get(asset)
    expect(response.status()).toBe(200)
    const expected = await readFile(path.join(root, 'frontend/dist', asset.slice(1)))
    const actual = await response.body()
    expect(actual.equals(expected)).toBe(true)
    manifest.push({ asset, bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') })
  }
  expect((await page.request.get('/api/v1/health')).status()).toBe(200)
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
  expect((await page.request.get('/api/v1/map/config')).status()).toBe(401)
  let refusal = ''
  try {
    await execute(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'),
      'preview', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
      cwd: path.join(root, 'frontend'), windowsHide: true, timeout: 15_000,
    })
  } catch (error) {
    expect(error).toMatchObject({ code: 1 })
    refusal = (error as { stderr: string }).stderr
  }
  expect(refusal).toContain('Port 5173 is already in use')
  const deep = await page.goto('/albums/not-a-real-id')
  expect(deep?.status()).toBe(200)
  expect(await deep!.text()).toBe(index)
  await expect(page).toHaveURL(/\/login$/)
  await page.reload()
  await expect(page.getByRole('button', { name: '登录我的手帐', exact: true })).toBeVisible()
  expect(errors).toEqual([])
  expect(external).toEqual([])
  await writeFile(path.join(results, 'build-manifest.json'), JSON.stringify({
    edge: browser.version(), headed: true, artifacts: manifest,
    index_sha256: createHash('sha256').update(index).digest('hex'),
    initial_counts: startup.initial_counts, migration: startup.migration,
    page_errors: errors.length, external_requests: external.length, port_conflict_refused: true,
  }, null, 2))
  console.log(`T16 built frontend verified in Microsoft Edge ${browser.version()}; empty initial database`)
})
