import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { AppError, normalizeEvent, verifySignature, validateTask } from '../lib/domain.mjs';
import { modelConfig, AnalysisWorker, analyzeBatch } from '../lib/model.mjs';
import { createApp } from '../server.mjs';

const event = (id = 1, groupId = 20001, content = '明天下午提交实验报告。') => ({ time: 1791673200, self_id: 10001,
  post_type: 'message', message_type: 'group', group_id: groupId, message_id: id, user_id: 30001,
  sender: { nickname: '老师' }, message: [{ type: 'text', data: { text: content } }] });
const candidate = (message, extra = {}) => ({ title: '提交实验报告', kind: '作业', description: '附原始记录', responsible: '', relevance: 'everyone',
  dueDate: null, dueTime: null, dueText: '明天下午', sourceIds: [message.id], questions: ['尚未给出具体时刻'], ...extra });
function monitoredStore() {
  const store = new Store(); const normalized = normalizeEvent(event());
  store.discover(normalized.conversation, true); store.ingest(normalized);
  return { store, normalized };
}

test('消息 ID 在账号与会话范围内去重，分段文字不丢空格', () => {
  const first = normalizeEvent(event(1, 20001)); const other = normalizeEvent(event(1, 20002));
  assert.notEqual(first.message.id, other.message.id);
  assert.equal(normalizeEvent({ ...event(), message: [{ type: 'text', data: { text: 'Part A ' } }, { type: 'text', data: { text: 'Part B' } }] }).message.content, 'Part A Part B');
  assert.throws(() => normalizeEvent({ ...event(), message_id: Number.MAX_SAFE_INTEGER + 1 }), /安全整数/);
});

test('私聊会话按对方划分，不把入站 target_id 误当作对方', () => {
  const incoming = normalizeEvent({ ...event(), message_type: 'private', target_id: 10001 });
  assert.equal(incoming.conversation.remoteId, '30001');
  const outgoing = normalizeEvent({ ...event(), post_type: 'message_sent', message_type: 'private', user_id: 10001, target_id: 30001 });
  assert.equal(outgoing.conversation.id, incoming.conversation.id);
});

test('签名校验覆盖原始正文，拒绝正文被修改或签名缺失', () => {
  const raw = Buffer.from(JSON.stringify(event())); const secret = 'test-only-secret';
  const signature = `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`;
  assert.equal(verifySignature(raw, signature, secret), true);
  assert.equal(verifySignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifySignature(raw, undefined, secret), false);
});

test('未关注会话不存正文，关注后重复上报只保存一次', () => {
  const store = new Store(); const normalized = normalizeEvent(event());
  assert.equal(store.ingest(normalized).ignored, true);
  assert.equal(store.messages(normalized.conversation.id).length, 0);
  store.updateConversation(normalized.conversation.id, { monitored: true });
  assert.equal(store.ingest(normalized).saved, true);
  assert.equal(store.ingest(normalized).duplicate, true);
  assert.equal(store.messages(normalized.conversation.id).length, 1);
  store.close();
});

test('AI 结果拒绝虚构来源、虚构原话、不存在的日期及跨会话任务', () => {
  const message = normalizeEvent(event()).message;
  assert.throws(() => validateTask(candidate(message, { sourceIds: ['foreign'] }), [message], []), /来源/);
  assert.throws(() => validateTask(candidate(message, { quotes: [{ messageId: message.id, text: '明天17点交' }] }), [message], []), /原话/);
  assert.throws(() => validateTask(candidate(message, { dueDate: '2026-02-30' }), [message], []), /日期不存在/);
  assert.throws(() => validateTask(candidate(message, { id: 'other-conversation-task' }), [message], []), /会话之外/);
  assert.equal(validateTask(candidate(message), [message], []).dueTime, null);
});

test('后续通知更新原任务并保留来源与历史，完成建议仍需确认', () => {
  const { store, normalized } = monitoredStore();
  const batch = store.batch(normalized.conversation.id);
  const initial = validateTask(candidate(batch.pending[0], { dueDate: '2026-10-16' }), batch.messages, batch.tasks);
  const [first] = store.commitAnalysis(batch, [initial], '有作业通知');
  store.ingest(normalizeEvent(event(2, 20001, '实验报告改到10月14日交。')));
  const next = store.batch(normalized.conversation.id);
  const update = validateTask(candidate(next.pending[0], { id: first.id, dueDate: '2026-10-14', dueText: '10月14日', suggestedStatus: 'done' }), next.messages, next.tasks);
  store.commitAnalysis(next, [update], '截止时间调整');
  const task = store.task(first.id);
  assert.equal(store.tasks().length, 1);
  assert.equal(task.dueDate, '2026-10-14');
  assert.equal(task.history[0].dueDate, '2026-10-16');
  assert.equal(task.sourceIds.length, 2);
  assert.equal(task.status, 'pending');
  assert.equal(task.suggestedStatus, 'done');
  assert.equal(task.needsReview, true);
  store.close();
});

test('分析期间用户修改造成冲突时，整批写入和处理游标均回滚', () => {
  const { store, normalized } = monitoredStore(); const batch = store.batch(normalized.conversation.id);
  const [task] = store.commitAnalysis(batch, [validateTask(candidate(batch.pending[0]), batch.messages, batch.tasks)], '');
  store.ingest(normalizeEvent(event(2))); const next = store.batch(normalized.conversation.id);
  store.manualTask({ revision: task.revision, title: '用户修正的标题' }, task.id);
  const beforeCursor = store.conversation(normalized.conversation.id).cursor;
  assert.throws(() => store.commitAnalysis(next, [candidate(next.pending[0]), candidate(next.pending[0], { id: task.id })], ''), /分析期间/);
  assert.equal(store.tasks().length, 1);
  assert.equal(store.task(task.id).title, '用户修正的标题');
  assert.equal(store.conversation(normalized.conversation.id).cursor, beforeCursor);
  store.close();
});

test('模型失败保留消息和处理游标，不产生伪造任务', async () => {
  const { store, normalized } = monitoredStore();
  const worker = new AnalysisWorker(store, { configured: true }, async () => { throw new AppError('模拟模型超时', 502); });
  worker.enqueue(normalized.conversation.id); clearTimeout(worker.timer); await worker.drain();
  assert.equal(store.conversation(normalized.conversation.id).analysisState, 'error');
  assert.equal(store.conversation(normalized.conversation.id).cursor, 0);
  assert.equal(store.messages(normalized.conversation.id).length, 1);
  assert.equal(store.tasks().length, 0);
  worker.stop(); store.close();
});

test('模型请求携带上下文、用户规则和新消息范围；使用模拟响应验证接口契约', async () => {
  const { store, normalized } = monitoredStore(); store.saveProfile({ name: '学生甲', context: '本群通知适用于我' });
  store.updateConversation(normalized.conversation.id, { rules: '这是我的必修课群' });
  const batch = store.batch(normalized.conversation.id);
  const config = modelConfig({ MODEL_ENABLED: 'true', MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', MODEL_NAME: 'local-test-model' });
  const result = await analyzeBatch(config, batch, async (url, request) => {
    assert.equal(url.pathname, '/v1/chat/completions');
    const body = JSON.parse(request.body); const context = JSON.parse(body.messages[1].content);
    assert.equal(context.profile.name, '学生甲'); assert.equal(context.conversation.rules, '这是我的必修课群');
    assert.deepEqual(context.newMessageIds, batch.pending.map(message => message.id));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '模拟测试结果', tasks: [candidate(batch.pending[0])] }) }, finish_reason: 'stop' }] }), { status: 200 });
  });
  assert.equal(result.candidates.length, 1); store.close();
});

test('HTTP：本机会话、来源检查、签名上报、关注范围和持久化', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-workbench-test-'));
  const app = createApp({ dataDir, model: { configured: false, enabled: false, name: '', endpoint: null }, supervise: false });
  const base = await app.listen(0);
  t.after(async () => {
    await app.close();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('qq-workbench-test-')) throw new Error('拒绝清理非测试目录');
    rmSync(resolved, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
  const page = await fetch(base); const cookie = page.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST', origin = base) => fetch(base + route, { method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request('/api/profile', { name: '甲' }, 'PUT', 'https://external.example')).status, 403);
  const own = await (await request('/api/tasks', { title: '我自己的任务' })).json();
  const secret = JSON.parse(readFileSync(path.join(dataDir, 'connection.json'), 'utf8')).secret;
  const raw = JSON.stringify(event());
  const post = () => fetch(`${base}/onebot/events`, { method: 'POST', headers: { 'X-Signature': `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}` }, body: raw });
  assert.equal((await fetch(`${base}/onebot/events`, { method: 'POST', body: raw })).status, 401);
  assert.equal((await post()).status, 204);
  let snapshot = await (await request('/api/state')).json();
  const [conversation] = snapshot.conversations;
  assert.equal(conversation.monitored, false); assert.equal(conversation.messageCount, 0);
  assert.equal(snapshot.connection.messages, 0); assert.ok(snapshot.connection.lastReport);
  await request(`/api/conversations/${encodeURIComponent(conversation.id)}`, { monitored: true }, 'PATCH');
  for (let i = 0; i < 2; i++) assert.equal((await post()).status, 204);
  snapshot = await (await request('/api/state')).json();
  assert.equal(snapshot.connection.messages, 1); assert.equal(snapshot.conversations[0].messageCount, 1);
  assert.equal((await request('/api/chat', { prompt: '今天做什么' })).status, 503);
  assert.equal(app.store.chat('all').length, 0);
  await request('/api/tasks/' + own.id, { revision: own.revision, status: 'done' }, 'PATCH');
  assert.equal((await request('/api/tasks/' + own.id, { revision: own.revision, status: 'pending' }, 'PATCH')).status, 409);
  const reopened = new Store(path.join(dataDir, 'workbench.sqlite'));
  assert.equal(reopened.task(own.id).status, 'done');
  assert.equal(reopened.messages(conversation.id).length, 1); reopened.close();
});

test('HTTP：在页面中配置 AI，Key 不回传，留空沿用已保存的 Key，重启后仍生效', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-workbench-test-'));
  const calls = [];
  const fetcher = async (url, request) => { calls.push({ url: String(url), auth: request.headers.Authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), { status: 200 }); };
  let app = createApp({ dataDir, model: { configured: false, enabled: false, name: '', endpoint: null, key: '' }, supervise: false, fetcher });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = await app.listen(0);
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const request = (route, body, method = 'POST') => fetch(base + route, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const settings = { baseUrl: 'https://api.deepseek.com', name: 'deepseek-flash', enabled: true };
  assert.equal((await request('/api/model', { ...settings, baseUrl: 'http://example.com' }, 'PUT')).status, 400);
  assert.match((await (await request('/api/model', settings, 'PUT')).json()).error, /API Key/);
  assert.equal((await (await request('/api/model/test', { ...settings, key: 'sk-test-only' })).json()).reply, '连接成功，JSON 输出正常');
  assert.deepEqual(calls[0], { url: 'https://api.deepseek.com/chat/completions', auth: 'Bearer sk-test-only' });
  const saved = await (await request('/api/model', { ...settings, key: 'sk-test-only' }, 'PUT')).json();
  assert.equal(saved.configured, true); assert.equal(saved.hasKey, true);
  assert.equal((await request('/api/model', { ...settings, name: 'deepseek-v4-pro', key: '' }, 'PUT')).status, 200);
  const snapshot = await (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).text();
  assert.equal(snapshot.includes('sk-test-only'), false);
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'model.json'), 'utf8')).key, 'sk-test-only');
  await app.close();
  app = createApp({ dataDir, supervise: false });
  assert.equal(app.config.configured, true); assert.equal(app.config.name, 'deepseek-v4-pro');
});

test('换常驻账号：群会话不拆分，同一条群消息只保存一次（包括早期没有群内序号的消息）', () => {
  const store = new Store();
  const legacy = normalizeEvent(event(1));
  store.discover(legacy.conversation, true);
  assert.equal(legacy.conversation.id, 'qq:group:20001');
  assert.equal(store.ingest(legacy).saved, true);
  const fromAlt = normalizeEvent({ ...event(9), self_id: 10002, real_seq: '501' });
  assert.equal(fromAlt.conversation.id, legacy.conversation.id);
  assert.equal(store.ingest(fromAlt).duplicate, true);
  const next = normalizeEvent({ ...event(10, 20001, '下周一交表'), self_id: 10002, real_seq: '502' });
  assert.equal(store.ingest(next).saved, true);
  assert.equal(store.ingest(normalizeEvent({ ...event(77, 20001, '下周一交表'), real_seq: '502' })).duplicate, true);
  assert.equal(store.messages(legacy.conversation.id).length, 2);
  store.close();
});

test('旧版按账号编号的群会话，启动时合并到按群号编号，消息、任务和对话随之迁移', t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-workbench-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'workbench.sqlite');
  let store = new Store(file);
  const old = 'qq:10001:group:20001';
  store.discover({ id: old, kind: 'group', selfId: '10001', remoteId: '20001', title: '通知群' }, true);
  store.db.prepare('INSERT INTO messages(id,conversation_id,payload) VALUES(?,?,?)').run('m1', old, JSON.stringify({ id: 'm1', conversationId: old, content: '旧消息', sentAt: '2026-10-01T00:00:00.000Z' }));
  store.putTask({ id: 't1', conversationId: old, title: '旧任务', updatedAt: '' });
  store.appendChat(old, '问', '答');
  store.close();
  store = new Store(file);
  assert.deepEqual(store.conversations().map(value => [value.id, value.title, value.monitored, value.messageCount]), [['qq:group:20001', '通知群', true, 1]]);
  assert.equal(store.messages('qq:group:20001')[0].conversationId, 'qq:group:20001');
  assert.equal(store.task('t1').conversationId, 'qq:group:20001');
  assert.equal(store.chat('qq:group:20001').length, 2);
  store.close();
});

test('启动时清理旧版示例数据，真实会话、消息和任务保留', t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-workbench-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'workbench.sqlite');
  const store = new Store(file); const normalized = normalizeEvent(event());
  store.discover(normalized.conversation, true); store.ingest(normalized);
  const real = store.manualTask({ title: '真实任务' });
  store.discover({ id: 'demo:math', kind: 'group', selfId: 'demo', remoteId: 'demo-math', title: '示例群' }, true);
  store.db.prepare('INSERT INTO messages(id,conversation_id,payload) VALUES(?,?,?)').run('demo:m1', 'demo:math', '{}');
  store.putTask({ id: 'demo:t1', conversationId: 'demo:math', title: '示例任务', updatedAt: '' });
  store.appendChat('demo:math', '问', '答');
  store.close();
  const reopened = new Store(file);
  assert.deepEqual(reopened.conversations().map(value => value.id), [normalized.conversation.id]);
  assert.equal(reopened.messages(normalized.conversation.id).length, 1);
  assert.deepEqual(reopened.tasks().map(task => task.id), [real.id]);
  assert.equal(reopened.chat('demo:math').length, 0);
  reopened.close();
});
