import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, idString } from './domain.mjs';
import { inspectQQProcesses } from './qq-processes.mjs';
import { DEFAULT_SETTINGS } from './settings.mjs';
import { readJsonFile, writeJsonAtomic } from './json-file.mjs';

export const QQ_DESKTOP_CONFLICT = '检测到桌面 QQ 正在运行，独立采集已暂停，避免重复登录。需要采集时请先退出桌面 QQ，再手动启动采集。';
const blockedError = (message, code, status = 409) => Object.assign(new AppError(message, status), { code });

export class QQBridge {
  constructor(dataDir, options = {}) {
    this.settings = options.settings || DEFAULT_SETTINGS;
    this.runtime = path.join(dataDir, 'napcat');
    this.shell = path.join(this.runtime, 'shell');
    this.pidFile = path.join(this.runtime, 'launcher.pid');
    this.credential = null;
    this.authAt = 0;
    this.qqFile = process.env.QQ_EXECUTABLE || 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
    this.inspectProcesses = options.inspectProcesses || (() => inspectQQProcesses(this.runtime, this.qqFile));
    this.processSnapshot = null; this.processCheckedAt = 0; this.processCheck = null;
  }
  invalidateProcesses() { this.processSnapshot = null; }
  async processState({ fresh = false } = {}) {
    if (!fresh && this.processSnapshot && Date.now() - this.processCheckedAt < 3000) return this.processSnapshot;
    this.processCheck ??= this.inspectProcesses().then(result => { this.processSnapshot = result; this.processCheckedAt = Date.now(); return result; })
      .finally(() => { this.processCheck = null; });
    return this.processCheck;
  }
  desktopMode() {
    const file = path.join(this.runtime, 'desktop-enabled.json');
    try { return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).enabled === true; } catch { return false; }
  }
  async request(route, body = {}, authenticated = true) {
    if (authenticated && (!this.credential || Date.now() - this.authAt > 30 * 60_000)) {
      const file = path.join(this.desktopMode() ? path.join(this.runtime, 'framework') : this.shell, 'config', 'webui.json');
      if (!existsSync(file)) throw new AppError('QQ 消息桥尚未安装', 503);
      const config = JSON.parse(readFileSync(file, 'utf8'));
      if (config.host !== '127.0.0.1' || config.port !== this.settings.qq.webuiPort) throw new AppError('QQ 消息桥地址与程序配置不一致，请检查本机配置', 503);
      const result = await this.request('/auth/login', { hash: createHash('sha256').update(config.token + '.napcat').digest('hex') }, false);
      if (!result.Credential) throw new AppError('QQ 消息桥管理登录失败', 503);
      this.credential = result.Credential; this.authAt = Date.now();
    }
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${this.settings.qq.webuiPort}/api` + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${this.credential}` } : {}) }, body: JSON.stringify(body) });
    } catch { throw new AppError('QQ 消息桥暂时无法连接', 503); }
    const result = await response.json();
    if (!response.ok || result.code !== 0) { this.credential = null; throw new AppError('QQ 消息桥尚未就绪，请查看登录页面', 503); }
    return result.data;
  }
  async status() {
    const mode = this.desktopMode() ? 'desktop' : 'shell';
    let processes;
    try { processes = await this.processState(); }
    catch { return { available: false, online: false, mode, phase: 'process_check_failed', blockedReason: 'process_check_failed',
      error: '无法确认本机 QQ 进程状态，已暂停启动采集以保护桌面登录' }; }
    if (mode === 'shell' && processes.desktopRunning) return { ...processes, available: false, online: false, mode,
      phase: 'desktop_in_use', blockedReason: 'desktop_in_use', error: QQ_DESKTOP_CONFLICT };
    try {
      const result = await this.request('/QQLogin/CheckLoginStatus');
      const conflict = /无法重复登录|重复登[录陆]|already.*logged/i.test(result.loginError || '');
      return { ...processes, available: true, online: result.isLogin === true, mode, phase: conflict ? 'login_conflict' : result.loginPhase,
        scanned: result.qrLoginAccepted === true, error: conflict ? 'QQ 账号已被其他客户端登录，请先停止独立采集并检查桌面 QQ 的登录状态。'
          : result.loginError ? 'QQ 登录未完成，请刷新二维码或查看手机提示' : '' };
    } catch (error) { return { ...processes, available: false, online: false, mode,
      phase: processes.launcherRunning || processes.ownedQQRunning ? 'starting' : 'unavailable', error: error instanceof AppError ? error.message : 'QQ 消息桥状态暂不可用' }; }
  }
  async refreshQR() { await this.request('/QQLogin/RefreshQRcode'); }
  async loginInfo() { return this.request('/QQLogin/GetQQLoginInfo'); }
  async read(action, params) {
    if (!['get_friend_list', 'get_group_list', 'get_group_info', 'get_group_msg_history', 'get_friend_msg_history', 'get_recent_contact', 'get_msg'].includes(action)) throw new AppError('仅开放会话的只读查询');
    const result = await this.request('/Debug/call', { action, params });
    if (result.status !== 'ok' || result.retcode !== 0) throw new AppError(`采集群查询失败（${result.retcode ?? '未知'}）`, 502);
    return result.data;
  }
  async send(conversation, value) {
    const account = idString((await this.loginInfo()).uin, '当前 QQ 账号');
    if (conversation.kind === 'private' && String(conversation.selfId) !== account) throw new AppError('当前 QQ 账号已改变，请重新选择会话', 409);
    let action, params;
    if (value.type === 'file') {
      action = conversation.kind === 'group' ? 'upload_group_file' : 'upload_private_file';
      params = { [conversation.kind === 'group' ? 'group_id' : 'user_id']: conversation.remoteId, file: value.file, name: value.name };
    } else {
      action = conversation.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
      params = { [conversation.kind === 'group' ? 'group_id' : 'user_id']: conversation.remoteId,
        message: [{ type: value.type === 'image' ? 'image' : 'text', data: value.type === 'image' ? { file: value.file } : { text: value.text } }] };
    }
    const result = await this.request('/Debug/call', { action, params });
    if (result.status !== 'ok' || result.retcode !== 0) throw new AppError('QQ 发送未完成，请先核查客户端中的发送记录', 502);
    return { status: 'sent', confirmed: true, externalId: result.data?.message_id ? String(result.data.message_id) : null, selfId: account };
  }

  // 上次拉起 NapCat 的时间（以 PID 文件为准，工作台重启后也能避免重复拉起）。
  lastLaunchAt() { try { return statSync(this.pidFile).mtimeMs; } catch { return 0; } }
  async launcherAlive() { const state = await this.processState(); return state.launcherRunning || state.ownedQQRunning; }
  // 写入 NapCat 配置并在后台启动。account 为空时 NapCat 显示二维码，否则用本机登录记录快速登录。
  async launch({ account = null, secret, port = this.settings.server.port }) {
    const uin = account ? idString(account, '登录账号') : null;
    const qqFile = this.qqFile;
    const processes = await this.processState({ fresh: true });
    if (!this.desktopMode() && processes.desktopRunning) throw blockedError(QQ_DESKTOP_CONFLICT, 'desktop_in_use');
    if (processes.launcherRunning || processes.ownedQQRunning) throw blockedError('QQ 采集进程已经运行，正在等待接口就绪，不会重复启动。', 'bridge_running');
    if (this.desktopMode()) {
      if (processes.desktopRunning) throw blockedError('桌面 QQ 已运行，请等待现有客户端的消息接口就绪。', 'bridge_running');
      const child = spawn(qqFile, [], { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      writeFileSync(this.pidFile, String(child.pid)); child.unref(); return child.pid;
    }
    const launcher = path.join(this.shell, 'NapCatWinBootMain.exe');
    if (!existsSync(qqFile)) throw new AppError('没有找到电脑版 QQ，请确认已安装 QQNT', 503);
    if (!existsSync(launcher)) throw new AppError('没有找到 NapCat 运行包（data/napcat/shell）', 503);
    const configDir = path.join(this.shell, 'config');
    mkdirSync(configDir, { recursive: true });
    const webuiFile = path.join(configDir, 'webui.json');
    if (!existsSync(webuiFile)) {
      writeJsonAtomic(webuiFile, { host: '127.0.0.1', port: this.settings.qq.webuiPort, token: randomBytes(32).toString('hex'),
        autoLoginAccount: '', disableWebUI: false, accessControlMode: 'whitelist', ipWhitelist: ['127.0.0.1', '::1'],
        enableXForwardedFor: false });
    } else {
      const config = readJsonFile(webuiFile, 'QQ 接口配置');
      if (config.host !== '127.0.0.1' || typeof config.token !== 'string' || !config.token) throw new AppError('QQ 接口配置需要使用本机地址及有效令牌', 503);
      if (config.port !== this.settings.qq.webuiPort) writeJsonAtomic(webuiFile, { ...config, port: this.settings.qq.webuiPort });
    }
    writeJsonAtomic(path.join(configDir, 'napcat.json'), { fileLog: false, consoleLog: true, consoleLogLevel: 'warn', fileLogLevel: 'warn', autoTimeSync: false });
    const onebot = { network: {
      httpServers: [], httpSseServers: [], websocketServers: [], websocketClients: [], plugins: [],
      httpClients: [{ name: 'school-workbench', enable: true, url: `http://127.0.0.1:${port}/onebot/events`,
        messagePostFormat: 'array', reportSelfMessage: true, token: secret, debug: false }]
    }, enableLocalFile2Url: false, parseMultMsg: false };
    // NapCat 登录后优先读取按账号命名的配置，两份都写，保证上报地址和密钥一致。
    writeJsonAtomic(path.join(configDir, 'onebot11.json'), onebot);
    if (uin) writeJsonAtomic(path.join(configDir, `onebot11_${uin}.json`), onebot);

    const stdout = openSync(path.join(this.runtime, 'launcher.log'), 'a');
    const stderr = openSync(path.join(this.runtime, 'launcher-error.log'), 'a');
    const child = spawn(launcher, [qqFile, path.join(this.shell, 'NapCatWinBootHook.dll'), ...(uin ? [uin] : [])], {
      cwd: this.shell, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      env: { ...process.env, NAPCAT_PATCH_PACKAGE: path.join(this.shell, 'qqnt.json'),
        NAPCAT_LOAD_PATH: path.join(this.shell, 'loadNapCat.js'), NAPCAT_MAIN_PATH: path.join(this.shell, 'napcat.mjs'),
        NAPCAT_INJECT_PATH: path.join(this.shell, 'NapCatWinBootHook.dll'), NAPCAT_WORKDIR: this.shell }
    });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } catch { throw new AppError('QQ 采集进程启动失败，请查看 data/napcat/launcher-error.log', 503); }
    finally { closeSync(stdout); closeSync(stderr); }
    writeFileSync(this.pidFile, String(child.pid));
    this.invalidateProcesses();
    child.unref();
    return child.pid;
  }
}
