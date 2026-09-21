import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const keyFile = path.resolve(here, '../../validation/map-probe/.env.local');
const sampleFiles = new Map([
  ['sample/1.jpg', 'E:\\赤湾烟波-深圳\\24-1.jpg'],
  ['sample/2.jpg', 'E:\\赤湾烟波-深圳\\24-3.jpg'],
  ['sample/3.jpg', 'E:\\赤湾烟波-深圳\\24-5.jpg'],
  ['sample/4.jpg', 'E:\\赤湾烟波-深圳\\24-9.jpg'],
  ['sample/5.jpg', 'E:\\赤湾烟波-深圳\\24-14.jpg'],
  ['sample/6.jpg', 'E:\\赤湾烟波-深圳\\24-17.jpg'],
]);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);
const rootExtensions = new Set(['.html', '.css', '.js']);
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' https://tianditu.gov.cn https://*.tianditu.gov.cn 'unsafe-eval'",
  "style-src 'self' https://tianditu.gov.cn https://*.tianditu.gov.cn 'unsafe-inline'",
  "img-src 'self' data: blob: https://tianditu.gov.cn https://*.tianditu.gov.cn",
  "font-src 'self' data: https://tianditu.gov.cn https://*.tianditu.gov.cn",
  "connect-src 'self' https://tianditu.gov.cn https://*.tianditu.gov.cn",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
].join('; ');

async function readMapKey() {
  const fromEnvironment = process.env.TIANDITU_KEY?.trim();
  let configured = fromEnvironment;
  if (!configured) {
    try {
      const text = await readFile(keyFile, 'utf8');
      configured = text.match(/^\s*TIANDITU_KEY\s*=\s*["']?([a-f\d]{32})["']?\s*(?:#.*)?$/mi)?.[1];
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read local map configuration.');
    }
  }
  return /^[a-f\d]{32}$/i.test(configured || '') ? configured : null;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function staticRoute(route) {
  const file = route || 'index.html';
  const parts = file.split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[\\\u0000-\u001f\u007f<>:"|?*#%]/u.test(part)
    || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  const extension = path.extname(file).toLowerCase();
  if (!types.has(extension)) return null;
  if (parts.length === 1 ? !rootExtensions.has(extension) : parts[0] !== 'assets') return null;
  return { file, type: types.get(extension) };
}

function respond(req, res, status, body = '', type = 'text/plain; charset=utf-8') {
  const bytes = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

async function sendFile(req, res, filename, type) {
  let file;
  try {
    file = await open(filename, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) {
      await file.close();
      respond(req, res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    if (req.method === 'HEAD') {
      await file.close();
      res.end();
      return;
    }
    const stream = file.createReadStream();
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    await file?.close().catch(() => {});
    if (res.headersSent) res.destroy();
    else respond(req, res, 404, 'Not found');
  }
}

/** Start an isolated local preview. No account or photo data is persisted. */
export async function createPreviewServer({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer between 0 and 65535.');
  }
  const root = await realpath(here);
  const mapKey = await readMapKey();
  const basePath = `/${randomBytes(24).toString('hex')}/`;
  let authority;
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    try {
      if (req.headers.host !== authority || !req.url?.startsWith(basePath)) {
        respond(req, res, 404, 'Not found');
        return;
      }
      if ((req.headers.origin && req.headers.origin !== origin)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        respond(req, res, 403, 'Forbidden');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        respond(req, res, 405, 'Method not allowed');
        return;
      }
      let route;
      try {
        route = decodeURIComponent(req.url.split('?')[0].slice(basePath.length));
      } catch {
        respond(req, res, 400, 'Invalid path');
        return;
      }
      if (route === 'map-config') {
        respond(req, res, 200, JSON.stringify({ key: mapKey }), 'application/json; charset=utf-8');
        return;
      }
      if (sampleFiles.has(route)) {
        await sendFile(req, res, sampleFiles.get(route), 'image/jpeg');
        return;
      }
      const asset = staticRoute(route);
      if (!asset) {
        respond(req, res, 404, 'Not found');
        return;
      }
      let filename;
      try {
        filename = await realpath(path.join(root, asset.file));
      } catch {
        respond(req, res, 404, 'Not found');
        return;
      }
      const resolvedAsset = staticRoute(path.relative(root, filename).split(path.sep).join('/'));
      if (!inside(root, filename) || !resolvedAsset) {
        respond(req, res, 404, 'Not found');
        return;
      }
      await sendFile(req, res, filename, resolvedAsset.type);
    } catch {
      if (res.headersSent) res.destroy();
      else respond(req, res, 500, 'Preview request failed');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(port, host, () => {
      server.removeListener('error', failed);
      authority = `${host}:${server.address().port}`;
      origin = `http://${authority}`;
      resolve();
    });
  });
  let closing;
  const close = () => {
    closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  return { server, url: `${origin}${basePath}`, origin, basePath, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) {
    console.error('Usage: node server.mjs [--port 4173]');
    process.exitCode = 1;
  } else {
    try {
      const preview = await createPreviewServer({ port: args.length ? Number(args[1]) : 0 });
      console.log(`本机原型预览：${preview.url}`);
      console.log('按 Ctrl+C 关闭。演示数据仅保留在当前页面内存中。');
      const shutdown = async () => {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        await preview.close();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    } catch {
      console.error('无法启动本机预览，请检查端口和本地地图配置文件的访问权限。');
      process.exitCode = 1;
    }
  }
}
