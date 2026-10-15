import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { Messaging } from '../lib/messaging.mjs';
import { WechatBridge } from '../lib/wechat-bridge.mjs';
import { AppError } from '../lib/domain.mjs';
import { wechatConversation } from '../lib/wechat-domain.mjs';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';
import { createApp } from '../server.mjs';
import { EventLog } from '../lib/event-log.mjs';

const log = { write() {} };
const sample = (remoteId = 'filehelper', extra = {}) => ({ selfId: 'wxid_fixture', remoteId, kind: 'group', title: remoteId,
  externalId: '1', shard: 'fixture.db', time: 1791960000, senderId: 'teacher', senderName: '测试老师',
  content: '测试通知', messageType: '文本', ...extra });
function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-stability-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('workbench-stability-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('日志磁盘写入失败不打断业务，状态可见；恢复后仍能继续记录且不泄露异常路径', t => {
  const dir = directory(t), lines = []; let broken = true;
  const logger = new EventLog(dir, { append(file, line) { if (broken) throw new Error('fixture secret path'); lines.push(line); } });
  assert.doesNotThrow(() => logger.write('send.sent'));
  assert.equal(logger.status().ok, false); assert.ok(logger.status().lastFailureAt);
  assert.doesNotMatch(JSON.stringify(logger.status()), /secret/);
  broken = false; logger.write('app.start');
  assert.equal(logger.status().ok, true); assert.equal(lines.length, 1);
});

for (const failure of ['conversation', 'discovery']) test(`微信轮询隔离 ${failure} 失败，其他关注会话仍入库且账号保持在线`, async t => {
  const dir = directory(t), store = new Store(), attempted = [], events = [];
  const bad = store.discover(wechatConversation(sample('a-bad@chatroom')), true);
  const good = store.discover(wechatConversation(sample('b-good@chatroom')), true);
  const manager = new Messaging({ store, dataDir: dir, log: { write: (...args) => events.push(args) }, enqueue() {},
    qq: { status: async () => ({ online: false }) },
    wechat: { close() {}, status: async () => ({ online: true, available: true, phase: 'ready', selfId: 'wxid_fixture' }),
      sessions: async () => { if (failure === 'discovery') throw new Error('fixture discovery failure'); return []; },
      messages: async conv => { attempted.push(conv.id); if (conv.id === bad.id) throw new AppError('fixture conversation failure', 502); return [sample(conv.remoteId)]; } } });
  try {
    await manager.tick();
    assert.ok(attempted.includes(good.id)); assert.equal(store.messageCount(good.id), 1);
    assert.equal(manager.wechatStatus.online, true);
    assert.ok(events.some(([event]) => event === 'wechat.read.failed'));
  } finally { await manager.stop(); store.close(); }
});

class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.commands = []; this.killed = false;
    this.stdin.on('data', line => this.commands.push(JSON.parse(line.toString())));
  }
  reply(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  kill() { this.killed = true; this.stdout.end(); this.stderr.end(); queueMicrotask(() => this.emit('exit', 0)); return true; }
}
function bridgeFixture(t) {
  const root = directory(t), children = [];
  const python = path.join(root, 'data/wechat/python-3.12/tools/python.exe');
  mkdirSync(path.dirname(python), { recursive: true }); writeFileSync(python, 'fixture only');
  const bridge = new WechatBridge(root, { settings: { ...DEFAULT_SETTINGS, messaging: { ...DEFAULT_SETTINGS.messaging, requestTimeoutMs: 80 } },
    spawnProcess() { const child = new FakeChild(); children.push(child); return child; } });
  return { bridge, children };
}

test('微信 SDK 超时回收卡住的子进程；排队发送标为待核查，新读取可恢复且不重放发送', async t => {
  const { bridge, children } = bridgeFixture(t);
  try {
    const reading = assert.rejects(bridge.request('messages'), /读取超时/);
    const sending = assert.rejects(bridge.request('send'), /发送结果/);
    await Promise.all([reading, sending]);
    assert.equal(children[0].killed, true); assert.equal(bridge.pending.size, 0);
    const next = bridge.request('status');
    assert.equal(children.length, 2);
    children[1].reply({ id: children[1].commands[0].id, ok: true, data: { online: true } });
    assert.equal((await next).online, true);
    assert.deepEqual(children[1].commands.map(value => value.action), ['status']);
  } finally { bridge.close(); }
});

test('微信 IPC 忽略非对象和畸形响应，不使服务崩溃或提前完成请求', async t => {
  const { bridge, children } = bridgeFixture(t);
  const result = bridge.request('status'); result.catch(() => {});
  try {
    const id = children[0].commands[0].id;
    for (const value of [null, [], 'SDK diagnostic', { id, ok: 'yes', data: 'invalid' }]) assert.doesNotThrow(() => children[0].reply(value));
    assert.equal(bridge.pending.size, 1);
    children[0].reply({ id, ok: true, data: { online: true } });
    assert.deepEqual(await result, { online: true });
  } finally { bridge.close(); }
});

test('微信管道写入失败立即释放等待和工作进程，后续请求可重建连接', async t => {
  const { bridge, children } = bridgeFixture(t);
  try {
    bridge.start(); children[0].stdin.write = () => { throw new Error('fixture broken pipe'); };
    await assert.rejects(bridge.request('status'));
    assert.equal(bridge.pending.size, 0); assert.equal(children[0].killed, true);
    const next = bridge.request('status');
    children[1].reply({ id: children[1].commands[0].id, ok: true, data: { online: true } });
    assert.equal((await next).online, true);
  } finally { bridge.close(); }
});

test('重复启动因端口占用失败时，不改变原实例的发送、分析、维护状态；正常重启恢复中断任务', async t => {
  const dataDir = directory(t), options = { dataDir, supervise: false, model: { configured: false, enabled: false } };
  const first = createApp(options); let duplicate, reopened;
  try {
    const base = await first.listen(0), conv = first.store.discover(wechatConversation(sample()), true), id = randomUUID();
    first.store.putOutbox({ id, conversationId: conv.id, status: 'sending', text: 'fixture' });
    first.store.analysisState(conv.id, 'analyzing');
    first.store.db.prepare('INSERT INTO maintenance_runs VALUES (?,?)').run('fixture', JSON.stringify({ status: 'running' }));
    duplicate = createApp(options);
    await assert.rejects(duplicate.listen(Number(new URL(base).port)), { code: 'EADDRINUSE' });
    assert.equal(first.store.outbox(id).status, 'sending');
    assert.equal(first.store.conversation(conv.id).analysisState, 'analyzing');
    assert.equal(first.maintenance.snapshot().runs[0].status, 'running');
    await duplicate.close(); await first.close();
    reopened = createApp(options); await reopened.listen(0);
    assert.equal(reopened.store.outbox(id).status, 'uncertain');
    assert.equal(reopened.store.conversation(conv.id).analysisState, 'queued');
    assert.equal(reopened.maintenance.snapshot().runs[0].status, 'failed');
  } finally { await duplicate?.close(); await first.close(); await reopened?.close(); }
});

test('多部分发送已有文字成功而附件未提交时，不能报告整体未发送，也不能重试已发送部分', async t => {
  const dir = directory(t), store = new Store(); let calls = 0;
  const manager = new Messaging({ store, dataDir: dir, log, enqueue() {}, qq: {}, wechat: { close() {}, send: async () => {
    if (++calls === 1) return { confirmed: true, status: 'sent' };
    const error = new AppError('附件未提交'); error.attempted = false; throw error;
  } } });
  try {
    const conv = store.discover(wechatConversation(sample()));
    const attachment = manager.upload(Buffer.from('fixture'), '中文 测试.txt', 'text/plain');
    const request = { requestId: randomUUID(), text: 'fixture', attachments: [attachment.id] };
    const sent = await manager.send(conv, request);
    assert.equal(sent.status, 'uncertain'); assert.match(sent.error, /部分/); assert.equal(sent.parts.length, 1);
    assert.equal((await manager.send(conv, request)).status, 'uncertain'); assert.equal(calls, 2);
  } finally { await manager.stop(); store.close(); }
});

test('发送前数据库写入失败不会发送消息或永久占用平台，磁盘恢复后可再次发送', async t => {
  const dir = directory(t), store = new Store(); let calls = 0;
  const manager = new Messaging({ store, dataDir: dir, log, enqueue() {}, qq: {}, wechat: { close() {}, send: async () => { calls++; return { confirmed: true, status: 'sent' }; } } });
  const save = store.putOutbox.bind(store);
  try {
    const conv = store.discover(wechatConversation(sample()));
    store.putOutbox = () => { throw new Error('fixture disk full'); };
    await assert.rejects(manager.send(conv, { requestId: randomUUID(), text: 'fixture' }));
    assert.equal(calls, 0); assert.equal(manager.sending.size, 0);
    store.putOutbox = save;
    assert.equal((await manager.send(conv, { requestId: randomUUID(), text: 'fixture' })).status, 'sent');
  } finally { store.putOutbox = save; manager.sending.clear(); await manager.stop(); store.close(); }
});
