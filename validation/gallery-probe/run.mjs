import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated feasibility probe, not an application server.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
const edge = process.argv[3] || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!source) throw new Error('Provide the sample folder as the first argument.');
const count = 400;
const token = randomBytes(24).toString('hex');
const prefix = '/' + token + '/';
const out = path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const entries = await readdir(source, { withFileTypes: true });
const files = entries.filter(item => item.isFile() && /\.jpe?g$/i.test(item.name))
  .map(item => path.join(source, item.name))
  .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
if (!files.length || files.length > 100) throw new Error('Expected 1–100 JPEG sample files.');
const samples = await Promise.all(files.map(async file => ({
  name: path.basename(file), bytes: (await stat(file)).size,
})));
async function hashes() {
  return Promise.all(files.map(async file => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  }));
}
const before = await hashes();
const imageRequests = [];
const heldResponses = new Set();
let postedResult;
let settled = false;
let resolveResult;
const resultPromise = new Promise(resolve => { resolveResult = resolve; });
const settle = result => {
  if (settled) return;
  settled = true;
  postedResult = result;
  for (const res of heldResponses) res.end('<!doctype html><title>Finished</title>');
  heldResponses.clear();
  resolveResult(result);
};
const allowedAssets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['client.js', ['client.js', 'text/javascript; charset=utf-8']],
]);
let host;
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; img-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.headers.host !== host || !req.url.startsWith(prefix)) {
      res.writeHead(404).end(); return;
    }
    if (req.headers.origin && req.headers.origin !== 'http://' + host) {
      res.writeHead(403).end(); return;
    }
    const route = req.url.slice(prefix.length).split('?')[0];
    if (req.method === 'POST' && route === 'result') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 200_000) { res.writeHead(413).end(); return; }
      }
      const result = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      settle(result);
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (route === 'hold') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (settled) res.end('<!doctype html><title>Finished</title>');
      else {
        heldResponses.add(res);
        req.on('close', () => heldResponses.delete(res));
      }
      return;
    }
    if (route === 'manifest') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        count, catalogCount: 3000, pageSize: 12, samples,
        photos: Array.from({ length: count }, (_, id) => ({
          id, sample: id % samples.length, url: './photo/' + id + '.jpg',
        })),
      }));
      return;
    }
    const match = /^photo\/(0|[1-9]\d*)\.jpg$/.exec(route);
    if (match) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id >= count) { res.writeHead(404).end(); return; }
      const index = id % files.length;
      const record = { id, sample: index, bytes: samples[index].bytes, finished: false };
      imageRequests.push(record);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': record.bytes });
      res.on('finish', () => { record.finished = true; });
      const stream = createReadStream(files[index]);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
    if (allowedAssets.has(route)) {
      const [file, type] = allowedAssets.get(route);
      res.writeHead(200, { 'Content-Type': type }).end(await readFile(path.join(here, file)));
      return;
    }
    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
host = '127.0.0.1:' + server.address().port;
const url = 'http://' + host + prefix;
let child;
let browserExit;
let timer;
let stdout = '';
let stderr = '';
let exitInfo;
const handleInterrupt = () => settle({ passed: false, error: 'Probe interrupted; cleaning up.' });
process.once('SIGINT', handleInterrupt);
process.once('SIGTERM', handleInterrupt);
try {
  const checks = {};
  for (const [name, suffix] of [
    ['missingToken', '/'],
    ['unknownId', prefix + 'photo/400.jpg'],
    ['traversal', prefix + '%2e%2e%2fdocs%2ffeasibility.md'],
  ]) {
    checks[name] = (await fetch('http://' + host + suffix)).status;
  }
  checks.crossOrigin = (await fetch(url + 'manifest', { headers: { Origin: 'https://example.invalid' } })).status;
  if (checks.missingToken !== 404 || checks.unknownId !== 404 || checks.traversal !== 404 || checks.crossOrigin !== 403) {
    throw new Error('Fixture access boundary check failed.');
  }
  const args = [
    '--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions',
    '--user-data-dir=' + path.join(out, 'edge-profile'),
    '--window-size=1280,900', '--dump-dom', '--timeout=180000',
    '--screenshot=' + path.join(out, 'edge-gallery.png'), url,
  ];
  child = spawn(edge, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { if (stdout.length < 2_000_000) stdout += chunk; });
  child.stderr.on('data', chunk => { if (stderr.length < 500_000) stderr += chunk; });
  browserExit = new Promise(resolve => {
    child.once('error', error => { exitInfo = { error: error.message }; settle({ passed: false, error: error.message }); resolve(exitInfo); });
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (!settled) settle({ passed: false, error: 'Edge exited before page completed.', code });
      resolve(exitInfo);
    });
  });
  timer = setTimeout(() => settle({ passed: false, error: 'Probe timeout after 150 seconds.' }), 150_000);
  console.log('Running isolated Edge probe; originals are read-only.');
  const pageResult = await resultPromise;
  let exitWait;
  await Promise.race([browserExit, new Promise(resolve => { exitWait = setTimeout(resolve, 10_000); })]);
  clearTimeout(exitWait);
  const after = await hashes();
  const preserved = before.every((value, index) => value === after[index]);
  const domComplete = stdout.includes('data-probe-status="' + (pageResult.passed ? 'passed' : 'failed') + '"');
  const finishedIds = new Set(imageRequests.filter(item => item.finished).map(item => item.id));
  const servedAllRecords = finishedIds.size === count && Array.from({ length: count }, (_, id) => id).every(id => finishedIds.has(id));
  const report = {
    capturedAt: new Date().toISOString(),
    passed: pageResult.passed === true && preserved && domComplete && exitInfo?.code === 0 && servedAllRecords,
    browser: { executable: edge, exit: exitInfo, viewport: '1280x900', mode: 'headless', domComplete },
    environment: { node: process.version, platform: os.platform(), release: os.release(),
      memoryGiB: Math.round(os.totalmem() / 1024 ** 3), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      network: '127.0.0.1 loopback; originals streamed from USB; no WAN throttle' },
    sampleCount: samples.length, syntheticRecords: count, pageSize: 12,
    limitations: [
      '400 synthetic records reuse 23 real JPEG contents through distinct no-store URLs.',
      'Headless loopback timings do not measure physical UI feel or Internet performance.',
      'No production authentication, database, photo import, durable sorting, or map service is implemented.',
    ],
    originalsUnchanged: preserved, originalHashes: samples.map((item, index) => ({ ...item, sha256: before[index] })),
    fixtureAccessChecks: checks, servedAllRecords, pageResult,
    requests: { count: imageRequests.length, completed: imageRequests.filter(item => item.finished).length,
      completedBytes: imageRequests.filter(item => item.finished).reduce((sum, item) => sum + item.bytes, 0),
      distinctRecordIds: new Set(imageRequests.map(item => item.id)).size,
      distinctSamples: new Set(imageRequests.map(item => item.sample)).size, records: imageRequests },
  };
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'dom.html'), stdout);
  await writeFile(path.join(out, 'edge-stderr.log'), stderr);
  console.log(JSON.stringify({ passed: report.passed, output: out,
    page: { passed: pageResult.passed, error: pageResult.error, userAgent: pageResult.userAgent,
      firstPageMs: pageResult.metrics?.firstPageMs, originalOpenMs: pageResult.metrics?.originalOpenMs,
      totalMs: pageResult.metrics?.totalMs, decodedRecords: pageResult.metrics?.all400PagesDecoded },
    requests: { ...report.requests, records: undefined }, originalsUnchanged: preserved, browser: report.browser }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (child && !exitInfo) {
    // Targets only the process started above and its own children.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const [killCode] = await once(killer, 'exit');
    if (killCode !== 0 && !exitInfo) {
      console.error('Could not confirm cleanup of the test Edge process PID ' + child.pid);
      process.exitCode = 1;
    }
  }
  for (const res of heldResponses) res.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  process.removeListener('SIGINT', handleInterrupt);
  process.removeListener('SIGTERM', handleInterrupt);
}
