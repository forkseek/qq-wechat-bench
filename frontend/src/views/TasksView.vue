<script setup>
import { ref, computed, reactive } from 'vue';
import { api } from '../api.js';
import {
  todayBeijing,
  datePlusDays,
  todayHeading,
  lunarHeading,
  shichenHeading,
  monogramChar,
  formatDue,
  formatTime,
  sortPendingTasks,
  relevanceLabel,
  isStaleHistoricalTask
} from '../utils/format.js';

const props = defineProps({
  state: { type: Object, required: true }
});
const emit = defineEmits(['refresh', 'navigate', 'open-messages', 'toast']);

const tab = ref('pending'); // 'pending' | 'week' | 'review' | 'done' | 'cancelled' | 'stale'
const query = ref('');
const selectedIds = ref(new Set());
const busy = ref(false);
const showMoreRuns = ref(false);
const showOther = ref(false);

// 内联新建待办栏
const showQuickCreate = ref(false);
const createForm = ref({ title: '', dueDate: '', dueTime: '', description: '' });
const creating = ref(false);

// 内联展开的详情抽屉（点任务行直接在下方展开群原话与快捷改期，不弹窗遮挡）
const expandedId = ref('');
const detailCache = reactive({}); // { [id]: { loading, sources, form } }

// 上一步撤销栈
const lastUndo = ref(null); // { label, items: [{ id, status, needsReview }] }

const convMap = computed(() => new Map((props.state?.conversations || []).map(c => [c.id, c])));
const allTasks = computed(() => props.state?.tasks || []);
const monitoredGroupCount = computed(() => (props.state?.conversations || []).filter(c => c.monitored).length);

// 将「当前活跃待办」与「超过 7 天的历史补拉旧通知」分开
const freshPending = computed(() =>
  sortPendingTasks(allTasks.value.filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t)))
);
const stalePending = computed(() =>
  sortPendingTasks(allTasks.value.filter(t => t.status === 'pending' && t.relevance !== 'other' && isStaleHistoricalTask(t)))
);
const otherPending = computed(() =>
  sortPendingTasks(allTasks.value.filter(t => t.status === 'pending' && t.relevance === 'other'))
);
const doneTasks = computed(() =>
  [...allTasks.value.filter(t => t.status === 'done')].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
);
const cancelledTasks = computed(() =>
  [...allTasks.value.filter(t => t.status === 'cancelled')].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
);

const stats = computed(() => {
  const today = todayBeijing();
  const in7 = datePlusDays(7);
  const list = freshPending.value;
  return {
    pending: list.length,
    review: list.filter(t => t.needsReview).length,
    week: list.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7).length,
    overdue: list.filter(t => t.dueDate && t.dueDate < today).length,
    stale: stalePending.value.length,
    done: doneTasks.value.length
  };
});

const visibleTasks = computed(() => {
  const today = todayBeijing();
  const in7 = datePlusDays(7);
  let base;
  if (tab.value === 'done') base = doneTasks.value;
  else if (tab.value === 'cancelled') base = cancelledTasks.value;
  else if (tab.value === 'stale') base = stalePending.value;
  else if (tab.value === 'review') base = freshPending.value.filter(t => t.needsReview);
  else if (tab.value === 'week') base = freshPending.value.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7);
  else base = freshPending.value;

  const q = query.value.trim().toLowerCase();
  if (!q) return base;
  return base.filter(t => {
    const conv = convMap.value.get(t.conversationId);
    const hay = `${t.title || ''} ${t.description || ''} ${conv?.title || ''}`.toLowerCase();
    return hay.includes(q);
  });
});

const allVisibleSelected = computed(() =>
  visibleTasks.value.length > 0 && visibleTasks.value.every(t => selectedIds.value.has(t.id))
);

const latestRun = computed(() => (props.state?.runs || [])[0] || null);
const olderRuns = computed(() => (props.state?.runs || []).slice(1));
const lunarText = lunarHeading();
const shichen = shichenHeading();

function convTitle(task) {
  if (!task.conversationId) return '手记';
  return convMap.value.get(task.conversationId)?.title || '群通知';
}

function convPlatform(task) {
  if (!task.conversationId) return '';
  return convMap.value.get(task.conversationId)?.platform || 'qq';
}

function switchTab(nextTab) {
  tab.value = nextTab;
  selectedIds.value = new Set();
}

// 圆圈仅用于多选，绝不直接让项目消失
function toggleSelect(id) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAllVisible() {
  if (allVisibleSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(visibleTasks.value.map(t => t.id));
  }
}

// 点任务行在下方原地展开「群原话 + 快捷改期」
async function toggleExpand(task) {
  if (expandedId.value === task.id) {
    expandedId.value = '';
    return;
  }
  expandedId.value = task.id;
  detailCache[task.id] = {
    loading: true,
    sources: detailCache[task.id]?.sources || [],
    questions: task.questions || [],
    form: {
      title: task.title || '',
      dueDate: task.dueDate || '',
      dueTime: task.dueTime || '',
      relevance: task.relevance || 'mine',
      description: task.description || ''
    }
  };
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(task.id)}`);
    if (detailCache[task.id]) {
      detailCache[task.id].sources = data.sources || [];
      detailCache[task.id].questions = data.task?.questions || [];
      detailCache[task.id].loading = false;
    }
  } catch {
    if (detailCache[task.id]) detailCache[task.id].loading = false;
  }
}

function setQuickDate(targetForm, offsetDays) {
  if (offsetDays === null) {
    targetForm.dueDate = '';
    targetForm.dueTime = '';
  } else {
    targetForm.dueDate = datePlusDays(offsetDays);
  }
}

async function saveInlineEdit(task) {
  const entry = detailCache[task.id];
  if (!entry) return;
  const f = entry.form;
  if (!f.title.trim()) {
    emit('toast', '请输入事项标题', 'error');
    return;
  }
  if (f.dueTime && !f.dueDate) {
    emit('toast', '填写具体时刻前请先选择日期', 'error');
    return;
  }
  busy.value = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
      revision: task.revision,
      title: f.title.trim(),
      dueDate: f.dueDate || null,
      dueTime: f.dueTime || null,
      relevance: f.relevance,
      description: f.description,
      needsReview: false
    }, 'PATCH');
    emit('toast', '修改已保存');
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busy.value = false;
  }
}

// 统一状态变更（支持单条与顶部多选批量操作，并记录一键撤销）
async function applyStatusToTasks(tasksToChange, nextStatus, actionLabel) {
  if (!tasksToChange.length || busy.value) return;
  busy.value = true;
  const undoItems = [];
  let count = 0;
  try {
    for (const t of tasksToChange) {
      const current = allTasks.value.find(x => x.id === t.id) || t;
      try {
        await api(`/api/tasks/${encodeURIComponent(current.id)}`, {
          revision: current.revision,
          status: nextStatus,
          needsReview: false
        }, 'PATCH');
        undoItems.push({ id: current.id, prevStatus: current.status, prevReview: current.needsReview });
        selectedIds.value.delete(current.id);
        if (expandedId.value === current.id) expandedId.value = '';
        count++;
      } catch { /* 跳过版本冲突 */ }
    }
    if (count > 0) {
      lastUndo.value = { label: `已将 ${count} 项${actionLabel}`, items: undoItems };
      emit('toast', `已将 ${count} 项${actionLabel}`);
      emit('refresh');
    }
  } finally {
    busy.value = false;
  }
}

function batchChangeStatus(nextStatus, label) {
  const list = allTasks.value.filter(t => selectedIds.value.has(t.id));
  return applyStatusToTasks(list, nextStatus, label);
}

async function batchDelete() {
  const ids = [...selectedIds.value];
  if (!ids.length || busy.value) return;
  busy.value = true;
  let count = 0;
  try {
    for (const id of ids) {
      try {
        await api(`/api/tasks/${encodeURIComponent(id)}`, undefined, 'DELETE');
        selectedIds.value.delete(id);
        if (expandedId.value === id) expandedId.value = '';
        count++;
      } catch { /* ignore */ }
    }
    lastUndo.value = null;
    if (count > 0) {
      emit('toast', `已删除 ${count} 项`);
      emit('refresh');
    }
  } finally {
    busy.value = false;
  }
}

async function deleteSingleTask(task) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, undefined, 'DELETE');
    selectedIds.value.delete(task.id);
    if (expandedId.value === task.id) expandedId.value = '';
    emit('toast', `已删除「${task.title}」`);
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busy.value = false;
  }
}

async function undoLastAction() {
  if (!lastUndo.value || busy.value) return;
  const { items } = lastUndo.value;
  busy.value = true;
  let restored = 0;
  try {
    for (const item of items) {
      const current = allTasks.value.find(x => x.id === item.id);
      if (!current) continue;
      try {
        await api(`/api/tasks/${encodeURIComponent(current.id)}`, {
          revision: current.revision,
          status: item.prevStatus,
          needsReview: item.prevReview
        }, 'PATCH');
        restored++;
      } catch { /* ignore */ }
    }
    lastUndo.value = null;
    if (restored > 0) {
      emit('toast', `已撤销操作，恢复 ${restored} 项`);
      emit('refresh');
    }
  } finally {
    busy.value = false;
  }
}

async function submitQuickCreate() {
  const f = createForm.value;
  if (!f.title.trim() || creating.value) return;
  if (f.dueTime && !f.dueDate) {
    emit('toast', '填写时刻前请先选择日期', 'error');
    return;
  }
  creating.value = true;
  try {
    await api('/api/tasks', {
      title: f.title.trim(),
      dueDate: f.dueDate || null,
      dueTime: f.dueTime || null,
      description: f.description,
      relevance: 'mine',
      status: 'pending'
    }, 'POST');
    createForm.value = { title: '', dueDate: '', dueTime: '', description: '' };
    showQuickCreate.value = false;
    emit('toast', '已记入待办');
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    creating.value = false;
  }
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
    <!-- 宋韵书卷卷首画匣（远山云烟水墨暗纹 + 时辰印 + 乌丝栏四联书签） -->
    <header class="hero-plaque">
      <svg class="hero-ink-art" viewBox="0 0 560 140" fill="none" aria-hidden="true">
        <path d="M220 140 C275 88, 330 74, 395 112 C445 78, 495 56, 560 95 L560 140 Z" fill="rgba(27, 73, 56, 0.045)" />
        <path d="M310 140 C360 102, 420 82, 480 116 C512 96, 538 88, 560 104 L560 140 Z" fill="rgba(45, 93, 140, 0.038)" />
        <circle cx="486" cy="38" r="16" fill="rgba(184, 51, 34, 0.07)" />
      </svg>

      <div class="head-date-block">
        <div class="date-line">
          <span class="shichen-stamp">{{ shichen.seal }}</span>
          <span v-if="lunarText" class="lunar-text">{{ lunarText }}</span>
          <span class="date-sep" aria-hidden="true">·</span>
          <span>{{ todayHeading() }}</span>
          <span class="date-sep" aria-hidden="true">·</span>
          <span class="shichen-phrase">{{ shichen.phrase }}</span>
        </div>

        <div class="title-lockup">
          <h1 class="planner-title">今日案头</h1>
          <span class="vertical-seal" aria-hidden="true">卷壹</span>
          <p class="hero-sub">
            静默守护 <strong class="num">{{ monitoredGroupCount }}</strong> 个关注群聊 ·
            当前 <strong class="num">{{ stats.pending }}</strong> 项待办候审
          </p>
        </div>
      </div>

      <div class="head-right">
        <div class="bookmark-metrics" aria-label="待办统计">
          <button class="metric-chip" :class="{ active: tab === 'pending' }" @click="switchTab('pending')">
            <span class="metric-k">当前待办</span>
            <strong class="metric-v num">{{ stats.pending }}</strong>
          </button>
          <span class="metric-div" aria-hidden="true"></span>
          <button class="metric-chip" :class="{ active: tab === 'week' }" @click="switchTab('week')">
            <span class="metric-k">七日内</span>
            <strong class="metric-v num">{{ stats.week }}</strong>
          </button>
          <span class="metric-div" aria-hidden="true"></span>
          <button class="metric-chip" :class="{ active: tab === 'review' }" @click="switchTab('review')">
            <span class="metric-k">待确认</span>
            <strong class="metric-v num" :class="{ 'v-ochre': stats.review > 0 }">{{ stats.review }}</strong>
          </button>
          <span class="metric-div" aria-hidden="true"></span>
          <button v-if="stats.overdue > 0" class="metric-chip" @click="switchTab('pending')">
            <span class="metric-k">近期逾期</span>
            <strong class="metric-v num v-seal">{{ stats.overdue }}</strong>
          </button>
          <button v-else class="metric-chip" :class="{ active: tab === 'done' }" @click="switchTab('done')">
            <span class="metric-k">已勾销</span>
            <strong class="metric-v num">{{ stats.done }}</strong>
          </button>
        </div>

        <button class="btn btn-primary write-btn" @click="showQuickCreate = !showQuickCreate">
          <span>{{ showQuickCreate ? '收起手记' : '✒ 记一条' }}</span>
        </button>
      </div>
    </header>

    <!-- 内联手记新建框（无需弹窗） -->
    <form v-if="showQuickCreate" class="book-sheet quick-create-box" @submit.prevent="submitQuickCreate">
      <div class="qc-top">
        <input
          v-model="createForm.title"
          class="input qc-title-input"
          maxlength="180"
          required
          placeholder="写下要做的事…（例如：周五 17:00 前交大物实验报告）"
        />
        <div class="qc-date-pills">
          <button type="button" class="mini-date-pill" @click="setQuickDate(createForm, 0)">今天</button>
          <button type="button" class="mini-date-pill" @click="setQuickDate(createForm, 1)">明天</button>
          <button type="button" class="mini-date-pill" @click="setQuickDate(createForm, 3)">3天后</button>
          <input v-model="createForm.dueDate" type="date" class="input qc-date-input" />
          <input v-model="createForm.dueTime" type="time" class="input qc-time-input" />
        </div>
      </div>
      <div class="qc-bottom">
        <input v-model="createForm.description" class="input qc-desc-input" maxlength="500" placeholder="补充备注、地点或提交方式（可选）…" />
        <div class="qc-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="showQuickCreate = false">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="creating || !createForm.title.trim()">
            {{ creating ? '保存中…' : '落纸保存' }}
          </button>
        </div>
      </div>
    </form>

    <!-- 线装主卷 -->
    <div class="book-sheet planner-sheet">
      <!-- 书页顶栏：分类章目 + 雕花检索匣 -->
      <div class="sheet-toolbar">
        <div class="ink-tabs" role="tablist">
          <button class="ink-tab" :class="{ active: tab === 'pending' }" @click="switchTab('pending')">
            <span>当前待办</span>
            <span class="tab-pill num">{{ stats.pending }}</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'week' }" @click="switchTab('week')">
            <span>七日内</span>
            <span class="tab-pill num">{{ stats.week }}</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'review' }" @click="switchTab('review')">
            <span>待确认</span>
            <span class="tab-pill num" :class="{ 'pill-ochre': stats.review > 0 }">{{ stats.review }}</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'done' }" @click="switchTab('done')">
            <span>已完成</span>
            <span class="tab-pill num">{{ doneTasks.length }}</span>
          </button>
          <button class="ink-tab" :class="{ active: tab === 'cancelled' }" @click="switchTab('cancelled')">
            <span>已忽略</span>
            <span class="tab-pill num">{{ cancelledTasks.length }}</span>
          </button>
          <button v-if="stats.stale > 0 || tab === 'stale'" class="ink-tab" :class="{ active: tab === 'stale' }" @click="switchTab('stale')">
            <span>历史旧通知</span>
            <span class="tab-pill num">{{ stats.stale }}</span>
          </button>
        </div>

        <div class="search-capsule">
          <span class="search-glyph muted" aria-hidden="true">⌕</span>
          <input v-model="query" class="bare-input" placeholder="检索事项、群名或关键词…" />
          <button v-if="query" class="clear-x" @click="query = ''" aria-label="清除搜索">×</button>
        </div>
      </div>

      <!-- 顶部多选操作栏（点前方圆圈选中后，在这里点按钮才真正执行！） -->
      <div v-if="selectedIds.size > 0" class="selection-bar">
        <div class="sel-left">
          <button class="select-circle checked" @click="toggleSelectAllVisible" title="全选 / 取消全选当页">✓</button>
          <span>已选中 <strong class="num">{{ selectedIds.size }}</strong> 项</span>
          <button class="btn-link" @click="toggleSelectAllVisible">
            {{ allVisibleSelected ? '取消全选' : `全选当页 (${visibleTasks.length})` }}
          </button>
        </div>
        <div class="sel-actions">
          <button
            v-if="tab !== 'done'"
            class="btn btn-primary btn-sm"
            :disabled="busy"
            @click="batchChangeStatus('done', '标记为已完成')"
          >
            ✓ 标记完成
          </button>
          <button
            v-if="tab !== 'cancelled'"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            @click="batchChangeStatus('cancelled', '移入已忽略')"
          >
            × 忽略 / 不参加
          </button>
          <button
            v-if="tab === 'done' || tab === 'cancelled' || tab === 'stale'"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            @click="batchChangeStatus('pending', '恢复为待办')"
          >
            ↶ 恢复为待办
          </button>
          <button class="btn btn-danger btn-sm" :disabled="busy" @click="batchDelete">删除</button>
          <button class="btn btn-ghost btn-sm" @click="selectedIds = new Set()">取消选择</button>
        </div>
      </div>

      <!-- 撤销上一步提示条 -->
      <div v-else-if="lastUndo" class="undo-bar">
        <span>{{ lastUndo.label }}</span>
        <div class="undo-actions">
          <button class="btn-link" :disabled="busy" @click="undoLastAction">↶ 撤销上一步</button>
          <button class="clear-x" @click="lastUndo = null" aria-label="关闭提示">×</button>
        </div>
      </div>

      <!-- AI 最近一次整理批注 + 操作说明 -->
      <div v-if="!state.model?.configured" class="colophon-bar">
        <span class="colophon-tag">未配 AI</span>
        <span class="muted">
          {{ state.pendingCount ? `已有 ${state.pendingCount} 条消息候整。` : '配置模型后，群通知将自动摘录成条。' }}
        </span>
        <button class="btn-link" @click="$emit('navigate', 'settings')">前往配置</button>
      </div>
      <div v-else class="colophon-bar">
        <button
          v-if="visibleTasks.length"
          class="select-all-link"
          @click="toggleSelectAllVisible"
          title="全选或取消全选当前列表"
        >
          <span class="mini-circle" :class="{ checked: allVisibleSelected }">
            <span v-if="allVisibleSelected">✓</span>
          </span>
          <span>全选当页</span>
        </button>
        <template v-if="latestRun">
          <span class="colophon-tag" :class="{ 'tag-err': latestRun.error }">近录</span>
          <span class="num muted">{{ formatTime(latestRun.at) }}</span>
          <span class="colophon-conv">{{ latestRun.conversation }}</span>
          <span class="colophon-desc muted">{{ describeRun(latestRun) }}</span>
        </template>
        <span v-if="state.pendingCount" class="badge badge-ochre">正在整理 {{ state.pendingCount }} 条消息…</span>
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

      <!-- 线装日程条目（点圆圈 = 多选不消失；点标题/行 = 原地展开群原话与快捷改期） -->
      <div v-if="visibleTasks.length" class="entries">
        <div
          v-for="task in visibleTasks"
          :key="task.id"
          class="entry-block"
          :class="[
            `state-${formatDue(task).state}`,
            {
              'is-selected': selectedIds.has(task.id),
              'is-expanded': expandedId === task.id,
              'is-done': task.status === 'done' || task.status === 'cancelled',
              'is-overdue': formatDue(task).state === 'overdue' && tab !== 'stale'
            }
          ]"
        >
          <div class="entry-row">
            <div class="entry-left">
              <!-- 唯一的前置圆圈：只用来多选，绝不直接让任务消失 -->
              <button
                type="button"
                class="select-circle"
                :class="{ checked: selectedIds.has(task.id) }"
                :aria-label="`选择 ${task.title}`"
                title="点击选择（可多选后在顶部批量完成、忽略或删除）"
                @click.stop="toggleSelect(task.id)"
              >
                <span v-if="selectedIds.has(task.id)">✓</span>
              </button>

              <div class="entry-body" @click="toggleExpand(task)">
                <div class="entry-title-row">
                  <span class="entry-title">{{ task.title }}</span>
                  <span v-if="formatDue(task).state === 'overdue' && tab !== 'stale'" class="seal-stamp">逾期</span>
                  <span v-else-if="formatDue(task).state === 'today'" class="ochre-stamp">今日</span>
                  <span v-if="tab === 'stale'" class="tag-pill">历史补拉</span>
                  <span v-else-if="task.needsReview && task.status === 'pending'" class="tag-pill tag-ochre">待确认</span>
                  <span v-if="task.relevance === 'unclear'" class="tag-pill">{{ relevanceLabel(task.relevance) }}</span>
                  <span v-if="task.suggestedStatus === 'done' && task.status === 'pending'" class="tag-pill tag-pine">建议完成</span>
                </div>

                <div class="entry-meta">
                  <span class="source-chip">
                    <span
                      v-if="convPlatform(task)"
                      class="plat-badge"
                      :class="convPlatform(task) === 'wechat' ? 'plat-wx' : 'plat-qq'"
                    >
                      {{ convPlatform(task) === 'wechat' ? '微信' : 'QQ' }}
                    </span>
                    <span v-else class="plat-badge plat-manual">手记</span>
                    <span class="source-name">{{ convTitle(task) }}</span>
                  </span>
                  <span v-if="task.sourceAt" class="muted">· {{ formatTime(task.sourceAt) }}通知</span>
                  <span v-if="task.description" class="entry-desc muted">· {{ task.description }}</span>
                </div>
              </div>
            </div>

            <div class="entry-right">
              <div class="due-ticket" :class="`ticket-${formatDue(task).state}`" @click="toggleExpand(task)">
                <span class="due-main num" :class="`due-${formatDue(task).state}`" :title="formatDue(task).text">
                  {{ formatDue(task).text }}
                </span>
                <span class="due-sub muted">
                  {{ formatDue(task).tag ? `${formatDue(task).tag} · ` : '' }}{{ formatDue(task).basisLabel }}
                </span>
              </div>

              <!-- 右侧明确操作按钮：区分「完成」与「忽略/不参加」，以及原地展开原话 -->
              <div class="row-actions">
                <template v-if="task.status === 'pending'">
                  <button
                    class="row-btn row-btn-done"
                    :disabled="busy"
                    title="我已完成这件事"
                    @click.stop="applyStatusToTasks([task], 'done', '标记为已完成')"
                  >
                    ✓ 完成
                  </button>
                  <button
                    class="row-btn row-btn-ignore"
                    :disabled="busy"
                    title="我不参加或与我无关，移入已忽略"
                    @click.stop="applyStatusToTasks([task], 'cancelled', '移入已忽略')"
                  >
                    忽略 ×
                  </button>
                </template>
                <template v-else>
                  <button
                    class="row-btn"
                    :disabled="busy"
                    @click.stop="applyStatusToTasks([task], 'pending', '恢复为待办')"
                  >
                    ↶ 恢复待办
                  </button>
                </template>
                <button
                  class="row-btn row-btn-expand"
                  :class="{ active: expandedId === task.id }"
                  title="在下方原地展开群原话与快捷改期"
                  @click.stop="toggleExpand(task)"
                >
                  {{ expandedId === task.id ? '收起 ▴' : '原话 ▾' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 原地内联展开批注笺：左边看群原话，右边快捷改期/编辑 -->
          <div v-if="expandedId === task.id && detailCache[task.id]" class="inline-drawer">
            <div class="drawer-grid">
              <!-- 左栏：群通知来源原话 -->
              <div class="drawer-col">
                <div class="drawer-col-head">
                  <div class="drawer-head-title">
                    <span class="drawer-seal" aria-hidden="true">源</span>
                    <h3 class="drawer-col-title">来源群原话</h3>
                  </div>
                  <button
                    v-if="task.conversationId"
                    type="button"
                    class="btn-link"
                    @click="$emit('open-messages', task.conversationId)"
                  >
                    去该群看上下文 ↗
                  </button>
                </div>

                <div v-if="detailCache[task.id].loading" class="muted drawer-note">正在读取原话…</div>
                <div v-else-if="!detailCache[task.id].sources.length" class="muted drawer-note">
                  这是手动记录的待办，没有关联群消息。
                </div>
                <div v-else class="inline-sources">
                  <div v-for="msg in detailCache[task.id].sources" :key="msg.id" class="inline-source-card">
                    <div class="inline-source-meta">
                      <span class="sender-badge">
                        <span class="sender-monogram">{{ monogramChar(msg.senderName) }}</span>
                        <strong>{{ msg.senderName }}</strong>
                      </span>
                      <time class="num muted">{{ formatTime(msg.sentAt, true) }}</time>
                    </div>
                    <p class="inline-source-text">{{ msg.content }}</p>
                  </div>
                </div>

                <div v-if="detailCache[task.id].questions?.length" class="inline-questions">
                  <span class="q-label">待核实：</span>
                  <span>{{ detailCache[task.id].questions.join('；') }}</span>
                </div>
              </div>

              <!-- 右栏：快捷改期与内容微调 -->
              <form class="drawer-col drawer-edit" @submit.prevent="saveInlineEdit(task)">
                <div class="drawer-col-head">
                  <div class="drawer-head-title">
                    <span class="drawer-seal seal-pine" aria-hidden="true">改</span>
                    <h3 class="drawer-col-title">快捷改期与微调</h3>
                  </div>
                  <div class="quick-date-row">
                    <button type="button" class="mini-date-pill" @click="setQuickDate(detailCache[task.id].form, 0)">今天</button>
                    <button type="button" class="mini-date-pill" @click="setQuickDate(detailCache[task.id].form, 1)">明天</button>
                    <button type="button" class="mini-date-pill" @click="setQuickDate(detailCache[task.id].form, 3)">3天后</button>
                    <button type="button" class="mini-date-pill" @click="setQuickDate(detailCache[task.id].form, 7)">下周</button>
                    <button type="button" class="mini-date-pill" @click="setQuickDate(detailCache[task.id].form, null)">无截止</button>
                  </div>
                </div>

                <input v-model="detailCache[task.id].form.title" class="input" maxlength="180" required placeholder="事项标题" />

                <div class="inline-edit-row">
                  <input v-model="detailCache[task.id].form.dueDate" type="date" class="input" />
                  <input v-model="detailCache[task.id].form.dueTime" type="time" class="input" />
                  <select v-model="detailCache[task.id].form.relevance" class="select">
                    <option value="mine">与我有关</option>
                    <option value="everyone">全体适用</option>
                    <option value="unclear">归属待确认</option>
                    <option value="other">属于他人</option>
                  </select>
                </div>

                <textarea
                  v-model="detailCache[task.id].form.description"
                  class="textarea"
                  rows="2"
                  maxlength="2000"
                  placeholder="补充要求、地点或备注…"
                ></textarea>

                <div class="inline-edit-actions">
                  <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="deleteSingleTask(task)">
                    删除此条
                  </button>
                  <div class="inline-edit-right">
                    <button type="button" class="btn btn-secondary btn-sm" @click="expandedId = ''">收起</button>
                    <button type="submit" class="btn btn-primary btn-sm" :disabled="busy">保存修改</button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>

      <!-- 宣纸留白空态 -->
      <div v-else class="zen-empty">
        <div class="zen-seal" aria-hidden="true">{{ query ? '无获' : tab === 'done' ? '未归' : tab === 'cancelled' ? '无弃' : '无事' }}</div>
        <h2 class="zen-title">
          {{
            query ? '未寻得相符事项'
            : tab === 'done' ? '尚无已完成记录'
            : tab === 'cancelled' ? '尚无已忽略的通知'
            : tab === 'stale' ? '没有积压的历史旧通知'
            : '案头清净，当前没有待处理事项'
          }}
        </h2>
        <p class="zen-desc">
          {{
            query ? '不妨换一词再寻，或切换上方标签查看其他分类。'
            : tab === 'pending' && stats.stale > 0
              ? `系统已为你自动收起 ${stats.stale} 条超过 7 天的历史旧通知，避免旧消息干扰今日案头。`
              : '所关注的微信与 QQ 群收到新通知后会自动摘录至此；亦可点击右上角随时手记一笔。'
          }}
        </p>
        <div class="zen-actions">
          <button v-if="!query && tab === 'pending'" class="btn btn-primary" @click="showQuickCreate = true">✒ 手记一条待办</button>
          <button v-if="tab === 'pending' && stats.stale > 0" class="btn btn-secondary" @click="switchTab('stale')">
            查看 {{ stats.stale }} 条历史旧通知
          </button>
        </div>
      </div>
    </div>

    <!-- 书尾注脚：历史旧通知提示 + 他人事项折叠 -->
    <footer class="sheet-footer">
      <div v-if="stats.stale > 0 && tab !== 'stale'" class="stale-notice-bar">
        <div class="stale-left">
          <span class="stale-seal">旧闻</span>
          <span>已自动收纳 <strong class="num">{{ stats.stale }}</strong> 条 7 天前的历史补拉旧通知（不计入今日逾期）</span>
        </div>
        <div class="stale-actions">
          <button class="btn-link" @click="switchTab('stale')">查看旧通知</button>
          <button class="btn-link" :disabled="busy" @click="applyStatusToTasks(stalePending, 'cancelled', '历史旧通知批量忽略')">
            一键全部忽略
          </button>
        </div>
      </div>

      <div v-if="otherPending.length" class="other-wrap">
        <button class="other-trigger" @click="showOther = !showOther">
          <span>{{ showOther ? '▾' : '▸' }}</span>
          <span>另有 <strong class="num">{{ otherPending.length }}</strong> 条明确属于他人的事项（不计入本人案头）</span>
        </button>

        <div v-if="showOther" class="card other-box">
          <div v-for="task in otherPending" :key="task.id" class="entry-row">
            <div class="entry-left">
              <div class="entry-body" @click="toggleExpand(task)">
                <div class="entry-title-row">
                  <span class="entry-title">{{ task.title }}</span>
                  <span class="tag-pill">他人事项</span>
                </div>
                <div class="entry-meta muted">
                  <span>{{ convTitle(task) }}</span>
                  <span v-if="task.responsible">· 负责人：{{ task.responsible }}</span>
                </div>
              </div>
            </div>
            <div class="entry-right">
              <button class="row-btn" @click="applyStatusToTasks([task], 'cancelled', '移入已忽略')">忽略 ×</button>
            </div>
          </div>
        </div>
      </div>

      <div class="motto-lockup">
        <span class="motto-rule" aria-hidden="true"></span>
        <p class="motto-line">消息有出处 · 事情有着落</p>
        <span class="motto-rule" aria-hidden="true"></span>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.planner-spread {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 卷首宋韵画匣 */
.hero-plaque {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 20px 24px;
  border-radius: 10px;
  border: 1px solid var(--book-frame);
  background:
    linear-gradient(135deg, rgba(255, 253, 248, 0.96) 0%, rgba(247, 241, 228, 0.9) 100%);
  box-shadow: var(--shadow-float);
}

.hero-plaque::before {
  content: "";
  position: absolute;
  inset: 4px;
  border: 1px solid rgba(213, 199, 173, 0.45);
  border-radius: 7px;
  pointer-events: none;
}

.hero-ink-art {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 440px;
  height: 120px;
  pointer-events: none;
}

.head-date-block {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.date-line {
  font-size: 12.5px;
  color: var(--ink-2);
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.shichen-stamp {
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--seal);
  color: #fdf8f2;
  letter-spacing: 0.08em;
}

.lunar-text { color: var(--pine); font-weight: 600; }
.shichen-phrase { color: var(--ink-3); font-family: var(--font-display); font-size: 13.5px; }

.title-lockup {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.planner-title {
  font-family: var(--font-display);
  font-size: 36px;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1.1;
  color: var(--ink);
}

.vertical-seal {
  writing-mode: vertical-rl;
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: 0.14em;
  line-height: 1;
  padding: 4px 3px;
  border: 1px solid rgba(184, 51, 34, 0.6);
  border-radius: 2px;
  color: var(--seal);
  background: rgba(251, 234, 230, 0.7);
  user-select: none;
  align-self: center;
}

.hero-sub {
  font-size: 13px;
  color: var(--ink-3);
  margin-left: 4px;
}

.head-right {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.bookmark-metrics {
  display: inline-flex;
  align-items: stretch;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 8px;
  border: 1px solid var(--hairline-strong);
  background: rgba(255, 253, 248, 0.92);
  box-shadow: 0 2px 6px rgba(22, 31, 26, 0.04), 0 1px 0 #fff inset;
}

.metric-chip {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 6px 14px;
  border-radius: 6px;
  transition: all 0.15s var(--ease);
  white-space: nowrap;
}
.metric-chip:hover { background: var(--paper-soft); }
.metric-chip.active {
  background: var(--pine-wash);
}
.metric-chip.active::after {
  content: "";
  position: absolute;
  bottom: 2px;
  left: 14px;
  right: 14px;
  height: 2px;
  border-radius: 2px;
  background: var(--pine);
}

.metric-k { font-size: 11.5px; color: var(--ink-3); }
.metric-v { font-size: 20px; font-weight: 700; color: var(--pine); line-height: 1.05; }
.v-ochre { color: var(--ochre); }
.v-seal { color: var(--seal); }

.metric-div { width: 1px; margin: 6px 0; background: var(--hairline); }
.write-btn { padding: 10px 18px; font-size: 14px; }

/* 内联新建待办栏 */
.quick-create-box {
  padding: 16px 20px 16px 26px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.qc-top, .qc-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.qc-title-input { flex: 2; min-width: 220px; }
.qc-desc-input { flex: 1; min-width: 200px; }
.qc-date-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.qc-date-input { width: 138px; padding: 6px 9px; }
.qc-time-input { width: 108px; padding: 6px 9px; }
.qc-actions { display: flex; gap: 6px; margin-left: auto; }

.mini-date-pill {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong);
  background: var(--paper);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  transition: all 0.14s;
}
.mini-date-pill:hover {
  border-color: var(--pine-border);
  background: var(--pine-wash);
  color: var(--pine);
}

/* 线装主卷 */
.planner-sheet {
  padding-left: 16px;
  overflow: hidden;
}

.sheet-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 22px 10px;
  border-bottom: 1px solid var(--hairline-strong);
  background: linear-gradient(180deg, rgba(249, 245, 235, 0.7) 0%, rgba(255, 253, 248, 0.4) 100%);
  flex-wrap: wrap;
}

.ink-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.ink-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13.5px;
  color: var(--ink-2);
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s var(--ease);
}
.ink-tab:hover { color: var(--ink); background: rgba(239, 232, 216, 0.5); }
.ink-tab.active {
  color: var(--pine);
  font-weight: 600;
  background: var(--pine-wash);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.7) inset;
}

.tab-pill {
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(22, 31, 26, 0.06);
  color: var(--ink-2);
}
.ink-tab.active .tab-pill {
  background: var(--pine);
  color: #faf7f0;
}
.tab-pill.pill-ochre {
  background: var(--ochre-wash);
  color: var(--ochre);
  border: 1px solid var(--ochre-border);
}

.search-capsule {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--hairline-strong);
  border-radius: 999px;
  background: var(--paper-card);
  padding: 5px 12px;
  width: min(240px, 100%);
  box-shadow: 0 1px 2px rgba(22, 31, 26, 0.03) inset;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.search-capsule:focus-within {
  border-color: var(--pine);
  box-shadow: 0 0 0 3px rgba(27, 73, 56, 0.1);
}
.search-glyph { font-size: 14px; line-height: 1; }
.bare-input { border: 0; background: transparent; outline: none; font-size: 13px; width: 100%; min-width: 0; }
.clear-x { font-size: 15px; color: var(--ink-3); padding: 0 3px; }
.clear-x:hover { color: var(--ink); }

/* 顶部多选批量执行栏 */
.selection-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 22px;
  background: linear-gradient(90deg, var(--pine-wash) 0%, rgba(228, 239, 232, 0.65) 100%);
  border-bottom: 1px solid var(--pine-border);
  font-size: 13px;
  flex-wrap: wrap;
}

.sel-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sel-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

/* 撤销提示栏 */
.undo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 22px;
  background: var(--ochre-wash);
  border-bottom: 1px solid var(--ochre-border);
  font-size: 13px;
  color: #6b470f;
}

.undo-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 批注栏 */
.colophon-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 22px;
  font-size: 12.5px;
  background: rgba(239, 232, 216, 0.42);
  border-bottom: 1px solid var(--hairline);
}

.select-all-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-2);
  padding-right: 10px;
  margin-right: 4px;
  border-right: 1px solid var(--hairline-strong);
}
.select-all-link:hover { color: var(--pine); }

.mini-circle {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1.5px solid var(--hairline-strong);
  background: var(--paper-card);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #fff;
}
.mini-circle.checked { background: var(--pine); border-color: var(--pine); }

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
.colophon-tag.tag-err { border-color: var(--seal-border); background: var(--seal-wash); color: var(--seal); }
.colophon-conv { font-weight: 600; color: var(--ink); }
.colophon-desc { flex: 1; min-width: 160px; }
.colophon-more { margin-left: auto; font-size: 12px; }

.colophon-history {
  padding: 8px 22px 10px;
  border-bottom: 1px solid var(--hairline);
  background: rgba(239, 232, 216, 0.25);
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}
.colophon-hist-row { display: flex; gap: 8px; flex-wrap: wrap; }

/* 条目列表 */
.entries { display: flex; flex-direction: column; }

.entry-block {
  position: relative;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.16s var(--ease);
}
.entry-block:last-child { border-bottom: 0; }

/* 左侧优先级色签细条 */
.entry-block::before {
  content: "";
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: transparent;
  transition: background 0.16s;
}
.entry-block.state-overdue::before { background: var(--seal); }
.entry-block.state-today::before { background: var(--ochre); }
.entry-block.state-soon::before { background: var(--pine); }
.entry-block:hover::before { background: var(--pine-border); }
.entry-block.state-overdue:hover::before { background: var(--seal); }

.entry-block.is-overdue { background: rgba(184, 51, 34, 0.026); }
.entry-block.is-selected { background: rgba(27, 73, 56, 0.06); }
.entry-block.is-expanded { background: rgba(239, 232, 216, 0.55); }

.entry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 22px;
}
.entry-row:hover { background: rgba(239, 232, 216, 0.36); }

.entry-left {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  min-width: 0;
  flex: 1;
}

/* 唯一圆圈：双环墨韵多选框 */
.select-circle {
  margin-top: 2px;
  width: 21px;
  height: 21px;
  border-radius: 50%;
  border: 1.5px solid var(--hairline-strong);
  background: var(--paper-card);
  box-shadow: 0 1px 2px rgba(22, 31, 26, 0.05);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  transition: all 0.15s var(--ease);
}
.select-circle:hover {
  border-color: var(--pine);
  background: var(--pine-wash);
  color: var(--pine);
  box-shadow: 0 0 0 3px rgba(27, 73, 56, 0.1);
}
.select-circle.checked {
  background: var(--pine);
  border-color: var(--pine);
  color: #faf7f0;
  box-shadow: 0 2px 5px rgba(27, 73, 56, 0.25);
}

.entry-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}

.entry-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.entry-title {
  font-size: 15.5px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.45;
  letter-spacing: 0.01em;
}
.entry-body:hover .entry-title { color: var(--pine); }
.is-done .entry-title { color: var(--ink-3); text-decoration: line-through; font-weight: 400; }

.seal-stamp {
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
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
  border-radius: 3px;
  border: 1px solid var(--ochre);
  color: var(--ochre);
  background: var(--ochre-wash);
  white-space: nowrap;
}

.tag-pill {
  font-size: 11.5px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong);
  background: var(--paper-soft);
  color: var(--ink-2);
  white-space: nowrap;
}
.tag-ochre { background: var(--ochre-wash); border-color: var(--ochre-border); color: var(--ochre); }
.tag-pine { background: var(--pine-wash); border-color: var(--pine-border); color: var(--pine); }

.entry-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--ink-2);
  flex-wrap: wrap;
}

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.plat-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  line-height: 1.3;
}
.plat-wx { background: var(--wx-wash); color: var(--wx); border: 1px solid var(--wx-border); }
.plat-qq { background: var(--qq-wash); color: var(--qq); border: 1px solid var(--qq-border); }
.plat-manual { background: var(--paper-soft); color: var(--ink-2); border: 1px solid var(--hairline-strong); }

.source-name { font-weight: 500; color: var(--ink-2); }

.entry-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.entry-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* 日历签样式截止时间牌 */
.due-ticket {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: rgba(246, 241, 229, 0.55);
  text-align: right;
  cursor: pointer;
  transition: border-color 0.14s, background 0.14s;
}
.due-ticket:hover { border-color: var(--hairline-strong); background: var(--paper-soft); }
.due-ticket.ticket-overdue { border-color: var(--seal-border); background: rgba(251, 234, 230, 0.55); }
.due-ticket.ticket-today { border-color: var(--ochre-border); background: rgba(250, 240, 218, 0.55); }

.due-main {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.due-overdue { color: var(--seal); }
.due-today { color: var(--ochre); }
.due-soon { color: var(--pine); }
.due-unknown { color: var(--ink-2); font-weight: 500; }
.due-sub { font-size: 11px; white-space: nowrap; }

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.row-btn {
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--hairline-strong);
  background: linear-gradient(180deg, #fffefb 0%, #f5efe2 100%);
  color: var(--ink-2);
  white-space: nowrap;
  box-shadow: 0 1px 2px rgba(22, 31, 26, 0.03), 0 1px 0 #fff inset;
  transition: all 0.14s var(--ease);
}
.row-btn:hover:not(:disabled) {
  background: var(--paper-soft);
  color: var(--ink);
}
.row-btn-done:hover:not(:disabled) {
  background: var(--pine-wash);
  border-color: var(--pine-border);
  color: var(--pine);
}
.row-btn-ignore:hover:not(:disabled) {
  background: var(--seal-wash);
  border-color: var(--seal-border);
  color: var(--seal);
}
.row-btn-expand.active {
  background: var(--pine);
  border-color: var(--pine);
  color: #faf7f0;
  box-shadow: none;
}

/* 原地内联展开批注笺 */
.inline-drawer {
  padding: 16px 22px 18px 54px;
  border-top: 1px dashed var(--hairline-strong);
  background:
    linear-gradient(180deg, rgba(246, 241, 229, 0.72) 0%, rgba(255, 253, 248, 0.9) 100%);
}

.drawer-grid {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 20px;
}

.drawer-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.drawer-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.drawer-head-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.drawer-seal {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--seal);
  color: #fdf8f2;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.drawer-seal.seal-pine { background: var(--pine); }

.drawer-col-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.drawer-note { font-size: 12.5px; padding: 8px 0; }

.inline-sources {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 230px;
  overflow-y: auto;
}

.inline-source-card {
  padding: 10px 13px;
  border-radius: var(--radius-sm);
  background: var(--paper-card);
  border: 1px solid var(--hairline-strong);
  border-left: 3px solid var(--pine);
  box-shadow: var(--shadow-sm);
}

.inline-source-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 5px;
}

.sender-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sender-monogram {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--pine-wash);
  border: 1px solid var(--pine-border);
  color: var(--pine);
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.inline-source-text {
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.inline-questions {
  font-size: 12px;
  color: var(--ochre);
  background: var(--ochre-wash);
  border: 1px solid var(--ochre-border);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
}
.q-label { font-weight: 600; }

.quick-date-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.inline-edit-row {
  display: grid;
  grid-template-columns: 1.1fr 0.9fr 1fr;
  gap: 7px;
}

.inline-edit-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}
.inline-edit-right { display: flex; gap: 6px; }

/* 宣纸留白空态 */
.zen-empty {
  padding: 60px 24px 66px;
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
  border: 1.5px solid rgba(184, 51, 34, 0.58);
  border-radius: 3px;
  color: var(--seal);
  background: rgba(251, 234, 230, 0.45);
  margin-bottom: 4px;
}

.zen-title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink);
}

.zen-desc {
  font-size: 13px;
  color: var(--ink-3);
  max-width: 420px;
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
  gap: 12px;
  padding: 4px 4px;
}

.stale-notice-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 15px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--hairline-strong);
  background: rgba(255, 253, 248, 0.78);
  font-size: 12.5px;
  color: var(--ink-2);
  flex-wrap: wrap;
}

.stale-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stale-seal {
  font-family: var(--font-display);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--hairline-strong);
  background: var(--paper-soft);
  color: var(--ink-2);
}

.stale-actions { display: flex; gap: 14px; }

.other-wrap { display: flex; flex-direction: column; gap: 8px; }
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

.motto-lockup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding-top: 6px;
}

.motto-rule {
  width: 48px;
  height: 1px;
  background: var(--hairline-strong);
}

.motto-line {
  text-align: center;
  font-family: var(--font-display);
  font-size: 13.5px;
  letter-spacing: 0.24em;
  color: var(--ink-3);
  opacity: 0.85;
}

@media (max-width: 820px) {
  .hero-plaque { padding: 16px; }
  .planner-title { font-size: 28px; }
  .planner-sheet { padding-left: 8px; }
  .sheet-toolbar { padding: 10px 14px; }
  .search-capsule { width: 100%; }
  .colophon-bar, .selection-bar, .undo-bar { padding: 8px 14px; }
  .entry-row {
    flex-direction: column;
    align-items: stretch;
    padding: 13px 14px;
    gap: 8px;
  }
  .entry-right {
    justify-content: space-between;
    padding-left: 34px;
    flex-wrap: wrap;
  }
  .due-ticket { align-items: flex-start; text-align: left; }
  .inline-drawer { padding: 12px 14px; }
  .drawer-grid { grid-template-columns: 1fr; }
  .inline-edit-row { grid-template-columns: 1fr; }
}
</style>
