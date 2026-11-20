<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { todayHeading } from './utils/format.js';
import StatusPills from './components/StatusPills.vue';
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
  (state.value?.tasks || []).filter(t => t.status === 'pending' && t.relevance !== 'other').length
);

const qqBanner = computed(() => {
  const qq = state.value?.qq;
  if (!qq || qq.online) return null;
  if (qq.blockedReason === 'desktop_in_use') {
    return {
      text: qq.pausedByDesktop
        ? '检测到桌面 QQ 正在运行，独立采集已临时暂停；关闭桌面 QQ 后将自动恢复并补拉消息。'
        : '检测到桌面 QQ 正在运行，已优先保护桌面登录。',
      action: null
    };
  }
  if (qq.keepRunning && qq.available && !qq.online) {
    return { text: 'QQ 采集等待扫码登录，请打开扫码页完成验证。', action: 'qr' };
  }
  if (!qq.keepRunning && (state.value?.capture?.groups?.length || 0) > 0) {
    return { text: 'QQ 采集当前已停止，暂不会收到新的 QQ 群消息。', action: 'start' };
  }
  return null;
});

async function refresh(silent = false) {
  try {
    // 非聊天页用 compact=1 只拉取已关注会话，避免每 5 秒传输 400+ 未关注群。
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
  } catch (err) {
    showToast('无法切换迷你小窗', 'error');
  }
}

onMounted(() => {
  refresh(false);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="shell">
    <!-- 左侧松柏墨绿导航栏 -->
    <aside class="rail">
      <a class="brand" href="/" @click.prevent="navigate('tasks')">
        <span class="brand-seal" aria-hidden="true">讯</span>
        <span class="brand-text">
          <strong class="brand-name">讯课</strong>
          <small class="brand-sub">QQ · 微信工作台</small>
        </span>
      </a>

      <nav class="rail-nav" aria-label="主导航">
        <button class="rail-item" :class="{ active: view === 'tasks' }" @click="navigate('tasks')">
          <span class="rail-icon" aria-hidden="true">◎</span>
          <span class="rail-label">待办清单</span>
          <span class="rail-count num" :class="{ 'has-items': pendingCount > 0 }">{{ pendingCount }}</span>
        </button>

        <button class="rail-item" :class="{ active: view === 'messages' }" @click="navigate('messages')">
          <span class="rail-icon" aria-hidden="true">▤</span>
          <span class="rail-label">聊天与消息</span>
        </button>

        <button class="rail-item" :class="{ active: view === 'conversations' }" @click="navigate('conversations')">
          <span class="rail-icon" aria-hidden="true">◇</span>
          <span class="rail-label">会话管理</span>
        </button>

        <button class="rail-item" :class="{ active: view === 'settings' }" @click="navigate('settings', 'connections')">
          <span class="rail-icon" aria-hidden="true">⚙</span>
          <span class="rail-label">设置与维护</span>
        </button>
      </nav>

      <div class="rail-footer">
        <button v-if="inDesktop" class="rail-action" @click="openMiniWidget">
          <span aria-hidden="true">◳</span>
          <span>迷你小窗</span>
        </button>
        <div class="rail-motto">
          <span>消息有出处 · 事情有着落</span>
        </div>
        <button class="profile-btn" @click="profileModalOpen = true">
          <span class="profile-avatar">我</span>
          <span class="profile-text">{{ state?.profile?.name || '我的信息与规则' }}</span>
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </aside>

    <!-- 右侧工作区 -->
    <section class="workspace">
      <header class="topbar">
        <div class="topbar-date">
          <span class="eyebrow">STUDY DESK</span>
          <span class="today-text">{{ todayHeading() }}</span>
        </div>
        <StatusPills
          v-if="state"
          :state="state"
          :assistant-open="assistantOpen"
          @navigate="v => navigate(v, 'connections')"
          @toggle-assistant="assistantOpen = !assistantOpen"
        />
      </header>

      <main class="main-body">
        <div v-if="loadError && !state" class="banner banner-err">
          <span>无法连接工作台服务：{{ loadError }}</span>
          <button class="btn btn-secondary btn-sm" @click="refresh(false)">重试</button>
        </div>

        <div v-else-if="!state" class="empty-state">
          <div class="empty-mark">◎</div>
          <p class="muted">正在打开讯课工作台…</p>
        </div>

        <template v-else>
          <div v-if="state.logging && !state.logging.ok" class="banner banner-err">
            <span>{{ state.logging.error }}</span>
          </div>

          <div v-if="qqBanner && view !== 'settings'" class="banner">
            <span class="banner-text">{{ qqBanner.text }}</span>
            <button v-if="qqBanner.action === 'start'" class="btn btn-secondary btn-sm" @click="quickStartQQ">启动采集</button>
            <a v-else-if="qqBanner.action === 'qr'" class="btn btn-secondary btn-sm" href="/qq-login" target="_blank" rel="noopener">去扫码 ↗</a>
          </div>

          <TasksView
            v-if="view === 'tasks'"
            :state="state"
            @refresh="refresh(true)"
            @open-task="id => { taskModal = { open: true, mode: 'edit', taskId: id }; }"
            @create-task="() => { taskModal = { open: true, mode: 'create', taskId: '' }; }"
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
      </main>
    </section>

    <!-- 通知助手侧滑抽屉 -->
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
.shell {
  display: flex;
  min-height: 100vh;
  overflow-x: clip;
}

.rail {
  width: 204px;
  flex-shrink: 0;
  background: var(--pine-rail);
  color: #f2ece0;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  gap: 18px;
  position: sticky;
  top: 0;
  height: 100vh;
  border-right: 1px solid #0f241b;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  color: #f7f3ea;
  text-decoration: none;
}
.brand:hover { text-decoration: none; }

.brand-seal {
  width: 34px;
  height: 34px;
  border-radius: 7px;
  background: var(--seal);
  color: #fdf8f2;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid rgba(255, 232, 224, 0.35);
  box-shadow: inset 0 0 0 2px rgba(255, 240, 234, 0.16);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-name {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.brand-sub {
  font-size: 11px;
  color: rgba(242, 236, 224, 0.62);
  margin-top: 2px;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rail-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  color: rgba(242, 236, 224, 0.8);
  font-size: 13.5px;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.rail-item:hover {
  background: rgba(255, 255, 255, 0.07);
  color: #fff;
}

.rail-item.active {
  background: var(--paper);
  color: var(--pine-deep);
  font-weight: 600;
}

.rail-icon { font-size: 15px; width: 18px; text-align: center; flex-shrink: 0; }
.rail-label { flex: 1; text-align: left; }

.rail-count {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(242, 236, 224, 0.85);
}

.rail-item.active .rail-count {
  background: var(--pine-wash);
  color: var(--pine);
}

.rail-count.has-items {
  background: var(--seal);
  color: #fff;
}

.rail-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rail-action {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(242, 236, 224, 0.2);
  color: #f2ece0;
  font-size: 13px;
  white-space: nowrap;
}
.rail-action:hover { background: rgba(255, 255, 255, 0.09); }

.rail-motto {
  font-size: 11.5px;
  color: rgba(242, 236, 224, 0.45);
  padding: 0 6px;
  letter-spacing: 0.05em;
}

.profile-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.06);
  color: #f2ece0;
  font-size: 13px;
}
.profile-btn:hover { background: rgba(255, 255, 255, 0.12); }

.profile-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(242, 236, 224, 0.16);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 13px;
  flex-shrink: 0;
}

.profile-text {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(247, 244, 237, 0.94);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--hairline);
  padding: 10px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.topbar-date {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.eyebrow {
  font-family: var(--font-num);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--ink-3);
  white-space: nowrap;
}

.today-text {
  font-size: 13px;
  color: var(--ink-2);
  white-space: nowrap;
}

.main-body {
  flex: 1;
  min-width: 0;
  padding: 20px 24px 28px;
  max-width: 1220px;
  width: 100%;
  margin: 0 auto;
}

/* 窄窗口（含 420x760 手机/侧栏小窗）响应式适配 */
@media (max-width: 720px) {
  .shell { flex-direction: column; }

  .rail {
    width: 100%;
    height: auto;
    position: sticky;
    top: 0;
    z-index: 30;
    padding: 10px 12px;
    gap: 10px;
    border-right: 0;
    border-bottom: 1px solid #0f241b;
  }

  .brand-sub, .rail-motto { display: none; }

  .rail-nav {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 4px;
  }

  .rail-item {
    flex-direction: column;
    gap: 2px;
    padding: 6px 4px;
    font-size: 11.5px;
    position: relative;
  }

  .rail-label { text-align: center; }

  .rail-count {
    position: absolute;
    top: 3px;
    right: 6px;
    padding: 0 5px;
    font-size: 10px;
  }

  .rail-footer {
    flex-direction: row;
    margin-top: 0;
    justify-content: flex-end;
    display: none;
  }

  .topbar {
    position: static;
    padding: 8px 14px;
  }

  .main-body {
    padding: 14px;
  }
}
</style>
