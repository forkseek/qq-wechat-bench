import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError } from './domain.mjs';
import { readJsonFile } from './json-file.mjs';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SETTINGS_FILE = path.join(APP_ROOT, 'config', 'workbench.json');
const fail = field => { throw new AppError(`workbench.json 的 ${field} 配置不正确`, 500); };
const object = (value, keys, field) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) fail(field);
};
const integer = (value, min, max, field) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail(field); };
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };

export function validateSettings(value) {
  object(value, ['schemaVersion', 'server', 'qq', 'messaging', 'maintenance', 'ui', 'modelPresets'], '根对象');
  if (value.schemaVersion !== 1) fail('schemaVersion');
  object(value.server, ['host', 'port', 'requestBodyBytes', 'requestTimeoutMs', 'headersTimeoutMs'], 'server');
  if (value.server.host !== '127.0.0.1') fail('server.host（仅支持本机）');
  integer(value.server.port, 1, 65535, 'server.port');
  integer(value.server.requestBodyBytes, 1024, 16 * 1024 * 1024, 'server.requestBodyBytes');
  integer(value.server.requestTimeoutMs, 1000, 300_000, 'server.requestTimeoutMs');
  integer(value.server.headersTimeoutMs, 1000, value.server.requestTimeoutMs, 'server.headersTimeoutMs');
  object(value.qq, ['webuiPort', 'pollIntervalMs', 'launchRetryMinutes', 'backfillMinutes'], 'qq');
  integer(value.qq.webuiPort, 1, 65535, 'qq.webuiPort');
  if (value.qq.webuiPort === value.server.port) fail('qq.webuiPort（不能占用工作台端口）');
  integer(value.qq.pollIntervalMs, 1000, 300_000, 'qq.pollIntervalMs');
  integer(value.qq.backfillMinutes, 1, 1440, 'qq.backfillMinutes');
  if (!Array.isArray(value.qq.launchRetryMinutes) || !value.qq.launchRetryMinutes.length || value.qq.launchRetryMinutes.length > 10) fail('qq.launchRetryMinutes');
  value.qq.launchRetryMinutes.forEach((minutes, index, list) => {
    integer(minutes, 1, 60, 'qq.launchRetryMinutes'); if (index && minutes < list[index - 1]) fail('qq.launchRetryMinutes（应递增）');
  });
  object(value.messaging, ['pollIntervalMs', 'requestTimeoutMs', 'maxAttachmentBytes', 'maxAttachments'], 'messaging');
  integer(value.messaging.pollIntervalMs, 1000, 300_000, 'messaging.pollIntervalMs');
  integer(value.messaging.requestTimeoutMs, 1000, 300_000, 'messaging.requestTimeoutMs');
  integer(value.messaging.maxAttachmentBytes, 1024 * 1024, 100 * 1024 * 1024, 'messaging.maxAttachmentBytes');
  if (value.messaging.maxAttachmentBytes % (1024 * 1024)) fail('messaging.maxAttachmentBytes（需为整 MB）');
  integer(value.messaging.maxAttachments, 1, 20, 'messaging.maxAttachments');
  object(value.maintenance, ['enabled', 'analysisMinutes', 'backupHour', 'optimizeMinutes', 'timezone'], 'maintenance');
  if (typeof value.maintenance.enabled !== 'boolean' || value.maintenance.timezone !== 'Asia/Shanghai') fail('maintenance');
  integer(value.maintenance.analysisMinutes, 1, 60, 'maintenance.analysisMinutes');
  integer(value.maintenance.optimizeMinutes, 5, 60, 'maintenance.optimizeMinutes');
  integer(value.maintenance.backupHour, 0, 23, 'maintenance.backupHour');
  if (60 % value.maintenance.analysisMinutes || 60 % value.maintenance.optimizeMinutes) fail('maintenance（间隔需整除 60 分钟）');
  object(value.ui, ['refreshIntervalMs', 'qqLoginPollIntervalMs'], 'ui');
  for (const [key, milliseconds] of Object.entries(value.ui)) integer(milliseconds, 500, 60_000, `ui.${key}`);
  if (!Array.isArray(value.modelPresets) || !value.modelPresets.length || value.modelPresets.length > 10) fail('modelPresets');
  const presetIds = new Set();
  for (const preset of value.modelPresets) {
    object(preset, ['id', 'label', 'baseUrl', 'name'], 'modelPresets');
    if (typeof preset.id !== 'string' || !/^[a-z][a-z0-9-]{0,29}$/.test(preset.id) || preset.id === 'custom' || presetIds.has(preset.id)) fail('modelPresets.id');
    presetIds.add(preset.id);
    if (typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 80 || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 150) fail('modelPresets');
    let url; try { url = new URL(preset.baseUrl); } catch { fail('modelPresets.baseUrl'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) fail('modelPresets.baseUrl');
  }
  return freeze(structuredClone(value));
}

export const loadSettings = (file = SETTINGS_FILE) => validateSettings(readJsonFile(file, '程序默认配置'));
export const DEFAULT_SETTINGS = loadSettings();
export const APP_METADATA = Object.freeze(readJsonFile(path.join(APP_ROOT, 'package.json'), '程序信息'));
export function publicSettings(settings = DEFAULT_SETTINGS) {
  return { ui: settings.ui, messaging: { pollIntervalMs: settings.messaging.pollIntervalMs, maxAttachmentBytes: settings.messaging.maxAttachmentBytes,
    maxAttachments: settings.messaging.maxAttachments }, modelPresets: settings.modelPresets };
}
export function runtimeInfo(root = APP_ROOT, env = process.env) {
  const settings = loadSettings(path.join(root, 'config', 'workbench.json'));
  const file = path.join(root, '.env');
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  const raw = env.PORT ?? saved.PORT ?? settings.server.port;
  if (!/^\d+$/.test(String(raw))) throw new AppError('PORT 需要是 1–65535 之间的整数', 500);
  const port = Number(raw);
  if (port < 1 || port > 65535 || port === settings.qq.webuiPort) throw new AppError('PORT 需要在 1–65535 之间，且不能占用 QQ 消息桥端口', 500);
  const metadata = readJsonFile(path.join(root, 'package.json'), '程序信息');
  return { app: metadata.name, version: metadata.version, port, url: `http://127.0.0.1:${port}` };
}
