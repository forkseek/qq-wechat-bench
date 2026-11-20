<script setup>
import { ref, computed } from 'vue';
import { api } from '../api.js';
import {
  todayBeijing,
  datePlusDays,
  todayHeading,
  lunarHeading,
  formatDue,
  formatTime,
  sortPendingTasks,
  relevanceLabel
} from '../utils/format.js';

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
const lunarText = lunarHeading();

function convTitle(task) {
  if (!task.conversationId) return '手记';
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
    emit('toast', nextStatus === 'done' ? `已勾销「${task.title}」` : `已恢复「${task.title}」`);
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
  emit('toast', `已批量完成 ${ok} 项`);
  emit('refresh');
}

function describeRun(run) {
  if (run.error) return `整理未完成：${run.error}`;
  const parts = [`审阅 ${run.messages || 0} 条消息`];
  if (run.created) parts.push(`记入 ${run.created} 项`);
  if (run.updated) parts.push(`更新 ${run.updated} 项`);
  if (!run.created && !run.updated) parts.push('无新增事项');
  return parts.join('，');
}
</script>

<template>
  <section class="planner-spread">
    <!-- 书首抬头：农历 + 公历 + 楷书题签 + 极简书签统计 -->
    <header class="planner-head">
      <div class="head-date-block">
        <p class="date-line">
          <span v-if="lunarText" class="lunar-text">{{ lunarText }}</span>
          <span v-if="lunarText" class="date-sep" aria-hidden="true">·</span>
          <span>{{ todayHeading() }}</span>
        </p>
        <div class="title-lockup">
          <h1 class="planner-title">今日待办</h1>
          <span class="vertical-seal" aria-hidden="true">案头</span>
        </div>
      </div>

      <div class="head-right">
        <div class="bookmark-metrics" aria-label="待办统计">
          <button class="metric-chip" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
            <span class="metric-k">未完成</span>
            <strong class="metric-v num">{{ stats.pending }}</strong>
          </button>
          <span class="metric-div" aria-hidden="true"></span>
          <button class="metric-chip" :class="{ active: tab === 'week' }" @click="tab = 'week'">
            <span class="metric-k">七日内</span>
            <strong class="metric-v num">{{ stats.week }}</strong>
          </button>
          <span class="metric-div" aria-hidden="true"></span>
          <button class="metric-chip" :class="{ active: tab === 'review' }" @click="tab = 'review'">
            <span class="metric-k">待确认</span>
            <strong class="metric-v num" :class="{ 'v-ochre': stats.review > 0 }">{{ stats.review }}</strong>
          </button>
          <template v-if="stats.overdue > 0">
            <span class="metric-div" aria-hidden="true"></span>
            <button class="metric-chip" @click="tab = 'pending'">
              <span class="metric-k">已逾期</span>
              <strong class="metric-v num v-seal">{{ stats.overdue }}</strong>
            </button>
          </template>
        </div>

        <button class="btn btn-primary write-btn" @click="$emit('create-task')">＋ 记一条</button>
      </div>
    </header>

    <!-- 线装主卷 -->
    <div class="book-sheet planner-sheet">
      <!-- 书页顶栏：筛选章目 + 无框底线搜索 -->
      <div class="sheet-toolbar">
        <div class="ink-tabs" role="tablist">
          <button class="ink-tab" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
            待办 <span class="num">({{ stats.pending }})</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'review' }" @click="tab = 'review'">
            待确认 <span class="num">({{ stats.review }})</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'week' }" @click="tab = 'week'">
            七日内 <span class="num">({{ stats.week }})</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'done' }" @click="tab = 'done'">
            已归档 <span class="num">({{ doneTasks.length }})</span>
          </button>
        </div>

        <div class="underline-search">
          <span class="search-glyph muted" aria-hidden="true">⌕</span>
          <input v-model="query" class="bare-input" placeholder="检索事项或群名…" />
          <button v-if="query" class="clear-x" @click="query = ''" aria-label="清除搜索">×</button>
        </div>
      </div>

      <!-- AI 最近一次整理批注（单行素雅样式） -->
      <div v-if="!state.model?.configured" class="colophon-bar">
        <span class="colophon-tag">未配 AI</span>
        <span class="muted">
          {{ state.pendingCount ? `已有 ${state.pendingCount} 条消息候整。` : '配置模型后，群通知将自动摘录成条。' }}
        </span>
        <button class="btn-link" @click="$emit('navigate', 'settings')">前往配置</button>
      </div>
      <div v-else-if="latestRun" class="colophon-bar">
        <span class="colophon-tag" :class="{ 'tag-err': latestRun.error }">近录</span>
        <span class="num muted">{{ formatTime(latestRun.at) }}</span>
        <span class="colophon-conv">{{ latestRun.conversation }}</span>
        <span class="colophon-desc muted">{{ describeRun(latestRun) }}</span>
        <span v-if="state.pendingCount" class="badge badge-ochre">候整 {{ state.pendingCount }}</span>
        <button v-if="olderRuns.length" class="btn-link colophon-more" @click="showMoreRuns = !showMoreRuns">
          {{ showMoreRuns ? '收起' : `往次 (${olderRuns.length})` }}
        </button>
      </div>
      <div v-if="showMoreRuns && olderRuns.length" class="colophon-history">
        <div v-for="(run, idx) in olderRuns" :key="idx" class="colophon-hist-row">
          <span class="num muted">{{ formatTime(run.at) }}</span>
          <strong>{{ run.conversation }}</strong>
          <span class="muted">{{ describeRun(run) }}</span>
        </div>
      </div>

      <!-- 批量完成条 -->
      <div v-if="selectedIds.size && tab !== 'done'" class="batch-strip">
        <span>已勾选 <strong class="num">{{ selectedIds.size }}</strong> 项</span>
        <div class="batch-btns">
          <button class="btn btn-primary btn-sm" @click="batchComplete">批量勾销</button>
          <button class="btn btn-ghost btn-sm" @click="selectedIds = new Set()">取消</button>
        </div>
      </div>

      <!-- 线装日程条目 -->
      <div v-if="visibleTasks.length" class="entries">
        <article
          v-for="task in visibleTasks"
          :key="task.id"
          class="entry-row"
          :class="{
            'is-done': task.status === 'done',
            'is-overdue': formatDue(task).state === 'overdue'
          }"
        >
          <div class="entry-left">
            <input
              v-if="tab !== 'done'"
              type="checkbox"
              class="row-select"
              :checked="selectedIds.has(task.id)"
              :aria-label="`选择 ${task.title}`"
              @change="toggleSelect(task.id)"
            />
            <button
              class="ink-check"
              :class="{ checked: task.status === 'done' }"
              :disabled="busyIds.has(task.id)"
              :title="task.status === 'done' ? '恢复为待办' : '标记完成'"
              @click="toggleComplete(task)"
            >
              <span v-if="task.status === 'done'">✓</span>
            </button>

            <div class="entry-body">
              <div class="entry-title-row">
                <button class="entry-title" @click="$emit('open-task', task.id)">{{ task.title }}</button>
                <span v-if="formatDue(task).state === 'overdue'" class="seal-stamp">逾期</span>
                <span v-else-if="formatDue(task).state === 'today'" class="ochre-stamp">今日</span>
                <span v-if="task.needsReview && task.status === 'pending'" class="tag-pill tag-ochre">待确认</span>
                <span v-if="task.relevance === 'unclear'" class="tag-pill">{{ relevanceLabel(task.relevance) }}</span>
                <span v-if="task.suggestedStatus === 'done' && task.status === 'pending'" class="tag-pill tag-pine">建议完成</span>
              </div>

              <div class="entry-meta">
                <span class="source-chip">
                  <span v-if="convPlatform(task)" class="plat-dot" :class="convPlatform(task) === 'wechat' ? 'dot-wx' : 'dot-qq'"></span>
                  <span>{{ convTitle(task) }}</span>
                </span>
                <span v-if="task.sourceAt" class="muted">· {{ formatTime(task.sourceAt) }}</span>
                <span v-if="task.description" class="entry-desc muted">· {{ task.description }}</span>
              </div>
            </div>
          </div>

          <div class="entry-right">
            <div class="due-block">
              <span class="due-main num" :class="`due-${formatDue(task).state}`" :title="formatDue(task).text">{{ formatDue(task).text }}</span>
              <span class="due-sub muted">
                {{ formatDue(task).tag ? `${formatDue(task).tag} · ` : '' }}{{ formatDue(task).basisLabel }}
              </span>
            </div>
            <button class="entry-open" @click="$emit('open-task', task.id)" title="核对来源与详情">溯源 ↗</button>
          </div>
        </article>
      </div>

      <!-- 宣纸留白空态（中式竖排朱印「无事」） -->
      <div v-else class="zen-empty">
        <div class="zen-seal" aria-hidden="true">{{ query ? '无获' : tab === 'done' ? '未归' : '无事' }}</div>
        <h2 class="zen-title">
          {{ query ? '未寻得相符事项' : tab === 'done' ? '尚无已归档记录' : '案头清净，暂无未完成待办' }}
        </h2>
        <p class="zen-desc">
          {{ query ? '不妨换一词再寻，或翻阅「已归档」查看往期记录。' : '所关注的微信与 QQ 群收到学校通知后，会自动摘录至此；亦可随时手记一笔。' }}
        </p>
        <div class="zen-actions">
          <button v-if="!query && tab !== 'done'" class="btn btn-primary" @click="$emit('create-task')">＋ 手记一条待办</button>
          <button v-if="tab !== 'done' && doneTasks.length" class="btn btn-secondary" @click="tab = 'done'">
            翻阅已归档 ({{ doneTasks.length }})
          </button>
        </div>
      </div>
    </div>

    <!-- 书尾注脚：他人事项折叠 + 卷尾语 -->
    <footer class="sheet-footer">
      <div v-if="otherPending.length" class="other-wrap">
        <button class="other-trigger" @click="showOther = !showOther">
          <span>{{ showOther ? '▾' : '▸' }}</span>
          <span>另有 <strong class="num">{{ otherPending.length }}</strong> 条明确属于他人的未完成事项（不计入本人案头）</span>
        </button>

        <div v-if="showOther" class="card other-box">
          <article v-for="task in otherPending" :key="task.id" class="entry-row">
            <div class="entry-left">
              <div class="entry-body">
                <div class="entry-title-row">
                  <button class="entry-title" @click="$emit('open-task', task.id)">{{ task.title }}</button>
                  <span class="tag-pill">他人事项</span>
                </div>
                <div class="entry-meta muted">
                  <span>{{ convTitle(task) }}</span>
                  <span v-if="task.responsible">· 负责人：{{ task.responsible }}</span>
                </div>
              </div>
            </div>
            <div class="entry-right">
              <button class="entry-open" @click="$emit('open-task', task.id)">查看 ↗</button>
            </div>
          </article>
        </div>
      </div>

      <p class="motto-line">消息有出处 · 事情有着落</p>
    </footer>
  </section>
</template>

<style scoped>
.planner-spread {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 书首抬头 */
.planner-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 4px 2px 2px;
}

.head-date-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.date-line {
  font-size: 12.5px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.lunar-text {
  color: var(--pine);
  font-weight: 500;
}

.title-lockup {
  display: flex;
  align-items: center;
  gap: 12px;
}

.planner-title {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 600;
  letter-spacing: 0.1em;
  line-height: 1.15;
  color: var(--ink);
}

.vertical-seal {
  writing-mode: vertical-rl;
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: 0.15em;
  line-height: 1;
  padding: 4px 3px;
  border: 1px solid rgba(181, 54, 36, 0.55);
  border-radius: 2px;
  color: var(--seal);
  background: rgba(250, 236, 232, 0.55);
  user-select: none;
}

.head-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 紧凑书签统计条（彻底替代 4 张沉重大方框） */
.bookmark-metrics {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: rgba(255, 253, 248, 0.78);
}

.metric-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 4px;
  transition: background 0.14s;
  white-space: nowrap;
}
.metric-chip:hover { background: var(--paper-soft); }
.metric-chip.active { background: var(--pine-wash); }

.metric-k { font-size: 12px; color: var(--ink-3); }
.metric-v { font-size: 17px; font-weight: 700; color: var(--pine); line-height: 1; }
.v-ochre { color: var(--ochre); }
.v-seal { color: var(--seal); }

.metric-div {
  width: 1px;
  height: 14px;
  background: var(--hairline);
}

.write-btn {
  padding: 8px 16px;
}

/* 线装主卷 */
.planner-sheet {
  padding-left: 14px;
  overflow: hidden;
}

.sheet-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 22px 0;
  border-bottom: 1px solid var(--hairline);
  flex-wrap: wrap;
}

.ink-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ink-tab {
  position: relative;
  padding: 8px 12px 12px;
  font-size: 13.5px;
  color: var(--ink-3);
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.14s;
}
.ink-tab:hover { color: var(--ink); }
.ink-tab.active { color: var(--pine); font-weight: 600; }
.ink-tab.active::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  background: var(--pine);
}

.underline-search {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--hairline-strong);
  padding: 4px 2px;
  margin-bottom: 8px;
  width: min(230px, 100%);
  transition: border-color 0.16s;
}
.underline-search:focus-within { border-color: var(--pine); }

.search-glyph { font-size: 15px; line-height: 1; }

.bare-input {
  border: 0;
  background: transparent;
  outline: none;
  font-size: 13px;
  width: 100%;
  min-width: 0;
}

.clear-x {
  font-size: 15px;
  color: var(--ink-3);
  padding: 0 2px;
}
.clear-x:hover { color: var(--ink); }

/* 素雅批注栏 */
.colophon-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 22px;
  font-size: 12.5px;
  background: rgba(242, 237, 225, 0.45);
  border-bottom: 1px solid var(--hairline);
}

.colophon-tag {
  font-family: var(--font-display);
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--pine-border);
  background: var(--pine-wash);
  color: var(--pine);
  white-space: nowrap;
}
.colophon-tag.tag-err {
  border-color: var(--seal-border);
  background: var(--seal-wash);
  color: var(--seal);
}

.colophon-conv { font-weight: 600; color: var(--ink); }
.colophon-desc { flex: 1; min-width: 160px; }
.colophon-more { margin-left: auto; font-size: 12px; }

.colophon-history {
  padding: 8px 22px 10px;
  border-bottom: 1px solid var(--hairline);
  background: rgba(242, 237, 225, 0.25);
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}

.colophon-hist-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.batch-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 22px;
  background: var(--pine-wash);
  border-bottom: 1px solid var(--pine-border);
  font-size: 13px;
}
.batch-btns { display: flex; gap: 6px; }

/* 日程条目 */
.entries {
  display: flex;
  flex-direction: column;
}

.entry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 22px;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.15s var(--ease);
}
.entry-row:last-child { border-bottom: 0; }
.entry-row:hover { background: rgba(242, 237, 225, 0.42); }
.entry-row.is-overdue { background: rgba(181, 54, 36, 0.032); }

.entry-left {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  min-width: 0;
  flex: 1;
}

.row-select {
  margin-top: 5px;
  width: 14px;
  height: 14px;
  accent-color: var(--pine);
  cursor: pointer;
  flex-shrink: 0;
}

.ink-check {
  margin-top: 2px;
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
  transition: border-color 0.15s, background 0.15s, transform 0.12s;
}
.ink-check:hover {
  border-color: var(--pine);
  background: var(--pine-wash);
  color: var(--pine);
  transform: scale(1.06);
}
.ink-check.checked {
  background: var(--pine);
  border-color: var(--pine);
  color: #faf7f0;
}

.entry-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.entry-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.entry-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--ink);
  text-align: left;
  line-height: 1.45;
}
.entry-title:hover { color: var(--pine); text-decoration: underline; }
.is-done .entry-title { color: var(--ink-3); text-decoration: line-through; }

.seal-stamp {
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 2px;
  border: 1px solid var(--seal);
  color: var(--seal);
  background: var(--seal-wash);
  white-space: nowrap;
}

.ochre-stamp {
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 2px;
  border: 1px solid var(--ochre);
  color: var(--ochre);
  background: var(--ochre-wash);
  white-space: nowrap;
}

.tag-pill {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  background: var(--paper-soft);
  color: var(--ink-2);
  white-space: nowrap;
}
.tag-ochre { background: var(--ochre-wash); border-color: var(--ochre-border); color: var(--ochre); }
.tag-pine { background: var(--pine-wash); border-color: var(--pine-border); color: var(--pine); }

.entry-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
  flex-wrap: wrap;
}

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.plat-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-wx { background: var(--wx); }
.dot-qq { background: var(--qq); }

.entry-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 340px;
}

.entry-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}

.due-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  text-align: right;
}

.due-main {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.due-overdue { color: var(--seal); }
.due-today { color: var(--ochre); }
.due-soon { color: var(--pine); }
.due-unknown { color: var(--ink-3); font-weight: 400; }

.due-sub { font-size: 11.5px; white-space: nowrap; }

.entry-open {
  font-size: 12.5px;
  color: var(--ink-3);
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.14s, background 0.14s;
}
.entry-open:hover { color: var(--pine); background: var(--pine-wash); }

/* 宣纸留白空态 */
.zen-empty {
  padding: 66px 24px 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
}

.zen-seal {
  writing-mode: vertical-rl;
  font-family: var(--font-display);
  font-size: 18px;
  letter-spacing: 0.25em;
  line-height: 1;
  padding: 10px 7px;
  border: 1.5px solid rgba(181, 54, 36, 0.58);
  border-radius: 3px;
  color: var(--seal);
  background: rgba(250, 236, 232, 0.4);
  margin-bottom: 4px;
  user-select: none;
}

.zen-title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--ink);
}

.zen-desc {
  font-size: 13px;
  color: var(--ink-3);
  max-width: 400px;
  line-height: 1.7;
}

.zen-actions {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

/* 书尾注脚 */
.sheet-footer {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 2px 4px;
}

.other-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.other-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-3);
  align-self: flex-start;
}
.other-trigger:hover { color: var(--pine); }

.other-box { overflow: hidden; }

.motto-line {
  text-align: center;
  font-family: var(--font-display);
  font-size: 13px;
  letter-spacing: 0.22em;
  color: var(--ink-3);
  opacity: 0.72;
  padding-top: 6px;
}

@media (max-width: 760px) {
  .planner-title { font-size: 26px; }
  .planner-sheet { padding-left: 8px; }
  .sheet-toolbar { padding: 10px 14px 0; }
  .underline-search { width: 100%; }
  .colophon-bar { padding: 8px 14px; }
  .entry-row {
    flex-direction: column;
    align-items: stretch;
    padding: 13px 14px;
    gap: 8px;
  }
  .entry-right {
    justify-content: space-between;
    padding-left: 30px;
  }
  .due-block { align-items: flex-start; text-align: left; }
  .zen-empty { padding: 44px 16px 50px; }
}
</style>
