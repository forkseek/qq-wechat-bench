import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AppError } from './domain.mjs';
import { DEFAULT_SETTINGS } from './settings.mjs';

export class WechatBridge {
  constructor(root, { mediaReader = false, dataDir = path.join(root, 'data'), settings = DEFAULT_SETTINGS, spawnProcess = spawn } = {}) {
    Object.assign(this, { root, dataDir: path.resolve(dataDir), settings, spawnProcess, mediaReader });
    this.child = null; this.pending = new Map(); this.mediaWorkers = new Set(); this.closed = false;
  }
  start() {
    if (this.closed) throw new AppError('微信连接已关闭', 503);
    if (this.child) return;
    const python = path.join(this.root, 'data', 'wechat', 'python-3.12', 'tools', 'python.exe');
    if (!existsSync(python)) throw new AppError('微信接入运行时尚未安装', 503);
    const privateDir = path.join(this.dataDir, 'wechat'); mkdirSync(privateDir, { recursive: true });
    this.child = this.spawnProcess(python, ['-u', path.join(this.root, 'scripts', 'wechat-worker.py'), ...(this.mediaReader ? ['--media-reader'] : [])], {
      cwd: privateDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', WORKBENCH_WECHAT_DATA_DIR: privateDir }
    });
    const child = this.child;
    createInterface({ input: child.stdout }).on('line', line => {
      let result; try { result = JSON.parse(line); } catch { return; }
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.id !== 'string' || typeof result.ok !== 'boolean') return;
      const waiting = this.pending.get(result.id);
      if (!waiting || waiting.child !== child) return;
      this.pending.delete(result.id); clearTimeout(waiting.timer);
      if (result.ok) waiting.resolve(result.data);
      else { const error = new AppError(result.error || '微信操作失败', 503); error.code = result.code; error.attempted = result.attempted; waiting.reject(error); }
    });
    child.stderr.on('data', () => {}); // Never forward unfiltered SDK logs.
    const ended = () => this.endChild(child);
    child.once('exit', ended); child.once('error', ended);
    child.stdin.on('error', () => this.endChild(child, true));
  }
  endChild(child, terminate = false) {
    if (this.child === child) this.child = null;
    for (const [id, request] of this.pending) if (request.child === child) {
      const error = new AppError('微信连接已断开，发送结果需核查', 503); error.code = 'WECHAT_TRANSPORT_CLOSED';
      clearTimeout(request.timer); request.reject(error); this.pending.delete(id);
    }
    if (terminate && !child.killed) { child.stdin.destroy(); child.kill(); }
  }
  async request(action, params = {}) {
    this.start();
    const id = randomUUID(), child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AppError(action === 'send' ? '发送结果未确认，请先查看客户端，避免重复发送' : '微信读取超时，请稍后重试', 504); error.code = 'WECHAT_TIMEOUT';
        reject(error);
        // 原生 SDK 串行处理请求。超时后回收本工作台的读取进程，防止队列永久阻塞或稍后执行旧发送。
        // 后续读取会重建连接，发送请求始终不自动重放。
        this.endChild(child, true);
      }, this.settings.messaging.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      try { child.stdin.write(JSON.stringify({ id, action, params }) + '\n'); }
      catch { this.endChild(child, true); }
    });
  }
  async status() {
    try { return await this.request('status'); }
    catch (error) { return { available: false, online: false, phase: 'unavailable', error: error instanceof AppError ? error.message : '微信接入暂不可用' }; }
  }
  sessions() { return this.request('sessions'); }
  messages(conversation, limit = 80) { return this.request('messages', { selfId: conversation.selfId, remoteId: conversation.remoteId, limit }); }
  async media(conversation, message, sourceFilename = '') {
    if (this.mediaWorkers.size) throw new AppError('另一份微信附件正在读取，请稍后再试', 409);
    const reader = new WechatBridge(this.root, { mediaReader: true, dataDir: this.dataDir, settings: this.settings, spawnProcess: this.spawnProcess }); this.mediaWorkers.add(reader);
    try { return await reader.request('media', { selfId: conversation.selfId, remoteId: conversation.remoteId, externalId: message.externalId, shard: message.shard, sourceFilename }); }
    finally { reader.close(); this.mediaWorkers.delete(reader); }
  }
  send(conversation, value) { return this.request('send', { selfId: conversation.selfId, remoteId: conversation.remoteId, ...value }); }
  close() {
    this.closed = true;
    for (const reader of this.mediaWorkers) reader.close(); this.mediaWorkers.clear();
    if (this.child) this.endChild(this.child, true);
  }
}
