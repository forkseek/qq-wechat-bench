import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('限定实验群：第一条消息自动保存、其他群和私聊不登记、暂停后不自动恢复', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-capture-test-'));
  const app = createApp({ dataDir, capture: { groups: ['1048751336'] }, model: { configured: false, enabled: false }, supervise: false });
  const base = await app.listen(0);
  t.after(async () => {
    await app.close();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('qq-capture-test-')) throw new Error('拒绝清理非测试目录');
    rmSync(resolved, { recursive: true, force: true });
  });
  const secret = JSON.parse(readFileSync(path.join(dataDir, 'connection.json'), 'utf8')).secret;
  async function report(extra) {
    const raw = JSON.stringify({ time: 1791673200, self_id: 10001, post_type: 'message', message_type: 'group',
      group_id: 1048751336, message_id: 1, user_id: 30001, message: '测试通知', ...extra });
    const response = await fetch(base + '/onebot/events', { method: 'POST', body: raw,
      headers: { 'X-Signature': `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}` } });
    assert.equal(response.status, 204);
  }
  await report({ group_id: 20002 });
  await report({ message_type: 'private' });
  assert.equal(app.store.conversations().length, 0);
  await report({});
  const [conversation] = app.store.conversations();
  assert.equal(conversation.remoteId, '1048751336');
  assert.equal(conversation.messageCount, 1);
  assert.equal(conversation.monitored, true);
  const { lastReport, lastMessage } = app.store.bridge();
  await report({ message_id: 2, workbench_source: 'history' });
  assert.equal(app.store.bridge().lastReport, lastReport);
  assert.equal(app.store.bridge().lastMessage, lastMessage);
  assert.equal(app.store.bridge().historyMessages, 1);
  assert.equal(app.store.messages(conversation.id).at(-1).source, 'history');
  app.store.updateConversation(conversation.id, { monitored: false });
  await report({ message_id: 3 });
  assert.equal(app.store.messages(conversation.id).length, 2);
  assert.equal(app.store.conversation(conversation.id).monitored, false);
});
