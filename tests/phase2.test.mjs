import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Messaging } from '../lib/messaging.mjs';
import { Maintenance } from '../lib/maintenance.mjs';
import { EventLog } from '../lib/event-log.mjs';
import { QQSupervisor } from '../lib/supervisor.mjs';
import { normalizeEvent, validateTask, timeString, findDuplicateTask, summarizeTasks } from '../lib/domain.mjs';
import { normalizeWechat } from '../lib/wechat-domain.mjs';
import { analyzeBatch, chatContext, modelConfig } from '../lib/model.mjs';
import { createApp } from '../server.mjs';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-phase2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const qqEvent = (id, content, groupId = 20001) => ({
  time: 1791673200 + id, self_id: 10001, post_type: 'message', message_type: 'group',
  group_id: groupId, message_id: id, user_id: 30001, sender: { nickname: '老师' },
  message: [{ type: 'text', data: { text: content } }]
});

test('微信状态防抖：偶发 unavailable 连续 2 次保持在线，第 3 次才离线；明确退出客户端立即离线', async t => {
  const dir = tempDir(t), store = new Store(), events = [];
  let state = { available: true, online: true, phase: 'ready', selfId: 'wxid_1', name: '测试' };
  const manager = new Messaging({
    store, dataDir: dir, log: { write: (...args) => events.push(args) }, enqueue() {},
    qq: { status: async () => ({ online: false }) },
    wechat: { close() {}, status: async () => ({ ...state }), sessions: async () => [], messages: async () => [] },
    wechatOfflineThreshold: 3
  });
  try {
    await manager.tick();
    assert.equal(manager.wechatStatus.online, true);
    state = { available: false, online: false, phase: 'unavailable', error: '短暂超时' };
    await manager.tick();
    assert.equal(manager.wechatStatus.online, true);
    assert.equal(manager.wechatStatus.degraded, true);
    await manager.tick();
    assert.equal(manager.wechatStatus.online, true);
    // 恢复后重置计数
    state = { available: true, online: true, phase: 'ready', selfId: 'wxid_1', name: '测试' };
    await manager.tick();
    assert.equal(manager.wechatTransientFailures, 0);
    // 连续 3 次 unavailable 才真正离线
    state = { available: false, online: false, phase: 'unavailable', error: '断开' };
    await manager.tick(); await manager.tick(); assert.equal(manager.wechatStatus.online, true);
    await manager.tick(); assert.equal(manager.wechatStatus.online, false);
    // 恢复后再明确关闭微信客户端 -> 立即离线
    state = { available: true, online: true, phase: 'ready', selfId: 'wxid_1', name: '测试' };
    await manager.tick(); assert.equal(manager.wechatStatus.online, true);
    state = { available: true, online: false, phase: 'client_closed', error: '已关闭' };
    await manager.tick(); assert.equal(manager.wechatStatus.online, false);
  } finally { await manager.stop(); store.close(); }
});

test('微信群消息自动清理冗余 wxid 前缀，私聊原文不受影响', () => {
  const group = normalizeWechat({
    selfId: 'wxid_me', remoteId: '123@chatroom', kind: 'group', title: '学习群',
    externalId: '1', shard: 'message_0.db', time: 1791960000,
    senderId: 'wxid_sender123', senderName: '同学A', content: 'wxid_sender123:\n明天交报告', messageType: '文本'
  });
  assert.equal(group.message.content, '明天交报告');
  const priv = normalizeWechat({
    selfId: 'wxid_me', remoteId: 'wxid_friend', kind: 'private', title: '好友',
    externalId: '2', shard: 'message_0.db', time: 1791960000,
    senderId: 'wxid_friend', senderName: '好友', content: 'abc:\n保留原样', messageType: '文本'
  });
  assert.equal(priv.message.content, 'abc:\n保留原样');
});

test('timeString 兼容 9:00、24:00、带秒格式；validateTask 容忍空白符差异但仍拒绝编造原话', () => {
  assert.equal(timeString('9:00'), '09:00');
  assert.equal(timeString('24:00'), '23:59');
  assert.equal(timeString('17:30:00'), '17:30');
  assert.throws(() => timeString('25:00'), /时:分/);
  const msg = normalizeEvent(qqEvent(1, '1.\u00a0请于本周五\n17:00前提交实验报告。')).message;
  const ok = validateTask({
    title: '提交实验报告', relevance: 'everyone', sourceIds: [msg.id], dueDate: '2026-10-16', dueTime: '24:00',
    quotes: [{ messageId: msg.id, text: '1. 请于本周五 17:00前提交实验报告。' }]
  }, [msg], []);
  assert.equal(ok.dueTime, '23:59');
  assert.throws(() => validateTask({
    title: '提交实验报告', relevance: 'everyone', sourceIds: [msg.id],
    quotes: [{ messageId: msg.id, text: '周六中午交报告' }]
  }, [msg], []), /原话/);
});

test('AI 去重合并：过滤纯占位符空洞任务、同批去重、跨批与已有待办自动合并', async () => {
  const store = new Store();
  const m1 = normalizeEvent(qqEvent(1, '请于10月22日17:00前完成大物实验预习并写好预习报告'));
  const m2 = normalizeEvent(qqEvent(2, '[文件/链接/卡片：可在微信客户端查看]'));
  store.discover(m1.conversation, true);
  store.ingest(m1); store.ingest(m2);
  const batch1 = store.batch(m1.conversation.id);
  const cfg = modelConfig({ MODEL_ENABLED: 'true', MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', MODEL_NAME: 'mock' });
  const res1 = await analyzeBatch(cfg, batch1, async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: '测试',
          tasks: [
            { id: null, title: '完成大物实验预习并写好预习报告', relevance: 'everyone', dueDate: '2026-10-22', dueTime: '17:00', dueBasis: 'explicit', sourceIds: [m1.message.id] },
            { id: null, title: '大物实验预习并写好预习报告', relevance: 'everyone', dueDate: '2026-10-22', dueTime: null, dueBasis: 'explicit', sourceIds: [m1.message.id] },
            { id: null, title: '查看老师发送的文件/链接/卡片', relevance: 'unclear', dueDate: null, dueTime: null, dueBasis: 'none', sourceIds: [m2.message.id] }
          ]
        })
      }, finish_reason: 'stop'
    }]
  }), { status: 200 }));
  assert.equal(res1.candidates.length, 1);
  assert.equal(res1.candidates[0].dueTime, '17:00');
  const [created] = store.commitAnalysis(batch1, res1.candidates, res1.summary);

  // 下一批又来催交提醒，即使模型给了 id: null，commitAnalysis 也会自动识别并合并到原任务
  const m3 = normalizeEvent(qqEvent(3, '提醒大家别忘了10月22日交大物实验预习报告！'));
  store.ingest(m3);
  const batch2 = store.batch(m1.conversation.id);
  const dupCandidate = validateTask({
    id: null, title: '提交大物实验预习并写好预习报告', relevance: 'everyone', dueDate: '2026-10-22', dueTime: '17:00', dueBasis: 'explicit', sourceIds: [m3.message.id]
  }, batch2.messages, batch2.tasks);
  assert.equal(findDuplicateTask(dupCandidate, batch2.tasks)?.id, created.id);
  const [merged] = store.commitAnalysis(batch2, [dupCandidate], '催交');
  assert.equal(merged.id, created.id);
  assert.equal(store.tasks().length, 1);
  assert.equal(merged.sourceIds.length, 2);
  store.close();
});

test('通知助手上下文：包含实时 taskSummary，超过 60 条已完成任务也不会挤掉未完成待办', () => {
  const store = new Store();
  const n = normalizeEvent(qqEvent(1, '交作业'));
  store.discover(n.conversation, true);
  for (let i = 0; i < 65; i++) {
    const t = store.manualTask({ title: `历史已完成任务 ${i}`, dueDate: '2026-01-01' });
    store.manualTask({ revision: t.revision, status: 'done' }, t.id);
  }
  store.manualTask({ title: '最新未完成待办' });
  store.manualTask({ title: '他人的待办', relevance: 'other' });
  const ctx = chatContext(store, 'all');
  assert.equal(ctx.taskSummary.pendingCount, 1);
  assert.equal(ctx.taskSummary.otherPendingCount, 1);
  assert.equal(ctx.taskSummary.doneCount, 65);
  assert.deepEqual(ctx.taskSummary.pendingTitles, ['最新未完成待办']);
  assert.ok(ctx.tasks.some(task => task.title === '最新未完成待办' && task.status === '未完成'));
  assert.equal(summarizeTasks(store.tasks()).pendingCount, 1);
  store.close();
});

test('定时空跑不刷日志，分页查询会话与日志、清空助手历史接口正常', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-phase2-'));
  const app = createApp({ dataDir: dir, supervise: false, model: { configured: false, enabled: false } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  // 定时 analysis 在无待处理消息时静默跳过，不写 job.start/job.finish 日志
  const skipped = await app.maintenance.run('analysis', { manual: false });
  assert.equal(skipped.status, 'skipped');
  assert.equal(app.log.list().filter(r => r.job === 'analysis').length, 0);
  // 手动触发则正常记录
  const manual = await app.maintenance.run('analysis', { manual: true });
  assert.equal(manual.status, 'success');
  assert.ok(app.log.list().some(r => r.job === 'analysis'));

  for (let i = 1; i <= 5; i++) {
    app.store.discover({ id: `qq:group:${i}`, platform: 'qq', selfId: '10001', remoteId: String(i), kind: 'group', title: `测试群 ${i}` }, i <= 2);
  }
  app.store.appendChat('all', '旧问题', '旧回答');

  const base = await app.listen(0);
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const api = (route, method = 'GET') => fetch(base + route, { method, headers: { Cookie: cookie, Origin: base } });

  const page1 = await (await api('/api/conversations?monitored=false&page=1&pageSize=2')).json();
  assert.equal(page1.total, 3); assert.equal(page1.items.length, 2); assert.equal(page1.hasMore, true); assert.equal(page1.monitoredCount, 2);
  const searched = await (await api('/api/conversations?q=%E6%B5%8B%E8%AF%95%E7%BE%A4%204')).json();
  assert.equal(searched.total, 1); assert.equal(searched.items[0].remoteId, '4');

  const compact = await (await api('/api/state?compact=1')).json();
  assert.equal(compact.conversations.length, 2); assert.equal(compact.conversationCount, 5);

  const pagedLogs = await (await api('/api/logs?paged=1&page=1&pageSize=10&excludeRoutine=1')).json();
  assert.equal(pagedLogs.items.some(r => r.job === 'analysis' && (r.count === 0 || r.count === undefined)), false);

  assert.equal((await api('/api/chat?scope=all', 'DELETE')).status, 200);
  assert.equal(app.store.chat('all').length, 0);

  // 新版 Vue 3 入口（/ 与 /widget）及构建产物路径安全检查
  const widgetResp = await fetch(base + '/widget');
  assert.equal(widgetResp.status, 200);
  assert.match(widgetResp.headers.get('set-cookie') || '', /workbench_session=/);
  assert.equal((await fetch(base + '/app/assets/..%2F..%2Fserver.mjs')).status, 404);
});

test('QQ 补拉隔离单群错误：一个群失败不影响其余群继续补拉', async t => {
  const dir = tempDir(t), store = new Store();
  let savedCount = 0;
  const bridge = {
    status: async () => ({ available: true, online: true, phase: 'ready' }),
    loginInfo: async () => ({ uin: 10001 }),
    read: async (action, params) => {
      if (params.group_id === '111') throw new Error('单群权限失败');
      if (action === 'get_group_info') return { group_name: '正常群' };
      return { messages: [qqEvent(9, '补拉到的消息', 222)] };
    },
    lastLaunchAt: () => 0, launcherAlive: () => false
  };
  const supervisor = new QQSupervisor({
    bridge, store, capture: { groups: ['111', '222'] }, dataDir: dir,
    receive: () => { savedCount++; return { saved: true, duplicate: false }; },
    launch: async () => {}
  });
  const res = await supervisor.backfill({ pages: 1, count: 10 });
  assert.equal(res.imported, 1);
  assert.equal(savedCount, 1);
  assert.ok(res.error);
  store.close();
});

test('桌面 QQ 本地直读：自动发现群与消息，与历史 NapCat groupSeq 无缝去重，未关注群不存库', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-qqlocal-'));
  const qqLocalBridge = {
    status: async () => ({ available: true, online: true, mode: 'local', phase: 'ready', selfId: '10001', name: '测试同学', error: '' }),
    groups: async () => [
      { groupId: '20001', name: '课程通知群', memberCount: 60 },
      { groupId: '20002', name: '闲聊未关注群', memberCount: 30 }
    ],
    sessions: async () => [{ platform: 'qq', selfId: '10001', remoteId: '20001', kind: 'group', title: '课程通知群', lastTime: 1795160200 }],
    activeGroups: async () => [{ platform: 'qq', selfId: '10001', remoteId: '20002', kind: 'group', title: '闲聊未关注群', lastTime: 1795160200 }],
    messages: async conv => [
      { platform: 'qq', selfId: '10001', remoteId: conv.remoteId, kind: 'group', title: conv.title, externalId: '99901', groupSeq: '500', senderId: '30001', senderName: '老师', content: '已有旧消息', time: 1795160100, isSelf: false },
      { platform: 'qq', selfId: '10001', remoteId: conv.remoteId, kind: 'group', title: conv.title, externalId: '99902', groupSeq: '501', senderId: '30001', senderName: '老师', content: '今天新发的作业通知', time: 1795160200, isSelf: false }
    ],
    close() {}
  };
  const app = createApp({
    dataDir: dir, supervise: false, capture: { groups: ['20001'] },
    model: { configured: false, enabled: false },
    qqLocalBridge,
    wechatBridge: { status: async () => ({ available: true, online: false, phase: 'client_closed', error: '' }), close() {} }
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  // 先通过旧版 NapCat 格式入库一条 seq=500 的消息
  app.receive({ time: 1795160100, self_id: 10001, post_type: 'message', message_type: 'group', group_id: 20001, message_id: 1, real_seq: '500', user_id: 30001, sender: { nickname: '老师' }, message: [{ type: 'text', data: { text: '已有旧消息' } }] });
  assert.equal(app.store.messageCount('qq:group:20001'), 1);

  await app.messaging.tick();
  // 本地直读同步：seq=500 去重，只新增 seq=501；未关注群 20002 不存正文
  assert.equal(app.store.messageCount('qq:group:20001'), 2);
  assert.equal(app.store.messageCount('qq:group:20002'), 0);

  const base = await app.listen(0);
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const api = (route, body = undefined, method = body === undefined ? 'GET' : 'POST') => fetch(base + route, {
    method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const state = await (await api('/api/state?compact=1')).json();
  assert.equal(state.qq.online, true);
  assert.equal(state.qq.mode, 'local');
  assert.equal(state.qq.name, '测试同学');
  const groups = await (await api('/api/qq/groups')).json();
  assert.equal(groups.length, 2);
  const unmonMsgs = await (await api(`/api/conversations/${encodeURIComponent('qq:group:20002')}/messages`)).json();
  assert.equal(unmonMsgs.length, 2);
  assert.equal(app.store.messageCount('qq:group:20002'), 0);
});
