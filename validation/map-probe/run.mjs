import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const envText = await readFile(path.join(here, '.env.local'), 'utf8').catch(() => '');
const key = process.env.TIANDITU_KEY || envText.match(/^TIANDITU_KEY=([a-f\d]{32})\s*$/mi)?.[1];
if (!/^[a-f\d]{32}$/i.test(key || '')) throw new Error('Set TIANDITU_KEY in the environment or map-probe/.env.local.');
const redact = text => String(text).split(key).join('[REDACTED]').replace(/([?&]tk=)[^&\s"'<>]+/gi, '$1[REDACTED]');
const token = randomBytes(24).toString('hex');
const prefix = '/' + token + '/';
const out = path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const names = new Map([['shenzhen', '深圳'], ['guangzhou', '广州'], ['hezhou', '贺州'], ['hongkong', '香港'], ['macau', '澳门'], ['beijing', '北京']]);
const assets = new Map([['', ['index.html', 'text/html; charset=utf-8']], ['client.js', ['client.js', 'text/javascript; charset=utf-8']]]);
let host, child, exitInfo, timer, report, cdp, settled = false;
let stdout = '', stderr = '';
const runtimeExceptions = [];
async function connectDebugger(profile) {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exitInfo) throw new Error('Browser stopped before debugger connected');
    const contents = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    if (/^\d+\r?\n/.test(contents)) { port = Number(contents.split('\n')[0]); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!port) throw new Error('Isolated browser debugging endpoint unavailable');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = pages.find(item => item.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const waiting = new Map(); let id = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeExceptions.push(JSON.parse(redact(JSON.stringify(message.params.exceptionDetails))));
    if (message.id && waiting.has(message.id)) {
      const pending = waiting.get(message.id); waiting.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return { close: () => socket.close(), call: (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timeout = setTimeout(() => { waiting.delete(next); reject(new Error('Debugger command timed out: ' + method)); }, 10000);
    waiting.set(next, { resolve, reject, timer: timeout }); socket.send(JSON.stringify({ id: next, method, params }));
  }) };
}
const held = new Set();
let resolveResult;
const resultPromise = new Promise(resolve => { resolveResult = resolve; });
function settle(result) {
  if (settled) return;
  settled = true; resolveResult(result);
  for (const res of held) res.end('<!doctype html><title>Complete</title>');
  held.clear();
}
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self' https://*.tianditu.gov.cn data: blob:; script-src 'self' https://*.tianditu.gov.cn 'unsafe-inline' 'unsafe-eval'; style-src 'self' https://*.tianditu.gov.cn 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'; upgrade-insecure-requests");
    if (req.headers.host !== host || !req.url.startsWith(prefix)) { res.writeHead(404).end(); return; }
    if (req.headers.origin && req.headers.origin !== 'http://' + host) { res.writeHead(403).end(); return; }
    const address = new URL(req.url, 'http://' + host);
    const route = address.pathname.slice(prefix.length);
    if (req.method === 'POST' && route === 'result') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 150000) { res.writeHead(413).end(); return; } }
      const result = JSON.parse(redact(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); settle(result); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (route === 'hold') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (settled) res.end('<!doctype html><title>Complete</title>');
      else { held.add(res); req.on('close', () => held.delete(res)); }
      return;
    }
    if (route === 'config') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key })); return; }
    if (route === 'marker.svg' && names.has(address.searchParams.get('city'))) {
      const name = names.get(address.searchParams.get('city'));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="34"><rect x="1" y="1" width="74" height="28" rx="6" fill="#235c44" stroke="white" stroke-width="2"/><path d="M33 29L38 34L43 29" fill="#235c44"/><text x="38" y="21" fill="white" text-anchor="middle" font-size="14" font-family="Microsoft YaHei,sans-serif">${name}</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg); return;
    }
    if (assets.has(route)) {
      const [file, type] = assets.get(route);
      res.writeHead(200, { 'Content-Type': type }).end(await readFile(path.join(here, file))); return;
    }
    res.writeHead(404).end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening'); host = '127.0.0.1:' + server.address().port;
const url = 'http://' + host + prefix;
const interrupt = () => settle({ passed: false, error: 'Interrupted; stopping isolated test.' });
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  const checks = {
    noToken: (await fetch('http://' + host + '/config')).status,
    crossOrigin: (await fetch(url + 'config', { headers: { Origin: 'https://example.invalid' } })).status,
  };
  if (checks.noToken !== 404 || checks.crossOrigin !== 403) throw new Error('Local fixture access checks failed');
  const profile = path.join(out, 'edge-profile');
  child = spawn(edge, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--user-data-dir=' + profile, '--window-size=1360,940', '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { if (stdout.length < 3000000) stdout += chunk; });
  child.stderr.on('data', chunk => { if (stderr.length < 500000) stderr += chunk; });
  const exited = new Promise(resolve => {
    child.once('error', error => { exitInfo = { error: redact(error.message) }; settle({ passed: false, error: exitInfo.error }); resolve(); });
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; settle({ passed: false, error: 'Browser exited before completion', code }); resolve(); });
  });
  timer = setTimeout(() => settle({ passed: false, error: 'Map probe exceeded 75 seconds' }), 75000);
  console.log('Running isolated Edge map test; application key will be redacted from saved evidence.');
  if (!exitInfo) {
    cdp = await connectDebugger(profile);
    await cdp.call('Runtime.enable'); await cdp.call('Page.enable');
    await cdp.call('Page.navigate', { url });
  }
  const page = await resultPromise;
  if (cdp && !exitInfo) {
    const dom = await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
    stdout = dom.result.value || '';
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(out, 'edge-map.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp.call('Browser.close').catch(() => {});
  }
  let waitTimer;
  await Promise.race([exited, new Promise(resolve => { waitTimer = setTimeout(resolve, 10000); })]);
  clearTimeout(waitTimer);
  const domComplete = stdout.includes('data-probe-status="' + (page.passed ? 'passed' : 'failed') + '"');
  report = { capturedAt: new Date().toISOString(), passed: page.passed === true && exitInfo?.code === 0 && domComplete,
    browser: { executable: edge, mode: 'headless', viewport: '1360x940', exit: exitInfo, domComplete },
    fixtureAccessChecks: checks, page, runtimeExceptions,
    limitations: ['Six approximate fixture city points, not a verified nationwide city directory.', 'Sample city search and year albums are test data without accounts, photos, or durable storage.', 'Programmatic marker DOM clicks in Edge headless are not manual mouse usability testing.', 'Official online SDK and map tiles use the owner browser key; actual daily account consumption has not been read.'] };
  await writeFile(path.join(out, 'result.json'), redact(JSON.stringify(report, null, 2)));
  await writeFile(path.join(out, 'dom.html'), redact(stdout));
  await writeFile(path.join(out, 'edge-stderr.log'), redact(stderr));
  if (!report.passed) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  const cleanup = { browserStopped: Boolean(exitInfo) || !child, serverClosed: false };
  try {
    if (child && !exitInfo) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const [code] = await once(killer, 'exit');
      cleanup.killExitCode = code; cleanup.browserStopped = code === 0 || Boolean(exitInfo);
    }
  } catch (error) { cleanup.error = redact(error.message); }
  finally {
    cdp?.close();
    for (const res of held) res.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    cleanup.serverClosed = true;
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (report) {
    report.cleanup = cleanup; report.passed = report.passed && cleanup.browserStopped && cleanup.serverClosed;
    await writeFile(path.join(out, 'result.json'), redact(JSON.stringify(report, null, 2)));
    console.log(JSON.stringify({ passed: report.passed, output: out, browser: report.browser, cleanup,
      page: { passed: report.page.passed, error: report.page.error, tiles: report.page.tiles, errors: report.page.errors,
        checksPassed: report.page.checks?.filter(item => item.passed).length, elapsedMs: report.page.elapsedMs },
      runtimeExceptions: runtimeExceptions.map(item => ({ text: item.text, description: item.exception?.description })) }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
