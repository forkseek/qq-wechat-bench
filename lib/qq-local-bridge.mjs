import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AppError } from './domain.mjs';
import { DEFAULT_SETTINGS } from './settings.mjs';

export class QQLocalBridge {
  constructor(root, { dataDir = path.join(root, 'data'), settings = DEFAULT_SETTINGS, spawnProcess = spawn } = {}) {
    Object.assign(this, { root, dataDir: path.resolve(dataDir), settings, spawnProcess });
    this.child = null;
    this.pending = new Map();
    this.closed = false;
  }
  start() {
    if (this.closed) throw new AppError('QQ 本地直读已关闭', 503);
    if (this.child) return;
    const python = path.join(this.root, 'data', 'wechat', 'python-3.12', 'tools', 'python.exe');
    if (!existsSync(python)) throw new AppError('本地 Python 运行时尚未安装', 503);
    const privateDir = path.join(this.dataDir, 'qq-local');
    mkdirSync(privateDir, { recursive: true });
    this.child = this.spawnProcess(python, ['-u', path.join(this.root, 'scripts', 'qq-worker.py')], {
      cwd: privateDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', WORKBENCH_QQ_DATA_DIR: privateDir }
    });
    const child = this.child;
    createInterface({ input: child.stdout }).on('line', line => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.id !== 'string' || typeof result.ok !== 'boolean') return;
      const waiting = this.pending.get(result.id);
      if (!waiting || waiting.child !== child) return;
      this.pending.delete(result.id);
      clearTimeout(waiting.timer);
      if (result.ok) waiting.resolve(result.data);
      else {
        const error = new AppError(result.error || 'QQ 本地读取失败', 503);
        error.code = result.code;
        waiting.reject(error);
      }
    });
    child.stderr.on('data', () => {});
    const ended = () => this.endChild(child);
    child.once('exit', ended);
    child.once('error', ended);
    child.stdin.on('error', () => this.endChild(child, true));
  }
  endChild(child, terminate = false) {
    if (this.child === child) this.child = null;
    for (const [id, request] of this.pending) {
      if (request.child === child) {
        const error = new AppError('QQ 本地读取连接已断开，后台将自动恢复', 503);
        error.code = 'QQ_LOCAL_TRANSPORT_CLOSED';
        clearTimeout(request.timer);
        request.reject(error);
        this.pending.delete(id);
      }
    }
    if (terminate && !child.killed) {
      child.stdin.destroy();
      child.kill();
    }
  }
  async request(action, params = {}) {
    this.start();
    const id = randomUUID(), child = this.child;
    const timeoutMs = action === 'status' ? Math.min(this.settings.messaging.requestTimeoutMs, 30_000) : this.settings.messaging.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AppError('QQ 本地读取超时，请稍后重试', 504);
        error.code = 'QQ_LOCAL_TIMEOUT';
        reject(error);
        this.endChild(child, true);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      try { child.stdin.write(JSON.stringify({ id, action, params }) + '\n'); }
      catch { this.endChild(child, true); }
    });
  }
  async status() {
    try { return await this.request('status'); }
    catch (error) {
      return { available: false, online: false, mode: 'local', phase: 'unavailable', error: error instanceof AppError ? error.message : 'QQ 本地直读暂不可用' };
    }
  }
  groups() { return this.request('groups'); }
  sessions(limit = 200) { return this.request('sessions', { limit }); }
  activeGroups() { return this.request('active_groups'); }
  messages(conversation, limit = 80) {
    return this.request('messages', { selfId: conversation.selfId, remoteId: conversation.remoteId, kind: conversation.kind, limit });
  }
  close() {
    this.closed = true;
    if (this.child) this.endChild(this.child, true);
  }
}
