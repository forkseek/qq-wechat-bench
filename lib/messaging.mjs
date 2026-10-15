import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, normalizeEvent, text, idString } from './domain.mjs';
import { normalizeWechat, wechatConversation } from './wechat-domain.mjs';
import { DEFAULT_SETTINGS } from './settings.mjs';
import { readJsonFile, writeJsonAtomic } from './json-file.mjs';

export class Messaging {
  constructor({ store, qq, wechat, dataDir, log, enqueue, settings = DEFAULT_SETTINGS }) {
    Object.assign(this, { store, qq, wechat, dataDir, log, enqueue, settings });
    this.wechatStatus = { available: false, online: false, phase: 'starting', error: '' };
    this.busy = null; this.timer = null; this.sending = new Set(); this.statusStamp = ''; this.firstRead = new Set();
    this.qqStamp = ''; this.stopped = false;
    this.mediaCache = new Map();
  }
  start() { if (this.stopped) return Promise.resolve(); this.timer ??= setInterval(() => this.tick(), this.settings.messaging.pollIntervalMs); return this.tick(); }
  tick() {
    if (this.stopped) return Promise.resolve();
    this.busy ??= this.#tick().catch(() => { this.wechatStatus = { available: false, online: false, phase: 'unavailable', error: '微信接入暂未就绪' }; }).finally(() => { this.busy = null; });
    return this.busy;
  }
  async #tick() {
    try {
      const status = await this.qq.status();
      if (this.stopped) return;
      if (!status.online) { this.store.offlineAccounts('qq'); this.qqStamp = ''; }
      else {
        const info = await this.qq.loginInfo(), accountId = idString(info.uin);
        if (this.qqStamp !== accountId) { await this.discoverQQ(); this.log.write('account.online', { platform: 'qq', accountId }); this.qqStamp = accountId; }
      }
    } catch { this.store.offlineAccounts('qq'); }
    if (this.stopped) return;
    this.wechatStatus = await this.wechat.status();
    if (this.stopped) return;
    const stamp = `${this.wechatStatus.online}:${this.wechatStatus.phase}:${this.wechatStatus.selfId || ''}`;
    if (stamp !== this.statusStamp) {
      this.statusStamp = stamp;
      this.log.write(this.wechatStatus.online ? 'account.online' : 'account.offline', { platform: 'wechat', accountId: this.wechatStatus.selfId || '', status: this.wechatStatus.phase });
    }
    if (!this.wechatStatus.online) { this.store.offlineAccounts('wechat'); return; }
    this.store.putAccount('wechat', this.wechatStatus);
    const readFailed = (error, conversationId) => {
      this.wechatStatus.error = '部分微信会话暂时无法读取，后台会继续尝试';
      this.log.write('wechat.read.failed', { platform: 'wechat', conversationId, code: error.code || error.name }, 'warn');
      return ['WECHAT_TIMEOUT', 'WECHAT_TRANSPORT_CLOSED'].includes(error.code);
    };
    try { await this.discoverWechat(); }
    catch (error) { if (readFailed(error)) return; }
    for (const conversation of this.store.conversations().filter(value => value.platform === 'wechat' && value.monitored && value.selfId === this.wechatStatus.selfId)) {
      if (this.stopped) break;
      try { await this.readWechat(conversation, true); }
      catch (error) { if (readFailed(error, conversation.id)) break; }
    }
  }
  async discoverWechat(selfId = this.wechatStatus.selfId) {
    const list = await this.wechat.sessions();
    const current = list.filter(item => !selfId || item.selfId === selfId);
    for (const item of current) this.store.discover(wechatConversation(item));
    return current;
  }
  async wechatGroups() {
    const status = await this.wechat.status();
    this.wechatStatus = status;
    if (!status.online) {
      this.store.offlineAccounts('wechat');
      throw new AppError('请先在电脑微信中登录，再刷新微信群列表', 409);
    }
    this.store.putAccount('wechat', status);
    const sessions = await this.discoverWechat(status.selfId);
    return sessions.filter(item => item.kind === 'group' && item.remoteId.endsWith('@chatroom'))
      .map(item => this.store.conversation(wechatConversation(item).id))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }
  async addWechatGroup(id) {
    if (typeof id !== 'string' || !id || id.length > 700) throw new AppError('请选择要添加的微信群');
    // 每次添加重新核对本机账号和会话编号，不按群名匹配，也不接受旧账号的群。
    const group = (await this.wechatGroups()).find(value => value.id === id);
    if (!group) throw new AppError('这个群不在当前登录微信的会话中，请刷新列表后再添加', 409);
    const before = this.store.messageCount(id);
    const conversation = this.store.updateConversation(id, { monitored: true });
    if (!group.monitored) this.log.write('conversation.monitor.changed', { platform: 'wechat', conversationId: id, status: 'enabled' });
    try {
      await this.readWechat(conversation, true);
      return { conversation: this.store.conversation(id), backfill: { imported: this.store.messageCount(id) - before } };
    } catch {
      // 关注已保存，读取失败不伪装成添加失败；之后按原有轮询继续尝试。
      this.log.write('wechat.group.backfill.failed', { platform: 'wechat', conversationId: id }, 'warn');
      return { conversation, backfill: { error: '已添加，但暂时未能读取消息；请保持电脑微信登录，后台会继续尝试' } };
    }
  }
  async discoverQQ() {
    const info = await this.qq.loginInfo();
    const selfId = idString(info.uin);
    this.store.putAccount('qq', { selfId, online: info.online !== false, phase: 'ready', name: info.nick || selfId });
    const results = await Promise.allSettled([this.qq.read('get_friend_list', {}), this.qq.read('get_group_list', { no_cache: false })]);
    for (const [index, result] of results.entries()) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value || []) {
        const kind = index ? 'group' : 'private', remoteId = idString(index ? item.group_id : item.user_id);
        const id = index ? `qq:group:${remoteId}` : `qq:${selfId}:private:${remoteId}`;
        this.store.discover({ id, platform: 'qq', selfId, remoteId, kind, title: text(index ? item.group_name : item.remark || item.nickname, 100) || remoteId });
      }
    }
    return this.store.conversations().filter(value => value.platform === 'qq');
  }
  async readWechat(conversation, persist = false) {
    const list = await this.wechat.messages(conversation);
    const source = this.firstRead.has(conversation.id) ? 'live' : 'history';
    const rows = [];
    for (const item of list) {
      const normalized = normalizeWechat(item, source);
      if (normalized.conversation.id !== conversation.id) throw new AppError('微信返回了其他会话的数据', 502);
      rows.push(normalized.message);
      if (persist && conversation.monitored) {
        const result = this.store.ingest(normalized);
        if (result.saved) {
          this.log.write('message.received', { platform: 'wechat', conversationId: conversation.id, messageId: normalized.message.id });
          this.enqueue(conversation.id);
        }
      }
    }
    if (persist && conversation.monitored) this.firstRead.add(conversation.id);
    return rows.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }
  async history(conversation) {
    if (conversation.platform === 'wechat') return this.readWechat(conversation, true);
    if (conversation.monitored) return this.store.messages(conversation.id);
    const action = conversation.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const info = await this.qq.loginInfo();
    if (conversation.kind === 'private' && String(info.uin) !== String(conversation.selfId)) throw new AppError('当前 QQ 账号已改变，请重新选择会话', 409);
    const result = await this.qq.read(action, { [conversation.kind === 'group' ? 'group_id' : 'user_id']: conversation.remoteId,
      count: 50, disable_get_url: true, parse_mult_msg: false, quick_reply: false });
    return (result.messages || []).map(message => normalizeEvent({ ...message, self_id: info.uin,
      post_type: 'message', message_type: conversation.kind, ...(conversation.kind === 'group' ? { group_id: conversation.remoteId } : { user_id: message.user_id }),
      ...(conversation.kind === 'private' ? { target_id: conversation.remoteId } : {}),
      workbench_source: 'history' }).message).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }
  upload(raw, filename, mime) {
    if (!raw.length || raw.length > this.settings.messaging.maxAttachmentBytes) throw new AppError(`请选择 ${this.settings.messaging.maxAttachmentBytes / 1024 / 1024} MB 以内的图片或文件`);
    const dir = path.join(this.dataDir, 'uploads'); mkdirSync(dir, { recursive: true });
    const id = randomUUID(), name = path.basename(text(filename, 180)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || '附件';
    const imageMime = /^image\/(png|jpeg|gif|webp)$/.test(mime || '') ? mime : null;
    if (imageMime === 'image/png') {
      const invalid = () => new AppError('PNG 图片校验失败，请重新选择完整图片');
      if (!raw.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw invalid();
      let offset = 8, ended = false;
      while (offset + 12 <= raw.length) {
        const length = raw.readUInt32BE(offset), end = offset + 12 + length;
        if (end > raw.length || crc32(raw.subarray(offset + 4, end - 4)) !== raw.readUInt32BE(end - 4)) throw invalid();
        ended = raw.subarray(offset + 4, offset + 8).toString('ascii') === 'IEND'; offset = end;
        if (ended) break;
      }
      if (!ended || offset !== raw.length) throw invalid();
    }
    const folder = path.join(dir, id); mkdirSync(folder);
    const file = path.join(folder, ['.', '..'].includes(name) ? '附件' : name);
    writeFileSync(file, raw, { mode: 0o600 });
    const metadata = { id, name, size: raw.length, mime: imageMime || 'application/octet-stream', type: imageMime ? 'image' : 'file', file };
    writeJsonAtomic(path.join(dir, id + '.json'), metadata);
    return { id, name, size: raw.length, type: metadata.type };
  }
  async media(conversation, messageId) {
    if (conversation.platform !== 'wechat') throw new AppError('当前媒体查看支持微信本机缓存');
    const key = `${conversation.id}:${messageId}`;
    if (this.mediaCache.has(key)) return this.mediaCache.get(key);
    const message = (await this.readWechat(conversation, false)).find(value => value.id === messageId);
    if (!message || !['图片', '文件/链接/卡片'].includes(message.messageType)) throw new AppError('请选择当前会话中的图片或文件', 404);
    const sources = message.isSelf && message.messageType === '文件/链接/卡片' ? this.store.sentItems(conversation.id)
      .filter(record => record.status === 'sent' && Date.parse(message.sentAt) >= Date.parse(record.at) - 2000 && Date.parse(message.sentAt) <= Date.parse(record.at) + 120_000)
      .flatMap(record => record.attachments.filter(file => file.type === 'file')) : [];
    const source = sources.length === 1 ? sources[0] : null;
    const result = await this.wechat.media(conversation, message, source?.name || '');
    if (source && result.sourceFilename === source.name && result.externalId === message.externalId && result.shard === message.shard) {
      const file = this.attachment(source.id), saved = { id: file.id, name: file.name, size: file.size, type: file.type };
      this.mediaCache.set(key, saved); return saved;
    }
    if (!result.file) throw new AppError('本机没有这个附件，请先在微信中下载后重试', 404);
    const dir = path.resolve(this.dataDir, 'wechat', 'media'), file = path.resolve(result.file);
    const relative = path.relative(dir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(file) || statSync(file).size > this.settings.messaging.maxAttachmentBytes) throw new AppError('媒体缓存路径无效', 502);
    const mime = message.messageType === '图片' ? ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || '') : '';
    const saved = this.upload(readFileSync(file), result.name, mime);
    this.mediaCache.set(key, saved); return saved;
  }
  attachment(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('附件不存在', 404);
    const dir = path.resolve(this.dataDir, 'uploads'), meta = path.join(dir, id + '.json');
    if (!existsSync(meta)) throw new AppError('附件不存在', 404);
    const value = readJsonFile(meta, '附件索引');
    const relative = path.relative(dir, path.resolve(value.file));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(value.file) || value.id !== id) throw new AppError('附件路径无效', 404);
    return value;
  }
  async send(conversation, body) {
    if (this.stopped) throw new AppError('消息组件已关闭，请重新打开工作台', 503);
    const id = text(body.requestId, 60);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('发送请求需要唯一编号');
    const content = text(body.text, 6000), attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!content && !attachments.length) throw new AppError('请输入内容或选择附件');
    if (attachments.length > this.settings.messaging.maxAttachments) throw new AppError(`一次最多发送 ${this.settings.messaging.maxAttachments} 个附件`);
    const fingerprint = createHash('sha256').update(JSON.stringify([conversation.id, content, attachments])).digest('hex');
    const old = this.store.outbox(id);
    if (old) { if (old.fingerprint !== fingerprint) throw new AppError('同一发送请求的内容发生变化', 409); return old; }
    if (this.sending.has(conversation.platform)) throw new AppError('该平台正在发送，请稍后再试', 409);
    const files = attachments.map(value => this.attachment(value));
    const record = { id, conversationId: conversation.id, platform: conversation.platform, fingerprint, text: content,
      attachments: files.map(file => ({ id: file.id, name: file.name, type: file.type })), status: 'sending', at: new Date().toISOString(), parts: [] };
    // 持久化成功以后才占用平台；磁盘写入失败时不能发送，也不能留下永不释放的忙状态。
    this.store.putOutbox(record); this.sending.add(conversation.platform);
    let attempted = false;
    try {
      this.log.write('send.start', { platform: conversation.platform, conversationId: conversation.id, requestId: id });
      const provider = conversation.platform === 'wechat' ? this.wechat : this.qq;
      for (const part of [...(content ? [{ type: 'text', text: content }] : []), ...files.map(file => ({ type: file.type, file: file.file, name: file.name }))]) {
        attempted = true;
        const result = await provider.send(conversation, part);
        record.parts.push({ type: part.type, status: result.status, confirmed: result.confirmed === true, externalId: result.externalId || null, code: result.code || null });
        if (!result.confirmed) { record.status = 'uncertain'; break; }
      }
      if (record.status === 'sending') record.status = 'sent';
      this.log.write(record.status === 'sent' ? 'send.sent' : 'send.uncertain', { platform: conversation.platform, conversationId: conversation.id, requestId: id });
    } catch (error) {
      record.status = !attempted || (!record.parts.length && error.attempted === false) ? 'failed' : 'uncertain';
      record.error = (record.parts.length ? '部分内容已发送；' : '') + (error instanceof AppError ? error.message : '发送结果未确认，请先核查客户端记录');
      record.code = error.code || error.name;
      this.log.write(record.status === 'failed' ? 'send.failed' : 'send.uncertain', { platform: conversation.platform, requestId: id, code: record.code }, 'warn');
    } finally {
      record.partial = record.status === 'uncertain' && record.parts.some(part => part.confirmed);
      this.sending.delete(conversation.platform); this.store.putOutbox(record);
    }
    return record;
  }
  async checkSend(conversation, requestId) {
    const record = this.store.outbox(requestId);
    if (!record || record.conversationId !== conversation.id) throw new AppError('发送记录不存在', 404);
    if (record.status !== 'uncertain' || record.platform !== 'wechat' || !record.text || record.attachments.length) return record;
    const from = Date.parse(record.at), to = from + 240_000;
    const matches = (await this.readWechat(conversation, false)).filter(row => row.isSelf && row.content === record.text &&
      Date.parse(row.sentAt) >= from - 2000 && Date.parse(row.sentAt) <= to);
    if (matches.length === 1) {
      record.status = 'sent'; record.error = null; record.checkedAt = new Date().toISOString();
      record.parts = [{ type: 'text', status: 'sent', externalId: matches[0].externalId, code: 'confirmed_by_readback' }];
      this.store.putOutbox(record);
      this.log.write('send.sent', { platform: 'wechat', conversationId: conversation.id, requestId, status: 'confirmed_by_readback' });
    }
    return record;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; clearInterval(this.timer);
    this.stopPromise = (async () => {
      while (this.sending.size) await new Promise(resolve => setTimeout(resolve, 25));
      this.wechat.close?.(); await this.busy;
    })();
    return this.stopPromise;
  }
}
