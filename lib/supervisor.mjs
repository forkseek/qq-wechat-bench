import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, idString } from './domain.mjs';
import { DEFAULT_SETTINGS } from './settings.mjs';

const MINUTE = 60_000;
// 两次自动拉起之间的最短间隔；连续失败时逐步拉长，避免反复重启。
const errorText = (error, fallback) => error instanceof AppError ? error.message : fallback;
const iso = value => value ? new Date(value).toISOString() : null;

// 看护 NapCat：需要常驻时自动拉起；QQ 恢复在线和每隔一段时间补拉漏掉的群消息。
export class QQSupervisor {
  constructor({ bridge, store, capture, dataDir, receive, launch, stopCapture = async () => {}, onEvent = () => {}, now = Date.now, settings = DEFAULT_SETTINGS }) {
    Object.assign(this, { bridge, store, capture, receive, launch, stopCapture, onEvent, now });
    this.flag = path.join(dataDir, 'napcat', 'keep-running');
    mkdirSync(path.dirname(this.flag), { recursive: true });
    this.settings = settings;
    this.launchGaps = settings.qq.launchRetryMinutes.map(minutes => minutes * MINUTE);
    this.status = { available: false, online: false, phase: 'unknown', error: '' };
    this.wasOnline = false; this.launches = 0; this.lastLaunchAt = 0; this.forceLaunch = false;
    this.lastBackfill = null; this.error = ''; this.busy = null; this.timer = null; this.stopped = false;
  }

  get keepRunning() { return existsSync(this.flag); }
  account() { return this.store.meta('qq')?.account || null; }
  snapshot() {
    return { ...this.status, keepRunning: this.keepRunning, account: this.account(), error: this.error || this.status.error || '',
      lastLaunchAt: iso(Math.max(this.lastLaunchAt, this.bridge.lastLaunchAt())), lastBackfill: this.lastBackfill && { ...this.lastBackfill, at: iso(this.lastBackfill.at) } };
  }

  start(intervalMs = this.settings.qq.pollIntervalMs) {
    if (this.timer || this.stopped) return this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    return this.tick();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.busy; }
  async resume() {
    if (this.stopped) throw new AppError('QQ 采集看护已关闭，请重新打开工作台', 503);
    this.bridge.invalidateProcesses?.();
    await this.tick();
    this.#assertStartAllowed();
    writeFileSync(this.flag, new Date(this.now()).toISOString()); this.launches = 0; this.forceLaunch = true; this.error = '';
    await this.tick();
    this.#assertStartAllowed();
  }
  #assertStartAllowed() {
    if (this.status.blockedReason) throw new AppError(this.error || this.status.error, this.status.blockedReason === 'desktop_in_use' ? 409 : 503);
  }
  pause() { rmSync(this.flag, { force: true }); this.forceLaunch = false; }
  async pauseAndStop() {
    this.pause(); await this.busy;
    this.pause(); await this.stopCapture();
    this.bridge.invalidateProcesses?.(); await this.tick();
  }
  forgetAccount() { this.store.setMeta('qq', { account: null }); }

  // 同一时间只跑一轮；并发调用等待正在进行的那一轮。
  tick() {
    if (this.stopped) return Promise.resolve();
    this.busy ??= this.#round().catch(error => { this.error = errorText(error, 'QQ 采集检查失败'); }).finally(() => { this.busy = null; });
    return this.busy;
  }
  async #round() {
    const wasBlocked = Boolean(this.status.blockedReason);
    this.status = await this.bridge.status();
    if (wasBlocked && !this.status.blockedReason) this.error = '';
    if (this.status.blockedReason) {
      this.wasOnline = false; this.error = this.status.error;
      if (this.status.blockedReason === 'desktop_in_use') {
        const enabled = this.keepRunning;
        this.pause();
        if (this.status.launcherRunning || this.status.ownedQQRunning) {
          await this.stopCapture(); this.bridge.invalidateProcesses?.();
          this.status = await this.bridge.status(); this.error = this.status.error;
        }
        if (enabled) this.onEvent('qq.capture.paused', { code: 'desktop_in_use' });
      }
      return;
    }
    if (this.status.online) {
      this.launches = 0; this.error = '';
      const cameOnline = !this.wasOnline;
      this.wasOnline = true;
      if (cameOnline) await this.#rememberAccount();
      if (cameOnline || this.now() - (this.lastBackfill?.at || 0) >= this.settings.qq.backfillMinutes * MINUTE) await this.backfill();
      return;
    }
    this.wasOnline = false;
    if (!this.keepRunning || this.status.available) return;
    // 启动器可能先退出，但 QQ 子进程仍在初始化。不要在接口尚未就绪时再起一份。
    if (this.status.launcherRunning || this.status.ownedQQRunning || await this.bridge.launcherAlive()) { this.forceLaunch = false; return; }
    const since = this.now() - Math.max(this.lastLaunchAt, this.bridge.lastLaunchAt());
    const gap = this.launchGaps[Math.min(Math.max(this.launches - 1, 0), this.launchGaps.length - 1)];
    const due = this.forceLaunch || since >= gap;
    this.forceLaunch = false;
    if (!due || !this.keepRunning) return;
    this.lastLaunchAt = this.now(); this.launches++;
    try { await this.launch({ account: this.account() }); this.error = ''; }
    catch (error) {
      this.error = errorText(error, 'QQ 采集启动失败');
      // 启动前的第二次检查也可能发现刚打开的桌面 QQ。
      if (error.code === 'desktop_in_use') {
        this.pause(); this.status = { ...this.status, online: false, available: false, phase: 'desktop_in_use', blockedReason: 'desktop_in_use', error: this.error };
        this.onEvent('qq.capture.paused', { code: 'desktop_in_use' });
      }
    }
  }
  // 记住扫码登录过的账号，下次用本机登录记录免扫码登录。
  async #rememberAccount() {
    try {
      const account = idString((await this.bridge.loginInfo()).uin, '登录账号');
      if (account !== this.account()) this.store.setMeta('qq', { account });
    } catch { /* 读取失败不影响采集 */ }
  }

  // 从最新消息往前翻页，遇到已保存的消息为止。重复消息由数据库去重。
  // groups 默认为全部采集群；新添加的群可以单独补拉。
  async backfill({ pages = 5, count = 20, groups = this.capture?.groups || [] } = {}) {
    const result = { at: this.now(), imported: 0, error: '' };
    try {
      if (!this.capture || !groups.length) return result;
      const selfId = idString((await this.bridge.loginInfo()).uin, '登录账号');
      for (const groupId of groups) result.imported += await this.#backfillGroup(groupId, selfId, pages, count);
    } catch (error) { result.error = errorText(error, '补拉历史消息失败'); }
    finally { this.lastBackfill = result; }
    return result;
  }
  async #backfillGroup(groupId, selfId, pages, count) {
    const existing = this.store.conversation(`qq:group:${groupId}`);
    if (existing && !existing.monitored) return 0;
    const groupName = existing?.title || (await this.bridge.read('get_group_info', { group_id: groupId })).group_name;
    const seen = new Set();
    let anchor = null, imported = 0;
    for (let page = 0; page < pages; page++) {
      let messages;
      try {
        ({ messages = [] } = await this.bridge.read('get_group_msg_history', { group_id: groupId, count, ...(anchor ? { message_seq: anchor } : {}),
          disable_get_url: true, parse_mult_msg: false, quick_reply: false }));
      } catch (error) { if (page === 0) throw error; break; } // 翻到最早的消息时 NapCat 会报错，视为结束
      const batch = messages.filter(message => message.group_id === undefined || String(message.group_id) === groupId).sort((a, b) => a.time - b.time);
      let reachedKnown = false;
      for (const message of batch) {
        let saved;
        try {
          saved = this.receive({ ...message, post_type: 'message', message_type: 'group', group_id: groupId, self_id: selfId,
            group_name: groupName, workbench_source: 'history' });
        } catch { continue; } // 跳过格式无法识别的单条消息
        // 翻页时上一页最早的那条会再次出现，不能当作「已经接上」。
        if (saved?.duplicate && !seen.has(message.message_id)) reachedKnown = true;
        if (saved?.saved) imported++;
        seen.add(message.message_id);
      }
      if (reachedKnown || batch.length < count) break;
      anchor = String(batch[0].message_id);
    }
    return imported;
  }
}
