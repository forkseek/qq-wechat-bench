import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, verifySignature } from './domain.mjs';
import { APP_METADATA } from './settings.mjs';

const resources = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/qq-login', ['qq-login.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/qq-login.js', ['qq-login.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/messaging.css', ['messaging.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
const sameSecret = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('请求内容过大', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function jsonBody(raw) {
  try { const value = JSON.parse(raw.toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new AppError('请求需要是有效的 JSON 对象'); }
}
export function decodePath(value) {
  try { return decodeURIComponent(value); } catch { throw new AppError('接口路径编码不正确'); }
}

// 本机来源、会话、签名和请求大小都在接口分发之前统一检查。
export function createHttpHandler({ root, settings, getPort, secret, receive, handleApi, isClosing, log }) {
  const session = randomBytes(32).toString('hex');
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${getPort()}` && host !== `localhost:${getPort()}`) throw new AppError('仅允许本机地址访问', 403);
      const origin = `http://${host}`;
      const url = new URL(req.url, origin);
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('请求来源不匹配', 403);
      if (isClosing()) throw new AppError('工作台正在关闭，请稍后重新打开', 503);
      const readRaw = (limit = settings.server.requestBodyBytes) => readBody(req, limit);
      if (url.pathname === '/onebot/events' && req.method === 'POST') {
        const raw = await readRaw();
        if (!verifySignature(raw, req.headers['x-signature'], secret)) throw new AppError('事件签名不正确', 401);
        receive(jsonBody(raw)); res.writeHead(204); res.end(); return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') { send({ ok: true, app: APP_METADATA.name, version: APP_METADATA.version, pid: process.pid }); return; }
      const resource = resources.get(url.pathname);
      if (resource && req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/qq-login') res.setHeader('Set-Cookie', `workbench_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': resource[1] }); res.end(readFileSync(path.join(root, 'public', resource[0]))); return;
      }
      const cookie = /(?:^|;\s*)workbench_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      if (!sameSecret(cookie, session)) throw new AppError('请先打开工作台页面', 403);
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new AppError('修改操作需要来自工作台页面', 403);
      await handleApi({ req, res, url, send, readRaw, json: async () => jsonBody(await readRaw()) });
    } catch (error) {
      log.write('request.failed', { code: error instanceof AppError ? `HTTP_${error.status}` : error.name }, 'warn');
      if (res.headersSent) { res.end(); return; }
      send({ error: error instanceof AppError ? error.message : '处理失败，请重试或检查本机配置。' }, error instanceof AppError ? error.status : 500);
    }
  };
}
