<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { formatDue, sortPendingTasks } from './utils/format.js';

const state = ref(null);
const error = ref('');
const pinned = ref(true);
const quickTitle = ref('');
const quickDue = ref('');
const adding = ref(false);
const busyId = ref('');
const showDate = ref(false);
const toastText = ref('');
let timer = null;
let toastTimer = null;

const inDesktop = computed(() => typeof window !== 'undefined' && Boolean(window.pywebview?.api));
const convMap = computed(() => new Map((state.value?.conversations || []).map(c => [c.id, c])));

const pendingTasks = computed(() =>
  sortPendingTasks((state.value?.tasks || []).filter(t => t.status === 'pending' && t.relevance !== 'other'))
);

const qqOnline = computed(() => Boolean(state.value?.qq?.online));
const wxOnline = computed(() => Boolean(state.value?.wechat?.online));

function notify(msg) {
  toastText.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, 2400);
}

async function refresh() {
  try {
    state.value = await api('/api/state?compact=1');
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

async function complete(task) {
  busyId.value = task.id;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
      revision: task.revision,
      status: 'done',
      needsReview: false
    }, 'PATCH');
    notify(`已完成「${task.title}」`);
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    busyId.value = '';
  }
}

async function quickAdd() {
  const title = quickTitle.value.trim();
  if (!title || adding.value) return;
  adding.value = true;
  try {
    await api('/api/tasks', {
      title,
      dueDate: quickDue.value || null,
      relevance: 'mine',
      status: 'pending'
    }, 'POST');
    quickTitle.value = '';
    quickDue.value = '';
    showDate.value = false;
    notify('已添加待办');
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    adding.value = false;
  }
}

async function togglePin() {
  pinned.value = !pinned.value;
  try { await window.pywebview?.api?.set_widget_on_top(pinned.value); } catch { /* ignore */ }
}

async function openMain() {
  if (inDesktop.value) {
    try { await window.pywebview.api.show_main(); } catch { /* ignore */ }
  } else {
    window.open('/', '_blank', 'noopener');
  }
}

async function hideWidget() {
  try { await window.pywebview?.api?.hide_widget(); } catch { /* ignore */ }
}

onMounted(() => {
  refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, 6000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="widget-shell">
    <header class="w-head">
      <div class="w-brand">
        <span class="w-seal">讯</span>
        <span class="w-title">今日待办</span>
        <span class="w-count num">{{ pendingTasks.length }}</span>
      </div>
      <div class="w-tools">
        <span class="w-dot-pill" :title="qqOnline ? 'QQ 已连接' : 'QQ 未连接'">
          <span class="dot" :class="qqOnline ? 'dot-ok' : ''"></span>QQ
        </span>
        <span class="w-dot-pill" :title="wxOnline ? '微信已接入' : '微信未接入'">
          <span class="dot" :class="wxOnline ? 'dot-ok' : 'dot-warn'"></span>微信
        </span>
        <button v-if="inDesktop" class="w-icon-btn" :class="{ active: pinned }" @click="togglePin" :title="pinned ? '取消置顶' : '窗口置顶'">
          📌
        </button>
        <button class="w-icon-btn" @click="openMain" title="打开主工作台">↗</button>
        <button v-if="inDesktop" class="w-icon-btn" @click="hideWidget" title="收起小窗">×</button>
      </div>
    </header>

    <div class="w-body">
      <div v-if="error && !state" class="w-empty muted">{{ error }}</div>
      <div v-else-if="!state" class="w-empty muted">加载中…</div>
      <div v-else-if="!pendingTasks.length" class="w-empty">
        <p class="w-empty-title">暂无未完成待办</p>
        <p class="muted">下方可直接记一条，或等待群通知自动整理。</p>
      </div>
      <ul v-else class="w-list">
        <li v-for="task in pendingTasks" :key="task.id" class="w-item" :class="{ overdue: formatDue(task).state === 'overdue' }">
          <button
            class="w-check"
            :disabled="busyId === task.id"
            :aria-label="`完成 ${task.title}`"
            @click="complete(task)"
          ></button>
          <div class="w-item-main">
            <div class="w-item-title">
              <span>{{ task.title }}</span>
              <span v-if="formatDue(task).state === 'overdue'" class="w-seal-tag">逾期</span>
            </div>
            <div class="w-item-meta">
              <span class="num" :class="`due-${formatDue(task).state}`">{{ formatDue(task).text }}</span>
              <span class="muted">· {{ task.conversationId ? (convMap.get(task.conversationId)?.title || '群通知') : '手动' }}</span>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="toastText" class="w-toast">{{ toastText }}</div>

    <form class="w-add" @submit.prevent="quickAdd">
      <div class="w-add-row">
        <input v-model="quickTitle" class="input w-input" maxlength="180" placeholder="快速记一条待办…" />
        <button type="button" class="btn btn-secondary btn-sm" @click="showDate = !showDate" title="设置截止日期">📅</button>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="adding || !quickTitle.trim()">添加</button>
      </div>
      <input v-if="showDate" v-model="quickDue" type="date" class="input w-date" />
    </form>
  </div>
</template>

<style scoped>
.widget-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--paper);
  color: var(--ink);
  overflow: hidden;
}

.w-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  background: var(--pine-rail);
  color: #f4efe4;
  flex-shrink: 0;
}

.w-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.w-seal {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: var(--seal);
  color: #fff;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.w-title {
  font-family: var(--font-display);
  font-size: 16px;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.w-count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
}

.w-tools {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.w-dot-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: rgba(244, 239, 228, 0.85);
  white-space: nowrap;
}

.w-icon-btn {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(244, 239, 228, 0.82);
  font-size: 13px;
}
.w-icon-btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.w-icon-btn.active { background: rgba(255, 255, 255, 0.22); color: #fff; }

.w-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
}

.w-empty {
  text-align: center;
  padding: 36px 12px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.w-empty-title { font-family: var(--font-display); font-size: 16px; color: var(--ink); }

.w-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.w-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  background: var(--paper-card);
  border: 1px solid var(--hairline);
}
.w-item.overdue { border-color: var(--seal-border); background: #fdf6f4; }

.w-check {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.5px solid var(--hairline-strong);
  margin-top: 2px;
  flex-shrink: 0;
  background: #fff;
}
.w-check:hover { border-color: var(--pine); background: var(--pine-wash); }

.w-item-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.w-item-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.w-seal-tag {
  font-family: var(--font-display);
  font-size: 10.5px;
  padding: 0 4px;
  border: 1px solid var(--seal);
  border-radius: 3px;
  color: var(--seal);
  background: var(--seal-wash);
  white-space: nowrap;
}

.w-item-meta {
  font-size: 11.5px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.due-overdue { color: var(--seal); font-weight: 600; }
.due-today { color: var(--ochre); font-weight: 600; }
.due-soon { color: var(--pine); }
.due-unknown { color: var(--ink-3); }

.w-toast {
  padding: 5px 10px;
  font-size: 12px;
  text-align: center;
  background: var(--pine);
  color: #fff;
}

.w-add {
  padding: 8px 10px;
  border-top: 1px solid var(--hairline);
  background: var(--paper-card);
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.w-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.w-input { flex: 1; padding: 6px 9px; font-size: 13px; }
.w-date { padding: 5px 8px; font-size: 12.5px; }
</style>
