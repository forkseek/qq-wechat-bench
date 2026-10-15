import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../lib/domain.mjs';
import { Store } from '../lib/store.mjs';
import { QQBridge, QQ_DESKTOP_CONFLICT } from '../lib/qq-bridge.mjs';
import { classifyQQProcesses, inspectQQProcesses } from '../lib/qq-processes.mjs';
import { QQSupervisor } from '../lib/supervisor.mjs';
import { createApp } from '../server.mjs';

const qqFile = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
const launcherFile = 'C:\\workbench\\data\\napcat\\shell\\NapCatWinBootMain.exe';
const at = Date.parse('2026-10-15T00:00:00Z');
const processEntry = (pid, parentPid, file = qqFile, offset = 100, auxiliary = false) => ({ pid, parentPid, file,
  name: path.win32.basename(file), createdAt: new Date(at + offset).toISOString(), auxiliary });
const absent = { desktopRunning: false, desktopProcessCount: 0, launcherRunning: false, ownedQQRunning: false };
const offline = { ...absent, available: false, online: false, phase: 'unavailable', error: '' };
const desktop = { ...offline, desktopRunning: true, desktopProcessCount: 1, phase: 'desktop_in_use', blockedReason: 'desktop_in_use', error: QQ_DESKTOP_CONFLICT };
function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-login-test-'));
  mkdirSync(path.join(dir, 'napcat'), { recursive: true });
  return dir;
}
function bridgeFake() { return { current: { ...offline }, status: async function () { return { ...this.current }; },
  lastLaunchAt: () => 0, launcherAlive: () => false }; }
function supervisorFixture(t, { bridge = bridgeFake(), launch = async () => {}, stopCapture = async () => {} } = {}) {
  const dir = directory(), store = new Store();
  const supervisor = new QQSupervisor({ bridge, store, capture: null, dataDir: dir, receive: () => null, launch, stopCapture, now: () => at });
  t.after(async () => { await supervisor.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, bridge, store, supervisor };
}

test('通过进程路径、创建时间及父子关系区分独立采集和桌面 QQ', () => {
  const entries = [processEntry(10, 1, launcherFile, 0), processEntry(11, 10), processEntry(12, 11, qqFile, 200, true),
    processEntry(20, 1), processEntry(21, 20, qqFile, 200, true)];
  assert.deepEqual(classifyQQProcesses(entries, { qqFile, launcherFile }), { desktopRunning: true, desktopProcessCount: 1, launcherRunning: true, ownedQQRunning: true });
  assert.deepEqual(classifyQQProcesses(entries.slice(0, 3), { qqFile, launcherFile }), { ...absent, launcherRunning: true, ownedQQRunning: true });
});

test('启动器先退出时仍识别 QQ 子进程；PID 被复用或创建时间不符时不认领桌面客户端', () => {
  const options = { qqFile, launcherFile, recordedPid: 10, recordedAt: at };
  const children = [processEntry(11, 10), processEntry(12, 11, qqFile, 200, true)];
  assert.deepEqual(classifyQQProcesses(children, options), { ...absent, ownedQQRunning: true });
  const reused = [processEntry(10, 1, 'C:\\Other\\NapCatWinBootMain.exe', 0), ...children];
  assert.equal(classifyQQProcesses(reused, options).desktopRunning, true);
  assert.equal(classifyQQProcesses(reused, options).ownedQQRunning, false);
  assert.equal(classifyQQProcesses([processEntry(11, 10, qqFile, 120_000)], options).desktopRunning, true);
  assert.equal(classifyQQProcesses([processEntry(10, 1, launcherFile, 1000), processEntry(11, 10, qqFile, 0)], options).desktopRunning, true);
});

test('桌面 QQ 阻止直接启动，阻止启动前不写配置或 PID；已有采集实例也不重复启动', async t => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let processes = { ...absent, desktopRunning: true, desktopProcessCount: 1 };
  const bridge = new QQBridge(dir, { inspectProcesses: async () => processes });
  assert.equal((await bridge.status()).blockedReason, 'desktop_in_use');
  await assert.rejects(() => bridge.launch({ account: '10001', secret: 'fixture-secret' }), error => error.status === 409 && error.code === 'desktop_in_use');
  assert.equal(existsSync(path.join(dir, 'napcat', 'launcher.pid')), false);
  assert.equal(existsSync(path.join(dir, 'napcat', 'shell', 'config')), false);
  processes = { ...absent, ownedQQRunning: true };
  await assert.rejects(() => bridge.launch({ secret: 'fixture-secret' }), error => error.code === 'bridge_running');
});

test('进程检查失败时禁止启动；重复登录错误不会伪装成普通等待扫码或暴露账号', async t => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failed = new QQBridge(dir, { inspectProcesses: async () => { throw new AppError('模拟检查失败', 503); } });
  assert.equal((await failed.status()).blockedReason, 'process_check_failed');
  await assert.rejects(() => failed.launch({ secret: 'fixture-secret' }), /检查失败/);
  const bridge = new QQBridge(dir, { inspectProcesses: async () => absent });
  bridge.request = async () => ({ isLogin: false, loginPhase: 'waiting_qrcode', loginError: '当前账号(10001)已登录,无法重复登录' });
  const state = await bridge.status();
  assert.equal(state.phase, 'login_conflict'); assert.match(state.error, /其他客户端/); assert.equal(state.error.includes('10001'), false);
});

test('Windows：实际运行进程查询脚本，验证编码、时间格式与 JSON 快照兼容性', { skip: process.platform !== 'win32' }, async t => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = await inspectQQProcesses(path.join(dir, 'napcat'), qqFile);
  for (const key of ['desktopRunning', 'launcherRunning', 'ownedQQRunning']) assert.equal(typeof state[key], 'boolean');
  assert.ok(Number.isSafeInteger(state.desktopProcessCount) && state.desktopProcessCount >= 0);
});

test('Windows：PowerShell 与 Python 启动器在隔离服务中返回冲突原因，不写常驻开关', { skip: process.platform !== 'win32' }, async t => {
  const dir = directory(), root = fileURLToPath(new URL('../', import.meta.url));
  const python = path.join(root, 'data', 'wechat', 'python-3.12', 'tools', 'python.exe');
  if (!existsSync(python)) { rmSync(dir, { recursive: true, force: true }); t.skip('本机 Python 未准备'); return; }
  let starts = 0; const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ route: req.url, method: req.method, hasCookie: Boolean(req.headers.cookie?.includes('workbench_session=fixture')), origin: req.headers.origin });
    req.resume(); res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, app: 'qq-school-workbench' })); return; }
    if (req.url === '/qq-login') { res.setHeader('Set-Cookie', 'workbench_session=fixture; Path=/; HttpOnly; SameSite=Strict'); res.end('{}'); return; }
    if (req.url === '/api/qq/start' && req.method === 'POST' && req.headers.cookie?.includes('workbench_session=fixture')
      && req.headers.origin === `http://127.0.0.1:${server.address().port}`) {
      starts++; res.writeHead(409); res.end(JSON.stringify({ error: QQ_DESKTOP_CONFLICT })); return;
    }
    res.writeHead(403); res.end(JSON.stringify({ error: 'fixture-auth-failed' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  // 复制原启动器到独立目录；服务启动脚本为空，HTTP 只访问临时端口，不运行 QQ 或真实工作台。
  writeFileSync(path.join(dir, '.env'), `PORT=${server.address().port}\n`);
  writeFileSync(path.join(dir, 'start.ps1'), 'param([switch]$NoBrowser)\n');
  for (const file of ['start-qq.ps1', 'open_workbench.py', 'package.json', 'config/workbench.json',
    'scripts/runtime-config.ps1', 'scripts/runtime-config.mjs', 'lib/settings.mjs', 'lib/json-file.mjs', 'lib/domain.mjs']) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), readFileSync(path.join(root, file)));
  }
  const run = promisify(execFile);
  for (const [exe, args] of [['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'start-qq.ps1'), '-NoBrowser']],
    [python, [path.join(dir, 'open_workbench.py'), '--qq', '--no-browser']]]) {
    await assert.rejects(() => run(exe, args, { cwd: dir, windowsHide: true, timeout: 30_000, encoding: 'utf8', env: { ...process.env, PORT: String(server.address().port), PYTHONUTF8: '0' } }),
      error => { assert.ok(starts > 0, JSON.stringify(requests)); return error.code === 1 && /检测到桌面 QQ/.test(error.stdout + error.stderr); });
    assert.equal(existsSync(path.join(dir, 'data', 'napcat', 'keep-running')), false);
  }
  assert.equal(starts, 2);
});

test('工作台重启遇到桌面 QQ 时撤销常驻开关；桌面退出后仍等待人工开启', async t => {
  let launches = 0;
  const { supervisor, bridge } = supervisorFixture(t, { launch: async () => { launches++; } });
  writeFileSync(supervisor.flag, 'enabled'); bridge.current = desktop;
  await supervisor.tick(); assert.equal(supervisor.keepRunning, false); assert.equal(launches, 0);
  await assert.rejects(() => supervisor.resume(), error => error.status === 409);
  assert.equal(supervisor.keepRunning, false); assert.equal(launches, 0);
  bridge.current = offline; await supervisor.tick(); assert.equal(launches, 0); assert.equal(supervisor.snapshot().blockedReason, undefined);
  await supervisor.resume(); assert.equal(launches, 1);
});

test('采集运行期间打开桌面 QQ：优先停止采集，而非桌面 QQ；停止后不再拉起', async t => {
  let stopped = 0, launches = 0;
  const bridge = bridgeFake();
  const { supervisor } = supervisorFixture(t, { bridge, launch: async () => { launches++; }, stopCapture: async () => {
    stopped++; bridge.current = desktop;
  } });
  writeFileSync(supervisor.flag, 'enabled');
  bridge.current = { ...desktop, launcherRunning: true, ownedQQRunning: true };
  await supervisor.tick(); await supervisor.tick();
  assert.equal(stopped, 1); assert.equal(launches, 0); assert.equal(supervisor.keepRunning, false);
  assert.equal(supervisor.snapshot().desktopRunning, true);
});

test('消息接口未就绪但 QQ 子进程仍在运行时，强制开启和自动检查都不能重复拉起', async t => {
  let launches = 0;
  const { supervisor, bridge } = supervisorFixture(t, { launch: async () => { launches++; } });
  bridge.current = { ...offline, ownedQQRunning: true };
  await supervisor.resume(); await supervisor.tick(); assert.equal(launches, 0);
});

test('启动前再次检查发现刚打开的桌面 QQ 时，返回冲突并撤销常驻开关', async t => {
  const { supervisor } = supervisorFixture(t, { launch: async () => {
    throw Object.assign(new AppError(QQ_DESKTOP_CONFLICT, 409), { code: 'desktop_in_use' });
  } });
  await assert.rejects(() => supervisor.resume(), error => error.status === 409);
  assert.equal(supervisor.keepRunning, false); assert.equal(supervisor.snapshot().blockedReason, 'desktop_in_use');
});

test('停止操作等待已开始的启动完成，再清理新进程；清理失败不能报告成功', async t => {
  let release, entered, stops = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { supervisor } = supervisorFixture(t, { launch: async () => { entered(); await gate; }, stopCapture: async () => { stops++; } });
  const starting = supervisor.resume(); await started;
  const stopping = supervisor.pauseAndStop(); release();
  await Promise.all([starting, stopping]); assert.equal(stops, 1); assert.equal(supervisor.keepRunning, false);
  supervisor.stopCapture = async () => { throw new AppError('终止进程失败', 500); };
  await assert.rejects(() => supervisor.pauseAndStop(), /终止进程失败/);
});

test('HTTP：桌面 QQ 冲突返回 409，不启用采集，也不提供旧二维码；停止失败返回 500', async t => {
  const dir = directory(), bridge = bridgeFake(); let launches = 0;
  bridge.current = desktop;
  const cache = path.join(dir, 'napcat', 'shell', 'cache'); mkdirSync(cache, { recursive: true }); writeFileSync(path.join(cache, 'qrcode.png'), 'stale-private-qr');
  const app = createApp({ dataDir: dir, supervise: false, model: { configured: false, enabled: false }, qqBridge: bridge,
    supervisor: { launch: async () => { launches++; }, stopCapture: async () => { throw new AppError('模拟终止失败', 500); } } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = await app.listen(0), cookie = (await fetch(base + '/qq-login')).headers.get('set-cookie').split(';')[0];
  const call = (route, method = 'POST') => fetch(base + route, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  const result = await call('/api/qq/start'); assert.equal(result.status, 409); assert.match((await result.json()).error, /桌面 QQ/);
  assert.equal(app.supervisor.keepRunning, false); assert.equal(launches, 0);
  assert.equal((await call('/api/qq/qr', 'GET')).status, 409);
  assert.equal((await call('/api/qq/refresh-qr')).status, 409);
  assert.equal((await call('/api/qq/stop')).status, 500);
});
