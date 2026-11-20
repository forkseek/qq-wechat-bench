<script setup>
import { ref, computed, watch } from 'vue';
import { api } from '../api.js';
import { formatTime } from '../utils/format.js';
import LogsPanel from './LogsPanel.vue';
import MaintenancePanel from './MaintenancePanel.vue';

const props = defineProps({
  state: { type: Object, required: true },
  initialSubTab: { type: String, default: 'connections' } // 'connections' | 'logs' | 'maintenance'
});
const emit = defineEmits(['refresh', 'navigate', 'toast']);

const subTab = ref(props.initialSubTab || 'connections');
watch(() => props.initialSubTab, v => { if (v) subTab.value = v; });

const presets = computed(() => props.state?.settings?.modelPresets || []);
const modelForm = ref({
  preset: 'custom',
  enabled: true,
  baseUrl: '',
  name: '',
  key: ''
});
const modelDirty = ref(false);
const testingModel = ref(false);
const savingModel = ref(false);
const testResult = ref('');
const testError = ref('');
const busyAction = ref('');

watch(() => props.state?.model, m => {
  if (!m || modelDirty.value) return;
  const matched = presets.value.find(p => p.baseUrl === m.baseUrl);
  modelForm.value = {
    preset: matched ? matched.id : (m.baseUrl ? 'custom' : (presets.value[0]?.id || 'custom')),
    enabled: m.enabled !== false,
    baseUrl: m.baseUrl || presets.value[0]?.baseUrl || '',
    name: m.name || presets.value[0]?.name || '',
    key: ''
  };
}, { immediate: true });

function onPresetChange() {
  modelDirty.value = true;
  const found = presets.value.find(p => p.id === modelForm.value.preset);
  if (found) {
    modelForm.value.baseUrl = found.baseUrl;
    modelForm.value.name = found.name;
  }
}

async function runAction(name, fn, successMsg) {
  busyAction.value = name;
  try {
    const res = await fn();
    if (typeof successMsg === 'function') emit('toast', successMsg(res));
    else if (successMsg) emit('toast', successMsg);
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busyAction.value = '';
  }
}

async function testAI() {
  testingModel.value = true;
  testResult.value = '';
  testError.value = '';
  try {
    const res = await api('/api/model/test', {
      enabled: modelForm.value.enabled,
      baseUrl: modelForm.value.baseUrl,
      name: modelForm.value.name,
      key: modelForm.value.key
    }, 'POST');
    testResult.value = res.reply;
  } catch (err) {
    testError.value = err.message;
  } finally {
    testingModel.value = false;
  }
}

async function saveAI() {
  savingModel.value = true;
  try {
    await api('/api/model', {
      enabled: modelForm.value.enabled,
      baseUrl: modelForm.value.baseUrl,
      name: modelForm.value.name,
      key: modelForm.value.key
    }, 'PUT');
    modelDirty.value = false;
    modelForm.value.key = '';
    emit('toast', 'AI 模型配置已保存并立即生效');
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    savingModel.value = false;
  }
}

const qqMonitoredTitles = computed(() =>
  (props.state?.conversations || []).filter(c => c.platform === 'qq' && c.monitored).map(c => c.title)
);

const qqStatusBadge = computed(() => {
  const qq = props.state?.qq || {};
  if (qq.online) {
    if (qq.mode === 'local') return { text: qq.degraded ? '重试中' : '已接入（桌面直读）', cls: qq.degraded ? 'badge-ochre' : 'badge-pine' };
    return { text: '已在线（独立采集）', cls: 'badge-pine' };
  }
  if (qq.blockedReason === 'desktop_in_use') return { text: '桌面 QQ 运行中', cls: 'badge-ochre' };
  if (qq.available || qq.launcherRunning || qq.ownedQQRunning) return { text: '启动中 / 待扫码', cls: 'badge-ochre' };
  return { text: '等待登录', cls: '' };
});

const wxStatusBadge = computed(() => {
  const wx = props.state?.wechat || {};
  if (wx.online) return { text: wx.degraded ? '重试中' : '已接入', cls: wx.degraded ? 'badge-ochre' : 'badge-pine' };
  if (wx.phase === 'client_closed') return { text: '未打开', cls: '' };
  return { text: '等待登录', cls: 'badge-ochre' };
});
</script>

<template>
  <section class="settings-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">设置与维护</h1>
        <span class="page-title-accent" aria-hidden="true"></span>
        <p class="page-subtitle">管理微信/QQ 接入、AI 模型、运行日志和数据库定时备份。</p>
      </div>
      <div class="segmented" role="tablist">
        <button class="seg-btn" :class="{ active: subTab === 'connections' }" @click="subTab = 'connections'">接入与 AI</button>
        <button class="seg-btn" :class="{ active: subTab === 'logs' }" @click="subTab = 'logs'">运行日志</button>
        <button class="seg-btn" :class="{ active: subTab === 'maintenance' }" @click="subTab = 'maintenance'">数据与定时</button>
      </div>
    </header>

    <div v-if="subTab === 'connections'" class="conn-stack">
      <!-- 微信接入 -->
      <article class="card setting-card">
        <div class="setting-head">
          <div class="setting-head-text">
            <h2 class="setting-title">微信 · 本机登录自动接入</h2>
            <p class="muted setting-sub">
              <template v-if="state.wechat?.online">
                当前已接入账号 <strong>{{ state.wechat.name || state.wechat.selfId }}</strong>，后台每 15 秒同步已关注群消息。
              </template>
              <template v-else>
                {{ state.wechat?.error || '打开并登录电脑微信后会自动识别当前账号与会话，无需另扫二维码。' }}
              </template>
            </p>
          </div>
          <span class="badge" :class="wxStatusBadge.cls">
            <span class="dot" :class="state.wechat?.online ? 'dot-ok' : 'dot-warn'"></span>
            <span>{{ wxStatusBadge.text }}</span>
          </span>
        </div>
        <div class="setting-actions">
          <button
            class="btn btn-secondary btn-sm"
            :disabled="busyAction === 'discover'"
            @click="runAction('discover', () => api('/api/conversations/discover', {}, 'POST'), '已刷新本机会话')"
          >
            {{ busyAction === 'discover' ? '检测中…' : '刷新微信会话' }}
          </button>
        </div>
      </article>

      <!-- QQ 接入 -->
      <article class="card setting-card">
        <div class="setting-head">
          <div class="setting-head-text">
            <h2 class="setting-title">QQ · 本机登录自动接入</h2>
            <p class="muted setting-sub">
              <template v-if="state.qq?.online && state.qq?.mode === 'local'">
                当前已直连桌面 QQ 账号 <strong>{{ state.qq.name || state.qq.account }}</strong>（<span class="num">{{ state.qq.account }}</span>），与电脑 QQ 完全共存，后台每 15 秒同步已关注群消息，无需扫码或修改 QQ 客户端。
              </template>
              <template v-else-if="state.qq?.online">
                当前通过独立采集在线，正在同步已关注 QQ 群。
              </template>
              <template v-else>
                打开并登录电脑 QQ 后会自动识别当前账号与群聊，无需另扫二维码，与微信体验完全一致。
              </template>
            </p>
          </div>
          <span class="badge" :class="qqStatusBadge.cls">
            <span class="dot" :class="state.qq?.online ? 'dot-ok' : state.qq?.blockedReason ? 'dot-warn' : ''"></span>
            <span>{{ qqStatusBadge.text }}</span>
          </span>
        </div>

        <div class="qq-details muted">
          <p v-if="qqMonitoredTitles.length">
            正在关注 {{ qqMonitoredTitles.length }} 个群：{{ qqMonitoredTitles.join('、') }}
          </p>
          <p v-if="state.connection">
            已保存 <strong class="num">{{ state.connection.messages || 0 }}</strong> 条消息（含历史补拉 <strong class="num">{{ state.connection.historyMessages || 0 }}</strong> 条）
            <span v-if="state.connection.lastReport"> · 最近同步 {{ formatTime(state.connection.lastReport) }}</span>
          </p>
        </div>

        <div class="setting-actions">
          <button
            class="btn btn-primary btn-sm"
            :disabled="!state.qq?.online || busyAction === 'qq-backfill'"
            @click="runAction('qq-backfill', () => api('/api/qq/backfill', {}, 'POST'), r => r?.error || `同步完成，新增 ${r?.imported ?? 0} 条 QQ 消息`)"
          >
            {{ busyAction === 'qq-backfill' ? '同步中…' : '立即同步 QQ 消息' }}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="busyAction === 'discover'"
            @click="runAction('discover', () => api('/api/conversations/discover', {}, 'POST'), '已刷新 QQ 与微信会话')"
          >
            刷新 QQ 会话
          </button>
          <button class="btn btn-ghost btn-sm" @click="$emit('navigate', 'conversations')">管理关注的群</button>
        </div>

        <details class="legacy-qq">
          <summary class="muted">高级：无桌面 QQ 时的独立采集选项（NapCat）</summary>
          <div class="legacy-qq-body">
            <p class="muted">平时开着电脑 QQ 时不需要开启此项；仅当你想关闭电脑 QQ 并在后台挂机采集或发 QQ 消息时才使用。</p>
            <p v-if="state.qq?.account && state.qq?.mode !== 'local'" class="muted">
              免扫码账号：<strong class="num">{{ state.qq.account }}</strong>
              <button
                class="btn-link forget-link"
                :disabled="busyAction === 'qq-forget'"
                @click="runAction('qq-forget', () => api('/api/qq/account', {}, 'DELETE'), '已忘记账号，下次独立启动需重新扫码')"
              >
                忘记账号
              </button>
            </p>
            <div class="setting-actions">
              <button
                v-if="!state.qq?.keepRunning"
                class="btn btn-secondary btn-sm"
                :disabled="busyAction === 'qq-start'"
                @click="runAction('qq-start', () => api('/api/qq/start', {}, 'POST'), '已开启独立 QQ 采集')"
              >
                启动独立采集
              </button>
              <button
                v-else
                class="btn btn-danger btn-sm"
                :disabled="busyAction === 'qq-stop'"
                @click="runAction('qq-stop', () => api('/api/qq/stop', {}, 'POST'), '独立 QQ 采集已停止')"
              >
                停止独立采集
              </button>
              <a class="btn btn-ghost btn-sm" href="/qq-login" target="_blank" rel="noopener">独立扫码页 ↗</a>
            </div>
          </div>
        </details>
      </article>

      <!-- AI 模型配置 -->
      <article class="card setting-card">
        <div class="setting-head">
          <div class="setting-head-text">
            <h2 class="setting-title">AI 模型</h2>
            <p class="muted setting-sub">兼容 OpenAI 对话接口（/chat/completions）与 JSON 输出，保存后立即生效。</p>
          </div>
          <span class="badge" :class="state.model?.configured ? 'badge-pine' : state.model?.error ? 'badge-seal' : ''">
            {{ state.model?.configured ? '已配置' : state.model?.error ? '配置异常' : '未配置' }}
          </span>
        </div>

        <div v-if="state.model?.error" class="banner banner-err">
          <span>{{ state.model.error }}</span>
        </div>

        <form class="model-form" @submit.prevent="saveAI">
          <label class="toggle-check">
            <input v-model="modelForm.enabled" type="checkbox" @change="modelDirty = true" />
            <span>启用 AI 自动整理与通知助手</span>
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">服务预设</span>
              <select v-model="modelForm.preset" class="select" @change="onPresetChange">
                <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.label }}</option>
                <option value="custom">自定义兼容服务</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">模型名称</span>
              <input v-model="modelForm.name" class="input" placeholder="例如：deepseek-flash" @input="modelDirty = true" />
            </label>
          </div>

          <div class="field-row">
            <label class="field">
              <span class="field-label">接口地址（HTTPS 或本机地址）</span>
              <input v-model="modelForm.baseUrl" class="input" placeholder="https://api.deepseek.com" @input="modelDirty = true" />
            </label>
            <label class="field">
              <span class="field-label">API Key（{{ state.model?.hasKey ? '已保存，留空沿用' : '本机模型可留空' }}）</span>
              <input v-model="modelForm.key" type="password" class="input" autocomplete="off" placeholder="sk-..." @input="modelDirty = true" />
            </label>
          </div>

          <div v-if="testResult" class="banner banner-ok"><span>{{ testResult }}</span></div>
          <div v-if="testError" class="banner banner-err"><span>{{ testError }}</span></div>

          <div class="setting-actions">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="testingModel" @click="testAI">
              {{ testingModel ? '测试中…' : '测试连接' }}
            </button>
            <button type="submit" class="btn btn-primary btn-sm" :disabled="savingModel">
              {{ savingModel ? '保存中…' : '保存模型设置' }}
            </button>
          </div>
        </form>
      </article>

      <!-- 开机自启 -->
      <article class="card setting-card">
        <div class="setting-head">
          <div class="setting-head-text">
            <h2 class="setting-title">开机自启</h2>
            <p class="muted setting-sub">登录 Windows 后在后台自动启动讯课工作台并驻留系统托盘。</p>
          </div>
          <button
            class="btn btn-sm"
            :class="state.autostart ? 'btn-primary' : 'btn-secondary'"
            :disabled="busyAction === 'autostart'"
            @click="runAction('autostart', () => api('/api/autostart', { enabled: !state.autostart }, 'PUT'), r => r.autostart ? '已开启开机自启' : '已关闭开机自启')"
          >
            {{ state.autostart ? '已开启（点击关闭）' : '已关闭（点击开启）' }}
          </button>
        </div>
      </article>
    </div>

    <LogsPanel v-else-if="subTab === 'logs'" @toast="(m, k) => $emit('toast', m, k)" />

    <MaintenancePanel
      v-else
      @toast="(m, k) => $emit('toast', m, k)"
      @refresh="$emit('refresh')"
    />
  </section>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.conn-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.setting-head-text {
  min-width: 0;
  flex: 1;
}

.setting-title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 600;
}

.setting-sub {
  font-size: 13px;
  margin-top: 4px;
  line-height: 1.5;
}

.qq-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  padding-top: 4px;
  border-top: 1px solid var(--hairline);
}

.highlight-note {
  color: var(--ochre);
  font-weight: 500;
}

.forget-link {
  margin-left: 10px;
}

.legacy-qq {
  border-top: 1px solid var(--hairline);
  padding-top: 10px;
  font-size: 12.5px;
}

.legacy-qq summary {
  cursor: pointer;
  user-select: none;
}

.legacy-qq-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.setting-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.model-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toggle-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  cursor: pointer;
}
.toggle-check input { accent-color: var(--pine); }

@media (max-width: 640px) {
  .setting-head { flex-direction: column; align-items: flex-start; }
}
</style>
