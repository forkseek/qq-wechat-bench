import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { normalizeWechat, wechatConversation } from '../lib/wechat-domain.mjs';

const group = (remoteId, extra = {}) => ({ selfId: 'wxid_student', remoteId, kind: 'group', title: '课程通知群', ...extra });
const message = (conversation, externalId = '1') => ({ ...conversation, externalId, shard: 'message_0.db',
  time: 1791960000, senderId: 'wxid_teacher', senderName: '老师', content: '周五交作业', messageType: '文本', isSelf: false });

async function fixture(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'workbench-wechat-groups-'));
  const captureFile = path.join(dataDir, 'capture.json');
  writeFileSync(captureFile, '{"groups":["1048751336"]}\n');
  const native = { selfId: 'wxid_student', online: true, failRead: false, messageId: '1', reads: [], sends: 0, qqCalls: 0,
    sessions: [group('class_a@chatroom'), group('class_b@chatroom'), group('class_a@chatroom', { selfId: 'wxid_old' }),
      group('filehelper', { kind: 'private', title: '文件传输助手' }), group('invalid_private')] };
  const app = createApp({ dataDir, supervise: false, model: { configured: false, enabled: false },
    wechatBridge: {
      status: async () => ({ online: native.online, available: true, phase: native.online ? 'ready' : 'waiting_login', selfId: native.selfId, name: '学生' }),
      sessions: async () => native.sessions,
      messages: async conversation => {
        native.reads.push(conversation.id);
        if (native.failRead) throw new Error('模拟微信读取失败');
        return [message(conversation, native.messageId)];
      },
      send: async () => { native.sends++; throw new Error('测试禁止真实发送'); }, close() {}
    },
    qqBridge: {
      status: async () => { native.qqCalls++; return { online: false }; },
      loginInfo: async () => { native.qqCalls++; throw new Error('模拟 QQ 离线'); }, lastLaunchAt: () => 0, launcherAlive: () => false
    }
  });
  const base = await app.listen(0);
  t.after(async () => {
    try { await app.close(); } finally {
      if (path.dirname(dataDir) !== path.resolve(tmpdir()) || !path.basename(dataDir).startsWith('workbench-wechat-groups-')) throw new Error('非测试目录');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const api = (route, body, method = body === undefined ? 'GET' : 'POST') => fetch(base + route, { method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, api, base, cookie, native, captureFile };
}

test('微信群列表只显示当前账号的群，同名群保留独立编号，发现会话不读取正文或启动 QQ', async t => {
  const { app, api, base, native, captureFile } = await fixture(t);
  assert.equal((await fetch(base + '/api/wechat/groups')).status, 403);
  const result = await api('/api/wechat/groups'); assert.equal(result.status, 200);
  const groups = await result.json();
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(value => value.title), ['课程通知群', '课程通知群']);
  assert.notEqual(groups[0].id, groups[1].id);
  assert.ok(groups.every(value => value.selfId === native.selfId && value.kind === 'group' && !value.monitored));
  assert.equal(app.store.conversations().filter(value => value.selfId === 'wxid_old').length, 0);
  assert.deepEqual(native.reads, []); assert.equal(native.qqCalls, 0); assert.equal(native.sends, 0);
  assert.equal(readFileSync(captureFile, 'utf8'), '{"groups":["1048751336"]}\n');
});

test('按编号添加指定微信群，重复添加不重复入库；移除保留历史，恢复只保存新增消息', async t => {
  const { app, api, native, captureFile } = await fixture(t);
  const groups = await (await api('/api/wechat/groups')).json();
  const selected = groups.find(value => value.remoteId === 'class_b@chatroom'), other = groups.find(value => value.id !== selected.id);
  app.store.updateConversation(selected.id, { title: '我的课程群', rules: '只整理作业通知' });
  const added = await (await api('/api/wechat/groups', { conversationId: selected.id })).json();
  assert.equal(added.conversation.monitored, true); assert.equal(added.backfill.imported, 1);
  assert.equal(added.conversation.title, '我的课程群'); assert.equal(added.conversation.rules, '只整理作业通知');
  assert.equal(app.store.conversation(other.id).monitored, false); assert.equal(app.store.messages(other.id).length, 0);
  assert.equal((await (await api('/api/wechat/groups', { conversationId: selected.id })).json()).backfill.imported, 0);
  assert.equal(app.store.messages(selected.id).length, 1);
  assert.equal(app.store.messages(selected.id)[0].source, 'history');
  await api(`/api/conversations/${encodeURIComponent(selected.id)}`, { monitored: false }, 'PATCH');
  native.messageId = '2';
  await api(`/api/conversations/${encodeURIComponent(selected.id)}/messages`);
  assert.equal(app.store.conversation(selected.id).monitored, false);
  assert.equal(app.store.messages(selected.id).length, 1);
  const restored = await (await api('/api/wechat/groups', { conversationId: selected.id })).json();
  assert.equal(restored.backfill.imported, 1); assert.equal(app.store.messages(selected.id).length, 2);
  assert.equal(app.store.conversation('qq:group:1048751336')?.monitored ?? false, false);
  assert.equal(readFileSync(captureFile, 'utf8'), '{"groups":["1048751336"]}\n');
  assert.equal(native.qqCalls, 0); assert.equal(native.sends, 0);
});

test('微信群添加拒绝私聊、旧账号、未知编号和未登录状态，不改变任何关注设置', async t => {
  const { app, api, native } = await fixture(t);
  const groups = await (await api('/api/wechat/groups')).json();
  const privateId = wechatConversation(group('filehelper', { kind: 'private' })).id;
  const oldId = wechatConversation(group('class_a@chatroom', { selfId: 'wxid_old' })).id;
  for (const conversationId of [privateId, oldId, 'wechat:wxid_student:group:unknown%40chatroom']) {
    assert.equal((await api('/api/wechat/groups', { conversationId })).status, 409);
  }
  assert.equal((await api('/api/wechat/groups', { conversationId: 123 })).status, 400);
  native.selfId = 'wxid_other';
  assert.equal((await api('/api/wechat/groups', { conversationId: groups[0].id })).status, 409);
  native.online = false;
  assert.equal((await api('/api/wechat/groups')).status, 409);
  assert.equal((await api('/api/wechat/groups', { conversationId: groups[0].id })).status, 409);
  assert.ok(app.store.conversations().every(value => !value.monitored)); assert.deepEqual(native.reads, []);
});

test('已保存超过消息页大小的微信群，恢复时仍返回真实新增数', async t => {
  const { app, api, native } = await fixture(t);
  const [selected] = await (await api('/api/wechat/groups')).json();
  app.store.updateConversation(selected.id, { monitored: true });
  for (let index = 1; index <= 90; index++) app.store.ingest(normalizeWechat(message(selected, String(index)), 'history'));
  app.store.updateConversation(selected.id, { monitored: false });
  native.messageId = '91';
  const added = await (await api('/api/wechat/groups', { conversationId: selected.id })).json();
  assert.equal(added.backfill.imported, 1);
  assert.equal(app.store.messageCount(selected.id), 91);
  assert.equal(app.store.messages(selected.id).length, 80);
});

test('微信群已添加但首次读取失败时明确返回待重试状态，保留设置且不伪造消息', async t => {
  const { app, api, native, cookie, base } = await fixture(t);
  const [selected] = await (await api('/api/wechat/groups')).json();
  assert.equal((await fetch(base + '/api/wechat/groups', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: selected.id }) })).status, 403);
  assert.equal(app.store.conversation(selected.id).monitored, false);
  native.failRead = true;
  const result = await api('/api/wechat/groups', { conversationId: selected.id });
  assert.equal(result.status, 200);
  const added = await result.json();
  assert.equal(added.conversation.monitored, true); assert.match(added.backfill.error, /已添加/);
  assert.equal(added.backfill.imported, undefined); assert.equal(app.store.messages(selected.id).length, 0);
  native.failRead = false;
  assert.equal((await (await api('/api/wechat/groups', { conversationId: selected.id })).json()).backfill.imported, 1);
  assert.equal(native.sends, 0);
});
