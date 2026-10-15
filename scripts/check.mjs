import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadSettings, APP_METADATA } from '../lib/settings.mjs';
import { readJsonFile } from '../lib/json-file.mjs';
const files = ['server.mjs', 'public/app.js', 'public/qq-login.js', ...['lib', 'scripts', 'tests'].flatMap(folder => readdirSync(folder).filter(file => file.endsWith('.mjs')).map(file => `${folder}/${file}`))];
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stderr); }
}
console.log(`${files.length} 个 JavaScript 文件语法检查${failed ? '失败' : '通过'}`);
if (process.platform === 'win32') {
  const command = "$bad = 0; $files = @(Get-ChildItem -LiteralPath . -Filter '*.ps1') + @(Get-ChildItem -LiteralPath scripts -Filter '*.ps1'); foreach ($file in $files) { $errors = $null; $tokens = $null; [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null; foreach ($error in $errors) { Write-Output ($file.Name + ': ' + $error.Message); $bad++ } }; if ($bad) { exit 1 }";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stdout + result.stderr + (result.error?.message || '')); }
  else console.log('Windows PowerShell 5.1 脚本语法与中文编码检查通过');
}
try {
  loadSettings();
  const lock = readJsonFile('package-lock.json');
  if (lock.version !== APP_METADATA.version || lock.packages[''].version !== APP_METADATA.version) throw new Error('版本与锁文件不一致');
  console.log('JSON 默认配置校验、版本与锁文件检查通过');
} catch (error) { failed = true; process.stderr.write(error.message + '\n'); }
process.exitCode = failed ? 1 : 0;
