<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
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
  <div class="desk-shell">
    <!-- 顶部书眉雅栏（去除了厚重侧边栏，全宣纸通透视野） -->
    <header class="masthead">
      <div class="masthead-inner">
        <div class="mast-left">
          <a class="brand" href="/" @click.prevent="navigate('tasks')">
            <span class="seal-mark" aria-hidden="true">讯</span>
            <span class="brand-word">讯课</span>
          </a>

          <span class="mast-divider" aria-hidden="true"></span>

          <nav class="chapter-nav" aria-label="主导航">
            <button class="chapter-tab" :class="{ active: view === 'tasks' }" @click="navigate('tasks')">
              <span>待办</span>
              <span v-if="pendingCount > 0" class="tab-badge num">{{ pendingCount }}</span>
            </button>
            <button class="chapter-tab" :class="{ active: view === 'messages' }" @click="navigate('messages')">
              <span>消息</span>
            </button>
            <button class="chapter-tab" :class="{ active: view === 'conversations' }" @click="navigate('conversations')">
              <span>会话</span>
            </button>
            <button class="chapter-tab" :class="{ active: view === 'settings' }" @click="navigate('settings', 'connections')">
              <span>设置</span>
            </button>
          </nav>
        </div>

        <div class="mast-right">
          <StatusPills
            v-if="state"
            :state="state"
            :assistant-open="assistantOpen"
            @navigate="v => navigate(v, 'connections')"
            @toggle-assistant="assistantOpen = !assistantOpen"
          />
          <button v-if="inDesktop" class="icon-action" @click="openMiniWidget" title="显示 / 隐藏迷你待办小窗">
            ◳
          </button>
          <button class="profile-seal" @click="profileModalOpen = true" :title="state?.profile?.name ? `我的信息与规则（${state.profile.name}）` : '我的信息与规则'">
            我
          </button>
        </div>
      </div>
    </header>

    <!-- 主卷工作区 -->
    <main class="desk-main" :class="{ 'desk-wide': view === 'messages' }">
      <div v-if="loadError && !state" class="banner banner-err">
        <span>无法连接工作台服务：{{ loadError }}</span>
        <button class="btn btn-secondary btn-sm" @click="refresh(false)">重试</button>
      </div>

      <div v-else-if="!state" class="empty-state">
        <div class="empty-mark">讯</div>
        <p class="muted">展卷中…</p>
      </div>

      <template v-else>
        <div v-if="state.logging && !state.logging.ok" class="banner banner-err">
          <span>{{ state.logging.error }}</span>
        </div>

        <div v-if="qqBanner && view !== 'settings'" class="quiet-notice">
          <span class="notice-dot" aria-hidden="true"></span>
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
.desk-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow-x: clip;
}

/* 顶部书眉雅栏：通透素宣 + 顶部一缕极细朱砂边线 */
.masthead {
  position: sticky;
  top: 0;
  z-index: 30;
  background: rgba(249, 246, 238, 0.88);
  backdrop-filter: blur(12px);
  border-top: 2px solid var(--pine);
  border-bottom: 1px solid var(--hairline);
}

.masthead-inner {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 28px;
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.mast-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--ink);
  text-decoration: none;
  flex-shrink: 0;
}
.brand:hover { text-decoration: none; }

.seal-mark {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  border: 1.5px solid var(--seal);
  background: var(--seal);
  color: #fdf8f2;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 0 1.5px rgba(255, 245, 240, 0.25);
}

.brand-word {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--ink);
}

.mast-divider {
  width: 1px;
  height: 18px;
  background: var(--hairline-strong);
  flex-shrink: 0;
}

.chapter-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.chapter-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 15px 13px;
  font-size: 14px;
  color: var(--ink-2);
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.15s;
}

.chapter-tab:hover { color: var(--ink); }

.chapter-tab.active {
  color: var(--pine);
  font-weight: 600;
}

.chapter-tab.active::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 2px;
  background: var(--seal);
  border-radius: 2px 2px 0 0;
}

.tab-badge {
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--seal);
  color: #fff;
}

.mast-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.icon-action {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--hairline);
  background: var(--paper-card);
  color: var(--ink-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  transition: border-color 0.15s, color 0.15s;
}
.icon-action:hover { border-color: var(--pine-border); color: var(--pine); }

.profile-seal {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--hairline-strong);
  background: var(--paper-card);
  color: var(--pine);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.profile-seal:hover {
  background: var(--pine);
  border-color: var(--pine);
  color: #faf7f0;
}

/* 居中留白主卷 */
.desk-main {
  flex: 1;
  width: 100%;
  max-width: 960px;
  min-width: 0;
  margin: 0 auto;
  padding: 26px 28px 44px;
}

.desk-main.desk-wide {
  max-width: 1180px;
  padding: 18px 28px 24px;
}

/* 轻量低噪提示条（替代刺眼的整块大黄横幅） */
.quiet-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  margin-bottom: 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: rgba(255, 253, 248, 0.72);
  font-size: 12.5px;
  color: var(--ink-2);
  flex-wrap: wrap;
}

.notice-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ochre);
  flex-shrink: 0;
}

.notice-text { flex: 1; min-width: 180px; }

@media (max-width: 780px) {
  .masthead-inner {
    padding: 8px 14px;
    gap: 8px;
  }
  .mast-divider { display: none; }
  .mast-left {
    width: 100%;
    justify-content: space-between;
  }
  .chapter-tab {
    padding: 8px 10px;
    font-size: 13.5px;
  }
  .mast-right {
    width: 100%;
    justify-content: space-between;
    padding-top: 6px;
    border-top: 1px solid var(--hairline);
  }
  .desk-main, .desk-main.desk-wide {
    padding: 16px 14px 28px;
  }
}
</style>
