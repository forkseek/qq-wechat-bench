import { createHash } from 'node:crypto';
import { AppError, text } from './domain.mjs';

export function wechatId(value) {
  const id = String(value ?? '');
  if (!id || id.length > 200 || /[\x00-\x20]/.test(id)) throw new AppError('微信会话标识无效');
  return id;
}
export function wechatConversation(value) {
  const selfId = wechatId(value.selfId), remoteId = wechatId(value.remoteId);
  const kind = value.kind === 'group' ? 'group' : 'private';
  return { id: `wechat:${encodeURIComponent(selfId)}:${kind}:${encodeURIComponent(remoteId)}`,
    platform: 'wechat', selfId, remoteId, kind, title: text(value.title, 100) || remoteId };
}
export function normalizeWechat(value, source = 'live') {
  const conversation = wechatConversation(value);
  const externalId = wechatId(value.externalId), shard = text(value.shard, 100);
  if (!Number.isFinite(value.time) || value.time < 0 || value.time > 4102444800) throw new AppError('微信消息时间无效');
  const kind = text(value.messageType, 40) || '文本';
  const content = ['文本', 'text'].includes(kind) ? text(value.content, 12000) : `[${kind}：可在微信客户端查看]`;
  return { conversation, message: { id: `msg_${createHash('sha256').update(`${conversation.id}:${shard}:${externalId}`).digest('hex')}`,
    conversationId: conversation.id, platform: 'wechat', selfId: conversation.selfId, externalId, shard,
    senderId: text(value.senderId, 200), senderName: text(value.senderName, 100) || '发送者待识别',
    content, messageType: kind, sentAt: new Date(value.time * 1000).toISOString(), receivedAt: new Date().toISOString(),
    isSelf: value.isSelf === true, source } };
}
