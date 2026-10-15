import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { normalizeWechat, wechatConversation } from '../lib/wechat-domain.mjs';
import { EventLog } from '../lib/event-log.mjs';
import { Maintenance } from '../lib/maintenance.mjs';
import { Messaging } from '../lib/messaging.mjs';
import { createApp } from '../server.mjs';

const sample = (extra = {}) => ({ selfId: 'wxid_local', remoteId: 'filehelper', kind: 'private', title: '文件传输助手',
  externalId: '19', shard: 'message_0.db', time: 1791960000, senderId: 'wxid_local', senderName: '我', content: '测试通知', messageType: '文本', isSelf: true, ...extra });
function directory(t, register = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-multiplatform-'));
  if (register) t.after(() => removeDirectory(dir));
  return dir;
}
function removeDirectory(dir) {
  if (path.dirname(path.resolve(dir)) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('workbench-multiplatform-')) throw new Error('非测试目录');
  rmSync(dir, { recursive: true, force: true });
}

test('微信按账号、会话、数据库分片去重；多平台同名会话不会混合', () => {
  const store = new Store();
  const first = normalizeWechat(sample()), second = normalizeWechat(sample({ shard: 'message_1.db', content: '另一片消息' })), other = normalizeWechat(sample({ selfId: 'wxid_other' }));
  for (const item of [first, second, other]) { store.discover(item.conversation, true); store.ingest(item); }
  store.discover({ id: 'qq:group:19', selfId: '10001', remoteId: '19', kind: 'group', title: '文件传输助手' });
  assert.equal(store.conversations().length, 3);
  assert.equal(store.messages(first.conversation.id).length, 2);
  assert.equal(store.ingest(first).duplicate, true);
  assert.notEqual(first.message.id, other.message.id);
  assert.equal(store.conversation('qq:group:19').platform, 'qq');
  store.putAccount('wechat', { selfId: 'wxid_local', online: true });
  store.putAccount('qq', { selfId: '10001', online: true });
  store.putAccount('wechat', { selfId: 'wxid_other', online: true });
  assert.deepEqual(store.accounts().filter(value => value.online).map(value => value.selfId).sort(), ['10001', 'wxid_other']);
  store.close();
});

test('微信仅查看时不持久化正文、不调用 AI，关注后增量入库且保持来源原话', async t => {
  const dir = directory(t), store = new Store(), calls = [];
  const wechat = { messages: async () => [sample()], close() {} };
  const manager = new Messaging({ store, wechat, dataDir: dir, qq: {}, log: new EventLog(dir), enqueue: id => calls.push(id) });
  const conv = store.discover(wechatConversation(sample()));
  assert.equal((await manager.history(conv))[0].content, '测试通知');
  assert.equal(store.messages(conv.id).length, 0); assert.equal(calls.length, 0);
  const enabled = store.updateConversation(conv.id, { monitored: true });
  await manager.history(enabled); await manager.history(enabled);
  assert.equal(store.messages(conv.id).length, 1); assert.equal(calls.length, 1);
  assert.equal(store.messages(conv.id)[0].source, 'history');
  store.close();
});

test('发送唯一请求只执行一次；超时或部分失败不会自动重复发送', async t => {
  const dir = directory(t), store = new Store(), sends = [];
  const wechat = { async send(conv, value) { sends.push(value); throw new Error('模拟已提交后超时'); } };
  const manager = new Messaging({ store, wechat, qq: {}, dataDir: dir, log: new EventLog(dir), enqueue() {} });
  const conv = store.discover(wechatConversation(sample()));
  const request = { requestId: randomUUID(), text: '请于明天交作业' };
  const result = await manager.send(conv, request);
  assert.equal(result.status, 'uncertain');
  assert.equal((await manager.send(conv, request)).status, 'uncertain');
  assert.equal(sends.length, 1);
  await assert.rejects(() => manager.send(conv, { ...request, text: '另一个内容' }), /内容发生变化/);
  store.close();
});

test('一致性备份包含 WAL 中的新数据，备份可重新读取；维护不删除消息', async t => {
  const dir = directory(t), file = path.join(dir, 'workbench.sqlite'), store = new Store(file);
  const entry = normalizeWechat(sample()); store.discover(entry.conversation, true); store.ingest(entry);
  const maintenance = new Maintenance({ store, dataDir: dir, log: new EventLog(dir), analyze() {} });
  const before = store.messages(entry.conversation.id).length;
  const result = await maintenance.run('backup');
  assert.equal(result.status, 'success');
  const db = new DatabaseSync(path.join(dir, 'backups', result.filename), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1); db.close();
  assert.equal((await maintenance.run('optimize')).check, 'ok');
  assert.equal(store.messages(entry.conversation.id).length, before);
  const old = { ...maintenance.config };
  assert.throws(() => maintenance.configure({ analysisMinutes: 7 }), /整除/);
  assert.deepEqual(maintenance.config, old);
  await maintenance.stop(); store.close();
});

test('延迟回读只确认近期本账号已发送的文字，不重发，不认旧消息或他人消息', async t => {
  const dir = directory(t), store = new Store(), messages = [];
  let sends = 0;
  const wechat = { messages: async () => messages, send: async () => { sends++; throw new Error('回执超时'); } };
  const manager = new Messaging({ store, wechat, qq: {}, dataDir: dir, log: new EventLog(dir), enqueue() {} });
  const conv = store.discover(wechatConversation(sample()));
  const request = { requestId: randomUUID(), text: '请于明天交作业' };
  const result = await manager.send(conv, request);
  messages.push(sample({ content: request.text, time: Math.floor(Date.parse(result.at) / 1000), isSelf: false }));
  assert.equal((await manager.checkSend(conv, request.requestId)).status, 'uncertain');
  messages[0] = sample({ content: request.text, time: Math.floor(Date.parse(result.at) / 1000) - 20, isSelf: true });
  assert.equal((await manager.checkSend(conv, request.requestId)).status, 'uncertain');
  messages[0] = sample({ content: request.text, time: Math.floor(Date.parse(result.at) / 1000) + 5, isSelf: true });
  assert.equal((await manager.checkSend(conv, request.requestId)).status, 'sent');
  assert.equal((await manager.send(conv, request)).status, 'sent');
  assert.equal(sends, 1); assert.equal(store.messages(conv.id).length, 0);
  await assert.rejects(() => manager.checkSend({ ...conv, id: 'other-conversation' }, request.requestId), /不存在/);
  store.close();
});

test('客户端在发送前拒绝时记录未提交；同一编号仍不自动重试', async t => {
  const dir = directory(t), store = new Store(); let calls = 0;
  const wechat = { send: async () => { calls++; const error = new Error('客户端未登录'); error.attempted = false; error.code = 'not_ready'; throw error; } };
  const manager = new Messaging({ store, wechat, qq: {}, dataDir: dir, log: new EventLog(dir), enqueue() {} });
  const conv = store.discover(wechatConversation(sample()));
  const request = { requestId: randomUUID(), text: '实验文字' };
  assert.equal((await manager.send(conv, request)).status, 'failed');
  assert.equal((await manager.send(conv, request)).status, 'failed');
  assert.equal(calls, 1); assert.equal(store.outbox(request.requestId).code, 'not_ready');
  store.close();
});

test('QQ 好友历史中的自发消息仍属于对方会话，切换账号后拒绝读取旧私聊', async t => {
  const dir = directory(t), store = new Store(); let account = '10001', reads = 0;
  const qq = { loginInfo: async () => ({ uin: account }), read: async () => {
    reads++; return { messages: [{ message_id: '7', user_id: '10001', time: 1791960000,
      message: [{ type: 'text', data: { text: '已收到' } }], sender: { nickname: '我' } }] };
  } };
  const manager = new Messaging({ store, wechat: {}, qq, dataDir: dir, log: new EventLog(dir), enqueue() {} });
  const conv = store.discover({ id: 'qq:10001:private:20002', platform: 'qq', selfId: '10001', remoteId: '20002', kind: 'private', title: '同学' });
  const rows = await manager.history(conv);
  assert.equal(rows[0].conversationId, conv.id); assert.equal(rows[0].isSelf, true);
  assert.equal(store.messages(conv.id).length, 0);
  account = '30003'; await assert.rejects(() => manager.history(conv), /账号已改变/);
  assert.equal(reads, 1); store.close();
});

test('日志不会记录传入的密钥、聊天正文或未筛选错误对象', t => {
  const dir = directory(t), log = new EventLog(dir);
  log.write('send.start', { platform: 'wechat', secret: 'secret-value', apiKey: 'api-key-value', body: '聊天正文', error: { password: 'password' }, count: 2 });
  const rows = log.list(); assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows);
  for (const value of ['secret-value', 'api-key-value', '聊天正文', 'password']) assert.equal(serialized.includes(value), false);
  assert.equal(rows[0].count, 2);
});

test('微信媒体绑定当前消息及账号，拒绝返回缓存目录外的文件；附件保留原名', async t => {
  const dir = directory(t), store = new Store();
  const folder = path.join(dir, 'wechat', 'media'); mkdirSync(folder, { recursive: true });
  const image = path.join(folder, '测试.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(image, bytes);
  let outside = true, calls = 0;
  const wechat = { messages: async () => [sample({ messageType: '图片' })], media: async (conv, msg) => {
    calls++; assert.equal(conv.selfId, 'wxid_local'); assert.equal(msg.shard, 'message_0.db');
    return { file: outside ? path.join(dir, 'private.txt') : image, name: '测试.png' };
  } };
  const manager = new Messaging({ store, wechat, qq: {}, dataDir: dir, log: new EventLog(dir), enqueue() {} });
  const corrupted = Buffer.from(bytes); corrupted[49] ^= 1;
  assert.throws(() => manager.upload(corrupted, '损坏.png', 'image/png'), /校验失败/);
  const conv = store.discover(wechatConversation(sample()));
  await assert.rejects(() => manager.media(conv, 'not-in-this-chat'), /当前会话/);
  assert.equal(calls, 0);
  const id = normalizeWechat(sample({ messageType: '图片' })).message.id;
  await assert.rejects(() => manager.media(conv, id), /缓存路径/);
  outside = false;
  const file = await manager.media(conv, id);
  assert.equal(path.basename(manager.attachment(file.id).file), '测试.png');
  assert.deepEqual(readFileSync(manager.attachment(file.id).file), bytes);
  assert.equal((await manager.media(conv, id)).id, file.id);
  assert.equal(calls, 2); assert.equal(store.messages(conv.id).length, 0);
  store.close();
});

test('HTTP：日志与附件受会话保护，微信查看、人工发送及定时处理使用独立接口', async t => {
  const dataDir = directory(t, false), delivered = [];
  const app = createApp({ dataDir, supervise: false, model: { configured: false, enabled: false },
    wechatBridge: { status: async () => ({ online: true, available: true, phase: 'ready', selfId: 'wxid_local', name: '学生' }),
      sessions: async () => [sample()], messages: async () => [sample()], send: async (conv, value) => { delivered.push(value); return { status: 'sent', confirmed: true }; }, close() {} },
    qqBridge: { status: async () => ({ online: false }), loginInfo: async () => { throw new Error('模拟 QQ 离线'); }, lastLaunchAt: () => 0, launcherAlive: () => false } });
  const base = await app.listen(0); t.after(async () => { try { await app.close(); } finally { removeDirectory(dataDir); } });
  assert.equal((await fetch(base + '/api/logs')).status, 403);
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const api = (route, value, method = value === undefined ? 'GET' : 'POST') => fetch(base + route, { method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  await api('/api/conversations/discover', {});
  const state = await (await api('/api/state')).json();
  assert.equal(state.accounts[0].platform, 'wechat'); assert.equal(state.conversations[0].monitored, false);
  const conv = state.conversations[0];
  assert.equal((await (await api(`/api/conversations/${encodeURIComponent(conv.id)}/messages`)).json())[0].content, '测试通知');
  assert.equal(app.store.messages(conv.id).length, 0);
  const upload = await fetch(base + '/api/attachments', { method: 'POST', body: '实验附件', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent('测试.txt') } });
  const file = await upload.json(); assert.equal(file.type, 'file');
  assert.equal((await fetch(base + `/api/attachments/${file.id}`)).status, 403);
  const request = { requestId: randomUUID(), conversationId: conv.id, text: '已收到', attachments: [file.id] };
  assert.equal((await (await api('/api/messages/send', request)).json()).status, 'sent');
  await api('/api/messages/send', request); assert.equal(delivered.length, 2);
  assert.equal((await (await api('/api/maintenance/run', { job: 'backup' })).json()).status, 'success');
  assert.equal((await api('/api/maintenance/run', { job: 'arbitrary-sql' })).status, 400);
});

test('发送文件副本必须与本账号的新消息、原生编号、分片和文件名同时匹配', async t => {
  const dir = directory(t), store = new Store();
  let wrongId = true, row = sample({ messageType: '文件/链接/卡片', time: Math.floor(Date.now() / 1000) + 2 });
  const names = [];
  const wechat = { send: async () => ({ status: 'sent', confirmed: true }), messages: async () => [row],
    media: async (conv, message, name) => { names.push(name); return { sourceFilename: '测试.txt', externalId: wrongId ? 'wrong' : row.externalId, shard: row.shard }; } };
  const manager = new Messaging({ store, wechat, qq: {}, dataDir: dir, log: new EventLog(dir), enqueue() {} });
  const conv = store.discover(wechatConversation(sample()));
  const uploaded = manager.upload(Buffer.from('发送副本'), '测试.txt', 'text/plain');
  await manager.send(conv, { requestId: randomUUID(), attachments: [uploaded.id] });
  const id = normalizeWechat(row).message.id;
  await assert.rejects(() => manager.media(conv, id), /没有这个附件/);
  wrongId = false;
  assert.equal((await manager.media(conv, id)).id, uploaded.id);
  row = { ...row, externalId: '20', isSelf: false };
  await assert.rejects(() => manager.media(conv, normalizeWechat(row).message.id), /没有这个附件/);
  assert.deepEqual(names, ['测试.txt', '测试.txt', '']);
  store.close();
});
