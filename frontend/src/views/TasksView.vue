<script setup>
import { ref, computed } from 'vue';
import { api } from '../api.js';
import { todayBeijing, datePlusDays, formatDue, formatTime, sortPendingTasks, relevanceLabel } from '../utils/format.js';

const props = defineProps({
  state: { type: Object, required: true }
});
const emit = defineEmits(['refresh', 'open-task', 'create-task', 'navigate', 'toast']);

const tab = ref('pending'); // 'pending' | 'review' | 'week' | 'done'
const query = ref('');
const selectedIds = ref(new Set());
const busyIds = ref(new Set());
const showMoreRuns = ref(false);
const showOther = ref(false);

const convMap = computed(() => new Map((props.state?.conversations || []).map(c => [c.id, c])));
const allTasks = computed(() => props.state?.tasks || []);
const activePending = computed(() => sortPendingTasks(allTasks.value.filter(t => t.status === 'pending' && t.relevance !== 'other')));
const otherPending = computed(() => sortPendingTasks(allTasks.value.filter(t => t.status === 'pending' && t.relevance === 'other')));
const doneTasks = computed(() => [...allTasks.value.filter(t => t.status === 'done')].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));

const stats = computed(() => {
  const today = todayBeijing();
  const in7 = datePlusDays(7);
  const list = activePending.value;
  return {
    pending: list.length,
    review: list.filter(t => t.needsReview).length,
    week: list.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7).length,
    overdue: list.filter(t => t.dueDate && t.dueDate < today).length
  };
});

const visibleTasks = computed(() => {
  const today = todayBeijing();
  const in7 = datePlusDays(7);
  let base;
  if (tab.value === 'done') base = doneTasks.value;
  else if (tab.value === 'review') base = activePending.value.filter(t => t.needsReview);
  else if (tab.value === 'week') base = activePending.value.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7);
  else base = activePending.value;

  const q = query.value.trim().toLowerCase();
  if (!q) return base;
  return base.filter(t => {
    const conv = convMap.value.get(t.conversationId);
    const hay = `${t.title || ''} ${t.description || ''} ${conv?.title || ''}`.toLowerCase();
    return hay.includes(q);
  });
});

const latestRun = computed(() => (props.state?.runs || [])[0] || null);
const olderRuns = computed(() => (props.state?.runs || []).slice(1));

function convTitle(task) {
  if (!task.conversationId) return '手动待办';
  return convMap.value.get(task.conversationId)?.title || '群通知';
}

function convPlatform(task) {
  if (!task.conversationId) return '';
  return convMap.value.get(task.conversationId)?.platform || 'qq';
}

function toggleSelect(id) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

async function toggleComplete(task) {
  const nextBusy = new Set(busyIds.value);
  nextBusy.add(task.id);
  busyIds.value = nextBusy;
  try {
    const nextStatus = task.status === 'done' ? 'pending' : 'done';
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
      revision: task.revision,
      status: nextStatus,
      needsReview: false
    }, 'PATCH');
    selectedIds.value.delete(task.id);
    emit('toast', nextStatus === 'done' ? `已完成「${task.title}」` : `已恢复「${task.title}」`);
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    const clean = new Set(busyIds.value);
    clean.delete(task.id);
    busyIds.value = clean;
  }
}

async function batchComplete() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  let ok = 0;
  for (const id of ids) {
    const task = allTasks.value.find(t => t.id === id);
    if (!task || task.status === 'done') continue;
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}`, { revision: task.revision, status: 'done', needsReview: false }, 'PATCH');
      ok++;
    } catch { /* 跳过冲突 */ }
  }
  selectedIds.value = new Set();
  emit('toast', `已批量完成 ${ok} 项任务`);
  emit('refresh');
}

function describeRun(run) {
  if (run.error) return `整理失败：${run.error}`;
  const parts = [`处理 ${run.messages || 0} 条新消息`];
  if (run.created) parts.push(`新增 ${run.created} 项`);
  if (run.updated) parts.push(`更新 ${run.updated} 项`);
  if (!run.created && !run.updated) parts.push('没有发现新任务');
  return parts.join('，');
}
</script>

<template>
  <section class="tasks-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">待办清单</h1>
        <span class="page-title-accent" aria-hidden="true"></span>
        <p class="page-subtitle">截止时间均为北京时间。点击任务标题可核对来源原话与修改记录。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" @click="$emit('create-task')">＋ 添加待办</button>
      </div>
    </header>

    <!-- AI 整理状态条 -->
    <div v-if="!state.model?.configured" class="banner">
      <div class="banner-text">
        <strong>AI 尚未配置</strong>
        <span v-if="state.pendingCount">当前有 {{ state.pendingCount }} 条关注群消息等待整理。</span>
        <span v-else>配置模型后，关注的群通知将自动提取为待办。</span>
      </div>
      <button class="btn btn-secondary btn-sm" @click="$emit('navigate', 'settings')">去配置</button>
    </div>

    <div v-else-if="latestRun" class="card run-strip">
      <div class="run-main">
        <span class="badge" :class="latestRun.error ? 'badge-seal' : 'badge-pine'">最新整理</span>
        <span class="run-time muted num">{{ formatTime(latestRun.at) }}</span>
        <span class="run-conv">{{ latestRun.conversation }}</span>
        <span class="run-desc">{{ describeRun(latestRun) }}</span>
        <span v-if="state.pendingCount" class="badge badge-ochre">尚有 {{ state.pendingCount }} 条待整理</span>
      </div>
      <button v-if="olderRuns.length" class="btn btn-ghost btn-sm" @click="showMoreRuns = !showMoreRuns">
        {{ showMoreRuns ? '收起记录' : `之前 ${olderRuns.length} 次` }}
      </button>
      <div v-if="showMoreRuns && olderRuns.length" class="run-older">
        <div v-for="(run, idx) in olderRuns" :key="idx" class="run-older-row">
          <span class="muted num">{{ formatTime(run.at) }}</span>
          <strong>{{ run.conversation }}</strong>
          <span>{{ describeRun(run) }}</span>
        </div>
      </div>
    </div>

    <!-- KPI 概览条 -->
    <div class="kpi-grid">
      <button class="card kpi-card" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
        <span class="kpi-label">未完成</span>
        <span class="kpi-num num">{{ stats.pending }}</span>
      </button>
      <button class="card kpi-card" :class="{ active: tab === 'review' }" @click="tab = 'review'">
        <span class="kpi-label">待确认</span>
        <span class="kpi-num num" :class="stats.review ? 'kpi-ochre' : ''">{{ stats.review }}</span>
      </button>
      <button class="card kpi-card" :class="{ active: tab === 'week' }" @click="tab = 'week'">
        <span class="kpi-label">7 天内截止</span>
        <span class="kpi-num num">{{ stats.week }}</span>
      </button>
      <button class="card kpi-card" @click="tab = 'pending'">
        <span class="kpi-label">已逾期</span>
        <span class="kpi-num num" :class="stats.overdue ? 'kpi-seal' : ''">{{ stats.overdue }}</span>
      </button>
    </div>

    <!-- 筛选与搜索栏 -->
    <div class="filter-bar">
      <div class="segmented" role="tablist">
        <button class="seg-btn" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">未完成 ({{ stats.pending }})</button>
        <button class="seg-btn" :class="{ active: tab === 'review' }" @click="tab = 'review'">待确认 ({{ stats.review }})</button>
        <button class="seg-btn" :class="{ active: tab === 'week' }" @click="tab = 'week'">7 天内 ({{ stats.week }})</button>
        <button class="seg-btn" :class="{ active: tab === 'done' }" @click="tab = 'done'">已完成 ({{ doneTasks.length }})</button>
      </div>
      <input v-model="query" class="input filter-search" placeholder="搜索任务标题、要求或来源群…" />
    </div>

    <!-- 批量完成操作条 -->
    <div v-if="selectedIds.size && tab !== 'done'" class="batch-bar card">
      <span>已选择 <strong class="num">{{ selectedIds.size }}</strong> 项待办</span>
      <div class="batch-actions">
        <button class="btn btn-primary btn-sm" @click="batchComplete">批量标记完成</button>
        <button class="btn btn-ghost btn-sm" @click="selectedIds = new Set()">取消选择</button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div v-if="visibleTasks.length" class="card task-list">
      <article
        v-for="task in visibleTasks"
        :key="task.id"
        class="task-row"
        :class="{
          'task-done': task.status === 'done',
          'task-overdue': formatDue(task).state === 'overdue'
        }"
      >
        <div class="task-left">
          <input
            v-if="tab !== 'done'"
            type="checkbox"
            class="row-select"
            :checked="selectedIds.has(task.id)"
            :aria-label="`选择 ${task.title}`"
            @change="toggleSelect(task.id)"
          />
          <button
            class="check-circle"
            :class="{ checked: task.status === 'done' }"
            :disabled="busyIds.has(task.id)"
            :title="task.status === 'done' ? '恢复为未完成' : '标记已完成'"
            @click="toggleComplete(task)"
          >
            <span v-if="task.status === 'done'">✓</span>
          </button>

          <div class="task-main">
            <div class="task-title-line">
              <button class="task-title-btn" @click="$emit('open-task', task.id)">{{ task.title }}</button>
              <span v-if="formatDue(task).state === 'overdue'" class="seal-stamp">逾期</span>
              <span v-else-if="formatDue(task).state === 'today'" class="badge badge-ochre">今天截止</span>
              <span v-if="task.needsReview && task.status === 'pending'" class="badge badge-ochre">待确认</span>
              <span v-if="task.relevance === 'unclear'" class="badge">{{ relevanceLabel(task.relevance) }}</span>
              <span v-if="task.suggestedStatus === 'done' && task.status === 'pending'" class="badge badge-pine">建议完成</span>
            </div>
            <div class="task-meta">
              <span class="meta-source">
                <span v-if="convPlatform(task)" class="platform-tag" :class="convPlatform(task) === 'wechat' ? 'tag-wx' : 'tag-qq'">
                  {{ convPlatform(task) === 'wechat' ? '微信' : 'QQ' }}
                </span>
                {{ convTitle(task) }}
              </span>
              <span v-if="task.sourceAt" class="muted">· {{ formatTime(task.sourceAt) }}发</span>
              <span v-if="task.description" class="meta-desc muted">· {{ task.description }}</span>
            </div>
          </div>
        </div>

        <div class="task-right">
          <div class="due-col">
            <span class="due-text num" :class="`due-${formatDue(task).state}`">
              {{ formatDue(task).text }}
            </span>
            <span class="due-basis muted">
              {{ formatDue(task).tag ? `${formatDue(task).tag} · ` : '' }}{{ formatDue(task).basisLabel }}
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" @click="$emit('open-task', task.id)">详情</button>
        </div>
      </article>
    </div>

    <div v-else class="empty-state">
      <div class="empty-mark">◎</div>
      <h2 class="empty-title">
        {{ query ? '没有匹配的任务' : tab === 'done' ? '还没有已完成的任务' : '这个范围内暂无待办' }}
      </h2>
      <p class="empty-desc">
        {{ query ? '换个关键词试试，或切换到「已完成」查看历史记录。' : '关注群收到新通知后会自动整理到这里；你也可以随时手动记下一条。' }}
      </p>
      <button v-if="!query && tab !== 'done'" class="btn btn-primary btn-sm" @click="$emit('create-task')">＋ 手动添加待办</button>
    </div>

    <!-- 他人事项折叠区 -->
    <div v-if="otherPending.length" class="other-section">
      <button class="btn-link other-toggle" @click="showOther = !showOther">
        {{ showOther ? '▾' : '▸' }} 另有 {{ otherPending.length }} 条明确属于他人的未完成事项（未计入你的待办）
      </button>
      <div v-if="showOther" class="card task-list other-list">
        <article v-for="task in otherPending" :key="task.id" class="task-row">
          <div class="task-left">
            <div class="task-main">
              <div class="task-title-line">
                <button class="task-title-btn" @click="$emit('open-task', task.id)">{{ task.title }}</button>
                <span class="badge">他人事项</span>
              </div>
              <div class="task-meta muted">
                <span>{{ convTitle(task) }}</span>
                <span v-if="task.responsible">· 负责人：{{ task.responsible }}</span>
              </div>
            </div>
          </div>
          <div class="task-right">
            <button class="btn btn-ghost btn-sm" @click="$emit('open-task', task.id)">查看</button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tasks-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.run-strip {
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  font-size: 13px;
}

.run-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.run-conv { font-weight: 600; color: var(--ink); }
.run-desc { color: var(--ink-2); }

.run-older {
  width: 100%;
  border-top: 1px solid var(--hairline);
  padding-top: 8px;
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
}

.run-older-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--ink-2);
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.kpi-card {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  transition: border-color 0.16s, background 0.16s;
}

.kpi-card:hover { border-color: var(--pine-border); background: #fff; }
.kpi-card.active { border-color: var(--pine); background: var(--pine-wash); }

.kpi-label { font-size: 12.5px; color: var(--ink-2); }
.kpi-num { font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--pine); }
.kpi-ochre { color: var(--ochre); }
.kpi-seal { color: var(--seal); }

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.filter-search {
  width: min(280px, 100%);
}

.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  background: var(--pine-wash);
  border-color: var(--pine-border);
  font-size: 13px;
}

.batch-actions { display: flex; gap: 6px; }

.task-list {
  overflow: hidden;
}

.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.14s;
}
.task-row:last-child { border-bottom: 0; }
.task-row:hover { background: var(--paper); }

.task-overdue {
  background: rgba(184, 59, 40, 0.035);
}

.task-left {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.row-select {
  margin-top: 4px;
  width: 15px;
  height: 15px;
  accent-color: var(--pine);
  cursor: pointer;
  flex-shrink: 0;
}

.check-circle {
  margin-top: 1px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid var(--hairline-strong);
  background: var(--paper-card);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  flex-shrink: 0;
  transition: border-color 0.15s, background 0.15s;
}
.check-circle:hover { border-color: var(--pine); background: var(--pine-wash); color: var(--pine); }
.check-circle.checked { background: var(--pine); border-color: var(--pine); color: #fff; }

.task-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.task-title-line {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.task-title-btn {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--ink);
  text-align: left;
  line-height: 1.4;
}
.task-title-btn:hover { color: var(--pine); text-decoration: underline; }
.task-done .task-title-btn { color: var(--ink-3); text-decoration: line-through; }

.seal-stamp {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--seal);
  color: var(--seal);
  background: var(--seal-wash);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
  flex-wrap: wrap;
}

.meta-source {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.platform-tag {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.tag-wx { background: var(--wx-wash); color: var(--wx); }
.tag-qq { background: var(--qq-wash); color: var(--qq); }

.meta-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 340px;
}

.task-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.due-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
  gap: 2px;
}

.due-text { font-size: 13px; font-weight: 600; color: var(--ink); white-space: nowrap; }
.due-overdue { color: var(--seal); }
.due-today { color: var(--ochre); }
.due-soon { color: var(--pine); }
.due-unknown { color: var(--ink-3); font-weight: 400; }

.due-basis { font-size: 11.5px; white-space: nowrap; }

.other-section { margin-top: 2px; }
.other-toggle { font-size: 13px; color: var(--ink-2); }
.other-list { margin-top: 8px; }

@media (max-width: 780px) {
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .task-right { justify-content: space-between; padding-left: 30px; }
  .due-col { align-items: flex-start; text-align: left; }
  .filter-search { width: 100%; }
}
</style>
