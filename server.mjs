import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { AppError, text, idString, normalizeEvent } from './lib/domain.mjs';
import { loadModelConfig, publicModel, AnalysisWorker } from './lib/model.mjs';
import { captureConfig, saveCapture, permitsCapture, prepareCapture, MAX_GROUPS } from './lib/capture.mjs';
import { QQBridge } from './lib/qq-bridge.mjs';
import { QQSupervisor } from './lib/supervisor.mjs';
import { defaultStartupDir, autostartEnabled } from './lib/autostart.mjs';
import { WechatBridge } from './lib/wechat-bridge.mjs';
import { Messaging } from './lib/messaging.mjs';
import { EventLog } from './lib/event-log.mjs';
import { Maintenance } from './lib/maintenance.mjs';
import { createHttpHandler } from './lib/http.mjs';
import { createApi } from './lib/api.mjs';
import { APP_ROOT as root, DEFAULT_SETTINGS, validateSettings, publicSettings, runtimeInfo } from './lib/settings.mjs';
import { readJsonFile, writeJsonAtomic } from './lib/json-file.mjs';

const stopBridge = () => promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'start-qq.ps1'), '-Stop'], { windowsHide: true, timeout: 30000 });

// 先校验配置，再打开数据库。创建服务失败时保证释放 SQLite 文件。
export function createApp(options = {}) {
  const settings = options.settings ? validateSettings(options.settings) : DEFAULT_SETTINGS;
  const dataDir = path.resolve(options.dataDir || path.join(root, 'data'));
  mkdirSync(dataDir, { recursive: true });
  const connectionFile = path.join(dataDir, 'connection.json');
  if (!existsSync(connectionFile)) writeJsonAtomic(connectionFile, { secret: randomBytes(32).toString('hex') });
  const connection = readJsonFile(connectionFile, '消息桥连接配置');
  if (!connection || typeof connection.secret !== 'string' || !connection.secret.trim() || connection.secret.length > 256) throw new AppError('connection.json 的连接密钥格式不正确', 500);
  const captureFile = path.join(dataDir, 'capture.json');
  const capture = captureConfig(Object.hasOwn(options, 'capture') ? options.capture : existsSync(captureFile) ? readJsonFile(captureFile, '采集范围') : null);
  const modelFile = path.join(dataDir, 'model.json');
  const config = options.model || loadModelConfig(modelFile);
  const store = new Store(path.join(dataDir, 'workbench.sqlite'), { recover: false });
  try { return assembleApp({ options, settings, dataDir, connection, capture, captureFile, config, modelFile, store }); }
  catch (error) { store.close(); throw error; }
}

function assembleApp({ options, settings, dataDir, connection, capture, captureFile, config, modelFile, store }) {
  const log = new EventLog(dataDir);
  const qqBridge = options.qqBridge || new QQBridge(dataDir, { settings });
  const worker = new AnalysisWorker(store, config, options.analyzer);
  worker.onEvent = (event, conversation, count, code) => log.write(event, { platform: conversation.platform || 'qq', conversationId: conversation.id, count, code }, code ? 'warn' : 'info');
  let port, closing = false, closePromise, listenPromise;
  // 实时上报和补拉的历史消息都走这里：按采集范围过滤、去重保存，并排入 AI 整理。
  function receive(event) {
    const privateEvent = ['message', 'message_sent'].includes(event.post_type) && event.message_type === 'private' ? normalizeEvent(event) : null;
    const permitted = permitsCapture(event, capture) || Boolean(privateEvent && store.conversation(privateEvent.conversation.id)?.monitored);
    const normalized = permitted ? normalizeEvent(event) : null;
    prepareCapture(store, normalized, capture);
    const result = normalized ? store.ingest(normalized) : null;
    // 说明这条上报来自哪里：私聊不记对方信息，群消息只记群号和群名。
    const source = !['message', 'message_sent'].includes(event.post_type) ? null : event.message_type === 'group'
      ? { kind: 'group', groupId: String(event.group_id ?? ''), name: text(event.group_name, 100), captured: permitted }
      : { kind: 'private', captured: permitted };
    store.recordEvent({ history: event.workbench_source === 'history', saved: Boolean(result?.saved), source,
      selfId: normalized?.conversation.selfId || (event.self_id ? idString(event.self_id) : null) });
    if (result?.saved) {
      worker.enqueue(result.conversationId);
      log.write('message.received', { platform: 'qq', conversationId: result.conversationId, messageId: normalized.message.id });
    }
    return result;
  }
  const supervisor = new QQSupervisor({ bridge: qqBridge, store, capture, dataDir, receive,
    launch: value => qqBridge.launch({ ...value, secret: connection.secret, port }), stopCapture: stopBridge, settings,
    onEvent: (event, value) => log.write(event, { platform: 'qq', ...value }, 'warn'), ...options.supervisor });
  const enqueueMonitored = () => { for (const conversation of store.conversations().filter(value => value.monitored)) worker.enqueue(conversation.id); };
  const wechatBridge = options.wechatBridge || new WechatBridge(root, { dataDir, settings });
  const messaging = new Messaging({ store, qq: qqBridge, wechat: wechatBridge, dataDir, log, settings, enqueue: id => worker.enqueue(id) });
  const maintenance = new Maintenance({ store, dataDir, log, settings, analyze: enqueueMonitored, recover: false });

  const startupDir = options.startupDir || defaultStartupDir();

  function state() {
    return { settings: publicSettings(settings), profile: store.profile(), model: publicModel(config), capture, connection: store.bridge(), qq: supervisor.snapshot(),
      wechat: messaging.wechatStatus, accounts: store.accounts(), maintenance: { config: maintenance.config, active: [...maintenance.active.keys()] },
      autostart: autostartEnabled(startupDir), logging: log.status(), runs: store.runs(5), pendingCount: store.pendingCount(),
      conversations: store.conversations(), tasks: store.tasks().map(task => ({ ...task, sourceAt: store.sourceTime(task.sourceIds) })) };
  }
  // 添加或恢复拉取一个群：写入采集范围并保存，已有会话重新关注，QQ 在线时立即补拉。
  async function addGroup(value) {
    if (!capture) throw new AppError('当前没有使用采集范围（data/capture.json），请在会话管理中直接关注会话');
    const groupId = idString(value, '群号');
    if (!capture.groups.includes(groupId)) {
      if (capture.groups.length >= MAX_GROUPS) throw new AppError(`最多拉取 ${MAX_GROUPS} 个群`);
      const next = { groups: [...capture.groups, groupId] };
      saveCapture(captureFile, next);
      capture.groups = next.groups;
    }
    const id = `qq:group:${groupId}`;
    if (store.conversation(id) && !store.conversation(id).monitored) store.updateConversation(id, { monitored: true });
    await supervisor.tick();
    return supervisor.status.online ? supervisor.backfill({ groups: [groupId] }) : null;
  }
  function removeGroup(value) {
    if (!capture) throw new AppError('当前没有使用采集范围（data/capture.json）');
    const groupId = idString(value, '群号');
    const next = { groups: capture.groups.filter(id => id !== groupId) };
    saveCapture(captureFile, next);
    capture.groups = next.groups;
    // 已保存的消息和任务保留，只是不再拉取和整理。
    const id = `qq:group:${groupId}`;
    if (store.conversation(id)?.monitored) store.updateConversation(id, { monitored: false });
  }

  const handleApi = createApi({ store, worker, log, config, capture, qqBridge, supervisor, messaging, maintenance,
    dataDir, root, startupDir, modelFile, settings, state, addGroup, removeGroup, enqueueMonitored, fetcher: options.fetcher,
    shutdown: () => setImmediate(() => { app.close().catch(() => { process.exitCode = 1; }); }) });
  const server = http.createServer(createHttpHandler({ root, settings, getPort: () => port, secret: connection.secret,
    receive, handleApi, isClosing: () => closing, log }));
  server.requestTimeout = settings.server.requestTimeoutMs;
  server.headersTimeout = settings.server.headersTimeoutMs;
  const app = { store, worker, server, config, settings, supervisor, receive, messaging, maintenance, log,
    listen(requestedPort = settings.server.port) {
      if (closing || listenPromise) return Promise.reject(new AppError('工作台已经启动或正在关闭', 503));
      listenPromise = (async () => {
        await new Promise((resolve, reject) => {
          const failed = error => { server.removeListener('listening', ready); reject(error); };
          const ready = () => { server.removeListener('error', failed); resolve(); };
          server.once('error', failed); server.once('listening', ready); server.listen(requestedPort, settings.server.host);
        });
        port = server.address().port;
        if (!closing) {
          // 成功占用服务端口后才恢复中断记录，重复启动失败不能修改原实例正在进行的操作。
          store.recoverInterrupted(); maintenance.recoverInterrupted();
          if (options.supervise !== false) { enqueueMonitored(); supervisor.start(); messaging.start(); }
          if (options.supervise !== false && options.maintain !== false) maintenance.start();
          log.write('app.start', {});
        }
        return `http://127.0.0.1:${port}`;
      })();
      return listenPromise;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; worker.stop();
      closePromise = (async () => {
        try {
          await listenPromise?.catch(() => {});
          // 先停止接收新请求，让正在发送的请求完成，再关闭消息组件。
          if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
          const stopped = await Promise.allSettled([supervisor, messaging, maintenance].map(service => Promise.resolve().then(() => service.stop())));
          while (worker.running) await new Promise(resolve => setTimeout(resolve, 25));
          log.write('app.stop', {});
          if (stopped.some(result => result.status === 'rejected')) throw new AppError('部分后台组件退出失败，请检查运行日志', 500);
        } finally { store.close(); }
      })();
      return closePromise;
    }
  };
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let application;
  try {
    const runtime = runtimeInfo();
    application = createApp();
    const url = await application.listen(runtime.port);
    console.log(`QQ 与微信工作台已启动：${url}`);
    console.log('QQ 接入与 AI 状态请在页面中查看。停止服务：Ctrl+C。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      try { await application.close(); process.exit(0); } catch { process.exit(1); }
    });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请打开已有工作台或更改 PORT。' : error instanceof AppError ? error.message : '启动失败，请检查 Node.js 版本、目录权限与端口配置。');
    if (application) await application.close().catch(() => {});
    process.exitCode = 1;
  }
}
