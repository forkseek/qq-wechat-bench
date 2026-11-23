<script setup>
import { ref, computed, reactive } from 'vue';
import { api } from '../api.js';
import {
  todayBeijing,
  datePlusDays,
  todayHeading,
  lunarHeading,
  monogramChar,
  formatDue,
  formatTime,
  sortPendingTasks,
  relevanceLabel,
  isStaleHistoricalTask,
  inferTaskObligation
} from '../utils/format.js';

const props = defineProps({
  state: { type: Object, required: true }
});
const emit = defineEmits(['refresh', 'navigate', 'open-messages', 'toast']);

// 'pending'（默认分流视图：上方必做事项 + 下方普通通知）| 'required' | 'optional' | 'week' | 'done' | 'cancelled' | 'stale'
const tab = ref('pending');
const query = ref('');
const selectedIds = ref(new Set());
const busy = ref(false);
const showMoreRuns = ref(false);
const showOther = ref(false);
const optionalCollapsed = ref(false);

// 内联新建待办栏
const showQuickCreate = ref(false);
const createForm = ref({ title: '', dueDate: '', dueTime: '', obligation: 'required', description: '' });
const creating = ref(false);

// 内联展开的详情抽屉
const expandedId = ref('');
const detailCache = reactive({});

// 上一步撤销栈
const lastUndo = ref(null);

const convMap = computed(() => new Map((props.state?.conversations || []).map(c => [c.id, c])));
const allTasks = computed(() => props.state?.tasks || []);
const monitoredGroupCount = computed(() => (props.state?.conversations || []).filter(c => c.monitored).length);

const freshPending = computed(() =>
  sortPendingTasks(allTasks.value.filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t)))
);
const requiredPending = computed(() =>
  freshPending.value.filter(t => inferTaskObligation(t) === 'required')
);
const optionalPending = computed(() =>
  freshPending.value.filter(t => inferTaskObligation(t) === 'optional')
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
    required: requiredPending.value.length,
    optional: optionalPending.value.length,
    week: list.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7).length,
    overdue: requiredPending.value.filter(t => t.dueDate && t.dueDate < today).length,
    stale: stalePending.value.length,
    done: doneTasks.value.length
  };
});

function matchQuery(list) {
  const q = query.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(t => {
    const conv = convMap.value.get(t.conversationId);
    const hay = `${t.title || ''} ${t.description || ''} ${conv?.title || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

const visibleTasks = computed(() => {
  const today = todayBeijing();
  const in7 = datePlusDays(7);
  let base;
  if (tab.value === 'done') base = doneTasks.value;
  else if (tab.value === 'cancelled') base = cancelledTasks.value;
  else if (tab.value === 'stale') base = stalePending.value;
  else if (tab.value === 'required') base = requiredPending.value;
  else if (tab.value === 'optional') base = optionalPending.value;
  else if (tab.value === 'week') base = freshPending.value.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7);
  else base = [...requiredPending.value, ...optionalPending.value];
  return matchQuery(base);
});

const displaySections = computed(() => {
  if (tab.value === 'pending') {
    const reqList = matchQuery(requiredPending.value);
    const optList = matchQuery(optionalPending.value);
    return [
      {
        key: 'required',
        kind: 'required',
        title: '必须完成 · 必做事项',
        subtitle: '作业 · 实验报告 · 考试 · 汇报 · 全员硬性任务，优先处理',
        badge: '必做优先',
        items: reqList,
        collapsible: false,
        emptyText: query.value.trim() ? '未在必做事项中匹配到结果' : '太棒了，当前没有必须完成的硬性任务'
      },
      {
        key: 'optional',
        kind: 'optional',
        title: '普通通知 · 活动与选修关注',
        subtitle: '讲座 · 比赛演出报名 · 志愿招募 · 公示信息等非强制通知，按需查看或忽略',
        badge: '非强制分流',
        items: optList,
        collapsible: true,
        emptyText: query.value.trim() ? '未在普通通知中匹配到结果' : '当前没有额外的普通通知'
      }
    ];
  }
  return [
    {
      key: tab.value,
      kind: tab.value === 'required' ? 'required' : tab.value === 'optional' ? 'optional' : 'plain',
      title: '',
      subtitle: '',
      badge: '',
      items: visibleTasks.value,
      collapsible: false,
      emptyText: ''
    }
  ];
});

const allVisibleSelected = computed(() =>
  visibleTasks.value.length > 0 && visibleTasks.value.every(t => selectedIds.value.has(t.id))
);

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

function isRequired(task) {
  return inferTaskObligation(task) === 'required';
}

function switchTab(nextTab) {
  tab.value = nextTab;
  selectedIds.value = new Set();
}

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
      obligation: inferTaskObligation(task),
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
      obligation: f.obligation,
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

async function setObligation(tasksToChange, targetObligation) {
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
          obligation: targetObligation,
          needsReview: false
        }, 'PATCH');
        undoItems.push({
          id: current.id,
          prevStatus: current.status,
          prevReview: current.needsReview,
          prevObligation: inferTaskObligation(current)
        });
        selectedIds.value.delete(current.id);
        count++;
      } catch { /* ignore */ }
    }
    if (count > 0) {
      const label = targetObligation === 'required' ? '移入必做事项' : '分流为普通通知';
      lastUndo.value = { label: `已将 ${count} 项${label}`, items: undoItems };
      emit('toast', `已将 ${count} 项${label}`);
      emit('refresh');
    }
  } finally {
    busy.value = false;
  }
}

function batchChangeObligation(targetObligation) {
  const list = allTasks.value.filter(t => selectedIds.value.has(t.id));
  return setObligation(list, targetObligation);
}

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
        undoItems.push({
          id: current.id,
          prevStatus: current.status,
          prevReview: current.needsReview,
          prevObligation: inferTaskObligation(current)
        });
        selectedIds.value.delete(current.id);
        if (expandedId.value === current.id) expandedId.value = '';
        count++;
      } catch { /* ignore */ }
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
          needsReview: item.prevReview,
          ...(item.prevObligation ? { obligation: item.prevObligation } : {})
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
      obligation: f.obligation || 'required',
      description: f.description,
      relevance: 'mine',
      status: 'pending'
    }, 'POST');
    createForm.value = { title: '', dueDate: '', dueTime: '', obligation: 'required', description: '' };
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
  const parts = [`审阅 ${run.messages || 0} 条`];
  if (run.created) parts.push(`新增 ${run.created}`);
  if (run.updated) parts.push(`更新 ${run.updated}`);
  if (!run.created && !run.updated) parts.push('无新增');
  return parts.join(' · ');
}
</script>

<template>
  <section class="obsidian-workspace">
    <!-- 顶部极简标题与指令栏 -->
    <header class="ws-header">
      <div class="ws-title-col">
        <div class="ws-date-pill">
          <span class="dot dot-ok" aria-hidden="true"></span>
          <span>{{ todayHeading() }}</span>
          <span v-if="lunarText" class="ws-sep">·</span>
          <span v-if="lunarText" class="muted">{{ lunarText }}</span>
        </div>
        <div class="ws-heading-row">
          <h1 class="ws-title">今日待办</h1>
          <span class="ws-subtitle">
            必做事项 <strong class="num text-indigo">{{ stats.required }}</strong> 项 · 普通通知 <strong class="num">{{ stats.optional }}</strong> 条 · 守护 <strong class="num">{{ monitoredGroupCount }}</strong> 个群
          </span>
        </div>
      </div>

      <div class="ws-actions">
        <div class="glass-search">
          <svg class="search-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="query" class="bare-input" placeholder="检索事项、群名或关键词…" />
          <button v-if="query" class="clear-x" @click="query = ''" aria-label="清除搜索">×</button>
        </div>

        <button class="btn btn-primary create-btn" @click="showQuickCreate = !showQuickCreate">
          <span>{{ showQuickCreate ? '收起新建' : '＋ 新建待办' }}</span>
        </button>
      </div>
    </header>

    <!-- 四联液态琉璃 Bento 看板（首卡直击「必做事项」，次卡隔离「普通通知」） -->
    <div class="bento-grid" aria-label="待办分流概览">
      <button class="bento-card bento-indigo" :class="{ active: tab === 'required' || tab === 'pending' }" @click="switchTab('required')">
        <div class="bento-top">
          <span class="bento-label">必须完成 · 必做事项</span>
          <span class="bento-icon-wrap icon-indigo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </span>
        </div>
        <div class="bento-value num">{{ stats.required }}</div>
        <div class="bento-foot">全员必做与本人硬性任务</div>
      </button>

      <button class="bento-card bento-cyan" :class="{ active: tab === 'optional' }" @click="switchTab('optional')">
        <div class="bento-top">
          <span class="bento-label">普通通知 · 按需关注</span>
          <span class="bento-icon-wrap icon-cyan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </span>
        </div>
        <div class="bento-value num">{{ stats.optional }}</div>
        <div class="bento-foot">活动报名 · 讲座 · 公示分流</div>
      </button>

      <button class="bento-card bento-amber" :class="{ active: tab === 'week' }" @click="switchTab('week')">
        <div class="bento-top">
          <span class="bento-label">七日内截止</span>
          <span class="bento-icon-wrap icon-amber">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </span>
        </div>
        <div class="bento-value num">{{ stats.week }}</div>
        <div class="bento-foot">本周临近截止节点</div>
      </button>

      <button
        v-if="stats.overdue > 0"
        class="bento-card bento-rose"
        @click="switchTab('required')"
      >
        <div class="bento-top">
          <span class="bento-label">必做近期逾期</span>
          <span class="bento-icon-wrap icon-rose">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          </span>
        </div>
        <div class="bento-value num">{{ stats.overdue }}</div>
        <div class="bento-foot">7 日内已过截止的必做项</div>
      </button>

      <button
        v-else
        class="bento-card bento-emerald"
        :class="{ active: tab === 'done' }"
        @click="switchTab('done')"
      >
        <div class="bento-top">
          <span class="bento-label">已勾销完成</span>
          <span class="bento-icon-wrap icon-emerald">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <path d="M22 4 12 14.01l-3-3" />
            </svg>
          </span>
        </div>
        <div class="bento-value num">{{ stats.done }}</div>
        <div class="bento-foot">累计完成归档事项</div>
      </button>
    </div>

    <!-- 内联新建待办琉璃条 -->
    <form v-if="showQuickCreate" class="book-sheet quick-create-box" @submit.prevent="submitQuickCreate">
      <div class="qc-top">
        <input
          v-model="createForm.title"
          class="input qc-title-input"
          maxlength="180"
          required
          placeholder="输入待办标题…（例如：周五 17:00 前提交大物实验报告）"
        />
        <select v-model="createForm.obligation" class="select qc-ob-select">
          <option value="required">⚡ 必做事项</option>
          <option value="optional">📌 普通通知</option>
        </select>
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
            {{ creating ? '保存中…' : '保存待办' }}
          </button>
        </div>
      </div>
    </form>

    <!-- 分流导航与全局工具栏 -->
    <div class="book-sheet toolbar-sheet">
      <div class="panel-toolbar">
        <div class="glass-tabs" role="tablist">
          <button class="glass-tab" :class="{ active: tab === 'pending' }" @click="switchTab('pending')">
            <span>分流视图</span>
            <span class="tab-count num">{{ stats.pending }}</span>
          </button>
          <button class="glass-tab" :class="{ active: tab === 'required' }" @click="switchTab('required')">
            <span>⚡ 必做事项</span>
            <span class="tab-count num" :class="{ 'count-indigo': stats.required > 0 }">{{ stats.required }}</span>
          </button>
          <button class="glass-tab" :class="{ active: tab === 'optional' }" @click="switchTab('optional')">
            <span>普通通知</span>
            <span class="tab-count num">{{ stats.optional }}</span>
          </button>
          <button class="glass-tab" :class="{ active: tab === 'week' }" @click="switchTab('week')">
            <span>七日内</span>
            <span class="tab-count num">{{ stats.week }}</span>
          </button>
          <button class="glass-tab" :class="{ active: tab === 'done' }" @click="switchTab('done')">
            <span>已完成</span>
            <span class="tab-count num">{{ doneTasks.length }}</span>
          </button>
          <button class="glass-tab" :class="{ active: tab === 'cancelled' }" @click="switchTab('cancelled')">
            <span>已忽略</span>
            <span class="tab-count num">{{ cancelledTasks.length }}</span>
          </button>
          <button v-if="stats.stale > 0 || tab === 'stale'" class="glass-tab" :class="{ active: tab === 'stale' }" @click="switchTab('stale')">
            <span>历史旧通知</span>
            <span class="tab-count num">{{ stats.stale }}</span>
          </button>
        </div>
      </div>

      <!-- 多选批量操作栏 -->
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
            v-if="tab === 'pending' || tab === 'optional'"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            @click="batchChangeObligation('required')"
          >
            ⚡ 设为必做
          </button>
          <button
            v-if="tab === 'pending' || tab === 'required'"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            @click="batchChangeObligation('optional')"
          >
            转为通知
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

      <!-- AI 整理状态副栏 -->
      <div v-if="!state.model?.configured" class="status-strip">
        <span class="badge badge-ochre">未配 AI</span>
        <span class="muted">
          {{ state.pendingCount ? `已有 ${state.pendingCount} 条消息待分析。` : '配置 AI 模型后，群通知将自动分流为「必做事项」与「普通通知」。' }}
        </span>
        <button class="btn-link" @click="$emit('navigate', 'settings')">前往配置</button>
      </div>
      <div v-else class="status-strip">
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
          <span class="run-pill" :class="{ 'run-err': latestRun.error }">AI 同步</span>
          <span class="num muted">{{ formatTime(latestRun.at) }}</span>
          <span class="run-conv">{{ latestRun.conversation }}</span>
          <span class="run-desc muted">{{ describeRun(latestRun) }}</span>
        </template>
        <span v-if="state.pendingCount" class="badge badge-ochre">正在分析 {{ state.pendingCount }} 条消息…</span>
        <button v-if="olderRuns.length" class="btn-link run-more" @click="showMoreRuns = !showMoreRuns">
          {{ showMoreRuns ? '收起记录' : `近期记录 (${olderRuns.length})` }}
        </button>
      </div>
      <div v-if="showMoreRuns && olderRuns.length" class="run-history">
        <div v-for="(run, idx) in olderRuns" :key="idx" class="run-hist-row">
          <span class="num muted">{{ formatTime(run.at) }}</span>
          <strong>{{ run.conversation }}</strong>
          <span class="muted">{{ describeRun(run) }}</span>
        </div>
      </div>
    </div>

    <!-- 分流主列表区：默认「上方必做事项焦点卡」 + 「下方普通通知次级卡」 -->
    <div class="sections-stack">
      <div
        v-for="section in displaySections"
        :key="section.key"
        class="book-sheet glass-list-panel"
        :class="[
          section.kind === 'required' ? 'panel-required' : '',
          section.kind === 'optional' ? 'panel-optional' : ''
        ]"
      >
        <!-- 分区抬头（分流视图下清晰标明「必做事项」与「普通通知」） -->
        <div v-if="section.title" class="section-banner">
          <div class="section-banner-left">
            <span v-if="section.kind === 'required'" class="sec-icon sec-icon-req" aria-hidden="true">⚡</span>
            <span v-else class="sec-icon sec-icon-opt" aria-hidden="true">📌</span>
            <div>
              <div class="section-title-row">
                <h2 class="section-title">{{ section.title }}</h2>
                <span class="sec-count num" :class="section.kind === 'required' ? 'sec-count-req' : ''">
                  {{ section.items.length }}
                </span>
              </div>
              <p class="section-sub">{{ section.subtitle }}</p>
            </div>
          </div>

          <div class="section-banner-right">
            <button
              v-if="section.kind === 'optional' && section.items.length"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click="applyStatusToTasks(section.items, 'cancelled', '普通通知批量忽略')"
            >
              一键忽略本区
            </button>
            <button
              v-if="section.collapsible"
              class="btn btn-secondary btn-sm"
              @click="optionalCollapsed = !optionalCollapsed"
            >
              {{ optionalCollapsed ? `展开 (${section.items.length})` : '收起' }}
            </button>
          </div>
        </div>

        <!-- 条目列表 -->
        <template v-if="!(section.collapsible && optionalCollapsed)">
          <div v-if="section.items.length" class="entries">
            <div
              v-for="task in section.items"
              :key="task.id"
              class="entry-block"
              :class="[
                `state-${formatDue(task).state}`,
                isRequired(task) ? 'ob-required' : 'ob-optional',
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
                  <button
                    type="button"
                    class="select-circle"
                    :class="{ checked: selectedIds.has(task.id) }"
                    :aria-label="`选择 ${task.title}`"
                    title="点击选择（支持多选批量完成、分流、忽略或删除）"
                    @click.stop="toggleSelect(task.id)"
                  >
                    <span v-if="selectedIds.has(task.id)">✓</span>
                  </button>

                  <div class="entry-body" @click="toggleExpand(task)">
                    <div class="entry-title-row">
                      <span v-if="isRequired(task) && task.status === 'pending'" class="ob-pill ob-pill-req">必做</span>
                      <span v-else-if="task.status === 'pending'" class="ob-pill ob-pill-opt">通知</span>
                      <span class="entry-title">{{ task.title }}</span>
                      <span v-if="formatDue(task).state === 'overdue' && tab !== 'stale'" class="badge badge-seal">逾期</span>
                      <span v-else-if="formatDue(task).state === 'today'" class="badge badge-ochre">今日</span>
                      <span v-if="tab === 'stale'" class="badge">历史补拉</span>
                      <span v-else-if="task.needsReview && task.status === 'pending'" class="badge badge-ochre">待确认</span>
                      <span v-if="task.relevance === 'unclear'" class="badge">{{ relevanceLabel(task.relevance) }}</span>
                      <span v-if="task.suggestedStatus === 'done' && task.status === 'pending'" class="badge badge-pine">建议完成</span>
                    </div>

                    <div class="entry-meta">
                      <span class="source-chip">
                        <span
                          v-if="convPlatform(task)"
                          class="plat-tag"
                          :class="convPlatform(task) === 'wechat' ? 'plat-wx' : 'plat-qq'"
                        >
                          {{ convPlatform(task) === 'wechat' ? '微信' : 'QQ' }}
                        </span>
                        <span v-else class="plat-tag plat-manual">手记</span>
                        <span class="source-name">{{ convTitle(task) }}</span>
                      </span>
                      <span v-if="task.sourceAt" class="muted">· {{ formatTime(task.sourceAt) }}</span>
                      <span v-if="task.description" class="entry-desc muted">· {{ task.description }}</span>
                    </div>
                  </div>
                </div>

                <div class="entry-right">
                  <div class="due-chip" :class="`chip-${formatDue(task).state}`" @click="toggleExpand(task)">
                    <span class="due-main num" :class="`due-${formatDue(task).state}`" :title="formatDue(task).text">
                      {{ formatDue(task).text }}
                    </span>
                    <span class="due-sub muted">
                      {{ formatDue(task).tag ? `${formatDue(task).tag} · ` : '' }}{{ formatDue(task).basisLabel }}
                    </span>
                  </div>

                  <div class="row-actions">
                    <template v-if="task.status === 'pending'">
                      <button
                        v-if="!isRequired(task)"
                        class="row-btn row-btn-promote"
                        :disabled="busy"
                        title="提升为必做事项"
                        @click.stop="setObligation([task], 'required')"
                      >
                        ↑ 必做
                      </button>
                      <button
                        v-else
                        class="row-btn row-btn-demote"
                        :disabled="busy"
                        title="这不是硬性必做，降为普通通知"
                        @click.stop="setObligation([task], 'optional')"
                      >
                        ↓ 通知
                      </button>
                      <button
                        class="row-btn row-btn-done"
                        :disabled="busy"
                        title="标记为已完成"
                        @click.stop="applyStatusToTasks([task], 'done', '标记为已完成')"
                      >
                        ✓ 完成
                      </button>
                      <button
                        class="row-btn row-btn-ignore"
                        :disabled="busy"
                        title="忽略 / 不参加"
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
                      title="展开来源群原话与快捷改期"
                      @click.stop="toggleExpand(task)"
                    >
                      {{ expandedId === task.id ? '收起 ▴' : '原话 ▾' }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 原地内联玻璃详情抽屉 -->
              <div v-if="expandedId === task.id && detailCache[task.id]" class="inline-drawer">
                <div class="drawer-grid">
                  <div class="drawer-col">
                    <div class="drawer-col-head">
                      <h3 class="drawer-col-title">来源群原话</h3>
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
                            <span class="sender-avatar">{{ monogramChar(msg.senderName) }}</span>
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

                  <form class="drawer-col drawer-edit" @submit.prevent="saveInlineEdit(task)">
                    <div class="drawer-col-head">
                      <h3 class="drawer-col-title">快捷改期与分流微调</h3>
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
                      <select v-model="detailCache[task.id].form.obligation" class="select">
                        <option value="required">⚡ 必做事项</option>
                        <option value="optional">📌 普通通知</option>
                      </select>
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

          <!-- 分区空态 -->
          <div v-else-if="section.title" class="section-empty">
            <span class="sec-empty-icon">{{ section.kind === 'required' ? '✓' : '—' }}</span>
            <span>{{ section.emptyText }}</span>
          </div>

          <!-- 单列表视图空态 -->
          <div v-else class="empty-state">
            <div class="empty-mark">✦</div>
            <h2 class="empty-title">
              {{
                query ? '没有匹配的事项'
                : tab === 'required' ? '当前没有必须完成的硬性事项'
                : tab === 'optional' ? '当前没有额外的普通通知'
                : tab === 'done' ? '暂无已完成事项'
                : tab === 'cancelled' ? '暂无已忽略的通知'
                : tab === 'stale' ? '没有积压的历史旧通知'
                : '当前一切井然有序'
              }}
            </h2>
            <p class="empty-desc">
              {{
                query ? '可以尝试更换关键词，或切换上方标签页查看。'
                : '已关注的 QQ 与微信群收到新通知后会自动分流为「必做事项」与「普通通知」。'
              }}
            </p>
            <div class="empty-actions">
              <button v-if="!query && (tab === 'required' || tab === 'pending')" class="btn btn-primary" @click="showQuickCreate = true">＋ 新建一条必做</button>
              <button v-if="stats.stale > 0 && tab !== 'stale'" class="btn btn-secondary" @click="switchTab('stale')">
                查看 {{ stats.stale }} 条历史旧通知
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 底部提示：历史旧通知 + 他人事项 -->
    <footer class="ws-footer">
      <div v-if="stats.stale > 0 && tab !== 'stale'" class="stale-notice-bar">
        <div class="stale-left">
          <span class="badge">历史归档</span>
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
          <span>另有 <strong class="num">{{ otherPending.length }}</strong> 条明确属于他人的事项（不计入本人待办）</span>
        </button>

        <div v-if="showOther" class="card other-box">
          <div v-for="task in otherPending" :key="task.id" class="entry-row">
            <div class="entry-left">
              <div class="entry-body" @click="toggleExpand(task)">
                <div class="entry-title-row">
                  <span class="entry-title">{{ task.title }}</span>
                  <span class="badge">他人事项</span>
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
    </footer>
  </section>
</template>

<style scoped>
.obsidian-workspace {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.ws-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.ws-title-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-date-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 4px 13px;
  border-radius: var(--sketch-radius-pill);
  background: #ffffff;
  border: 1.75px solid var(--stroke);
  box-shadow: 2px 2px 0 var(--stroke);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.ws-sep { opacity: 0.45; }

.ws-heading-row {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}

.ws-title {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
  padding: 0 8px;
  background: linear-gradient(180deg, transparent 54%, var(--marker-yellow) 54%, var(--marker-yellow) 92%, transparent 92%);
}

.ws-subtitle { font-size: 13px; color: var(--ink-2); font-weight: 600; }
.text-indigo { color: var(--pine); }

.ws-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.glass-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  border-radius: var(--sketch-radius-pill);
  background: #ffffff;
  border: 2px solid var(--stroke);
  box-shadow: 2.5px 2.5px 0 var(--stroke);
  width: 240px;
  transition: box-shadow 0.14s;
}
.glass-search:focus-within {
  box-shadow: 3.5px 3.5px 0 var(--stroke), 0 0 0 3px var(--marker-yellow);
}
.search-svg { width: 15px; height: 15px; color: var(--ink); flex-shrink: 0; }
.bare-input { border: 0; background: transparent; outline: none; font-size: 13px; width: 100%; min-width: 0; color: var(--ink); }
.bare-input::placeholder { color: var(--ink-3); }
.clear-x { font-size: 15px; font-weight: 700; color: var(--ink-2); padding: 0 3px; }
.clear-x:hover { color: var(--seal); }
.create-btn { padding: 8px 17px; font-size: 13.5px; }

/* 四联手绘彩铅便利贴 Bento 看板 */
.bento-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.bento-card {
  position: relative;
  text-align: left;
  padding: 18px 18px 15px;
  border-radius: var(--sketch-radius);
  border: 2px solid var(--stroke);
  box-shadow: 4px 4px 0 var(--stroke);
  display: flex;
  flex-direction: column;
  gap: 7px;
  transition: transform 0.16s var(--ease), box-shadow 0.16s var(--ease);
}

/* 顶部半透明纸胶带装饰 */
.bento-card::before {
  content: "";
  position: absolute;
  top: -7px;
  left: 50%;
  transform: translateX(-50%) rotate(-2deg);
  width: 48px;
  height: 13px;
  background: rgba(255, 255, 255, 0.7);
  border: 1.5px solid rgba(35, 33, 30, 0.35);
  pointer-events: none;
}

.bento-indigo { background: var(--marker-lavender); transform: rotate(-0.7deg); }
.bento-cyan { background: var(--marker-sky); transform: rotate(0.6deg); }
.bento-amber { background: #fef9c3; transform: rotate(-0.5deg); }
.bento-emerald { background: var(--marker-mint); transform: rotate(0.6deg); }
.bento-rose { background: var(--marker-rose); transform: rotate(0.6deg); }

.bento-card:hover {
  transform: translate(-1px, -2px) rotate(0deg);
  box-shadow: 6px 6px 0 var(--stroke);
}
.bento-card.active {
  transform: rotate(0deg);
  box-shadow: 5px 5px 0 var(--stroke), 0 0 0 3px var(--marker-yellow-deep);
}

.bento-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bento-label { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--ink); }
.bento-icon-wrap {
  width: 30px;
  height: 30px;
  border-radius: var(--sketch-circle);
  border: 1.75px solid var(--stroke);
  background: #ffffff;
  color: var(--ink);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 2px 2px 0 var(--stroke);
}
.bento-icon-wrap svg { width: 15px; height: 15px; }
.icon-indigo { color: var(--pine); }
.icon-cyan { color: var(--qq); }
.icon-amber { color: var(--ochre); }
.icon-emerald { color: var(--wx); }
.icon-rose { color: var(--seal); }

.bento-value { font-size: 34px; font-weight: 700; line-height: 1.05; color: var(--ink); }
.bento-foot { font-size: 11.5px; color: var(--ink-2); font-weight: 600; }

/* 内联新建栏 */
.quick-create-box { padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; background: #fffef7; }
.qc-top, .qc-bottom { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.qc-title-input { flex: 2; min-width: 200px; }
.qc-ob-select { width: 136px; flex-shrink: 0; }
.qc-desc-input { flex: 1; min-width: 200px; }
.qc-date-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.qc-date-input { width: 140px; padding: 6px 9px; }
.qc-time-input { width: 110px; padding: 6px 9px; }
.qc-actions { display: flex; gap: 6px; margin-left: auto; }

.mini-date-pill {
  padding: 4px 10px;
  border-radius: var(--sketch-radius-pill);
  border: 1.5px solid var(--stroke);
  background: #ffffff;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  box-shadow: 1.5px 1.5px 0 var(--stroke);
  transition: all 0.12s;
}
.mini-date-pill:hover { background: var(--marker-yellow); transform: translate(-1px, -1px); box-shadow: 2.5px 2.5px 0 var(--stroke); }

/* 顶部工具条手账卡 */
.toolbar-sheet { overflow: hidden; }
.panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 18px;
  border-bottom: 2px dashed var(--hairline);
  background: var(--paper);
  flex-wrap: wrap;
}

.glass-tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.glass-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--sketch-radius-sm);
  border: 1.75px solid transparent;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-2);
  white-space: nowrap;
  transition: all 0.14s var(--ease);
}
.glass-tab:hover { color: var(--ink); background: var(--paper-soft); border-color: var(--stroke); }
.glass-tab.active {
  color: var(--ink);
  background: var(--marker-yellow);
  border-color: var(--stroke);
  box-shadow: 2.5px 2.5px 0 var(--stroke);
}

.tab-count {
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1.5px solid var(--stroke);
  background: #ffffff;
  color: var(--ink);
}
.glass-tab.active .tab-count { background: var(--ink); color: #ffffff; }
.tab-count.count-indigo { background: var(--marker-lavender); color: var(--pine); }

.selection-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  background: var(--marker-lavender);
  border-bottom: 2px solid var(--stroke);
  font-size: 13px;
  font-weight: 700;
  flex-wrap: wrap;
}
.sel-left, .sel-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.undo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 20px;
  background: var(--marker-peach);
  border-bottom: 2px solid var(--stroke);
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
}
.undo-actions { display: flex; align-items: center; gap: 10px; }

.status-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 20px;
  font-size: 12px;
  background: #fffdf8;
}

.select-all-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  color: var(--ink);
  padding-right: 10px;
  margin-right: 4px;
  border-right: 1.5px dashed var(--hairline);
}
.select-all-link:hover { color: var(--pine); }

.mini-circle {
  width: 16px;
  height: 16px;
  border-radius: var(--sketch-circle);
  border: 1.75px solid var(--stroke);
  background: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--ink);
}
.mini-circle.checked { background: var(--marker-yellow); }

.run-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: var(--sketch-radius-pill);
  background: var(--marker-mint);
  border: 1.5px solid var(--stroke);
  color: var(--wx);
}
.run-pill.run-err { background: var(--marker-rose); color: var(--seal); }
.run-conv { font-weight: 700; color: var(--ink); }
.run-desc { flex: 1; min-width: 140px; }
.run-more { margin-left: auto; font-size: 12px; }

.run-history {
  padding: 8px 20px 10px;
  border-top: 1.5px dashed var(--hairline);
  background: var(--paper);
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}
.run-hist-row { display: flex; gap: 8px; flex-wrap: wrap; }

/* 分流双卡堆叠：上方「必做事项」实线手绘主卡 + 下方「普通通知」虚线次卡 */
.sections-stack {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.glass-list-panel { overflow: hidden; }

.panel-required {
  border: 2.25px solid var(--stroke);
  box-shadow: 6px 6px 0 var(--stroke);
  background: #ffffff;
}

.panel-optional {
  background: #fbf6e9;
  border: 2px dashed #57524a;
  box-shadow: 4px 4px 0 rgba(35, 33, 30, 0.22);
}

.section-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 20px;
  border-bottom: 2px dashed var(--hairline);
  background: var(--paper);
  flex-wrap: wrap;
}
.panel-required .section-banner {
  background: var(--marker-lavender);
  border-bottom: 2px solid var(--stroke);
}
.panel-optional .section-banner {
  background: rgba(224, 242, 254, 0.55);
  border-bottom: 2px dashed var(--hairline);
}

.section-banner-left { display: flex; align-items: center; gap: 12px; min-width: 0; }

.sec-icon {
  width: 34px;
  height: 34px;
  border-radius: var(--sketch-circle);
  border: 2px solid var(--stroke);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
  box-shadow: 2px 2px 0 var(--stroke);
}
.sec-icon-req { background: var(--marker-yellow); color: var(--ink); }
.sec-icon-opt { background: #ffffff; color: var(--qq); }

.section-title-row { display: flex; align-items: center; gap: 8px; }
.section-title { font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--ink); line-height: 1.25; }
.section-sub { font-size: 12px; color: var(--ink-2); margin-top: 2px; }

.sec-count {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 9px;
  border-radius: var(--sketch-radius-pill);
  border: 1.75px solid var(--stroke);
  background: #ffffff;
  color: var(--ink);
}
.sec-count-req { background: var(--marker-yellow); }

.section-banner-right { display: flex; align-items: center; gap: 8px; }

.section-empty {
  padding: 24px 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink-2);
}
.sec-empty-icon {
  width: 24px;
  height: 24px;
  border-radius: var(--sketch-circle);
  background: var(--marker-mint);
  border: 1.75px solid var(--stroke);
  color: var(--wx);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}

/* 任务条目（手账横虚线排版） */
.entries { display: flex; flex-direction: column; }

.entry-block {
  position: relative;
  border-bottom: 1.5px dashed var(--hairline);
  transition: background 0.14s var(--ease);
}
.entry-block:last-child { border-bottom: 0; }

.entry-block.is-overdue { background: rgba(255, 228, 230, 0.45); }
.entry-block.is-selected { background: rgba(254, 240, 138, 0.35); }
.entry-block.is-expanded { background: #fffdf5; }

.entry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
}
.entry-row:hover { background: rgba(254, 240, 138, 0.18); }

.entry-left { display: flex; align-items: flex-start; gap: 13px; min-width: 0; flex: 1; }

/* 手绘不规则圆圈多选框 */
.select-circle {
  margin-top: 2px;
  width: 22px;
  height: 22px;
  border-radius: var(--sketch-circle);
  border: 2px solid var(--stroke);
  background: #ffffff;
  box-shadow: 2px 2px 0 var(--stroke);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  flex-shrink: 0;
  transition: all 0.12s var(--ease);
}
.select-circle:hover { background: var(--marker-yellow); transform: translate(-1px, -1px); }
.select-circle.checked { background: var(--marker-mint); color: var(--wx); }

.entry-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.entry-title-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }

.ob-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: var(--sketch-radius-pill);
  border: 1.5px solid var(--stroke);
  white-space: nowrap;
  line-height: 1.4;
}
.ob-pill-req { background: var(--marker-yellow); color: var(--ink); }
.ob-pill-opt { background: var(--paper-soft); color: var(--ink-2); border-style: dashed; }

.entry-title { font-size: 15.5px; font-weight: 700; color: var(--ink); line-height: 1.45; }
.ob-optional .entry-title { color: var(--ink-2); font-weight: 600; }
.entry-body:hover .entry-title { color: var(--pine); text-decoration: underline; text-decoration-style: wavy; text-underline-offset: 3px; }
.is-done .entry-title { color: var(--ink-3); text-decoration: line-through; font-weight: 500; }

.entry-meta { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-2); flex-wrap: wrap; }
.source-chip { display: inline-flex; align-items: center; gap: 6px; }
.plat-tag {
  font-size: 10.5px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--sketch-radius-pill);
  border: 1.5px solid var(--stroke);
  line-height: 1.35;
}
.plat-wx { background: var(--marker-mint); color: var(--wx); }
.plat-qq { background: var(--marker-sky); color: var(--qq); }
.plat-manual { background: var(--marker-peach); color: var(--ochre); }
.source-name { color: var(--ink); font-weight: 600; }
.entry-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }

.entry-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

/* 手绘日历贴纸标签 */
.due-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  padding: 4px 10px;
  border-radius: var(--sketch-radius-sm);
  border: 1.75px solid var(--stroke);
  background: var(--paper);
  box-shadow: 2px 2px 0 var(--stroke);
  text-align: right;
  cursor: pointer;
  transition: transform 0.12s;
}
.due-chip:hover { transform: translate(-1px, -1px); }
.due-chip.chip-overdue { background: var(--marker-rose); }
.due-chip.chip-today { background: var(--marker-yellow); }
.due-chip.chip-soon { background: var(--marker-sky); }

.due-main { font-size: 12.5px; font-weight: 700; color: var(--ink); white-space: nowrap; max-width: 175px; overflow: hidden; text-overflow: ellipsis; }
.due-overdue { color: var(--seal); }
.due-today { color: var(--ochre); }
.due-soon { color: var(--qq); }
.due-unknown { color: var(--ink-2); font-weight: 600; }
.due-sub { font-size: 11px; white-space: nowrap; }

.row-actions { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }

.row-btn {
  padding: 4px 9px;
  border-radius: var(--sketch-radius-sm);
  font-size: 12px;
  font-weight: 700;
  border: 1.75px solid var(--stroke);
  background: #ffffff;
  color: var(--ink);
  white-space: nowrap;
  box-shadow: 2px 2px 0 var(--stroke);
  transition: all 0.12s var(--ease);
}
.row-btn:hover:not(:disabled) { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 var(--stroke); background: var(--paper-soft); }
.row-btn:active:not(:disabled) { transform: translate(1px, 1px); box-shadow: 1px 1px 0 var(--stroke); }
.row-btn-promote:hover:not(:disabled) { background: var(--marker-lavender); color: var(--pine); }
.row-btn-demote { background: var(--paper); color: var(--ink-2); border-style: dashed; box-shadow: none; }
.row-btn-demote:hover:not(:disabled) { background: var(--marker-sky); border-style: solid; color: var(--ink); }
.row-btn-done:hover:not(:disabled) { background: var(--marker-mint); color: var(--wx); }
.row-btn-ignore:hover:not(:disabled) { background: var(--marker-rose); color: var(--seal); }
.row-btn-expand.active { background: var(--marker-yellow); }

/* 内联展开手账便签夹页 */
.inline-drawer {
  padding: 16px 20px 18px 52px;
  border-top: 2px dashed var(--stroke);
  background: #fffcf0;
}
.drawer-grid { display: grid; grid-template-columns: 1.12fr 1fr; gap: 20px; }
.drawer-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.drawer-col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.drawer-col-title { font-family: var(--font-display); font-size: 15.5px; font-weight: 700; color: var(--ink); }
.drawer-note { font-size: 12.5px; padding: 8px 0; }

.inline-sources { display: flex; flex-direction: column; gap: 9px; max-height: 230px; overflow-y: auto; padding-right: 4px; }
.inline-source-card {
  padding: 10px 13px;
  border-radius: var(--sketch-radius-sm);
  background: #ffffff;
  border: 1.75px solid var(--stroke);
  box-shadow: 2.5px 2.5px 0 var(--stroke);
}
.inline-source-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 5px; }
.sender-badge { display: inline-flex; align-items: center; gap: 7px; color: var(--ink); }
.sender-avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--sketch-circle);
  background: var(--marker-sky);
  border: 1.75px solid var(--stroke);
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.inline-source-text { font-size: 13px; line-height: 1.65; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }

.inline-questions {
  font-size: 12px;
  font-weight: 600;
  color: var(--ochre);
  background: var(--ochre-wash);
  border: 1.75px dashed var(--ochre);
  padding: 7px 10px;
  border-radius: var(--sketch-radius-sm);
}
.q-label { font-weight: 700; }

.quick-date-row { display: flex; gap: 5px; flex-wrap: wrap; }
.inline-edit-row { display: grid; grid-template-columns: 1.05fr 0.85fr 0.95fr 0.95fr; gap: 7px; }
.inline-edit-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
.inline-edit-right { display: flex; gap: 6px; }
.empty-actions { margin-top: 10px; display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }

.ws-footer { display: flex; flex-direction: column; gap: 12px; }
.stale-notice-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-radius: var(--sketch-radius-sm);
  border: 2px dashed var(--stroke);
  background: #fffdf5;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-2);
  flex-wrap: wrap;
}
.stale-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stale-actions { display: flex; gap: 14px; }

.other-wrap { display: flex; flex-direction: column; gap: 8px; }
.other-trigger { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--ink-2); align-self: flex-start; }
.other-trigger:hover { color: var(--pine); }
.other-box { overflow: hidden; }

@media (max-width: 1020px) {
  .bento-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .inline-edit-row { grid-template-columns: 1fr 1fr; }
}

@media (max-width: 780px) {
  .ws-title { font-size: 26px; }
  .ws-actions { width: 100%; }
  .glass-search { flex: 1; width: auto; }
  .entry-row { flex-direction: column; align-items: stretch; padding: 13px 14px; gap: 8px; }
  .entry-right { justify-content: space-between; padding-left: 35px; flex-wrap: wrap; }
  .due-chip { align-items: flex-start; text-align: left; }
  .inline-drawer { padding: 12px 14px; }
  .drawer-grid, .inline-edit-row { grid-template-columns: 1fr; }
}
</style>
