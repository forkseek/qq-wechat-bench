import { runtimeInfo } from '../lib/settings.mjs';
// Read-only verification of the authorized filehelper experiment; sends nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(readFileSync(path.join(root, 'data/verification/wechat-send-20261014.json'), 'utf8'));
const base = runtimeInfo().url, home = await fetch(base);
const cookie = home.headers.get('set-cookie').split(';')[0];
const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
const api = async (route, body) => { const r = await fetch(base + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error); return value; };
await api('/api/wechat/status');
const state = await api('/api/state');
if (state.wechat.selfId !== plan.selfId || !state.wechat.online) throw new Error('当前账号或登录状态改变');
const messages = await api(`/api/conversations/${encodeURIComponent(plan.conversationId)}/messages`);
const outbox = await api(`/api/conversations/${encodeURIComponent(plan.conversationId)}/outbox`);
const reports = [];
for (const type of ['image', 'file']) {
  const step = plan.steps.find(value => value.type === type), sent = outbox.find(value => value.id === step.requestId);
  if (sent?.status !== 'sent') throw new Error('测试发送尚未确认');
  const candidates = messages.filter(value => value.isSelf && value.messageType === (type === 'image' ? '图片' : '文件/链接/卡片') && Date.parse(value.sentAt) >= Date.parse(sent.at) - 2000 && Date.parse(value.sentAt) <= Date.parse(sent.at) + 120_000);
  if (candidates.length !== 1) throw new Error('测试媒体不能唯一定位');
  const media = await api('/api/messages/media', { conversationId: plan.conversationId, messageId: candidates[0].id });
  const r = await fetch(base + '/api/attachments/' + media.id, { headers });
  if (!r.ok) throw new Error('工作台媒体下载失败');
  const bytes = Buffer.from(await r.arrayBuffer());
  const expected = readFileSync(path.join(root, 'data/verification', step.filename));
  if (type === 'file' && !bytes.equals(expected)) throw new Error('文件内容与发送内容不一致');
  const report = { type, status: 'verified', messageId: candidates[0].id, at: candidates[0].sentAt,
    mediaId: media.id, filename: media.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    exactBytes: bytes.equals(expected) };
  reports.push(report); console.log(JSON.stringify({ type, status: report.status, bytes: report.bytes, exactBytes: report.exactBytes }));
}
writeFileSync(path.join(root, 'data/verification/wechat-media-20261014.json'), JSON.stringify(reports, null, 2));
