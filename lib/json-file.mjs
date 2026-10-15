import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './domain.mjs';

export function readJsonFile(file, label = 'JSON 配置') {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new AppError(`${label}无法读取或不是有效 JSON，请检查 ${path.basename(file)}`, 500); }
}

// 在同一目录完整写入、同步并替换，失败时保留原文件。io 参数用于验证磁盘故障。
export function writeJsonAtomic(file, value, io = fs) {
  const target = path.resolve(file);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json !== 'string') throw new Error('Value cannot be serialized');
    const serialized = json + '\n';
    io.mkdirSync(path.dirname(target), { recursive: true });
    descriptor = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(descriptor, serialized, 'utf8'); io.fsyncSync(descriptor);
    io.closeSync(descriptor); descriptor = undefined;
    io.renameSync(temporary, target);
  } catch { throw new AppError(`保存 ${path.basename(target)} 失败，原配置已保留`, 500); }
  finally {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
    try { io.rmSync(temporary, { force: true }); } catch {}
  }
}
