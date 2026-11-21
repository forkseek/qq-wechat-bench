<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { isStaleHistoricalTask } from './utils/format.js';
import AssistantDrawer from './components/AssistantDrawer.vue';
import TaskDetailModal from './components/TaskDetailModal.vue';
import ProfileModal from './components/ProfileModal.vue';
import ConvRulesModal from './components/ConvRulesModal.vue';
import AddGroupModal from './components/AddGroupModal.vue';
import ToastHost from './components/ToastHost.vue';
import TasksView from './views/TasksView.vue';
import MessagesView from './views/MessagesView.vue';
import ConversationsView from './views/ConversationsView.vue';
import SettingsView from './views/SettingsView.vue';

function parseRoute() {
  const v = new URLSearchParams(window.location.search).get('view') || 'tasks';
  if (v === 'logs') return { view: 'settings', subTab: 'logs' };
  if (v === 'maintenance') return { view: 'settings', subTab: 'maintenance' };
  if (['tasks', 'messages', 'conversations', 'settings'].includes(v)) return { view: v, subTab: 'connections' };
  return { view: 'tasks', subTab: 'connections' };
}

const initial = parseRoute();
const view = ref(initial.view);
const settingsSubTab = ref(initial.subTab);
const messageConvId = ref('');
const state = ref(null);
const loadError = ref('');
const assistantOpen = ref(false);
const toasts = ref([]);

const taskModal = ref({ open: false, mode: 'edit', taskId: '' });
const profileModalOpen = ref(false);
const rulesModalConv = ref(null);
const addGroupModalOpen = ref(false);

const inDesktop = computed(() => typeof window !== 'undefined' && Boolean(window.pywebview?.api));

let pollTimer = null;
let toastSeq = 0;

function showToast(text, kind = 'info') {
  const id = ++toastSeq;
  toasts.value.push({ id, text, kind });
  setTimeout(() => {
    toasts.value = toasts.value.filter(item => item.id !== id);
  }, 3600);
}

const pendingCount = computed(() =>
  (state.value?.tasks || []).filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t)).length
);

const monitoredCount = computed(() =>
  (state.value?.conversations || []).filter(c => c.monitored).length
);

const qqLive = computed(() => {
  const qq = state.value?.qq || {};
  if (qq.online) return { text: qq.name || '已直连', dot: qq.degraded ? 'dot-warn' : 'dot-ok', active: true };
  if (qq.blockedReason === 'desktop_in_use') return { text: '识别中', dot: 'dot-warn', active: false };
  return { text: '未连接', dot: '', active: false };
});

const wxLive = computed(() => {
  const wx = state.value?.wechat || {};
  if (wx.online) return { text: wx.name || '已直连', dot: wx.degraded ? 'dot-warn' : 'dot-ok', active: true };
  if (wx.phase === 'client_closed') return { text: '未打开', dot: '', active: false };
  return { text: '等待登录', dot: 'dot-warn', active: false };
});

const aiLive = computed(() => {
  const m = state.value?.model || {};
  if (m.configured) return { text: m.name || '已就绪', dot: 'dot-ok', active: true };
  if (m.error) return { text: '配置异常', dot: 'dot-err', active: false };
  return { text: '未配置', dot: '', active: false };
});

const qqBanner = computed(() => {
  const qq = state.value?.qq;
  if (!qq || qq.online) return null;
  if (qq.blockedReason === 'desktop_in_use') {
    return {
      text: qq.pausedByDesktop
        ? '桌面 QQ 运行中，独立采集已临时暂停；关闭桌面 QQ 后自动恢复并补拉。'
        : '检测到桌面 QQ 正在运行，已优先保护桌面登录。',
      action: null
    };
  }
  if (qq.keepRunning && qq.available && !qq.online) {
    return { text: 'QQ 采集等待扫码登录，请打开扫码页完成验证。', action: 'qr' };
  }
  if (!qq.keepRunning && (state.value?.capture?.groups?.length || 0) > 0) {
    return { text: 'QQ 采集当前未开启，暂不会收到新的 QQ 群消息。', action: 'start' };
  }
  return null;
});

async function refresh(silent = false) {
  try {
    const useCompact = view.value !== 'messages';
    const data = await api(useCompact ? '/api/state?compact=1' : '/api/state');
    state.value = data;
    loadError.value = '';
    const interval = data?.settings?.ui?.refreshIntervalMs || 5000;
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (!document.hidden) refresh(true);
      }, interval);
    }
  } catch (err) {
    if (!silent || !state.value) loadError.value = err.message;
  }
}

function navigate(targetView, subTab = null) {
  view.value = targetView;
  if (subTab) settingsSubTab.value = subTab;
  const queryView = targetView === 'settings' && settingsSubTab.value !== 'connections' ? settingsSubTab.value : targetView;
  const url = queryView === 'tasks' ? '/' : `/?view=${queryView}`;
  try { window.history.replaceState(null, '', url); } catch { /* ignore */ }
  if (targetView === 'messages') refresh(true);
}

function openMessagesFor(convId) {
  messageConvId.value = convId;
  navigate('messages');
}

async function quickStartQQ() {
  try {
    await api('/api/qq/start', {}, 'POST');
    showToast('已开启 QQ 采集');
    await refresh(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openMiniWidget() {
  try {
    await window.pywebview?.api?.toggle_widget();
  } catch {
    showToast('无法切换迷你小窗', 'error');
  }
}

onMounted(() => { refresh(false); });
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<template>
  <div class="desktop-shell">
    <!-- 左侧液态琉璃导航栏 -->
    <aside class="glass-sidebar" aria-label="主导航">
      <div class="sidebar-top">
        <a class="brand" href="/" @click.prevent="navigate('tasks')">
          <span class="brand-orb" aria-hidden="true">
            <span class="brand-orb-char">讯</span>
          </span>
          <div class="brand-meta">
            <span class="brand-name">讯课工作台</span>
            <span class="brand-tag">Obsidian · Studio</span>
          </div>
        </a>
      </div>

      <div class="sidebar-scroll">
        <div class="nav-group">
          <div class="nav-group-label">工作空间</div>
          <nav class="nav-list">
            <button class="nav-item" :class="{ active: view === 'tasks' }" @click="navigate('tasks')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M8 10h8M8 14h5" />
              </svg>
              <span class="nav-label">待办清单</span>
              <span v-if="pendingCount > 0" class="nav-pill pill-indigo num">{{ pendingCount }}</span>
            </button>

            <button class="nav-item" :class="{ active: view === 'messages' }" @click="navigate('messages')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span class="nav-label">群聊消息</span>
            </button>

            <button class="nav-item" :class="{ active: view === 'conversations' }" @click="navigate('conversations')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span class="nav-label">关注群组</span>
              <span v-if="monitoredCount > 0" class="nav-pill num">{{ monitoredCount }}</span>
            </button>

            <button class="nav-item" :class="{ active: view === 'settings' }" @click="navigate('settings', 'connections')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span class="nav-label">设置与维护</span>
            </button>
          </nav>
        </div>

        <div class="nav-group">
          <div class="nav-group-label">快捷工具</div>
          <div class="nav-list">
            <button
              v-if="state?.model?.configured"
              class="nav-item ai-nav-item"
              :class="{ active: assistantOpen }"
              @click="assistantOpen = !assistantOpen"
            >
              <span class="ai-spark" aria-hidden="true">✦</span>
              <span class="nav-label">AI 通知助手</span>
              <span class="nav-pill pill-cyan">对话</span>
            </button>

            <button v-if="inDesktop" class="nav-item" @click="openMiniWidget">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <rect x="11" y="11" width="7" height="7" rx="1" />
              </svg>
              <span class="nav-label">桌面迷你小窗</span>
            </button>

            <button class="nav-item" @click="profileModalOpen = true">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span class="nav-label">{{ state?.profile?.name ? `我的规则 · ${state.profile.name}` : '我的身份与规则' }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 底部实时连接状态舱 -->
      <div v-if="state" class="sidebar-telemetry">
        <button class="telemetry-row" @click="navigate('settings', 'connections')" title="查看 QQ 接入状态">
          <span class="tel-left">
            <span class="dot" :class="qqLive.dot"></span>
            <span class="tel-plat">QQ</span>
          </span>
          <span class="tel-val" :class="{ online: qqLive.active }">{{ qqLive.text }}</span>
        </button>

        <button class="telemetry-row" @click="navigate('settings', 'connections')" title="查看微信接入状态">
          <span class="tel-left">
            <span class="dot" :class="wxLive.dot"></span>
            <span class="tel-plat">微信</span>
          </span>
          <span class="tel-val" :class="{ online: wxLive.active }">{{ wxLive.text }}</span>
        </button>

        <button class="telemetry-row" @click="navigate('settings', 'connections')" title="查看 AI 模型状态">
          <span class="tel-left">
            <span class="dot" :class="aiLive.dot"></span>
            <span class="tel-plat">AI</span>
          </span>
          <span class="tel-val" :class="{ online: aiLive.active }">{{ aiLive.text }}</span>
        </button>
      </div>
    </aside>

    <!-- 右侧宽屏液态玻璃工作区 -->
    <main class="workspace-main">
      <div class="workspace-inner" :class="{ 'workspace-wide': view === 'messages' }">
        <div v-if="loadError && !state" class="banner banner-err">
          <span>无法连接工作台服务：{{ loadError }}</span>
          <button class="btn btn-secondary btn-sm" @click="refresh(false)">重试</button>
        </div>

        <div v-else-if="!state" class="empty-state">
          <div class="empty-mark">讯</div>
          <p class="muted">正在载入暗夜工作空间…</p>
        </div>

        <template v-else>
          <div v-if="state.logging && !state.logging.ok" class="banner banner-err">
            <span>{{ state.logging.error }}</span>
          </div>

          <div v-if="qqBanner && view !== 'settings'" class="quiet-notice">
            <span class="dot dot-warn" aria-hidden="true"></span>
            <span class="notice-text">{{ qqBanner.text }}</span>
            <button v-if="qqBanner.action === 'start'" class="btn-link" @click="quickStartQQ">开启采集</button>
            <a v-else-if="qqBanner.action === 'qr'" class="btn-link" href="/qq-login" target="_blank" rel="noopener">去扫码 ↗</a>
          </div>

          <TasksView
            v-if="view === 'tasks'"
            :state="state"
            @refresh="refresh(true)"
            @open-task="id => { taskModal = { open: true, mode: 'edit', taskId: id }; }"
            @create-task="() => { taskModal = { open: true, mode: 'create', taskId: '' }; }"
            @open-messages="openMessagesFor"
            @navigate="v => navigate(v, 'connections')"
            @toast="showToast"
          />

          <MessagesView
            v-else-if="view === 'messages'"
            :state="state"
            :initial-conversation-id="messageConvId"
            @refresh="refresh(true)"
            @toast="showToast"
          />

          <ConversationsView
            v-else-if="view === 'conversations'"
            :state="state"
            @refresh="refresh(true)"
            @open-rules="conv => { rulesModalConv = conv; }"
            @open-add="addGroupModalOpen = true"
            @open-messages="openMessagesFor"
            @toast="showToast"
          />

          <SettingsView
            v-else
            :state="state"
            :initial-sub-tab="settingsSubTab"
            @refresh="refresh(true)"
            @navigate="v => navigate(v)"
            @toast="showToast"
          />
        </template>
      </div>
    </main>

    <!-- 通知助手抽屉 -->
    <AssistantDrawer
      v-if="state?.model?.configured"
      :open="assistantOpen"
      :state="state"
      :pending-count="pendingCount"
      @close="assistantOpen = false"
      @toast="showToast"
    />

    <!-- 模态框 -->
    <TaskDetailModal
      v-if="taskModal.open"
      :task-id="taskModal.taskId"
      :mode="taskModal.mode"
      @close="taskModal.open = false"
      @saved="refresh(true)"
      @toast="showToast"
    />

    <ProfileModal
      v-if="profileModalOpen"
      :profile="state?.profile"
      @close="profileModalOpen = false"
      @saved="refresh(true)"
      @toast="showToast"
    />

    <ConvRulesModal
      v-if="rulesModalConv"
      :conversation="rulesModalConv"
      @close="rulesModalConv = null"
      @saved="refresh(true)"
      @toast="showToast"
    />

    <AddGroupModal
      v-if="addGroupModalOpen"
      @close="addGroupModalOpen = false"
      @saved="refresh(true)"
      @toast="showToast"
    />

    <ToastHost :items="toasts" />
  </div>
</template>

<style scoped>
.desktop-shell {
  min-height: 100vh;
  display: flex;
  overflow-x: clip;
}

/* 左侧液态琉璃导航栏 */
.glass-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  width: 244px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 14px 16px;
  background: var(--glass-sidebar);
  backdrop-filter: blur(26px) saturate(160%);
  border-right: 1px solid var(--hairline);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.03), 12px 0 36px -20px rgba(0, 0, 0, 0.65);
  z-index: 30;
}

.sidebar-top {
  padding: 2px 6px 18px;
  border-bottom: 1px solid var(--hairline);
  margin-bottom: 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  text-decoration: none;
  color: var(--ink);
}
.brand:hover { text-decoration: none; }

.brand-orb {
  width: 36px;
  height: 36px;
  border-radius: 11px;
  background: linear-gradient(135deg, #6366f1 0%, #3b82f6 52%, #14b8a6 100%);
  box-shadow: 0 6px 18px -4px rgba(99, 102, 241, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.45);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.brand-orb-char {
  font-size: 17px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 0.02em;
}

.brand-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.brand-name {
  font-size: 15.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: #ffffff;
  line-height: 1.2;
}

.brand-tag {
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.sidebar-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nav-group-label {
  padding: 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink-3);
  text-transform: uppercase;
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.nav-item {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ink-2);
  text-align: left;
  transition: all 0.16s var(--ease);
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--ink);
}

.nav-item.active {
  background: linear-gradient(90deg, rgba(99, 102, 241, 0.22) 0%, rgba(99, 102, 241, 0.08) 100%);
  color: #ffffff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(129, 140, 248, 0.28);
}

.nav-item.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: #818cf8;
  box-shadow: 0 0 10px rgba(129, 140, 248, 0.85);
}

.nav-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  opacity: 0.82;
}
.nav-item.active .nav-icon { opacity: 1; color: #a5b4fc; }

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-pill {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--ink-2);
}
.nav-pill.pill-indigo {
  background: rgba(99, 102, 241, 0.85);
  color: #ffffff;
  box-shadow: 0 0 12px rgba(99, 102, 241, 0.45);
}
.nav-pill.pill-cyan {
  background: rgba(45, 212, 191, 0.16);
  color: #5eead4;
  border: 1px solid rgba(45, 212, 191, 0.3);
}

.ai-nav-item {
  border: 1px solid rgba(129, 140, 248, 0.18);
  background: rgba(99, 102, 241, 0.06);
}
.ai-nav-item:hover {
  border-color: rgba(129, 140, 248, 0.36);
  background: rgba(99, 102, 241, 0.14);
}
.ai-spark {
  width: 16px;
  text-align: center;
  color: #38bdf8;
  font-size: 14px;
  flex-shrink: 0;
}

/* 底部实时状态舱 */
.sidebar-telemetry {
  margin-top: 14px;
  padding: 10px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--hairline);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.telemetry-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 7px;
  border-radius: 7px;
  font-size: 12px;
  transition: background 0.14s;
}
.telemetry-row:hover { background: rgba(255, 255, 255, 0.06); }

.tel-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-2);
  font-weight: 500;
}

.tel-val {
  color: var(--ink-3);
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tel-val.online { color: #cbd5e1; }

/* 右侧主工作区 */
.workspace-main {
  flex: 1;
  min-width: 0;
  min-height: 100vh;
}

.workspace-inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 28px 34px 48px;
}

.workspace-inner.workspace-wide {
  max-width: 1240px;
  padding: 22px 28px 24px;
}

.quiet-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  margin-bottom: 18px;
  border-radius: 10px;
  border: 1px solid var(--ochre-border);
  background: var(--ochre-wash);
  font-size: 12.5px;
  color: #fde68a;
  flex-wrap: wrap;
}
.notice-text { flex: 1; min-width: 180px; }

@media (max-width: 860px) {
  .desktop-shell { flex-direction: column; }
  .glass-sidebar {
    position: sticky;
    top: 0;
    height: auto;
    width: 100%;
    padding: 10px 14px;
    border-right: 0;
    border-bottom: 1px solid var(--hairline);
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .sidebar-top {
    padding: 0;
    margin: 0;
    border: 0;
  }
  .brand-tag, .nav-group-label, .sidebar-telemetry { display: none; }
  .sidebar-scroll {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    overflow: visible;
  }
  .nav-list { flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .nav-item { width: auto; padding: 6px 10px; font-size: 12.5px; }
  .nav-item.active::before { display: none; }
  .workspace-inner, .workspace-inner.workspace-wide { padding: 16px 14px 28px; }
}
</style>
