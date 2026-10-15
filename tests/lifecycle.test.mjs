import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WechatBridge } from '../lib/wechat-bridge.mjs';
import { Messaging } from '../lib/messaging.mjs';
import { Maintenance } from '../lib/maintenance.mjs';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

const log = { write() {} };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const temporary = () => mkdtempSync(path.join(tmpdir(), 'workbench-lifecycle-'));

class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.commands = [];
    this.stdin.on('data', line => { this.commands.push(JSON.parse(line.toString())); });
  }
  reply(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  kill() { this.stdout.end(); this.stderr.end(); queueMicrotask(() => this.emit('exit', 0)); return true; }
}
function bridgeFixture(t) {
  const root = temporary(), dataDir = path.join(root, 'isolated-state'), calls = [], children = [];
  const python = path.join(root, 'data', 'wechat', 'python-3.12', 'tools', 'python.exe'); mkdirSync(path.dirname(python), { recursive: true }); writeFileSync(python, 'fixture');
  const bridge = new WechatBridge(root, { dataDir, spawnProcess(exe, args, options) { calls.push({ exe, args, options }); const child = new FakeChild(); children.push(child); return child; } });
  t.after(() => { bridge.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, bridge, calls, children };
}

test('微信进程替换：旧进程的延迟退出和旧响应不影响新请求', async t => {
  const { bridge, children } = bridgeFixture(t);
  const first = bridge.request('status'); const failed = assert.rejects(first, /连接已断开/);
  children[0].emit('exit', 1); await failed;
  const next = bridge.request('sessions');
  const requestId = children[1].commands[0].id;
  children[0].reply({ id: requestId, ok: true, data: ['stale'] });
  children[0].emit('error', new Error('late old-process error'));
  assert.equal(bridge.pending.size, 1);
  children[1].reply({ id: requestId, ok: true, data: ['current'] }); assert.deepEqual(await next, ['current']);
});

test('微信关闭立即结束等待请求，禁止重开；工作缓存按 dataDir 隔离', async t => {
  const { bridge, calls, dataDir } = bridgeFixture(t);
  const pending = bridge.request('status'); const failed = assert.rejects(pending, /连接已断开/);
  bridge.close(); await failed;
  await assert.rejects(() => bridge.request('sessions'), /已关闭/);
  assert.equal(calls.length, 1); assert.equal(bridge.pending.size, 0);
  assert.equal(calls[0].options.cwd, path.join(dataDir, 'wechat'));
  assert.equal(calls[0].options.env.WORKBENCH_WECHAT_DATA_DIR, path.join(dataDir, 'wechat'));
});

test('关闭消息组件期间的 QQ 检查返回后，不再打开微信或再次轮询', async t => {
  const dir = temporary(), store = new Store(), checking = gate(); let wechatReads = 0, closed = 0;
  const messaging = new Messaging({ dataDir: dir, store, log, enqueue() {}, qq: { status: () => checking.promise },
    wechat: { status: async () => { wechatReads++; return { online: false }; }, close() { closed++; } } });
  t.after(async () => { await messaging.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const tick = messaging.tick(), stopping = messaging.stop(); checking.resolve({ online: false });
  await Promise.all([tick, stopping]); await messaging.tick(); await messaging.start();
  assert.equal(wechatReads, 0); assert.equal(closed, 1);
  await assert.rejects(() => messaging.send({ platform: 'wechat' }, {}), /已关闭/);
});

test('定时组件未启动时保存配置不创建任务；保存失败保持原配置；退出后不重开', async t => {
  const dir = temporary(), store = new Store();
  const maintenance = new Maintenance({ dataDir: dir, store, log, analyze() {} });
  t.after(async () => { await maintenance.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  maintenance.configure({ analysisMinutes: 10 }); assert.equal(maintenance.scheduled.length, 0);
  const before = { ...maintenance.config }, setMeta = store.setMeta;
  store.setMeta = () => { throw new Error('fixture disk error'); };
  assert.throws(() => maintenance.configure({ analysisMinutes: 15 }), /disk error/); assert.deepEqual(maintenance.config, before);
  store.setMeta = setMeta;
  maintenance.start(); assert.equal(maintenance.scheduled.length, 3);
  await maintenance.stop(); maintenance.start(); assert.equal(maintenance.scheduled.length, 0);
  await assert.rejects(() => maintenance.run('analysis'), /已关闭/);
});

test('应用关闭等待正在进行的人工发送完成，重复关闭共用结果，发送记录仍完整', async t => {
  const dir = temporary(), started = gate(), sending = gate(); let closed = 0;
  const app = createApp({ dataDir: dir, supervise: false, model: { configured: false, enabled: false },
    wechatBridge: { send: async () => { started.resolve(); return sending.promise; }, close() { closed++; } } });
  t.after(async () => { sending.resolve({ status: 'sent', confirmed: true }); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const conversation = { id: 'wechat:fixture:private:filehelper', title: 'fixture', platform: 'wechat', kind: 'private', selfId: 'fixture', remoteId: 'filehelper' };
  app.store.discover(conversation);
  const base = await app.listen(0), cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0], requestId = randomUUID();
  const response = fetch(base + '/api/messages/send', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conversation.id, requestId, text: 'fixture only' }) });
  await started.promise;
  const closing = app.close(); assert.equal(app.close(), closing); assert.equal(closed, 0);
  sending.resolve({ status: 'sent', confirmed: true });
  assert.equal((await (await response).json()).status, 'sent'); await closing; assert.equal(closed, 1);
  const reopened = new Store(path.join(dir, 'workbench.sqlite'));
  assert.equal(reopened.outbox(requestId).status, 'sent'); reopened.close();
});

test('安全关闭接口需要本机会话与来源，完成后数据库可重新打开', async t => {
  const dir = temporary(), app = createApp({ dataDir: dir, supervise: false, model: { configured: false, enabled: false } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = await app.listen(0), cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', body: '{}', headers: { Origin: base } })).status, 403);
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', body: '{}', headers: { Cookie: cookie, Origin: 'https://example.com' } })).status, 403);
  const response = await fetch(base + '/api/shutdown', { method: 'POST', body: '{}', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' } });
  assert.equal(response.status, 200); await app.close();
  const reopened = new Store(path.join(dir, 'workbench.sqlite')); assert.deepEqual(reopened.tasks(), []); reopened.close();
  assert.equal(existsSync(path.join(dir, 'workbench.sqlite')), true);
});

test('Windows：真实 PowerShell 停止脚本安全关闭隔离 Node 服务，并留下完整退出记录', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
  const dir = temporary(), root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of ['start.ps1', 'package.json', 'config/workbench.json', 'scripts/runtime-config.ps1', 'scripts/runtime-config.mjs', 'lib/settings.mjs', 'lib/json-file.mjs', 'lib/domain.mjs']) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), readFileSync(path.join(root, file)));
  }
  // 临时进程只运行关闭协议，不启动 QQ、微信、模型或定时任务。
  const source = `import {createApp} from ${JSON.stringify(pathToFileURL(path.join(root, 'server.mjs')).href)};
import {writeFileSync,mkdirSync} from 'node:fs';import path from 'node:path';
const dataDir=path.join(import.meta.dirname,'data');mkdirSync(dataDir,{recursive:true});
const app=createApp({dataDir,supervise:false,model:{configured:false,enabled:false}});
const base=await app.listen(0);writeFileSync(path.join(import.meta.dirname,'.env'),'PORT='+new URL(base).port+'\\n');
writeFileSync(path.join(dataDir,'runtime.pid'),String(process.pid));process.send({base,port:new URL(base).port});process.disconnect();`;
  const script = path.join(dir, 'server.mjs'); writeFileSync(script, source);
  const child = spawn(process.execPath, [script], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
  t.after(async () => { child.kill(); await exited; rmSync(dir, { recursive: true, force: true }); });
  const ready = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Fixture service exited before ready'))); });
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'start.ps1'), '-Stop'],
    { windowsHide: true, timeout: 12_000, encoding: 'utf8', env: { ...process.env, PORT: ready.port } });
  assert.equal(await exited, 0);
  const logs = path.join(dir, 'data', 'logs');
  const files = (await import('node:fs')).readdirSync(logs);
  const events = files.flatMap(file => readFileSync(path.join(logs, file), 'utf8').trim().split('\n').map(line => JSON.parse(line).event));
  assert.ok(events.includes('app.stop'));
});
