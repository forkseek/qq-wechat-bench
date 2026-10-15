import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SETTINGS, APP_METADATA, loadSettings, validateSettings, runtimeInfo } from '../lib/settings.mjs';
import { readJsonFile, writeJsonAtomic } from '../lib/json-file.mjs';
import { loadModelConfig, publicModel } from '../lib/model.mjs';
import { createApp } from '../server.mjs';
import { Messaging } from '../lib/messaging.mjs';
import { Maintenance } from '../lib/maintenance.mjs';
import { Store } from '../lib/store.mjs';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'workbench-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('JSON 默认配置拒绝未知字段、非本机监听、端口冲突及不合法的轮询/定时参数', () => {
  assert.equal(validateSettings(structuredClone(DEFAULT_SETTINGS)).messaging.maxAttachments, 5);
  for (const change of [s => { s.server.host = '0.0.0.0'; }, s => { s.server.port = s.qq.webuiPort; }, s => { s.schemaVersion = 2; },
    s => { s.qq.pollIntervalMs = 0; }, s => { s.qq.launchRetryMinutes = [5, 1]; }, s => { s.maintenance.analysisMinutes = 7; },
    s => { s.ui.refreshIntervalMs = '5000'; }, s => { s.messaging.maxAttachmentBytes = 1; }, s => { s.extra = true; },
    s => { s.modelPresets[0].key = 'fixture-secret'; }, s => { s.modelPresets[0].baseUrl = 'https://user:pass@example.com'; }]) {
    const settings = structuredClone(DEFAULT_SETTINGS); change(settings); assert.throws(() => validateSettings(settings), /workbench.json/);
  }
});

test('默认配置支持 UTF-8 BOM；配置错误在打开 SQLite 前被报告', t => {
  const dir = directory(t), file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(DEFAULT_SETTINGS)); assert.equal(loadSettings(file).schemaVersion, 1);
  const settings = structuredClone(DEFAULT_SETTINGS); settings.messaging.maxAttachments = -1;
  const dataDir = path.join(dir, 'should-not-open');
  assert.throws(() => createApp({ dataDir, settings, supervise: false }), /maxAttachments/);
  assert.equal(fs.existsSync(path.join(dataDir, 'workbench.sqlite')), false);
});

test('统一端口优先级：进程环境变量、支持引号的 .env、JSON 默认值；错误值不静默回退', t => {
  const dir = directory(t); fs.mkdirSync(path.join(dir, 'config'));
  const settings = structuredClone(DEFAULT_SETTINGS); settings.server.port = 4321;
  writeJsonAtomic(path.join(dir, 'config', 'workbench.json'), settings);
  writeJsonAtomic(path.join(dir, 'package.json'), { name: APP_METADATA.name, version: APP_METADATA.version });
  assert.equal(runtimeInfo(dir, {}).port, 4321);
  fs.writeFileSync(path.join(dir, '.env'), 'export PORT="4322" # fixture\n');
  assert.equal(runtimeInfo(dir, {}).port, 4322); assert.equal(runtimeInfo(dir, { PORT: '4323' }).port, 4323);
  for (const PORT of ['invalid', '', '0', '65536', String(settings.qq.webuiPort)]) assert.throws(() => runtimeInfo(dir, { PORT }), /PORT/);
});

test('JSON 原子保存：替换失败与序列化失败都保留原文件，并清理临时文件', t => {
  const dir = directory(t), file = path.join(dir, 'model.json');
  writeJsonAtomic(file, { name: 'old', key: 'fixture-original-secret' });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => writeJsonAtomic(file, { name: 'new' }, { ...fs, renameSync() { throw new Error('fixture disk failure'); } }), /原配置已保留/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => writeJsonAtomic(file, undefined), /原配置已保留/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => writeJsonAtomic(file, cyclic), /原配置已保留/);
  assert.deepEqual(fs.readdirSync(dir), ['model.json']);
  writeJsonAtomic(file, { name: 'new' }); assert.deepEqual(readJsonFile(file), { name: 'new' });
});

test('JSON 默认参数实际约束附件并提供定时默认值；用户保存的定时计划优先', async t => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'workbench-config-behavior-')), store = new Store();
  const settings = structuredClone(DEFAULT_SETTINGS); settings.messaging.maxAttachmentBytes = 1024 * 1024; settings.messaging.maxAttachments = 1; settings.maintenance.analysisMinutes = 10;
  const log = { write() {} }, messaging = new Messaging({ store, dataDir: dir, settings, log, qq: {}, wechat: {}, enqueue() {} });
  const maintenance = new Maintenance({ store, dataDir: dir, settings, log, analyze() {} });
  t.after(async () => { await messaging.stop(); await maintenance.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => messaging.upload(Buffer.alloc(1024 * 1024 + 1), 'fixture.bin', ''), /1 MB/);
  await assert.rejects(() => messaging.send({ id: 'fixture', platform: 'wechat' }, { requestId: '11111111-1111-4111-a111-111111111111', text: 'fixture', attachments: ['a', 'b'] }), /1 个附件/);
  assert.equal(maintenance.config.analysisMinutes, 10); maintenance.configure({ analysisMinutes: 15 });
  const reopened = new Maintenance({ store, dataDir: dir, settings, log, analyze() {} });
  assert.equal(reopened.config.analysisMinutes, 15); await reopened.stop();
});

test('已保存模型配置损坏时停用 AI，不切换到环境变量中的其他服务；有效 BOM 文件仍可用', t => {
  const file = path.join(directory(t), 'model.json'); fs.writeFileSync(file, '{"broken":"fixture-sensitive');
  const env = { MODEL_ENABLED: 'true', MODEL_BASE_URL: 'https://example.com', MODEL_NAME: 'remote', MODEL_API_KEY: 'fixture-fallback-key' };
  const disabled = loadModelConfig(file, env);
  assert.equal(disabled.configured, false); assert.equal(disabled.enabled, false); assert.equal(disabled.key, ''); assert.match(disabled.error, /AI 已停用/);
  assert.equal(JSON.stringify(publicModel(disabled)).includes('fixture-'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"broken":"fixture-sensitive');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', name: 'local', key: '' }));
  assert.equal(loadModelConfig(file, env).configured, true);
});

test('采集配置损坏时不打开数据库，避免以意外范围启动', t => {
  const dir = directory(t); fs.writeFileSync(path.join(dir, 'capture.json'), '{broken');
  assert.throws(() => createApp({ dataDir: dir, supervise: false }), /采集范围/);
  assert.equal(fs.existsSync(path.join(dir, 'workbench.sqlite')), false);
});

test('拆分后的 HTTP 继续保护配置、会话和来源，使用 JSON 请求大小限制并拒绝无效路径编码', async t => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'workbench-http-'));
  const settings = structuredClone(DEFAULT_SETTINGS); settings.server.requestBodyBytes = 1024;
  const app = createApp({ dataDir: dir, settings, supervise: false, model: { configured: false, enabled: false, key: 'fixture-hidden-key' } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = await app.listen(0), page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/state')).status, 403);
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
  const response = await fetch(base + '/api/state', { headers }); const state = await response.json();
  assert.equal(state.settings.messaging.maxAttachments, settings.messaging.maxAttachments);
  assert.deepEqual(state.settings.modelPresets, settings.modelPresets); assert.equal(JSON.stringify(state).includes('fixture-hidden-key'), false);
  assert.equal((await fetch(base + '/config/workbench.json', { headers })).status, 404);
  assert.equal((await fetch(base + '/api/tasks/%FF', { headers })).status, 400);
  assert.equal((await fetch(base + '/api/profile', { method: 'PUT', headers, body: JSON.stringify({ context: 'x'.repeat(2000) }) })).status, 413);
  assert.equal((await fetch(base + '/api/profile', { method: 'PUT', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
});
