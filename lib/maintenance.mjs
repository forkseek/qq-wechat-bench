import cron from 'node-cron';
import { backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './domain.mjs';
import { DEFAULT_SETTINGS } from './settings.mjs';

function maintenanceConfig(value, current) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw new AppError('定时处理设置格式不正确');
  const integer = (name, min, max) => { const v = Number(value[name] ?? current[name]); if (!Number.isInteger(v) || v < min || v > max) throw new AppError('定时处理设置超出允许范围'); return v; };
  const next = { enabled: value.enabled ?? current.enabled, analysisMinutes: integer('analysisMinutes', 1, 60),
    backupHour: integer('backupHour', 0, 23), optimizeMinutes: integer('optimizeMinutes', 5, 60), timezone: current.timezone };
  if (60 % next.analysisMinutes || 60 % next.optimizeMinutes) throw new AppError('处理间隔请选择能整除 60 的分钟数，例如 5、10、15、20、30 或 60');
  return next;
}

export class Maintenance {
  constructor({ store, dataDir, log, analyze, settings = DEFAULT_SETTINGS, recover = true }) {
    Object.assign(this, { store, dataDir, log, analyze });
    this.dir = path.join(dataDir, 'backups');
    mkdirSync(this.dir, { recursive: true });
    this.active = new Map(); this.scheduled = []; this.started = false; this.stopped = false;
    this.config = maintenanceConfig(store.meta('maintenance.config', settings.maintenance), settings.maintenance);
    store.db.exec('CREATE TABLE IF NOT EXISTS maintenance_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    if (recover) this.recoverInterrupted();
  }
  recoverInterrupted() {
    this.store.db.exec("UPDATE maintenance_runs SET payload=json_set(payload,'$.status','failed','$.error','上次处理因工作台退出而中断') WHERE json_extract(payload,'$.status')='running'");
  }
  snapshot() {
    return { config: this.config, active: [...this.active.keys()],
      runs: this.store.db.prepare('SELECT payload FROM maintenance_runs ORDER BY rowid DESC LIMIT 25').all().map(row => JSON.parse(row.payload)),
      backups: readdirSync(this.dir).filter(name => /^workbench-.*\.sqlite$/.test(name)).sort().reverse().slice(0, 30).map(name => ({ name, bytes: statSync(path.join(this.dir, name)).size })) };
  }
  configure(value) {
    if (this.stopped) throw new AppError('定时处理组件已关闭', 503);
    const next = maintenanceConfig(value, this.config);
    this.store.setMeta('maintenance.config', next);
    this.config = next;
    if (this.started) this.start(); return this.snapshot();
  }
  start() {
    if (this.stopped) return;
    this.started = true;
    for (const task of this.scheduled) task.destroy(); this.scheduled = [];
    if (!this.config.enabled) return;
    const schedule = (expression, job) => this.scheduled.push(cron.schedule(expression, () => this.run(job).catch(() => {}), { timezone: this.config.timezone, noOverlap: true }));
    schedule(`*/${this.config.analysisMinutes} * * * *`, 'analysis');
    schedule(`0 ${this.config.backupHour} * * *`, 'backup');
    schedule(`*/${this.config.optimizeMinutes} * * * *`, 'optimize');
  }
  async run(job) {
    if (this.stopped) throw new AppError('定时处理组件已关闭', 503);
    if (!['analysis', 'backup', 'optimize'].includes(job)) throw new AppError('未知的定时处理任务');
    if (this.active.has(job)) throw new AppError('同一任务正在处理，请稍后查看结果', 409);
    const promise = this.#run(job); this.active.set(job, promise);
    try { return await promise; } finally { this.active.delete(job); }
  }
  async #run(job) {
    const record = { id: randomUUID(), job, startedAt: new Date().toISOString(), status: 'running' };
    const save = () => this.store.db.prepare('INSERT INTO maintenance_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(record.id, JSON.stringify(record));
    save(); this.log.write('job.start', { job, requestId: record.id });
    try {
      if (job === 'analysis') { record.pending = this.store.pendingCount(); this.analyze(); }
      if (job === 'backup') {
        const name = `workbench-${new Date().toISOString().replace(/[:.]/g, '-')}-${record.id.slice(0, 8)}.sqlite`;
        const partial = path.join(this.dir, name + '.partial');
        await backup(this.store.db, partial);
        renameSync(partial, path.join(this.dir, name));
        record.filename = name; record.bytes = statSync(path.join(this.dir, name)).size;
      }
      if (job === 'optimize') {
        const checks = this.store.db.prepare('PRAGMA quick_check').all();
        if (checks.some(row => Object.values(row)[0] !== 'ok')) throw new AppError('数据库检查未通过，请先备份并检查');
        this.store.db.exec('PRAGMA optimize');
        const checkpoint = this.store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
        record.check = 'ok'; record.checkpoint = { ...checkpoint };
      }
      record.status = 'success'; this.log.write('job.finish', { job, requestId: record.id, count: record.pending, bytes: record.bytes });
    } catch (error) {
      record.status = 'failed'; record.error = error instanceof AppError ? error.message : '本机数据库处理失败，请查看运行状态';
      this.log.write('job.failed', { job, requestId: record.id, code: error.name }, 'error');
    } finally { record.finishedAt = new Date().toISOString(); save(); }
    return record;
  }
  async stop() { this.stopped = true; this.started = false; for (const task of this.scheduled) task.destroy(); this.scheduled = []; await Promise.allSettled([...this.active.values()]); }
}
