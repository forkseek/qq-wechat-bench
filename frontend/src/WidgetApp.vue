<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { formatDue, sortPendingTasks, lunarHeading, isStaleHistoricalTask } from './utils/format.js';

const state = ref(null);
const error = ref('');
const pinned = ref(true);
const quickTitle = ref('');
const quickDue = ref('');
const adding = ref(false);
const busyId = ref('');
const batchBusy = ref(false);
const showDate = ref(false);
const toastText = ref('');
const selectedIds = ref(new Set());
const undoAction = ref(null);
let timer = null;
let toastTimer = null;
let undoTimer = null;

const inDesktop = computed(() => typeof window !== 'undefined' && Boolean(window.pywebview?.api));
const convMap = computed(() => new Map((state.value?.conversations || []).map(c => [c.id, c])));
const lunarText = lunarHeading();

const pendingTasks = computed(() =>
  sortPendingTasks(
    (state.value?.tasks || []).filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t))
  )
);

const qqOnline = computed(() => Boolean(state.value?.qq?.online));
const wxOnline = computed(() => Boolean(state.value?.wechat?.online));

function notify(msg) {
  toastText.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, 2400);
}

function recordUndo(label, snapshots) {
  clearTimeout(undoTimer);
  undoAction.value = { label, snapshots };
  undoTimer = setTimeout(() => { undoAction.value = null; }, 9000);
}

async function performUndo() {
  const current = undoAction.value;
  if (!current || batchBusy.value) return;
  undoAction.value = null;
  clearTimeout(undoTimer);
  batchBusy.value = true;
  try {
    await refresh();
    const latestMap = new Map((state.value?.tasks || []).map(t => [t.id, t]));
    for (const snap of current.snapshots) {
      const latest = latestMap.get(snap.id);
      if (!latest) continue;
      await api(`/api/tasks/${encodeURIComponent(snap.id)}`, {
        revision: latest.revision,
        status: snap.status,
        needsReview: snap.needsReview
      }, 'PATCH');
    }
    notify('已撤销上一步');
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    batchBusy.value = false;
  }
}

async function refresh() {
  try {
    state.value = await api('/api/state?compact=1');
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

function toggleSelect(id) {
  const next = new Set(selectedIds.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selectedIds.value = next;
}

function clearSelection() {
  selectedIds.value = new Set();
}

async function setTaskStatus(task, targetStatus) {
  busyId.value = task.id;
  const prevSnap = [{ id: task.id, status: task.status, needsReview: Boolean(task.needsReview) }];
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
      revision: task.revision,
      status: targetStatus,
      needsReview: false
    }, 'PATCH');
    recordUndo(targetStatus === 'done' ? `已完成「${task.title}」` : `已忽略「${task.title}」`, prevSnap);
    if (selectedIds.value.has(task.id)) {
      const next = new Set(selectedIds.value);
      next.delete(task.id);
      selectedIds.value = next;
    }
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    busyId.value = '';
  }
}

async function batchUpdateStatus(targetStatus) {
  if (!selectedIds.value.size || batchBusy.value) return;
  batchBusy.value = true;
  try {
    const taskMap = new Map((state.value?.tasks || []).map(t => [t.id, t]));
    const targets = [...selectedIds.value].map(id => taskMap.get(id)).filter(Boolean);
    const snapshots = targets.map(t => ({ id: t.id, status: t.status, needsReview: Boolean(t.needsReview) }));
    for (const t of targets) {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
        revision: t.revision,
        status: targetStatus,
        needsReview: false
      }, 'PATCH');
    }
    selectedIds.value = new Set();
    recordUndo(`${targetStatus === 'done' ? '批量完成' : '批量忽略'} ${targets.length} 项`, snapshots);
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    batchBusy.value = false;
  }
}

async function batchDelete() {
  if (!selectedIds.value.size || batchBusy.value) return;
  batchBusy.value = true;
  try {
    const ids = [...selectedIds.value];
    for (const id of ids) {
      await api(`/api/tasks/${encodeURIComponent(id)}`, undefined, 'DELETE');
    }
    selectedIds.value = new Set();
    notify(`已删除 ${ids.length} 项`);
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    batchBusy.value = false;
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

onUnmounted(() => {
  if (timer) clearInterval(timer);
  clearTimeout(toastTimer);
  clearTimeout(undoTimer);
});
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

    <!-- 多选批量动作栏 -->
    <div v-if="selectedIds.size > 0" class="slip-sel-bar">
      <span class="slip-sel-count">已选 <strong class="num">{{ selectedIds.size }}</strong> 项</span>
      <div class="slip-sel-btns">
        <button type="button" class="slip-act-btn ok" :disabled="batchBusy" @click="batchUpdateStatus('done')">✓ 完成</button>
        <button type="button" class="slip-act-btn" :disabled="batchBusy" @click="batchUpdateStatus('cancelled')">× 忽略</button>
        <button type="button" class="slip-act-btn danger" :disabled="batchBusy" @click="batchDelete">删除</button>
        <button type="button" class="slip-act-btn" :disabled="batchBusy" @click="clearSelection">取消</button>
      </div>
    </div>

    <!-- 撤销提示栏 -->
    <div v-if="undoAction" class="slip-undo-bar">
      <span class="slip-undo-text">{{ undoAction.label }}</span>
      <button type="button" class="slip-undo-btn" :disabled="batchBusy" @click="performUndo">↶ 撤销</button>
    </div>

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
        <li
          v-for="task in pendingTasks"
          :key="task.id"
          class="slip-item"
          :class="{
            overdue: formatDue(task).state === 'overdue',
            selected: selectedIds.has(task.id)
          }"
        >
          <button
            type="button"
            class="slip-check"
            :class="{ checked: selectedIds.has(task.id) }"
            :aria-label="`选择 ${task.title}`"
            title="点击勾选（支持多选批量操作）"
            @click="toggleSelect(task.id)"
          >
            <span v-if="selectedIds.has(task.id)" class="slip-check-mark">✓</span>
          </button>
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
          <div class="slip-item-actions">
            <button
              type="button"
              class="slip-mini-btn ok"
              :disabled="busyId === task.id"
              title="标记完成"
              @click="setTaskStatus(task, 'done')"
            >
              完成
            </button>
            <button
              type="button"
              class="slip-mini-btn"
              :disabled="busyId === task.id"
              title="忽略此通知"
              @click="setTaskStatus(task, 'cancelled')"
            >
              忽略
            </button>
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
  background-color: var(--bg);
  background-image:
    radial-gradient(ellipse 85% 48% at 95% 4%, rgba(99, 102, 241, 0.16), transparent 70%),
    radial-gradient(ellipse 65% 42% at 6% 96%, rgba(20, 184, 166, 0.12), transparent 72%);
  border-top: 2px solid #6366f1;
  color: var(--ink);
  overflow: hidden;
  position: relative;
}

.slip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid var(--hairline);
  background: rgba(13, 18, 29, 0.85);
  backdrop-filter: blur(18px);
  flex-shrink: 0;
}

.slip-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.slip-seal {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: linear-gradient(135deg, #6366f1 0%, #3b82f6 55%, #14b8a6 100%);
  color: #ffffff;
  font-size: 13.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 3px 10px -2px rgba(99, 102, 241, 0.55);
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
  gap: 8px;
  flex-shrink: 0;
}

.slip-dot {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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

.slip-sel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  background: rgba(99, 102, 241, 0.16);
  border-bottom: 1px solid var(--pine-border);
  font-size: 11.5px;
  flex-shrink: 0;
}

.slip-sel-count { color: #c7d2fe; }
.slip-sel-btns { display: flex; align-items: center; gap: 4px; }

.slip-act-btn {
  padding: 2px 7px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong);
  background: rgba(255, 255, 255, 0.06);
  color: var(--ink-2);
}
.slip-act-btn:hover { border-color: var(--pine-border); color: #fff; }
.slip-act-btn.ok { background: #6366f1; border-color: #818cf8; color: #ffffff; }
.slip-act-btn.danger:hover { border-color: var(--seal); color: var(--seal); }

.slip-undo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: var(--ochre-wash);
  border-bottom: 1px solid var(--ochre-border);
  font-size: 11.5px;
  flex-shrink: 0;
}
.slip-undo-text { color: #fde68a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slip-undo-btn { color: #a5b4fc; font-weight: 600; white-space: nowrap; }

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
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 4px;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.14s;
}
.slip-item:hover { background: rgba(255, 255, 255, 0.045); margin: 0 -12px; padding: 11px 16px; }
.slip-item:last-child { border-bottom: 0; }
.slip-item.overdue { background: rgba(244, 63, 94, 0.08); margin: 0 -12px; padding: 11px 16px; border-left: 3px solid var(--seal); }
.slip-item.selected { background: rgba(99, 102, 241, 0.14); margin: 0 -12px; padding: 11px 16px; border-left: 3px solid #818cf8; }

.slip-check {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  margin-top: 2px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.04);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.slip-check:hover { border-color: #818cf8; background: var(--pine-wash); }
.slip-check.checked {
  border-color: #a5b4fc;
  background: #6366f1;
  color: #ffffff;
}
.slip-check-mark {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

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

.slip-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.slip-mini-btn {
  padding: 2px 7px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong);
  background: rgba(255, 255, 255, 0.05);
  color: var(--ink-2);
  white-space: nowrap;
}
.slip-mini-btn:hover { border-color: var(--seal-border); color: var(--seal); background: var(--seal-wash); }
.slip-mini-btn.ok:hover { border-color: var(--wx-border); background: var(--wx-wash); color: var(--wx); }

.due-overdue { color: #fda4af; font-weight: 600; }
.due-today { color: #fcd34d; font-weight: 600; }
.due-soon { color: #7dd3fc; }
.due-unknown { color: var(--ink-3); }

.slip-toast {
  padding: 6px 10px;
  font-size: 12px;
  text-align: center;
  background: #4f46e5;
  color: #ffffff;
}

.slip-add {
  padding: 9px 10px;
  border-top: 1px solid var(--hairline);
  background: rgba(11, 15, 24, 0.92);
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
