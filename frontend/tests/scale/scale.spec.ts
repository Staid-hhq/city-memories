import { expect, test } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const results = path.join(root, 'validation/scale/results')
const python = path.join(root, 'backend/.venv/Scripts/python.exe')
const execute = promisify(execFile)
type Item = { name: string; index: number; width: number; byte_size: number; sha256: string }
type Counters = { urls: number; bytes: number; peakUrls: number; peakBytes: number; longTasks: number; maxLongTaskMs: number }
type Memory = { private_bytes: number; working_set: number; peak_working_set: number }
type Sample = { label: string; elapsedMs: number; jsHeap: number; domNodes: number; backend: Memory; edgePrivate: number; edgeWorkingSet: number; edgeProcesses: { type: string; privateBytes: number }[]; counters: Counters }
const resume = process.env.CITY_MEMORIES_SCALE_RESUME === '1'

async function readJson(name: string) { return JSON.parse(await readFile(path.join(results, name), 'utf8')) }
function percentile(values: number[], fraction = .95) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.ceil(ordered.length * fraction) - 1]
}

test('T15 400 张原图页面导入、3000 张账号规模、双账号并发和重复浏览内存', async ({ page, browser, context }, info) => {
  const corpus = await readJson('fixtures-3400/manifest.json') as { items: Item[]; summary: object }
  expect(corpus.items).toHaveLength(3400)
  const first400 = corpus.items.slice(0, 400)
  const began = performance.now()
  const samples: Sample[] = []
  const errors: string[] = []
  const uploadStatuses: number[] = []
  page.on('response', response => {
    if (response.request().method() === 'PUT' && response.url().endsWith('/content')) {
      uploadStatuses.push(response.status())
      if (!response.ok()) console.log(`T15 upload HTTP failure: ${response.status()}`)
    }
  })
  const timings: Record<string, number | number[]> = {}
  const controller = new AbortController()
  let sampling = false
  let sampleError = ''
  let sampleRetries = 0
  let timer: ReturnType<typeof setInterval> | undefined
  page.on('pageerror', error => errors.push(error.name))
  page.on('crash', () => errors.push('PageCrash'))
  // Only instrument resource lifetimes/long tasks; never inspect password fields.
  await page.addInitScript(() => {
    const live = new Map<string, number>()
    const counters = { urls: 0, bytes: 0, peakUrls: 0, peakBytes: 0, longTasks: 0, maxLongTaskMs: 0 }
    Object.assign(window, { t15Counters: counters })
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object)
      live.set(url, object instanceof Blob ? object.size : 0)
      counters.urls = live.size; counters.bytes = [...live.values()].reduce((a, b) => a + b, 0)
      counters.peakUrls = Math.max(counters.peakUrls, counters.urls)
      counters.peakBytes = Math.max(counters.peakBytes, counters.bytes)
      return url
    }
    URL.revokeObjectURL = (url: string) => {
      live.delete(url); counters.urls = live.size; counters.bytes = [...live.values()].reduce((a, b) => a + b, 0)
      revoke(url)
    }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        counters.longTasks++; counters.maxLongTaskMs = Math.max(counters.maxLongTaskMs, entry.duration)
      }
    }).observe({ type: 'longtask', buffered: true })
  })
  const cdp = await context.newCDPSession(page)
  const browserCdp = await browser.newBrowserCDPSession()
  await cdp.send('Performance.enable')
  const state = await readJson('server.json') as { pid: number }
  async function sample(label: string, gc = false) {
    if (sampling) return
    sampling = true
    try {
      if (gc) await cdp.send('HeapProfiler.collectGarbage')
      const metrics = await cdp.send('Performance.getMetrics')
      const metricsByName = Object.fromEntries(metrics.metrics.map(metric => [metric.name, metric.value]))
      let memory: Memory[] = []
      let processTypes: string[] = []
      // Utility processes may exit between CDP enumeration and OpenProcess.
      // Refresh the inventory, never substitute zero for missing measurements.
      for (let attempt = 0; attempt < 3; attempt++) {
        const processes = await browserCdp.send('SystemInfo.getProcessInfo')
        const ids = [state.pid, ...processes.processInfo.map(process => process.id)]
        try {
          const output = await execute(python, [path.join(root, 'validation/scale/memory.py'), ids.join(',')], { windowsHide: true })
          memory = JSON.parse(output.stdout) as Memory[]
          processTypes = processes.processInfo.map(process => process.type)
          break
        } catch (error) {
          if (attempt === 2) throw error
          sampleRetries++
        }
      }
      const counters = await page.evaluate(() => (window as unknown as { t15Counters: Counters }).t15Counters)
      samples.push({ label, elapsedMs: performance.now() - began, jsHeap: metricsByName.JSHeapUsedSize,
        domNodes: metricsByName.Nodes, backend: memory[0],
        edgePrivate: memory.slice(1).reduce((sum, row) => sum + row.private_bytes, 0),
        edgeWorkingSet: memory.slice(1).reduce((sum, row) => sum + row.working_set, 0),
        edgeProcesses: memory.slice(1).map((row, index) => ({ type: processTypes[index], privateBytes: row.private_bytes })), counters })
    } finally { sampling = false }
  }
  async function runPython(action: string) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, [path.join(root, 'validation/scale/harness.py'), action], {
        cwd: root, windowsHide: true, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', data => process.stdout.write(data))
      child.stderr.on('data', data => process.stderr.write(data))
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`T15 ${action} exited ${code}`)))
    })
  }
  try {
    if (!resume) {
      await page.goto('/register')
      await page.getByLabel('用户名', { exact: true }).fill('Scale_One')
      await page.getByLabel('密码', { exact: true }).fill('Only for isolated T15 synthetic tests!')
      await page.getByLabel('确认密码', { exact: true }).fill('Only for isolated T15 synthetic tests!')
      await page.getByRole('button', { name: '创建账号', exact: true }).click()
      await expect(page).toHaveURL(/\/login$/)
    } else {
      console.log('T15 diagnostic resume: existing marked synthetic 3000 + 400 dataset')
      await page.goto('/login')
      await page.getByLabel('用户名', { exact: true }).fill('Scale_One')
    }
    await page.getByLabel('密码', { exact: true }).fill('Only for isolated T15 synthetic tests!')
    await page.getByRole('button', { name: '登录我的手帐', exact: true }).click()
    await expect(page.getByRole('heading', { name: '你好，Scale_One' })).toBeVisible()
    console.log(`T15 actual Edge ${browser.version()}, fixture bytes ${JSON.stringify(corpus.summary)}`)
    await sample('registered')
    timer = setInterval(() => { void sample('periodic').catch(error => { sampleError = String(error) }) }, 2000)
    await page.goto('/cities/a03b8f10-06dd-4b56-aef1-33cfc3696301')
    if (!resume) {
      await page.getByLabel('影集年份', { exact: true }).fill('2026')
      await page.getByRole('button', { name: '创建或进入影集', exact: true }).click()
      await expect(page.getByText('0 张照片 · 已保存的年份影集')).toBeVisible()
    } else {
      const atlas = (await (await page.request.get('/api/v1/me/atlas')).json()).data
      expect(atlas.photo_count).toBe(3000)
      await page.getByRole('link', { name: '深圳市，2026 年，400 张照片，打开相册', exact: true }).click()
    }
    const albumUrl = page.url()

    if (!resume) {
      await test.step('400 张不同原图在真实页面核对、上传和提交', async () => {
        await page.getByRole('link', { name: /批量导入原图/ }).click()
        await page.getByLabel('选择多张原图').setInputFiles(first400.map(item => path.join(results, 'fixtures-3400', item.name)))
        await expect(page.getByText('核对 400 张照片', { exact: true })).toBeVisible()
        await page.getByLabel('我已核对全部文件的城市、年份和顺序').check()
        await page.getByRole('button', { name: '确认队列', exact: true }).click()
        const started = performance.now()
        await page.getByRole('button', { name: '上传队列 / 重试未完成项', exact: true }).click()
        await expect(page.getByText('本轮上传已结束。请逐批检查结果并保存；失败项可重试，部分保存需要你明确选择。')).toBeVisible({ timeout: 600_000 })
        timings.ui400HashAndUploadMs = performance.now() - started
        expect(uploadStatuses).toHaveLength(400)
        expect(uploadStatuses.every(status => status === 200)).toBe(true)
        await expect(page.getByRole('alert')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '保存本批全部照片', exact: true })).toBeEnabled()
        const commit = performance.now()
        await page.getByRole('button', { name: '保存本批全部照片', exact: true }).click()
        await expect(page.getByText('已加入影集 400 项。', { exact: true })).toBeVisible({ timeout: 60_000 })
        timings.ui400CommitMs = performance.now() - commit
        await page.screenshot({ path: info.outputPath('400-uploaded.png') })
        console.log(`T15 UI 400 import complete: ${Math.round(Number(timings.ui400HashAndUploadMs))}ms upload; ${Math.round(Number(timings.ui400CommitMs))}ms commit`)
      })
      await page.goto(albumUrl)
      await expect(page.locator('.photo-card')).toHaveCount(24)
      await test.step('两个账号并发 HTTP 导入，主账号补至 3000，另一账号 400', async () => {
        await runPython('populate')
        const atlas = (await (await page.request.get('/api/v1/me/atlas')).json()).data
        expect(atlas.photo_count).toBe(3000)
        expect(atlas.album_count).toBe(8)
      })

      await test.step('400 张全分页无漏项重复或乱序，屏外原图卸载', async () => {
        const started = performance.now()
        while (await page.getByRole('button', { name: '加载更多照片', exact: true }).count()) {
          const count = await page.locator('.photo-card').count()
          await page.getByRole('button', { name: '加载更多照片', exact: true }).click()
          await expect(page.locator('.photo-card')).toHaveCount(Math.min(count + 24, 400))
        }
        timings.ui400PaginationMs = performance.now() - started
        await expect(page.locator('.photo-card')).toHaveCount(400)
        expect(await page.locator('.photo-caption strong').allTextContents()).toEqual(first400.map(item => item.name))
        const ids = await page.locator('.photo-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-photo-id')))
        expect(new Set(ids).size).toBe(400)
        expect(await page.locator('.photo-grid img').count()).toBeLessThanOrEqual(18)
        await page.locator('.photo-card').first().scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath('400-gallery.png') })
        await sample('400-cards-loaded', true)
        // Return by SPA navigation; repeat tests must not hide leaks by reloading JS.
        await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
        await page.getByRole('link', { name: '深圳市，2026 年，400 张照片，打开相册', exact: true }).click()
        await expect(page.locator('.photo-card')).toHaveCount(24)
      })

    }
    await test.step('3000 张数据下双账号读写响应与真实冲突', async () => {
      await runPython('benchmark')
      // Benchmark deliberately updates note/reorder versions; reload metadata once.
      await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
      await page.getByRole('link', { name: '深圳市，2026 年，400 张照片，打开相册', exact: true }).click()
      await expect(page.locator('.photo-card')).toHaveCount(24)
    })

    const turnMs: number[] = []
    const entryMs: number[] = []
    const rounds: Sample[] = []
    await test.step('20 轮预热 + 20 轮 SPA 进出和原图切换，不刷新页面掩盖内存', async () => {
      for (let round = 0; round < 40; round++) {
        const index = round % 10
        let start = performance.now()
        await page.getByRole('button', { name: `查看原图：${first400[index].name}`, exact: true }).click()
        const image = page.getByRole('dialog').locator('img')
        await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(first400[index].width)
        turnMs.push(performance.now() - start)
        await expect(page.getByText(`第 ${index + 1} / 400 张`, { exact: true })).toBeVisible()
        start = performance.now()
        await page.getByRole('button', { name: '下一张 →', exact: true }).click()
        await expect(page.getByText(`第 ${index + 2} / 400 张`, { exact: true })).toBeVisible()
        await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(first400[index + 1].width)
        turnMs.push(performance.now() - start)
        await page.getByRole('button', { name: '关闭原图', exact: true }).click()
        await page.getByRole('link', { name: '返回深圳市年份影集' }).click()
        start = performance.now()
        await page.getByRole('link', { name: '深圳市，2026 年，400 张照片，打开相册', exact: true }).click()
        await expect(page.locator('.photo-card')).toHaveCount(24)
        entryMs.push(performance.now() - start)
        await page.locator('.photo-card').first().evaluate(card => card.scrollIntoView({ block: 'start', behavior: 'instant' }))
        // SPA networkidle can be stale; empty image lists must not pass readiness.
        // Fix the viewport and wait for intrinsic dimensions, not paint/decode timing.
        await expect.poll(() => page.locator('.photo-grid .original-frame').evaluateAll(frames => {
          const visible = frames.filter(frame => {
            const rect = frame.getBoundingClientRect()
            return rect.bottom > -160 && rect.top < window.innerHeight + 160
          })
          return visible.length > 0 && visible.every(frame => (frame.querySelector('img')?.naturalWidth ?? 0) > 0)
        })).toBe(true)
        while (sampling) await new Promise(resolve => setTimeout(resolve, 25))
        await sample(`round-${round + 1}-after-gc`, true)
        rounds.push(samples[samples.length - 1])
        expect(rounds.at(-1)!.counters.urls).toBeLessThanOrEqual(18)
        console.log(`T15 browser memory round ${round + 1}/40: ${Math.round(rounds.at(-1)!.edgePrivate / 1024**2)} MiB private; ${rounds.at(-1)!.counters.urls} live blob URLs`)
      }
      timings.originalDecodeMs = turnMs
      timings.firstPageUiMs = entryMs
      const early = rounds.slice(20, 25), late = rounds.slice(35)
      const privateGrowth = percentile(late.map(r => r.edgePrivate), .5) - percentile(early.map(r => r.edgePrivate), .5)
      const heapGrowth = percentile(late.map(r => r.jsHeap), .5) - percentile(early.map(r => r.jsHeap), .5)
      timings.edgePrivateGrowthBytes = privateGrowth; timings.jsHeapGrowthBytes = heapGrowth
      expect(privateGrowth).toBeLessThan(256 * 1024**2)
      expect(heapGrowth).toBeLessThan(32 * 1024**2)
      expect(percentile(late.map(r => r.domNodes), .5) - percentile(early.map(r => r.domNodes), .5)).toBeLessThan(1000)
    })

    await test.step('模拟 20Mbps / 80ms 网络下读取 12MP 原图', async () => {
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80,
        downloadThroughput: 20_000_000 / 8, uploadThroughput: 20_000_000 / 8 })
      const start = performance.now()
      await page.getByRole('button', { name: `查看原图：${first400[0].name}`, exact: true }).click()
      await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(4000)
      timings.throttled12MpDecodeMs = performance.now() - start
      await page.screenshot({ path: info.outputPath('12mp-original.png') })
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await page.getByRole('button', { name: '关闭原图', exact: true }).click()
    })
    await test.step('3000 张回收站分页、归属与逐份恢复', () => runPython('lifecycle'))
    await runPython('audit')
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect.poll(() => page.evaluate(() => (window as unknown as { t15Counters: Counters }).t15Counters.urls)).toBe(0)
    await sample('logout', true)
    expect(errors).toEqual([])
    expect(sampleError).toBe('')
    expect(Math.max(...samples.map(row => row.edgePrivate))).toBeLessThan(4 * 1024**3)
    expect(Math.max(...samples.map(row => row.backend.private_bytes))).toBeLessThan(1024**3)
  } finally {
    if (timer) clearInterval(timer)
    controller.abort()
    while (sampling) await new Promise(resolve => setTimeout(resolve, 25))
    await writeFile(path.join(results, 'browser-metrics.json'), JSON.stringify({
      environment: { edge: browser.version(), node: process.version, cpu: os.cpus()[0].model,
        logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), platform: os.platform(),
        network: 'loopback; separate 20Mbps/80ms CDP simulation', synthetic: true },
      diagnosticResume: resume, timings, samples, errors, sampleError, sampleRetries,
      uploadStatuses, fixtureSummary: corpus.summary,
    }, null, 2))
  }
})
