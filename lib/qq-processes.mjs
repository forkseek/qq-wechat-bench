import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppError } from './domain.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/qq-processes.ps1', import.meta.url));
const sameFile = (a, b) => Boolean(a && b && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase());
const qq = entry => entry.name?.toLowerCase() === 'qq.exe';

// PID 会复用。通过可执行文件、父子关系和创建时间识别本工作台的进程。
export function classifyQQProcesses(processes, { qqFile, launcherFile, recordedPid = null, recordedAt = 0 }) {
  const entries = processes.map(value => ({ ...value, created: Date.parse(value.createdAt) }));
  const launchers = entries.filter(entry => entry.name?.toLowerCase() === 'napcatwinbootmain.exe' && sameFile(entry.file, launcherFile));
  const owners = new Map(launchers.map(entry => [entry.pid, entry.created]));
  const recordedProcess = entries.find(entry => entry.pid === recordedPid);
  // 启动器可能先退出，QQ 子进程仍运行；已被复用的 PID 不能作为所有权证据。
  if (!recordedProcess && Number.isSafeInteger(recordedPid) && recordedPid > 0 && recordedAt > 0) {
    for (const entry of entries) {
      if (qq(entry) && sameFile(entry.file, qqFile) && entry.parentPid === recordedPid && entry.created >= recordedAt - 5000 && entry.created <= recordedAt + 60_000) {
        owners.set(entry.pid, entry.created);
      }
    }
  }
  let changed;
  do {
    changed = false;
    for (const entry of entries) {
      const parentCreated = owners.get(entry.parentPid);
      if (qq(entry) && sameFile(entry.file, qqFile) && parentCreated !== undefined && entry.created >= parentCreated && !owners.has(entry.pid)) {
        owners.set(entry.pid, entry.created); changed = true;
      }
    }
  } while (changed);
  const ownedQQ = entries.filter(entry => qq(entry) && owners.has(entry.pid));
  const desktop = entries.filter(entry => qq(entry) && !entry.auxiliary && !owners.has(entry.pid));
  return { desktopRunning: desktop.length > 0, desktopProcessCount: desktop.length,
    launcherRunning: launchers.length > 0, ownedQQRunning: ownedQQ.length > 0 };
}

export async function inspectQQProcesses(runtime, qqFile) {
  if (process.platform !== 'win32') throw new AppError('QQ 本机进程检查仅支持 Windows', 503);
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const processes = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!Array.isArray(processes) || processes.some(entry => !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !Number.isFinite(Date.parse(entry.createdAt)))) throw new Error('Invalid process snapshot');
    const pidFile = path.join(runtime, 'launcher.pid');
    let recordedPid = null, recordedAt = 0;
    try { recordedPid = Number(readFileSync(pidFile, 'utf8').trim()); recordedAt = statSync(pidFile).mtimeMs; } catch { /* 尚未启动过 */ }
    return classifyQQProcesses(processes, { qqFile, launcherFile: path.join(runtime, 'shell', 'NapCatWinBootMain.exe'), recordedPid, recordedAt });
  } catch { throw new AppError('无法确认本机 QQ 进程状态，已暂停启动采集以保护桌面登录', 503); }
}
