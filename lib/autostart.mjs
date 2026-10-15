import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from './domain.mjs';

// 开机自启：在当前用户的「启动」文件夹放一个快捷方式，登录 Windows 后在后台运行 start.ps1。不需要管理员权限。
export const defaultStartupDir = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
export const shortcutPath = dir => path.join(dir, '讯课工作台.lnk');
export const autostartEnabled = dir => existsSync(shortcutPath(dir));

const quote = value => `'${String(value).replace(/'/g, "''")}'`;

export async function setAutostart(dir, enabled, root) {
  const file = shortcutPath(dir);
  if (!enabled) { rmSync(file, { force: true }); return false; }
  const args = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(root, 'start.ps1')}" -NoBrowser`;
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(file)}); $s.TargetPath = 'powershell.exe'; ` +
    `$s.Arguments = ${quote(args)}; $s.WorkingDirectory = ${quote(root)}; $s.WindowStyle = 7; ` +
    `$s.Description = ${quote('讯课 QQ 通知工作台：登录 Windows 后在后台启动')}; $s.Save()`;
  try {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000 });
  } catch { throw new AppError('创建开机启动快捷方式失败', 500); }
  if (!existsSync(file)) throw new AppError('创建开机启动快捷方式失败', 500);
  return true;
}
