import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../../frontend/node_modules/playwright/index.mjs';
import { directoryChecks } from './audit-checks.mjs';

// Bounded software integration test, not a connection to a user's browser/profile.
const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'wmts';
const supported = new Set(['national', 'regions', 'wmts']);
if (!supported.has(mode)) throw new Error('Usage: node validation/map-plan/live.mjs [national|regions|wmts]');
const env = await readFile(path.resolve(here, '../map-probe/.env.local'), 'utf8').catch(() => '');
const key = process.env.TIANDITU_KEY?.trim() || env.match(/^\s*TIANDITU_KEY\s*=\s*["']?([a-f\d]{32})["']?\s*(?:#.*)?$/mi)?.[1];
if (!/^[a-f\d]{32}$/i.test(key || '')) throw new Error('Local browser map configuration unavailable');
const redact = text => String(text).split(key).join('[REDACTED]').replace(/([?&]tk=)[^&\s"'<>]+/gi, '$1[REDACTED]');
const prefix = '/' + randomBytes(24).toString('hex') + '/';
const out = path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const files = new Map([
  ['', ['live.html', 'text/html; charset=utf-8']],
  ['guard.js', ['guard.js', 'text/javascript; charset=utf-8']],
  ['live-client.js', ['live-client.js', 'text/javascript; charset=utf-8']],
  ['wmts-adapter.js', ['wmts-adapter.js', 'text/javascript; charset=utf-8']],
  ['china-map-data.js', ['../../prototype/travel-journal/china-map-data.js', 'text/javascript; charset=utf-8']],
]);
let origin, authority, browser;
const errors = [];
const report = { capturedAt: new Date().toISOString(), mode, passed: false, views: [],
  limitations: ['Integration/visual audit only, not production or manual mouse acceptance.',
    'No full provider response, geometry dataset, private photos, account data or key is saved.',
    'Directory audit checks source consistency, not independent official nationwide correctness.'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://*.tianditu.gov.cn 'unsafe-eval'; style-src 'self' https://*.tianditu.gov.cn 'unsafe-inline'; img-src 'self' data: https://*.tianditu.gov.cn; connect-src 'self' https://*.tianditu.gov.cn; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'; upgrade-insecure-requests");
  try {
    if (req.headers.host !== authority || !req.url?.startsWith(prefix)) { res.writeHead(404).end(); return; }
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const route = new URL(req.url, origin).pathname.slice(prefix.length);
    if (route === 'map-config') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key })); return; }
    const asset = files.get(route);
    if (!asset) { res.writeHead(404).end(); return; }
    let body = await readFile(path.resolve(here, asset[0]), 'utf8');
    if (route === '') {
      // Official example uses a parser-blocking script. Keep the actual key in RAM only.
      body = body.replace('<!-- SDK_SCRIPT: inserted in the response only; no real key is written to this file. -->',
        mode === 'wmts' ? '<script src="./wmts-adapter.js"></script>'
          : '<script src="https://api.tianditu.gov.cn/api?v=4.0&amp;tk=' + key + '"></script>');
    }
    res.writeHead(200, { 'Content-Type': asset[1] }).end(body);
  } catch { res.writeHead(500).end('Audit fixture failed'); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  authority = '127.0.0.1:' + server.address().port;
  origin = 'http://' + authority;
  const url = origin + prefix;
  report.access = {
    unscoped: (await fetch(origin + '/map-config')).status,
    foreignOrigin: (await fetch(url + 'map-config', { headers: { Origin: 'https://example.invalid' } })).status,
  };
  if (report.access.unscoped !== 404 || report.access.foreignOrigin !== 403) throw new Error('Fixture isolation failed');
  browser = await chromium.launch({ channel: 'msedge', headless: true,
    args: ['--disable-background-networking', '--disable-sync', '--disable-extensions'] });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(redact(error.message)));
  const began = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => window.mapAudit?.state.firstMapMs != null, null, { timeout: 30000 });
  report.navigationToMapReadyMs = Date.now() - began;
  if (mode === 'national' || mode === 'wmts') {
    report.directory = await page.evaluate(() => window.mapAudit.directory());
    report.directoryChecks = directoryChecks(report.directory);
    // Optional in-memory human review; never dump/persist full provider responses.
    if (process.argv.includes('--review')) {
      const rows = await page.evaluate(() => window.mapAudit.reviewRows());
      console.log('PUBLIC_DIRECTORY_REVIEW ' + rows.map(row => row.code + ' ' + row.name).join(' | '));
    }
  }
  const names = mode === 'national' ? ['national', 'mainland']
    : mode === 'wmts' ? ['mainland', 'south', 'islands', 'taiwan', 'hongkongMacau']
      : ['south', 'taiwan', 'islands', 'hongkongMacau'];
  for (const name of names) {
    await page.evaluate(value => window.mapAudit.view(value), name);
    await page.waitForTimeout(400);
    await page.waitForFunction(() => {
      const t = window.mapAudit.tiles();
      return t.present > 0 && t.base > 0 && t.labels > 0 && t.decoded === t.present;
    }, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const snapshot = await page.evaluate(() => window.mapAudit.snapshot());
    await page.screenshot({ path: path.join(out, name + '.png') });
    report.views.push({ name, ...snapshot });
  }
  report.page = await page.evaluate(() => ({ ...window.mapAudit.state, errors: window.auditErrors }));
  report.errors = errors;
  report.passed = errors.length === 0 && report.page.errors.length === 0
    && (mode === 'regions' || Object.values(report.directoryChecks).every(Boolean))
    && report.views.every(v => v.tiles.base > 0 && v.tiles.labels > 0 && v.tiles.decoded === v.tiles.present);
} catch (error) { report.failure = redact(error.message); }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.cleanup = { isolatedBrowserClosed: true, serverClosed: true };
  await writeFile(path.join(out, 'report.json'), redact(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ output: out, passed: report.passed, error: report.failure, errors,
    browserVersion: report.browserVersion, navigationToMapReadyMs: report.navigationToMapReadyMs,
    directory: report.directory ? { count: report.directory.destinationCount, kinds: report.directory.kinds,
      conflicts: report.directory.conflicts, rejected: report.directory.rejected } : null, views: report.views }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
