import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError, normalizeEvent, validateTask } from '../lib/domain.mjs';
import { Store } from '../lib/store.mjs';
import { AnalysisWorker, analyzeBatch, modelConfig, chatContext, answerChat } from '../lib/model.mjs';
import { captureConfig, permitsCapture } from '../lib/capture.mjs';
import { setAutostart, autostartEnabled, shortcutPath } from '../lib/autostart.mjs';
import { createApp } from '../server.mjs';

const event = (id = 1, groupId = 20001, content = '明天下午5点前提交实验报告。') => ({ time: 1791673200 + id, self_id: 10001, post_type: 'message',
  message_type: 'group', group_id: groupId, message_id: id, user_id: 30001, sender: { nickname: '老师' }, message: [{ type: 'text', data: { text: content } }] });
const candidate = (message, extra = {}) => ({ title: '提交实验报告', relevance: 'everyone', sourceIds: [message.id], dueDate: '2026-10-16', dueTime: '17:00', dueText: '明天下午5点前', ...extra });
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-automation-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('截止时间依据：原文写明 / 推算 / 未给出；没说明的按推算处理', () => {
  const message = normalizeEvent(event()).message;
  assert.equal(validateTask(candidate(message, { dueBasis: 'explicit' }), [message], []).dueBasis, 'explicit');
  assert.equal(validateTask(candidate(message), [message], []).dueBasis, 'inferred');
  assert.equal(validateTask(candidate(message, { dueDate: null, dueTime: null, dueBasis: 'explicit' }), [message], []).dueBasis, 'none');
});

test('手动修改截止时间后依据变为「你填写的」；只改标题则保留 AI 的依据', () => {
  const store = new Store(); const normalized = normalizeEvent(event());
  store.discover(normalized.conversation, true); store.ingest(normalized);
  const batch = store.batch(normalized.conversation.id);
  const [task] = store.commitAnalysis(batch, [validateTask(candidate(batch.pending[0], { dueBasis: 'explicit' }), batch.messages, [])], '');
  const renamed = store.manualTask({ revision: task.revision, title: '交实验报告', dueDate: '2026-10-16', dueTime: '17:00' }, task.id);
  assert.equal(renamed.dueBasis, 'explicit');
  assert.equal(store.manualTask({ revision: renamed.revision, dueDate: '2026-10-17' }, task.id).dueBasis, 'manual');
  assert.equal(store.manualTask({ title: '自己的任务', dueDate: '2026-10-20' }).dueBasis, 'manual');
  assert.equal(store.manualTask({ title: '没有期限' }).dueBasis, 'none');
  store.close();
});

test('AI 每整理一批都留下记录；失败也记录原因并安排自动重试', async () => {
  const store = new Store(); const normalized = normalizeEvent(event());
  store.discover(normalized.conversation, true); store.ingest(normalized);
  assert.equal(store.pendingCount(), 1);
  let fail = true;
  const worker = new AnalysisWorker(store, { configured: true }, async (config, batch) => {
    if (fail) throw new AppError('模拟模型超时', 502);
    return { candidates: [validateTask(candidate(batch.pending[0]), batch.messages, batch.tasks, new Set(batch.pending.map(value => value.id)))], summary: '' };
  });
  worker.enqueue(normalized.conversation.id); clearTimeout(worker.timer); await worker.drain();
  assert.equal(store.runs()[0].error, '模拟模型超时');
  assert.equal(worker.retries.has(normalized.conversation.id), true);
  fail = false;
  worker.enqueue(normalized.conversation.id); clearTimeout(worker.timer); await worker.drain();
  const [run] = store.runs();
  assert.deepEqual([run.messages, run.created, run.updated, run.needsReview], [1, 1, 0, 1]);
  assert.equal(store.pendingCount(), 0);
  worker.stop(); store.close();
});

test('调用 DeepSeek 时关闭思考模式；其他服务不发该参数；空回答自动重试一次', async () => {
  const store = new Store(); const normalized = normalizeEvent(event());
  store.discover(normalized.conversation, true); store.ingest(normalized);
  const batch = store.batch(normalized.conversation.id);
  const bodies = [];
  const reply = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
  const fetcher = async (url, request) => { bodies.push({ host: url.hostname, ...JSON.parse(request.body) });
    return reply(bodies.length === 1 ? '' : JSON.stringify({ summary: '', tasks: [candidate(batch.pending[0])] })); };
  const deepseek = modelConfig({ MODEL_ENABLED: 'true', MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'deepseek-flash', MODEL_API_KEY: 'k' });
  assert.equal((await analyzeBatch(deepseek, batch, fetcher)).candidates.length, 1);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
  assert.equal(bodies[1].max_tokens, 8000);
  const other = modelConfig({ MODEL_ENABLED: 'true', MODEL_BASE_URL: 'https://example.com/v1', MODEL_NAME: 'm', MODEL_API_KEY: 'k' });
  await analyzeBatch(other, batch, fetcher);
  assert.equal('thinking' in bodies[2], false);
  store.close();
});

test('通知助手：每条任务带所属群名、状态和来源原话，时间为北京时间，只包含已接入的群', async () => {
  const store = new Store();
  for (const [groupId, title, text] of [[20001, '英语群', '周五交英语作业。'], [20002, '实验群', '明天交实验报告。']]) {
    const normalized = normalizeEvent({ ...event(groupId, groupId, text), group_name: title });
    store.discover(normalized.conversation, true); store.ingest(normalized);
    const batch = store.batch(normalized.conversation.id);
    store.commitAnalysis(batch, [validateTask(candidate(batch.pending[0], { title: `${title}任务` }), batch.messages, [])], '');
  }
  const [english] = store.tasks().filter(task => task.title === '英语群任务');
  store.manualTask({ revision: english.revision, status: 'cancelled' }, english.id);
  store.updateConversation('qq:group:20002', { monitored: true });
  store.discover({ id: 'qq:group:20003', kind: 'group', selfId: '10001', remoteId: '20003', title: '未关注的群' }, false);
  const context = chatContext(store, 'all');
  assert.deepEqual(context.connectedGroups.map(group => group.group).sort(), ['实验群', '英语群']);
  assert.deepEqual(context.tasks.map(task => [task.title, task.group, task.status]), [['实验群任务', '实验群', '未完成']]);
  assert.equal(context.tasks[0].sources[0].group, '实验群');
  assert.match(context.tasks[0].sources[0].sentAt, /^2026\/10\/\d+ \d{2}:\d{2}$/);
  let system = '';
  const reply = await answerChat(store, { configured: true, endpoint: new URL('https://example.com/v1/chat/completions'), name: 'm', key: 'k' }, 'all', '有什么要做的？',
    async (url, request) => { system = JSON.parse(request.body).messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: '实验群有一项。' }, finish_reason: 'stop' }] })); });
  assert.equal(reply, '实验群有一项。');
  assert.match(system, /不要提到 connectedGroups 以外的群/);
  assert.equal(system.includes('未关注的群'), false);
  store.close();
});

test('记录最近一条消息上报来自哪个群、是否已接入；历史补拉不覆盖', () => {
  const store = new Store();
  store.recordEvent({ history: false, saved: false, source: { kind: 'group', groupId: '30001', name: '羽协', captured: false } });
  assert.deepEqual([store.bridge().lastSource.name, store.bridge().lastSource.captured], ['羽协', false]);
  store.recordEvent({ history: true, saved: true, source: { kind: 'group', groupId: '20001', name: '通知群', captured: true } });
  assert.equal(store.bridge().lastSource.name, '羽协');
  store.recordEvent({ history: false, saved: false, source: null });
  assert.equal(store.bridge().lastSource.name, '羽协');
  store.close();
});

test('采集范围可以为空：一个群都不拉，而不是全部拉', () => {
  const capture = captureConfig({ groups: [] });
  assert.deepEqual(capture.groups, []);
  assert.equal(permitsCapture(event(), capture), false);
});

test('HTTP：添加、移除、恢复拉取的群，写入 capture.json，移除后保留历史但不再关注', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-automation-test-'));
  const bridge = { current: { available: false, online: false }, async status() { return this.current; }, async loginInfo() { return { uin: 10001 }; },
    async read(action) {
      if (action === 'get_group_list') return [{ group_id: 20001, group_name: '通知群', member_count: 300 }, { group_id: 20002, group_name: '课程群', member_count: 50 }];
      if (action === 'get_group_info') return { group_name: '课程群' };
      if (action === 'get_recent_contact') return [{ chatType: 2, peerUin: '20001', peerName: '通知群', msgTime: '1791900000' },
        { chatType: 2, peerUin: '20009', peerName: '班级群', msgTime: '1791950000' }, { chatType: 1, peerUin: '555', peerName: '好友', msgTime: '1791960000' },
        { chatType: 2, peerUin: '20008', peerName: '羽协', msgTime: '1791960000' }];
      return { messages: [] };
    }, lastLaunchAt() { return 0; }, launcherAlive() { return false; } };
  const app = createApp({ dataDir, capture: { groups: ['20001'] }, model: { configured: false, enabled: false }, qqBridge: bridge, supervise: false });
  // 先关闭服务和数据库，再删除临时目录。
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = await app.listen(0);
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const call = (route, body, method = 'POST') => fetch(base + route, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/api/qq/groups', null, 'GET')).status, 409);
  bridge.current = { available: true, online: true };
  const active = await (await call('/api/qq/active-groups', null, 'GET')).json();
  assert.deepEqual(active.map(group => group.name), ['羽协', '班级群']);
  const groups = await (await call('/api/qq/groups', null, 'GET')).json();
  assert.deepEqual(groups.map(group => [group.groupId, group.captured]), [['20001', true], ['20002', false]]);
  const added = await (await call('/api/capture/groups', { groupId: '20002' })).json();
  assert.equal(added.backfill.error, '');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'capture.json'), 'utf8')).groups, ['20001', '20002']);
  app.receive(event(1, 20002));
  assert.equal(app.store.conversation('qq:group:20002').monitored, true);
  await call('/api/capture/groups/20002', {}, 'DELETE');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'capture.json'), 'utf8')).groups, ['20001']);
  assert.equal(app.store.conversation('qq:group:20002').monitored, false);
  app.receive(event(2, 20002));
  assert.equal(app.store.messages('qq:group:20002').length, 1);
  await call('/api/capture/groups', { groupId: '20002' });
  assert.equal(app.store.conversation('qq:group:20002').monitored, true);
  assert.equal((await call('/api/capture/groups', { groupId: 'abc' })).status, 400);
  const state = await (await call('/api/state', null, 'GET')).json();
  assert.equal(state.pendingCount, 1);
});

test('开机自启：在启动文件夹创建和删除快捷方式', async t => {
  const dir = tempDir(t);
  assert.equal(autostartEnabled(dir), false);
  assert.equal(await setAutostart(dir, true, 'C:\\不存在的目录\\qq-workbench'), true);
  assert.equal(existsSync(shortcutPath(dir)), true);
  assert.equal(await setAutostart(dir, false, 'C:\\不存在的目录\\qq-workbench'), false);
  assert.equal(autostartEnabled(dir), false);
});
