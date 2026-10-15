import { runtimeInfo } from '../lib/settings.mjs';
// User-authorized experiment: each item once, only the current account's filehelper.
// Keep request IDs across interruptions; the server will return the saved result.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'verification', 'wechat-send-20261014.json');
const base = runtimeInfo().url;
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
if (only && !['text', 'image', 'file'].includes(only)) throw new Error('测试类型无效');
const page = await fetch(base);
const cookie = page.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('工作台页面未就绪');
const api = async (route, body) => {
  const response = await fetch(base + route, { headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `接口 ${response.status}`); return value;
};
await api('/api/wechat/status');
const state = await api('/api/state');
if (!state.wechat.online) throw new Error('微信尚未在线');
const helper = state.conversations.find(c => c.platform === 'wechat' && c.remoteId === 'filehelper' && c.selfId === state.wechat.selfId);
if (!helper) throw new Error('未发现当前账号的文件传输助手');
const plan = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
  conversationId: helper.id, selfId: helper.selfId, approvedTarget: 'filehelper',
  steps: [ { type: 'text', text: '讯课工作台连接测试' },
    { type: 'image', filename: '讯课接口测试.png', mime: 'image/png' },
    { type: 'file', filename: '讯课接口测试.txt', mime: 'text/plain' } ].map(s => ({ ...s, requestId: randomUUID(), status: 'pending' }))
};
if (plan.conversationId !== helper.id || plan.selfId !== helper.selfId || plan.approvedTarget !== 'filehelper') throw new Error('登录账号或测试接收方改变，停止发送');
const save = () => writeFileSync(file, JSON.stringify(plan, null, 2), { mode: 0o600 });
save();
for (const step of plan.steps) {
  if (only && only !== step.type) continue;
  if (step.status === 'sent') { console.log(JSON.stringify({ type: step.type, status: 'sent', reused: true })); continue; }
  if (step.status === 'uncertain') {
    const checked = await api('/api/messages/check', { conversationId: helper.id, requestId: step.requestId });
    step.status = checked.status; step.parts = checked.parts; step.error = checked.error || null; save();
    console.log(JSON.stringify({ type: step.type, status: step.status, readback: true }));
    if (step.status === 'sent') continue;
    break;
  }
  if (step.filename && !step.attachment) {
    const raw = readFileSync(path.join(root, 'data', 'verification', step.filename));
    const response = await fetch(base + '/api/attachments', { method: 'POST', headers: { Cookie: cookie, Origin: base,
      'X-Filename': encodeURIComponent(step.filename), 'Content-Type': step.mime }, body: raw });
    const attachment = await response.json(); if (!response.ok) throw new Error('测试附件准备失败');
    step.attachment = attachment.id; save();
  }
  step.status = 'attempting'; save();
  console.log(JSON.stringify({ type: step.type, status: 'attempting', target: 'filehelper' }));
  const result = await api('/api/messages/send', { requestId: step.requestId, conversationId: helper.id,
    text: step.text || '', attachments: step.attachment ? [step.attachment] : [] });
  step.status = result.status; step.parts = result.parts; step.error = result.error || null; save();
  console.log(JSON.stringify({ type: step.type, status: step.status, error: step.error }));
  if (step.status !== 'sent') break;
}
