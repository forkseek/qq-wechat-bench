// Reuse NapCat Framework's published CJS loader, and the public x64 patch pattern
// from Mzdyl/LiteLoaderQQNT_Install. No external installer or unreviewed DLL.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'napcat', 'desktop-install');
const framework = path.join(root, 'data', 'napcat', 'framework');
const qq = 'C:\\Program Files\\Tencent\\QQNT';
const version = '9.9.20-36330';
const dll = path.join(qq, 'versions', version, 'QQNT.dll');
const pkg = path.join(qq, 'versions', version, 'resources', 'app', 'package.json');
const manifestFile = path.join(dir, 'manifest.json');
const flag = path.join(root, 'data', 'napcat', 'desktop-enabled.json');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const mode = process.argv[2] || 'prepare';
if (!['prepare', 'install', 'restore'].includes(mode)) throw new Error('仅支持 prepare / install / restore');

if (mode === 'prepare') {
  if (existsSync(manifestFile)) throw new Error('准备目录已存在，请检查现有备份，不覆盖它');
  if (!existsSync(path.join(framework, 'napcat.cjs'))) throw new Error('请先下载固定版本 NapCat Framework');
  const binary = readFileSync(dll), old = readFileSync(pkg), config = JSON.parse(old);
  if (config.version !== version || config.main !== './application.asar/app_launcher/index.js') throw new Error('QQ 版本或入口与审查版本不同');
  const pe = binary.readUInt32LE(0x3c);
  if (binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('仅适用已审查的 x64 QQ');
  const sig = Buffer.from('4889ce488b114c8b41084929d0488b4918e8', 'hex');
  const offset = binary.indexOf(sig);
  if (offset < 0 || binary.indexOf(sig, offset + 1) !== -1) throw new Error('校验函数必须只有一个匹配，停止准备');
  mkdirSync(dir, { recursive: true });
  copyFileSync(dll, path.join(dir, 'QQNT.original.dll'));
  writeFileSync(path.join(dir, 'package.original.json'), old);
  const originalMain = path.resolve(path.dirname(pkg), config.main);
  const entry = path.join(framework, 'workbench-entry.cjs');
  writeFileSync(entry, `// 本机 QQ 桌面接入；原入口仍执行。\nprocess.env.NAPCAT_WORKDIR = ${JSON.stringify(framework)};\ntry { require(${JSON.stringify(path.join(framework, 'napcat.cjs'))}); } catch {}\nrequire(${JSON.stringify(originalMain)});\n`, 'utf8');
  Buffer.from('4889ce488b114c8b41084929d0488b4918b801000000', 'hex').copy(binary, offset);
  writeFileSync(path.join(dir, 'QQNT.patched.dll'), binary);
  writeFileSync(path.join(dir, 'package.patched.json'), JSON.stringify({ ...config, main: entry.replaceAll('\\', '/') }, null, 2));
  const rows = [{ target: dll, original: 'QQNT.original.dll', prepared: 'QQNT.patched.dll' },
    { target: pkg, original: 'package.original.json', prepared: 'package.patched.json' }]
    .map(row => ({ ...row, originalHash: hash(path.join(dir, row.original)), preparedHash: hash(path.join(dir, row.prepared)) }));
  writeFileSync(manifestFile, JSON.stringify({ version, frameworkVersion: '4.18.37', offset, rows, at: new Date().toISOString() }, null, 2));
  // Copy private local configuration, without displaying tokens.
  mkdirSync(path.join(framework, 'config'), { recursive: true });
  for (const name of ['webui.json', 'napcat.json', 'onebot11.json']) {
    copyFileSync(path.join(root, 'data', 'napcat', 'shell', 'config', name), path.join(framework, 'config', name));
  }
  const oldConfig = path.join(root, 'data', 'napcat', 'shell', 'config');
  for (const name of (await import('node:fs')).readdirSync(oldConfig).filter(name => /^onebot11_\d+\.json$/.test(name))) copyFileSync(path.join(oldConfig, name), path.join(framework, 'config', name));
  writeFileSync(path.join(framework, 'config', 'napcat.json'), JSON.stringify({ fileLog: false, consoleLog: false, consoleLogLevel: 'error', fileLogLevel: 'error', autoTimeSync: false }, null, 2));
  console.log(JSON.stringify({ prepared: true, version, offset, bytes: binary.length, backups: rows.map(row => ({ file: row.original, sha256: row.originalHash })) }));
} else {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== version || manifest.rows.length !== 2 || manifest.rows[0].target !== dll || manifest.rows[1].target !== pkg) throw new Error('恢复清单路径不匹配');
  for (const row of manifest.rows) {
    if (hash(path.join(dir, row.original)) !== row.originalHash || hash(path.join(dir, row.prepared)) !== row.preparedHash) throw new Error('备份或准备文件已变化');
    if (hash(row.target) !== (mode === 'install' ? row.originalHash : row.preparedHash)) throw new Error('安装文件发生变化，请先重新审查；不覆盖新版 QQ');
  }
  const copied = [];
  try {
    for (const row of manifest.rows) { copyFileSync(path.join(dir, mode === 'install' ? row.prepared : row.original), row.target); copied.push(row); }
    for (const row of manifest.rows) if (hash(row.target) !== (mode === 'install' ? row.preparedHash : row.originalHash)) throw new Error('写入后哈希不一致');
    writeFileSync(flag, JSON.stringify({ enabled: mode === 'install', version, frameworkVersion: '4.18.37' }));
    console.log(JSON.stringify({ mode, verified: true, files: copied.length }));
  } catch (error) {
    for (const row of copied.reverse()) copyFileSync(path.join(dir, mode === 'install' ? row.original : row.prepared), row.target);
    throw error;
  }
}
