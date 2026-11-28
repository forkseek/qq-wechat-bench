import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { AppError } from './domain.mjs';

const program = action => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$result = [System.Security.Cryptography.ProtectedData]::${action}($inputBytes, $null, $scope)
[Console]::Write([Convert]::ToBase64String($result))
`;

function windowsCredential(action, payload) {
  if (process.platform !== 'win32') throw new AppError('当前系统不支持保存模型密钥，请使用 MODEL_API_KEY 环境变量', 500);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const command = Buffer.from(program(action), 'utf16le').toString('base64');
    const result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      input: payload, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (!result || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) throw new Error();
    return result;
  } catch { throw new AppError('无法使用当前 Windows 用户保护模型密钥', 500); }
}

export function protectModelKey(key) {
  return windowsCredential('Protect', Buffer.from(key, 'utf8').toString('base64'));
}

export function unprotectModelKey(ciphertext) {
  return Buffer.from(windowsCredential('Unprotect', ciphertext), 'base64').toString('utf8');
}
