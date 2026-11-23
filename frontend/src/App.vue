<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { isStaleHistoricalTask, inferTaskObligation } from './utils/format.js';
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

const activePendingTasks = computed(() =>
  (state.value?.tasks || []).filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t))
);

const pendingCount = computed(() => activePendingTasks.value.length);

const requiredPendingCount = computed(() =>
  activePendingTasks.value.filter(t => inferTaskObligation(t) === 'required').length
);

const optionalPendingCount = computed(() =>
  activePendingTasks.value.filter(t => inferTaskObligation(t) === 'optional').length
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
    <!-- 左侧手绘手账活页导航栏 -->
    <aside class="sketch-sidebar" aria-label="主导航">
      <div class="sidebar-top">
        <a class="brand" href="/" @click.prevent="navigate('tasks')">
          <span class="brand-doodle" aria-hidden="true">
            <span class="brand-doodle-char">讯</span>
          </span>
          <div class="brand-meta">
            <span class="brand-name">讯课手账</span>
            <svg class="brand-wave" viewBox="0 0 90 10" fill="none" aria-hidden="true">
              <path d="M2 6 C14 1, 24 9, 38 5 C52 1, 64 9, 88 4" stroke="#6d28d9" stroke-width="2.2" stroke-linecap="round" />
            </svg>
          </div>
        </a>
      </div>

      <div class="sidebar-scroll">
        <div class="nav-group">
          <div class="nav-group-label">✎ 目录索引</div>
          <nav class="nav-list">
            <button
              class="nav-item"
              :class="{ active: view === 'tasks' }"
              :title="`必做事项 ${requiredPendingCount} 项，普通通知 ${optionalPendingCount} 条`"
              @click="navigate('tasks')"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 5.5C4 4.5 5 4 7 4h10c2 0 3 .7 3 2v12c0 1.5-.8 2-2.5 2H6.5C4.8 20 4 19.3 4 18V5.5z" />
                <path d="M8.5 9.5l2 2 4.5-4.5" />
                <path d="M8.5 15.5h7" />
              </svg>
              <span class="nav-label">待办清单</span>
              <span v-if="requiredPendingCount > 0" class="nav-pill pill-hot num" title="必做事项">{{ requiredPendingCount }}</span>
              <span v-else-if="optionalPendingCount > 0" class="nav-pill num" title="普通通知">{{ optionalPendingCount }}</span>
            </button>

            <button class="nav-item" :class="{ active: view === 'messages' }" @click="navigate('messages')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 6.5C4 5 5.2 4 7 4h10c1.8 0 3 1 3 2.5v7.5c0 1.8-1.2 2.5-3 2.5h-6.5L5.5 20v-3.5H7C5.2 16.5 4 15.5 4 14V6.5z" />
                <path d="M8.5 9.5h7M8.5 13h4.5" />
              </svg>
              <span class="nav-label">群聊消息</span>
            </button>

            <button class="nav-item" :class="{ active: view === 'conversations' }" @click="navigate('conversations')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="9" cy="8" r="3.5" />
                <path d="M3 19c.6-3.2 2.8-5 6-5s5.4 1.8 6 5" />
                <circle cx="17" cy="9" r="2.5" />
                <path d="M16.5 14.5c2.2.4 3.8 1.8 4.3 4.5" />
              </svg>
              <span class="nav-label">关注群组</span>
              <span v-if="monitoredCount > 0" class="nav-pill num">{{ monitoredCount }}</span>
            </button>

            <button class="nav-item" :class="{ active: view === 'settings' }" @click="navigate('settings', 'connections')">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
              </svg>
              <span class="nav-label">设置与维护</span>
            </button>
          </nav>
        </div>

        <div class="nav-group">
          <div class="nav-group-label">★ 随手工具</div>
          <div class="nav-list">
            <button
              v-if="state?.model?.configured"
              class="nav-item ai-nav-item"
              :class="{ active: assistantOpen }"
              @click="assistantOpen = !assistantOpen"
            >
              <span class="ai-spark" aria-hidden="true">✦</span>
              <span class="nav-label">AI 小助手</span>
              <span class="nav-pill pill-lav">问答</span>
            </button>

            <button v-if="inDesktop" class="nav-item" @click="openMiniWidget">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 5h16v14H4z" />
                <path d="M12 11h6v6h-6z" />
              </svg>
              <span class="nav-label">桌面小便签</span>
            </button>

            <button class="nav-item" @click="profileModalOpen = true">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="3.8" />
                <path d="M5 20c1-3.8 3.4-5.5 7-5.5s6 1.7 7 5.5" />
              </svg>
              <span class="nav-label">{{ state?.profile?.name ? `规则 · ${state.profile.name}` : '我的身份与规则' }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 底部胶带手绘状态便签 -->
      <div v-if="state" class="sidebar-sticky-note">
        <span class="washi-tape" aria-hidden="true"></span>
        <div class="sticky-note-title">连线小纸条</div>
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

    <!-- 右侧手账主纸页 -->
    <main class="workspace-main">
      <div class="workspace-inner" :class="{ 'workspace-wide': view === 'messages' }">
        <div v-if="loadError && !state" class="banner banner-err">
          <span>无法连接工作台服务：{{ loadError }}</span>
          <button class="btn btn-secondary btn-sm" @click="refresh(false)">重试</button>
        </div>

        <div v-else-if="!state" class="empty-state">
          <div class="empty-mark">讯</div>
          <p class="muted">正在翻开手账本…</p>
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

/* 左侧手账活页侧栏 */
.sketch-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 16px 18px;
  background-color: var(--glass-sidebar);
  background-image:
    repeating-linear-gradient(
      180deg,
      transparent 0px,
      transparent 38px,
      rgba(180, 165, 138, 0.25) 38px,
      rgba(180, 165, 138, 0.25) 39px
    );
  border-right: 2.5px solid var(--stroke);
  z-index: 30;
}

/* 活页装订孔装饰边 */
.sketch-sidebar::after {
  content: "";
  position: absolute;
  top: 18px;
  bottom: 18px;
  right: -7px;
  width: 12px;
  background-image: radial-gradient(circle at center, var(--bg) 4px, var(--stroke) 4.2px, var(--stroke) 5.5px, transparent 5.8px);
  background-size: 12px 34px;
  background-repeat: repeat-y;
  pointer-events: none;
}

.sidebar-top {
  padding: 2px 4px 16px;
  border-bottom: 2px dashed var(--hairline);
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

.brand-doodle {
  width: 40px;
  height: 40px;
  border-radius: var(--sketch-radius-sm);
  border: 2.2px solid var(--stroke);
  background: var(--marker-yellow);
  box-shadow: 3px 3px 0 var(--stroke);
  transform: rotate(-4deg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.brand-doodle-char {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1;
}

.brand-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.brand-name {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.1;
}

.brand-wave {
  width: 78px;
  height: 9px;
}

.sidebar-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-right: 4px;
}

.nav-group { display: flex; flex-direction: column; gap: 6px; }

.nav-group-label {
  padding: 0 8px;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-3);
  letter-spacing: 0.04em;
}

.nav-list { display: flex; flex-direction: column; gap: 5px; }

.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border-radius: var(--sketch-radius-sm);
  border: 2px solid transparent;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink-2);
  text-align: left;
  transition: all 0.14s var(--ease);
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.72);
  border-color: var(--stroke);
  color: var(--ink);
  box-shadow: 2px 2px 0 var(--stroke);
}

.nav-item.active {
  background: var(--marker-yellow);
  border-color: var(--stroke);
  color: var(--ink);
  font-weight: 700;
  box-shadow: 3px 3px 0 var(--stroke);
  transform: rotate(-0.5deg);
}

.nav-icon { width: 17px; height: 17px; flex-shrink: 0; }
.nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.nav-pill {
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 7px;
  border-radius: var(--sketch-radius-pill);
  border: 1.5px solid var(--stroke);
  background: #ffffff;
  color: var(--ink);
}
.nav-pill.pill-hot {
  background: var(--marker-rose);
  color: var(--seal);
}
.nav-pill.pill-lav {
  background: var(--marker-lavender);
  color: var(--pine);
}

.ai-nav-item {
  background: rgba(237, 233, 254, 0.55);
  border: 1.5px dashed var(--stroke);
}
.ai-nav-item.active {
  background: var(--marker-lavender);
  border-style: solid;
}
.ai-spark { width: 17px; text-align: center; color: var(--pine); font-size: 15px; flex-shrink: 0; }

/* 底部手绘便利贴状态栏 */
.sidebar-sticky-note {
  position: relative;
  margin-top: 16px;
  padding: 14px 11px 10px;
  border-radius: var(--sketch-radius-sm);
  border: 2px solid var(--stroke);
  background: #fffbeb;
  box-shadow: 3.5px 3.5px 0 var(--stroke);
  transform: rotate(-0.8deg);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.washi-tape {
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%) rotate(2deg);
  width: 54px;
  height: 15px;
  background: rgba(147, 197, 253, 0.72);
  border: 1.5px solid rgba(35, 33, 30, 0.35);
  pointer-events: none;
}

.sticky-note-title {
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink-3);
  text-align: center;
  margin-bottom: 3px;
  border-bottom: 1.5px dashed var(--hairline);
  padding-bottom: 4px;
}

.telemetry-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12px;
  transition: background 0.14s;
}
.telemetry-row:hover { background: var(--marker-yellow); }

.tel-left { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; color: var(--ink); }
.tel-val { color: var(--ink-3); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tel-val.online { color: var(--ink-2); font-weight: 600; }

/* 右侧手账主区 */
.workspace-main { flex: 1; min-width: 0; min-height: 100vh; }

.workspace-inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 26px 34px 48px;
}

.workspace-inner.workspace-wide {
  max-width: 1240px;
  padding: 20px 28px 24px;
}

.quiet-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  margin-bottom: 18px;
  border-radius: var(--sketch-radius-sm);
  border: 2px solid var(--stroke);
  background: var(--ochre-wash);
  box-shadow: 3px 3px 0 var(--stroke);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  flex-wrap: wrap;
}
.notice-text { flex: 1; min-width: 180px; }

@media (max-width: 860px) {
  .desktop-shell { flex-direction: column; }
  .sketch-sidebar {
    position: sticky;
    top: 0;
    height: auto;
    width: 100%;
    padding: 10px 14px;
    border-right: 0;
    border-bottom: 2.5px solid var(--stroke);
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .sketch-sidebar::after { display: none; }
  .sidebar-top { padding: 0; margin: 0; border: 0; }
  .brand-wave, .nav-group-label, .sidebar-sticky-note { display: none; }
  .sidebar-scroll { flex-direction: row; align-items: center; gap: 8px; overflow: visible; padding-right: 0; }
  .nav-list { flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .nav-item { width: auto; padding: 6px 10px; font-size: 12.5px; }
  .workspace-inner, .workspace-inner.workspace-wide { padding: 16px 14px 28px; }
}
</style>
