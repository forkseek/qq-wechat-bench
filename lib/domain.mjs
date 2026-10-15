import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function text(value, limit = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function idString(value, label = '编号') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new AppError(`${label}需要是安全整数或字符串`);
  const result = String(value ?? '');
  if (!/^-?\d{1,30}$/.test(result)) throw new AppError(`${label}格式不正确`);
  return result;
}

export function verifySignature(body, signature, secret) {
  const expected = Buffer.from(`sha1=${createHmac('sha1', secret).update(body).digest('hex')}`);
  const received = Buffer.from(typeof signature === 'string' ? signature : '');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function decodeCQ(value) {
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
}

export function messageText(event) {
  if (Array.isArray(event.message)) {
    return event.message.map(part => {
      if (part.type === 'text') return typeof part.data?.text === 'string' ? part.data.text.slice(0, 12000) : '';
      if (part.type === 'at') return part.data?.qq === 'all' ? '@全体成员' : `@${String(part.data?.qq ?? '').slice(0, 30)}`;
      if (part.type === 'reply') return '[回复前文]';
      if (part.type === 'image') return '[图片：尚未识别]';
      if (part.type === 'file') return `[文件：${text(part.data?.name, 150) || '附件'}，尚未解析]`;
      if (part.type === 'record') return '[语音：尚未转写]';
      if (part.type === 'face') return '[表情]';
      if (part.type === 'forward') return '[合并转发：尚未展开]';
      return '[非文字内容：尚未解析]';
    }).join('').trim().slice(0, 12000);
  }
  return decodeCQ(text(event.raw_message || event.message, 12000).replace(/\[CQ:([^,\]]+)[^\]]*\]/g, (_, type) => {
    if (type === 'at') return '[提及成员]';
    return `[${type === 'image' ? '图片' : type === 'record' ? '语音' : '非文字内容'}：尚未解析]`;
  }));
}

export function normalizeEvent(event, now = new Date()) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new AppError('事件必须是 JSON 对象');
  if (!['message', 'message_sent'].includes(event.post_type)) return null;
  if (!['group', 'private'].includes(event.message_type)) return null;
  const selfId = idString(event.self_id, '登录 QQ');
  const senderId = idString(event.user_id, '发送者');
  const remoteId = idString(event.message_type === 'group' ? event.group_id : senderId === selfId ? event.target_id || event.user_id : event.user_id, '会话');
  const externalId = idString(event.message_id, '消息 ID');
  if (!Number.isFinite(event.time) || event.time < 0 || event.time > 4102444800) throw new AppError('消息时间不正确');
  // 群会话只按群号识别，换常驻账号后仍是同一个会话；私聊仍按「账号 + 对方」区分。
  const conversationId = event.message_type === 'group' ? `qq:group:${remoteId}` : `qq:${selfId}:${event.message_type}:${remoteId}`;
  // 群内统一序号，同一条消息在不同账号上相同。
  const groupSeq = event.message_type === 'group' && event.real_seq != null && /^\d{1,20}$/.test(String(event.real_seq)) ? String(event.real_seq) : null;
  return {
    conversation: { id: conversationId, kind: event.message_type, selfId, remoteId,
      title: text(event.group_name, 100) || (event.message_type === 'group' ? `QQ群 ${remoteId}` : text(event.sender?.nickname, 100) || `好友 ${remoteId}`) },
    message: { id: `msg_${createHash('sha256').update(groupSeq ? `${conversationId}:seq:${groupSeq}` : `${conversationId}:${externalId}`).digest('hex')}`,
      conversationId, externalId, senderId, senderName: text(event.sender?.card || event.sender?.nickname, 100) || senderId,
      content: messageText(event), sentAt: new Date(event.time * 1000).toISOString(), receivedAt: now.toISOString(),
      source: event.workbench_source === 'history' ? 'history' : 'live', groupSeq,
      isSelf: senderId === selfId },
  };
}

export function dateString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError('日期需要使用 年-月-日 格式');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new AppError('日期不存在');
  return value;
}

export function timeString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new AppError('时间需要使用 时:分 格式');
  return value;
}

export function validateTask(candidate, messages, existing, pendingIds = null) {
  if (!candidate || typeof candidate !== 'object') throw new AppError('模型返回的任务格式不正确', 502);
  const title = text(candidate.title, 180);
  if (!title) throw new AppError('任务缺少标题', 502);
  const current = candidate.id ? existing.find(task => task.id === candidate.id) : null;
  if (candidate.id && !current) throw new AppError('模型引用了当前会话之外的任务', 502);
  if (!Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length) throw new AppError('任务缺少来源消息', 502);
  const sourceIds = [...new Set(candidate.sourceIds)];
  if (sourceIds.length > 15 || sourceIds.some(id => !messages.some(message => message.id === id))) throw new AppError('任务包含无法核实的来源消息', 502);
  if (pendingIds && !sourceIds.some(id => pendingIds.has(id))) throw new AppError('任务没有引用本次新消息', 502);
  if (candidate.quotes !== undefined) {
    if (!Array.isArray(candidate.quotes) || candidate.quotes.some(quote => !quote || !sourceIds.includes(quote.messageId) || !text(quote.text) || !messages.find(message => message.id === quote.messageId)?.content.includes(quote.text))) {
      throw new AppError('任务原话与来源不一致', 502);
    }
  }
  if (!['mine', 'everyone', 'other', 'unclear'].includes(candidate.relevance)) throw new AppError('任务缺少与用户的关系', 502);
  const dueDate = dateString(candidate.dueDate);
  const dueTime = timeString(candidate.dueTime);
  if (dueTime && !dueDate) throw new AppError('截止时刻缺少日期', 502);
  const suggestedStatus = ['done', 'cancelled'].includes(candidate.suggestedStatus) ? candidate.suggestedStatus : null;
  // 截止时间的依据：explicit 原文写明日期，inferred 由“明天/周五”等推算，none 原文没给。没说明的按推算处理，避免当成确定时间。
  const dueBasis = !dueDate ? 'none' : candidate.dueBasis === 'explicit' ? 'explicit' : 'inferred';
  return { id: current?.id || null, title, kind: text(candidate.kind, 40) || '通知',
    description: text(candidate.description, 2000), responsible: text(candidate.responsible, 100),
    relevance: candidate.relevance, dueDate, dueTime, dueText: text(candidate.dueText, 200), dueBasis,
    questions: Array.isArray(candidate.questions) ? candidate.questions.map(value => text(value, 300)).filter(Boolean).slice(0, 8) : [],
    sourceIds, suggestedStatus };
}
