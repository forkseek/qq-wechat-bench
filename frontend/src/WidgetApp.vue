<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { formatDue, sortPendingTasks, lunarHeading } from './utils/format.js';

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
const lunarText = lunarHeading();

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
    notify(`已勾销「${task.title}」`);
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
    notify('已落纸记下');
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

onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="slip-shell">
    <!-- 素宣便签顶眉（一缕细松柏线 + 朱印「讯」） -->
    <header class="slip-head">
      <div class="slip-brand">
        <span class="slip-seal">讯</span>
        <div>
          <div class="slip-title-row">
            <span class="slip-title">今日案头</span>
            <span class="slip-count num">{{ pendingTasks.length }}</span>
          </div>
          <p v-if="lunarText" class="slip-lunar">{{ lunarText }}</p>
        </div>
      </div>

      <div class="slip-tools">
        <span class="slip-dot" :title="qqOnline ? 'QQ 已连接' : 'QQ 未连接'">
          <span class="dot" :class="qqOnline ? 'dot-ok' : ''"></span>QQ
        </span>
        <span class="slip-dot" :title="wxOnline ? '微信已接入' : '微信未接入'">
          <span class="dot" :class="wxOnline ? 'dot-ok' : 'dot-warn'"></span>微
        </span>
        <button v-if="inDesktop" class="slip-icon" :class="{ active: pinned }" @click="togglePin" :title="pinned ? '取消置顶' : '窗口置顶'">
          📌
        </button>
        <button class="slip-icon" @click="openMain" title="展开主工作台">↗</button>
        <button v-if="inDesktop" class="slip-icon" @click="hideWidget" title="收起小窗">×</button>
      </div>
    </header>

    <!-- 线装宣纸便签正文 -->
    <div class="slip-body">
      <div v-if="error && !state" class="slip-empty muted">{{ error }}</div>
      <div v-else-if="!state" class="slip-empty muted">展卷中…</div>
      <div v-else-if="!pendingTasks.length" class="slip-empty">
        <span class="slip-zen-seal" aria-hidden="true">无事</span>
        <p class="slip-empty-title">案头清净</p>
        <p class="muted">下方可速记一条，群通知也会自动摘录至此。</p>
      </div>
      <ul v-else class="slip-list">
        <li v-for="task in pendingTasks" :key="task.id" class="slip-item" :class="{ overdue: formatDue(task).state === 'overdue' }">
          <button
            class="slip-check"
            :disabled="busyId === task.id"
            :aria-label="`完成 ${task.title}`"
            @click="complete(task)"
          ></button>
          <div class="slip-item-main">
            <div class="slip-item-title">
              <span>{{ task.title }}</span>
              <span v-if="formatDue(task).state === 'overdue'" class="slip-overdue-tag">逾期</span>
            </div>
            <div class="slip-item-meta">
              <span class="num" :class="`due-${formatDue(task).state}`">{{ formatDue(task).text }}</span>
              <span class="muted">· {{ task.conversationId ? (convMap.get(task.conversationId)?.title || '群通知') : '手记' }}</span>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="toastText" class="slip-toast">{{ toastText }}</div>

    <!-- 底部速记条 -->
    <form class="slip-add" @submit.prevent="quickAdd">
      <div class="slip-add-row">
        <input v-model="quickTitle" class="input slip-input" maxlength="180" placeholder="速记一条待办…" />
        <button type="button" class="btn btn-secondary btn-sm" @click="showDate = !showDate" title="设置截止日期">📅</button>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="adding || !quickTitle.trim()">记下</button>
      </div>
      <input v-if="showDate" v-model="quickDue" type="date" class="input slip-date" />
    </form>
  </div>
</template>

<style scoped>
.slip-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--paper-card);
  background-image:
    radial-gradient(ellipse 80% 45% at 95% 5%, var(--celadon-wash), transparent 70%);
  border-top: 2.5px solid var(--pine);
  color: var(--ink);
  overflow: hidden;
  position: relative;
}

.slip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 9px;
  border-bottom: 1px solid var(--hairline);
  background: rgba(249, 246, 238, 0.9);
  flex-shrink: 0;
}

.slip-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.slip-seal {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: var(--seal);
  color: #fdf8f2;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.slip-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.slip-title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

.slip-count {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--pine-wash);
  color: var(--pine);
  font-weight: 600;
}

.slip-lunar {
  font-size: 11px;
  color: var(--ink-3);
  line-height: 1.2;
}

.slip-tools {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.slip-dot {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--ink-2);
  white-space: nowrap;
}

.slip-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-2);
  font-size: 13px;
}
.slip-icon:hover { background: var(--paper-soft); color: var(--pine); }
.slip-icon.active { background: var(--pine-wash); color: var(--pine); }

.slip-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 12px;
}

.slip-empty {
  text-align: center;
  padding: 46px 14px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.slip-zen-seal {
  writing-mode: vertical-rl;
  font-family: var(--font-display);
  font-size: 14px;
  letter-spacing: 0.2em;
  padding: 7px 5px;
  border: 1px solid rgba(181, 54, 36, 0.55);
  border-radius: 2px;
  color: var(--seal);
  background: rgba(250, 236, 232, 0.45);
}

.slip-empty-title {
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: 0.08em;
  color: var(--ink);
}

.slip-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.slip-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--hairline);
}
.slip-item:last-child { border-bottom: 0; }
.slip-item.overdue { background: rgba(181, 54, 36, 0.035); margin: 0 -12px; padding: 10px 14px; }

.slip-check {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.5px solid var(--hairline-strong);
  margin-top: 2px;
  flex-shrink: 0;
  background: var(--paper-card);
}
.slip-check:hover { border-color: var(--pine); background: var(--pine-wash); }

.slip-item-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.slip-item-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.slip-overdue-tag {
  font-family: var(--font-display);
  font-size: 10.5px;
  padding: 0 4px;
  border: 1px solid var(--seal);
  border-radius: 2px;
  color: var(--seal);
  background: var(--seal-wash);
  white-space: nowrap;
}

.slip-item-meta {
  font-size: 11.5px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.due-overdue { color: var(--seal); font-weight: 600; }
.due-today { color: var(--ochre); font-weight: 600; }
.due-soon { color: var(--pine); }
.due-unknown { color: var(--ink-3); }

.slip-toast {
  padding: 5px 10px;
  font-size: 12px;
  text-align: center;
  background: var(--pine);
  color: #faf7f0;
}

.slip-add {
  padding: 9px 10px;
  border-top: 1px solid var(--hairline);
  background: var(--paper);
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.slip-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.slip-input { flex: 1; padding: 6px 9px; font-size: 13px; }
.slip-date { padding: 5px 8px; font-size: 12.5px; }
</style>
