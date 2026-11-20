import pino from 'pino';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const labels = {
  'app.start': '工作台已启动', 'app.stop': '工作台已停止', 'message.received': '消息已保存',
  'account.online': '账号已接入', 'account.offline': '账号已离线', 'account.error': '账号接入未完成',
  'send.start': '开始发送', 'send.sent': '发送已确认', 'send.uncertain': '发送结果待核查', 'send.failed': '发送失败',
  'job.start': '定时处理开始', 'job.finish': '定时处理完成', 'job.failed': '定时处理失败',
  'analysis.start': 'AI 整理开始', 'analysis.finish': 'AI 整理完成', 'analysis.failed': 'AI 整理失败',
  'request.failed': '工作台请求失败', 'wechat.discovered': '微信会话已发现',
  'conversation.monitor.changed': '会话保存与整理设置已更新', 'wechat.group.backfill.failed': '微信群已添加，等待读取消息',
  'wechat.read.failed': '微信会话读取未完成，将自动重试',
  'qq.read.failed': 'QQ 本地会话读取未完成，将自动重试',
  'qq.capture.paused': '已暂停独立 QQ 采集，优先使用桌面 QQ', 'qq.capture.resumed': '桌面 QQ 已退出，已自动恢复 QQ 采集', 'qq.capture.stopped': 'QQ 采集已停止'
};
const day = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const fields = new Set(['platform', 'accountId', 'conversationId', 'messageId', 'count', 'job', 'code', 'status', 'requestId', 'bytes', 'filename', 'route', 'detail']);
const LEVEL_MAP = { info: '30', warn: '40', error: '50' };
const isRoutineEmptyJob = row => (row.event === 'job.start' || row.event === 'job.finish') && row.job === 'analysis' && (row.count === 0 || row.count === undefined);

export class EventLog {
  constructor(dataDir, { append = appendFileSync } = {}) {
    this.dir = path.join(dataDir, 'logs');
    this.error = ''; this.lastFailureAt = null;
    mkdirSync(this.dir, { recursive: true });
    this.logger = pino({ base: null, timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['secret', 'token', 'apiKey', '*.secret', '*.token', '*.apiKey', 'body', 'message'], censor: '[已隐藏]' } }, {
      write: line => append(path.join(this.dir, `workbench-${day()}.jsonl`), line, { mode: 0o600 })
    });
  }
  write(event, value = {}, level = 'info') {
    const selected = Object.fromEntries(Object.entries(value).filter(([key, value]) => fields.has(key) && ['number', 'boolean', 'string'].includes(typeof value)));
    if (selected.filename) selected.filename = path.basename(selected.filename).slice(0, 150);
    if (selected.route) selected.route = selected.route.slice(0, 120);
    if (selected.detail) selected.detail = selected.detail.slice(0, 160);
    try {
      this.logger[['info', 'warn', 'error'].includes(level) ? level : 'info']({ event: Object.hasOwn(labels, event) ? event : 'request.failed', ...selected }, labels[event] || '操作未完成');
      this.error = '';
    } catch {
      // 日志故障不能中断已经发生的发送、数据库事务或 HTTP 错误响应。
      this.error = '运行日志暂时无法写入，请检查磁盘空间和目录权限'; this.lastFailureAt = new Date().toISOString();
    }
  }
  status() { return { ok: !this.error, error: this.error, lastFailureAt: this.lastFailureAt }; }
  #collect({ platform = '', level = '', q = '', excludeRoutine = false, cap = 2000 } = {}) {
    const names = readdirSync(this.dir).filter(name => /^workbench-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse().slice(0, 14);
    const normalizedLevel = LEVEL_MAP[String(level || '').toLowerCase()] || String(level || '');
    const needle = String(q || '').trim().toLowerCase();
    const rows = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n').reverse()) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (excludeRoutine && isRoutineEmptyJob(row)) continue;
        if (platform && row.platform !== platform) continue;
        if (normalizedLevel && String(row.level) !== normalizedLevel) continue;
        if (needle) {
          const hay = `${row.msg || ''} ${row.event || ''} ${row.code || ''} ${row.route || ''} ${row.detail || ''} ${row.job || ''} ${row.status || ''} ${row.platform || ''}`.toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        rows.push(row);
        if (rows.length >= cap) return rows;
      }
    }
    return rows;
  }
  list({ platform = '', level = '', q = '', excludeRoutine = false, limit = 150 } = {}) {
    return this.#collect({ platform, level, q, excludeRoutine, cap: Math.min(Math.max(Number(limit) || 150, 1), 200) });
  }
  page({ platform = '', level = '', q = '', excludeRoutine = true, page = 1, pageSize = 40 } = {}) {
    const size = Math.min(Math.max(Number(pageSize) || 40, 1), 100);
    const current = Math.max(Number(page) || 1, 1);
    const all = this.#collect({ platform, level, q, excludeRoutine, cap: 2000 });
    const offset = (current - 1) * size;
    const items = all.slice(offset, offset + size);
    return { items, total: all.length, page: current, pageSize: size, hasMore: offset + items.length < all.length };
  }
}
