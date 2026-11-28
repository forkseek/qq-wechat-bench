import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpHandler } from '../lib/http.mjs';
import { Store } from '../lib/store.mjs';
import { bindPetPreview } from '../frontend/src/pet/preview.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xunke-pet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pages(t) {
  const root = fixture(t);
  const dist = path.join(root, 'public', 'app');
  mkdirSync(dist, { recursive: true });
  for (const name of ['index', 'widget', 'pet']) writeFileSync(path.join(dist, name + '.html'), name);
  writeFileSync(path.join(root, 'public', 'index.html'), 'legacy');
  const handler = createHttpHandler({ root, getPort: () => 4321, isClosing: () => false,
    log: { write() {} }, handleApi: ({ send }) => send({ ok: true }) });
  async function request(url, headers = {}, method = 'GET') {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
      writeHead(status, h) { this.status = status; Object.assign(this.headers, h); },
      end(body) { this.body = String(body); } };
    await handler({ url, method, headers: { host: '127.0.0.1:4321', ...headers } }, res);
    return res;
  }
  return { dist, request };
}

for (const [route, entry] of [['/', 'index'], ['/widget', 'widget'], ['/pet', 'pet']]) {
  test(route + ' serves its own entry with the local page policy', async t => {
    const { request } = pages(t);
    const page = await request(route);
    assert.equal(page.status, 200);
    assert.equal(page.body, entry);
    assert.equal(page.headers['Cache-Control'], 'no-store');
    const policy = page.headers['Content-Security-Policy'];
    for (const rule of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) assert.ok(policy.split('; ').includes(rule));
    const session = page.headers['Set-Cookie'];
    assert.match(session, /^workbench_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.equal((await request('/api/state', { cookie: session.split(';')[0] })).status, 200);
    assert.equal((await request('/api/state')).status, 403);
    for (const rejected of [await request(route, { host: 'outside.invalid' }),
      await request(route, { origin: 'http://outside.invalid' }), await request(route, {}, 'POST')]) {
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers['Set-Cookie'], undefined);
    }
  });
}

test('missing pet build never serves the legacy workbench', async t => {
  const { dist, request } = pages(t);
  rmSync(path.join(dist, 'pet.html'));
  const page = await request('/pet');
  assert.equal(page.status, 503);
  assert.match(page.body, /桌宠/);
  assert.equal(page.headers['Set-Cookie'], undefined);
  rmSync(path.join(dist, 'index.html'));
  assert.equal((await request('/')).body, 'legacy');
});

test('focus reward replay after reopening the database is idempotent', t => {
  const file = path.join(fixture(t), 'fixture.sqlite');
  const store = new Store(file);
  try { assert.equal(store.focusPet(new Date(), '1000').gained, 15); } finally { store.close(); }
  const reopened = new Store(file);
  try {
    assert.equal(reopened.focusPet(new Date(), '1000').gained, 0);
    assert.equal(reopened.focusPet(new Date(), '2000').care.exp, 30);
  } finally { reopened.close(); }
});

test('browser pet supports single, double, drag suppression and input teardown without a bridge', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = new EventTarget(), controller = new AbortController(), calls = [];
  bindPetPreview(target, controller.signal, { inside: x => x < 100, click: () => calls.push('click'),
    doubleClick: () => calls.push('double'), cursor() {}, menu: () => calls.push('menu'), wheel: d => calls.push(d) });
  const fire = (type, x = 20, detail = 1) => target.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: 15, detail, deltaY: 2 }));
  fire('click'); t.mock.timers.tick(510);
  fire('click'); fire('click', 20, 2); fire('dblclick'); t.mock.timers.tick(510);
  fire('pointerdown'); fire('pointermove', 50); fire('pointerup'); fire('click', 50);
  fire('contextmenu'); fire('wheel'); t.mock.timers.tick(510);
  fire('pointerdown'); fire('pointerup'); fire('click', 150); fire('click'); controller.abort();
  t.mock.timers.tick(510); fire('contextmenu');
  assert.deepEqual(calls, ['click', 'double', 'menu', -2]);
});

const python = path.resolve(import.meta.dirname, '../data/wechat/python-3.12/tools/python.exe');
test('Windows desktop control and native input regression suite', { skip: process.platform !== 'win32' || !existsSync(python) }, () => {
  const child = spawnSync(python, ['-B', path.join(import.meta.dirname, 'pet_desktop_test.py')], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 35000
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
});
