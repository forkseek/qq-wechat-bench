import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../lib/domain.mjs';
import { Store } from '../lib/store.mjs';
import { QQSupervisor } from '../lib/supervisor.mjs';
import { createApp } from '../server.mjs';

const offline = { available: false, online: false, phase: 'unavailable', error: '' };
const online = { available: true, online: true, phase: 'ready', error: '' };
const message = id => ({ time: 1791673200 + id, message_id: id, real_seq: String(100 + id), user_id: 30001,
  sender: { nickname: '老师' }, message: [{ type: 'text', data: { text: `通知 ${id}` } }] });
function fakeBridge(pages = []) {
  return { current: offline, calls: [],
    async status() { return this.current; },
    async loginInfo() { return { uin: 10001 }; },
    async read(action, params) {
      this.calls.push([action, params]);
      if (action === 'get_group_info') return { group_name: '测试群' };
      const page = pages.shift();
      if (!page) throw new AppError('消息不存在', 502);
      return { messages: page };
    },
    lastLaunchAt() { return 0; }, launcherAlive() { return false; } };
}
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-supervisor-test-'));
  mkdirSync(path.join(dir, 'napcat'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// 先关闭应用（释放数据库文件）再删除临时目录。
function testApp(t, bridge) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-supervisor-test-'));
  const app = createApp({ dataDir: dir, capture: { groups: ['20001'] }, model: { configured: false, enabled: false }, qqBridge: bridge, supervise: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return app;
}

test('开启常驻才自动拉起；间隔内不重复拉起；停止后不再拉起', async t => {
  const store = new Store(); const bridge = fakeBridge(); const launches = []; let clock = 10_000_000;
  const supervisor = new QQSupervisor({ bridge, store, capture: null, dataDir: tempDir(t), receive: () => null,
    launch: async value => { launches.push(value); }, now: () => clock });
  await supervisor.tick();
  assert.equal(launches.length, 0);
  await supervisor.resume();
  assert.deepEqual(launches, [{ account: null }]);
  clock += 60_000; await supervisor.tick();
  assert.equal(launches.length, 1);
  clock += 3 * 60_000; await supervisor.tick();
  assert.equal(launches.length, 2);
  supervisor.pause(); clock += 30 * 60_000; await supervisor.tick();
  assert.equal(launches.length, 2);
  assert.equal(supervisor.snapshot().keepRunning, false);
  store.close();
});

test('拉起失败时记录原因，账号登录过后用该账号免扫码拉起', async t => {
  const store = new Store(); const bridge = fakeBridge(); let clock = 10_000_000; let fail = true; const accounts = [];
  const supervisor = new QQSupervisor({ bridge, store, capture: null, dataDir: tempDir(t), receive: () => null, now: () => clock,
    launch: async ({ account }) => { accounts.push(account); if (fail) throw new AppError('没有找到 NapCat 运行包', 503); } });
  await supervisor.resume();
  assert.equal(supervisor.snapshot().error, '没有找到 NapCat 运行包');
  bridge.current = online; await supervisor.tick();
  assert.equal(supervisor.snapshot().account, '10001');
  assert.equal(supervisor.snapshot().error, '');
  bridge.current = offline; fail = false; clock += 60 * 60_000; await supervisor.tick();
  assert.deepEqual(accounts, [null, '10001']);
  store.close();
});

test('补拉从最新往前翻页，遇到已保存的消息即停止，翻页重叠的那条不算接上', async t => {
  const bridge = fakeBridge([[message(5), message(4), message(3)], [message(3), message(2), message(1)], [message(0)]]);
  const app = testApp(t, bridge);
  app.receive({ ...message(1), self_id: 10001, post_type: 'message', message_type: 'group', group_id: 20001 });
  const result = await app.supervisor.backfill({ count: 3 });
  assert.equal(result.error, '');
  assert.equal(result.imported, 4);
  const history = bridge.calls.filter(([action]) => action === 'get_group_msg_history');
  assert.equal(history.length, 2);
  assert.equal(history[1][1].message_seq, '3');
  const [conversation] = app.store.conversations();
  // 消息流按发送时间排序，补拉的旧消息也排在正确位置。
  assert.deepEqual(app.store.messages(conversation.id).map(value => value.content), ['通知 1', '通知 2', '通知 3', '通知 4', '通知 5']);
  assert.equal(app.store.messages(conversation.id)[1].groupSeq, '102');
  assert.equal(app.store.bridge().historyMessages, 4);
});

test('QQ 恢复在线时自动补拉；停止关注的群不补拉', async t => {
  const bridge = fakeBridge([[message(7)]]);
  const app = testApp(t, bridge);
  bridge.current = online; await app.supervisor.tick();
  assert.equal(app.supervisor.snapshot().lastBackfill.imported, 1);
  const [conversation] = app.store.conversations();
  assert.equal(conversation.title, '测试群');
  app.store.updateConversation(conversation.id, { monitored: false });
  bridge.calls.length = 0;
  assert.equal((await app.supervisor.backfill()).imported, 0);
  assert.equal(bridge.calls.some(([action]) => action === 'get_group_msg_history'), false);
});
