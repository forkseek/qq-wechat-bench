import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { AppError, text } from './domain.mjs';
import { decodePath } from './http.mjs';
import { candidateModel, saveModelConfig, testModel, publicModel, answerChat } from './model.mjs';
import { setAutostart } from './autostart.mjs';

// 接口仅调用服务；认证、签名、正文限制由 http.mjs 统一负责。
export function createApi({ store, worker, log, config, capture, qqBridge, supervisor, messaging, maintenance,
  dataDir, root, startupDir, modelFile, settings, state, addGroup, removeGroup, enqueueMonitored, fetcher, shutdown }) {
  const chatBusy = new Set();
  return async ({ req, res, url, send, readRaw, json }) => {
    if (url.pathname === '/api/state' && req.method === 'GET') { send(state()); return; }
    if (url.pathname === '/api/wechat/status' && req.method === 'GET') { await messaging.tick(); send(messaging.wechatStatus); return; }
    if (url.pathname === '/api/wechat/groups' && req.method === 'GET') { send(await messaging.wechatGroups()); return; }
    if (url.pathname === '/api/logs' && req.method === 'GET') { send(log.list({ platform: url.searchParams.get('platform'), level: url.searchParams.get('level') })); return; }
    if (url.pathname === '/api/maintenance' && req.method === 'GET') { send(maintenance.snapshot()); return; }
    const attachmentMatch = /^\/api\/attachments\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (attachmentMatch && req.method === 'GET') {
      const attachment = messaging.attachment(attachmentMatch[1]);
      res.writeHead(200, { 'Content-Type': attachment.mime, 'Content-Disposition': `${attachment.type === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}` });
      res.end(readFileSync(attachment.file)); return;
    }
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
      let name; try { name = decodePath(req.headers['x-filename'] || '附件'); } catch { throw new AppError('附件名称无效'); }
      send(messaging.upload(await readRaw(settings.messaging.maxAttachmentBytes), name, req.headers['content-type'])); return;
    }
    if (url.pathname === '/api/qq/status' && req.method === 'GET') { await supervisor.tick(); send(supervisor.snapshot()); return; }
    if (url.pathname === '/api/qq/qr' && req.method === 'GET') {
      await supervisor.tick();
      if (!supervisor.status.available || supervisor.status.online || supervisor.status.blockedReason) throw new AppError('QQ 采集当前没有等待扫码，请刷新登录页查看状态', 409);
      const qrFile = path.join(dataDir, 'napcat', 'shell', 'cache', 'qrcode.png');
      if (!existsSync(qrFile)) throw new AppError('QQ 二维码尚未生成', 503);
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(readFileSync(qrFile)); return;
    }
    if (url.pathname === '/api/chat' && req.method === 'GET') { send(store.chat(url.searchParams.get('scope') || 'all')); return; }
    if (url.pathname === '/api/qq/groups' && req.method === 'GET') {
      await supervisor.tick();
      if (!supervisor.status.online) throw new AppError('QQ 未登录，暂时无法读取群列表；可以直接填写群号', 409);
      const groups = await qqBridge.read('get_group_list', { no_cache: false });
      send((Array.isArray(groups) ? groups : []).map(group => ({ groupId: String(group.group_id), name: text(group.group_name, 100),
        memberCount: Number(group.member_count) || null, captured: Boolean(capture?.groups.includes(String(group.group_id))) })));
      return;
    }
    // QQ「最近联系人」中有消息、但还没接入的群，按最后消息时间排序，方便发现漏接的群。
    if (url.pathname === '/api/qq/active-groups' && req.method === 'GET') {
      await supervisor.tick();
      if (!supervisor.status.online) throw new AppError('QQ 未登录，暂时无法读取最近活跃的群', 409);
      const contacts = await qqBridge.read('get_recent_contact', { count: 50 });
      send((Array.isArray(contacts) ? contacts : []).filter(contact => contact.chatType === 2 && /^\d+$/.test(String(contact.peerUin)))
        .map(contact => ({ groupId: String(contact.peerUin), name: text(contact.peerName, 100), lastAt: Number(contact.msgTime) ? new Date(Number(contact.msgTime) * 1000).toISOString() : null }))
        .filter(group => !capture?.groups.includes(group.groupId)).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')).slice(0, 10));
      return;
    }
    const captureMatch = /^\/api\/capture\/groups\/(\d{1,30})$/.exec(url.pathname);
    const conversationMatch = /^\/api\/conversations\/([^/]+)(?:\/(messages|analyze))?$/.exec(url.pathname);
    const outboxMatch = /^\/api\/conversations\/([^/]+)\/outbox$/.exec(url.pathname);
    if (outboxMatch && req.method === 'GET') { send(store.sentItems(decodePath(outboxMatch[1]))); return; }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (conversationMatch && req.method === 'GET' && conversationMatch[2] === 'messages') {
      const id = decodePath(conversationMatch[1]);
      const conversation = store.conversation(id);
      if (!conversation) throw new AppError('会话不存在', 404);
      send(conversation.platform === 'wechat' || !conversation.monitored ? await messaging.history(conversation) : store.messages(id)); return;
    }
    if (taskMatch && req.method === 'GET') {
      const task = store.task(decodePath(taskMatch[1]));
      if (!task) throw new AppError('任务不存在', 404);
      send({ task, sources: store.sources(task.sourceIds) }); return;
    }

    if (req.method === 'GET') throw new AppError('没有找到此接口', 404);

    const body = await json();
    if (url.pathname === '/api/wechat/groups' && req.method === 'POST') { send(await messaging.addWechatGroup(body.conversationId)); return; }
    if (url.pathname === '/api/shutdown' && req.method === 'POST') { send({ ok: true }); shutdown(); return; }
    if (url.pathname === '/api/conversations/discover' && req.method === 'POST') {
      const result = await Promise.allSettled([messaging.tick(), messaging.discoverQQ()]);
      send({ conversations: store.conversations(), wechat: messaging.wechatStatus, qqDiscovered: result[1].status === 'fulfilled' }); return;
    }
    if (url.pathname === '/api/messages/send' && req.method === 'POST') {
      const conversation = store.conversation(text(body.conversationId, 700));
      if (!conversation) throw new AppError('发送对象不存在', 404);
      send(await messaging.send(conversation, body)); return;
    }
    if (url.pathname === '/api/messages/media' && req.method === 'POST') {
      const conversation = store.conversation(body.conversationId);
      if (!conversation) throw new AppError('会话不存在', 404);
      send(await messaging.media(conversation, body.messageId)); return;
    }
    if (url.pathname === '/api/messages/check' && req.method === 'POST') {
      const conversation = store.conversation(body.conversationId);
      if (!conversation) throw new AppError('会话不存在', 404);
      send(await messaging.checkSend(conversation, body.requestId)); return;
    }
    if (url.pathname === '/api/maintenance' && req.method === 'PUT') { send(maintenance.configure(body)); return; }
    if (url.pathname === '/api/maintenance/run' && req.method === 'POST') { send(await maintenance.run(body.job)); return; }
    if (url.pathname === '/api/qq/refresh-qr' && req.method === 'POST') {
      await supervisor.tick();
      if (!supervisor.status.available || supervisor.status.online || supervisor.status.blockedReason) throw new AppError(supervisor.snapshot().error || 'QQ 采集当前没有等待扫码', 409);
      await qqBridge.refreshQR(); send({ ok: true }); return;
    }
    if (url.pathname === '/api/qq/start' && req.method === 'POST') { await supervisor.resume(); send(supervisor.snapshot()); return; }
    if (url.pathname === '/api/qq/stop' && req.method === 'POST') {
      try { await supervisor.pauseAndStop(); } catch { throw new AppError('停止 QQ 采集失败，请双击“停止QQ采集.cmd”并检查报错', 500); }
      log.write('qq.capture.stopped', { platform: 'qq' }); send(supervisor.snapshot()); return;
    }
    if (url.pathname === '/api/qq/backfill' && req.method === 'POST') {
      await supervisor.tick();
      if (!supervisor.status.online) throw new AppError('QQ 未登录，暂时无法补拉', 409);
      await supervisor.backfill(); send(supervisor.snapshot().lastBackfill); return;
    }
    if (url.pathname === '/api/qq/account' && req.method === 'DELETE') { supervisor.forgetAccount(); send(supervisor.snapshot()); return; }
    if (url.pathname === '/api/capture/groups' && req.method === 'POST') { send({ backfill: await addGroup(body.groupId), capture }); return; }
    if (captureMatch && req.method === 'DELETE') { removeGroup(captureMatch[1]); send({ capture }); return; }
    if (url.pathname === '/api/autostart' && req.method === 'PUT') { send({ autostart: await setAutostart(startupDir, body.enabled === true, root) }); return; }
    if (url.pathname === '/api/model' && req.method === 'PUT') {
      const candidate = candidateModel(body, config);
      saveModelConfig(modelFile, candidate);
      Object.assign(config, candidate, { error: '' });
      if (config.configured) enqueueMonitored();
      send(publicModel(config)); return;
    }
    if (url.pathname === '/api/model/test' && req.method === 'POST') { send({ reply: await testModel(candidateModel(body, config), fetcher) }); return; }
    if (url.pathname === '/api/profile' && req.method === 'PUT') { send(store.saveProfile(body)); return; }
    if (conversationMatch && req.method === 'PATCH' && !conversationMatch[2]) {
      const updated = store.updateConversation(decodePath(conversationMatch[1]), body);
      if (updated.platform === 'wechat' && updated.monitored) await messaging.readWechat(updated, true);
      if (updated.platform === 'qq' && updated.kind === 'group' && capture && body.monitored !== undefined) {
        if (updated.monitored) await addGroup(updated.remoteId); else removeGroup(updated.remoteId);
      }
      if (updated.monitored) worker.enqueue(updated.id);
      send(updated); return;
    }
    if (conversationMatch && req.method === 'POST' && conversationMatch[2] === 'analyze') {
      const id = decodePath(conversationMatch[1]);
      if (!store.conversation(id)?.monitored) throw new AppError('请先关注此会话');
      worker.enqueue(id); send({ queued: true, modelConfigured: config.configured }); return;
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') { send(store.manualTask(body)); return; }
    if (taskMatch && req.method === 'PATCH') { send(store.manualTask(body, decodePath(taskMatch[1]))); return; }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const prompt = text(body.prompt, 3000); const scope = text(body.scope, 200) || 'all';
      if (!prompt) throw new AppError('请输入问题');
      if (chatBusy.has(scope)) throw new AppError('上一个问题仍在回答，请稍后再试', 409);
      chatBusy.add(scope);
      try { send({ reply: await answerChat(store, config, scope, prompt, fetcher) }); }
      finally { chatBusy.delete(scope); }
      return;
    }
    throw new AppError('没有找到此接口', 404);
  };
}
