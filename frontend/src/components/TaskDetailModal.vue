<script setup>
import { ref, watch } from 'vue';
import { api } from '../api.js';
import { formatTime, formatDue } from '../utils/format.js';

const props = defineProps({
  taskId: { type: String, default: '' },
  mode: { type: String, default: 'edit' } // 'edit' | 'create'
});
const emit = defineEmits(['close', 'saved', 'toast']);

const loading = ref(false);
const saving = ref(false);
const task = ref(null);
const sources = ref([]);
const form = ref({
  title: '',
  dueDate: '',
  dueTime: '',
  obligation: 'required',
  relevance: 'mine',
  status: 'pending',
  description: ''
});

function resetCreate() {
  task.value = null;
  sources.value = [];
  form.value = { title: '', dueDate: '', dueTime: '', obligation: 'required', relevance: 'mine', status: 'pending', description: '' };
}

async function loadTask() {
  if (props.mode === 'create' || !props.taskId) {
    resetCreate();
    return;
  }
  loading.value = true;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(props.taskId)}`);
    task.value = data.task;
    sources.value = data.sources || [];
    form.value = {
      title: data.task.title || '',
      dueDate: data.task.dueDate || '',
      dueTime: data.task.dueTime || '',
      obligation: data.task.obligation || 'required',
      relevance: data.task.relevance || 'mine',
      status: data.task.status || 'pending',
      description: data.task.description || ''
    };
  } catch (err) {
    emit('toast', err.message, 'error');
    emit('close');
  } finally {
    loading.value = false;
  }
}

watch(() => [props.taskId, props.mode], loadTask, { immediate: true });

async function submit() {
  if (!form.value.title.trim()) {
    emit('toast', '请输入任务标题', 'error');
    return;
  }
  if (form.value.dueTime && !form.value.dueDate) {
    emit('toast', '填写具体时刻前，请先选择截止日期', 'error');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      title: form.value.title.trim(),
      dueDate: form.value.dueDate || null,
      dueTime: form.value.dueTime || null,
      obligation: form.value.obligation,
      relevance: form.value.relevance,
      status: form.value.status,
      description: form.value.description,
      needsReview: false
    };
    if (props.mode === 'edit' && task.value) {
      payload.revision = task.value.revision;
      await api(`/api/tasks/${encodeURIComponent(task.value.id)}`, payload, 'PATCH');
      emit('toast', '任务已保存并确认');
    } else {
      await api('/api/tasks', payload, 'POST');
      emit('toast', '已添加待办');
    }
    emit('saved');
    emit('close');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal-card" role="dialog" aria-modal="true" :aria-label="mode === 'create' ? '添加待办' : '任务详情与来源'">
      <header class="modal-header">
        <h2 class="modal-title">{{ mode === 'create' ? '添加待办' : '任务详情与来源' }}</h2>
        <button class="modal-close" @click="$emit('close')" aria-label="关闭">×</button>
      </header>

      <div v-if="loading" class="modal-body muted">正在读取任务详情…</div>
      <form v-else class="modal-body" @submit.prevent="submit">
        <div v-if="task?.suggestedStatus" class="banner banner-ok">
          <span>AI 建议将此任务标记为「{{ task.suggestedStatus === 'done' ? '已完成' : '已取消' }}」，保存前请核对下方状态。</span>
        </div>

        <label class="field">
          <span class="field-label">任务标题</span>
          <input v-model="form.title" class="input" maxlength="180" required placeholder="例如：提交大物实验报告" />
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label">截止日期（北京时间）</span>
            <input v-model="form.dueDate" type="date" class="input" />
          </label>
          <label class="field">
            <span class="field-label">具体时刻（可选）</span>
            <input v-model="form.dueTime" type="time" class="input" />
          </label>
        </div>

        <div class="field-row">
          <label class="field">
            <span class="field-label">优先分级</span>
            <select v-model="form.obligation" class="select">
              <option value="required">⚡ 必须完成 · 必做事项</option>
              <option value="optional">📌 普通通知 · 活动选修</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">完成状态</span>
            <select v-model="form.status" class="select">
              <option value="pending">未完成</option>
              <option value="done">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span class="field-label">归属关系</span>
          <select v-model="form.relevance" class="select">
            <option value="mine">与我有关</option>
            <option value="everyone">全体适用</option>
            <option value="unclear">归属待确认</option>
            <option value="other">明确属于他人</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">要求与备注</span>
          <textarea v-model="form.description" class="textarea" rows="3" maxlength="2000" placeholder="地点、提交方式、注意事项…"></textarea>
        </label>

        <div v-if="task" class="meta-strip">
          <span class="badge">时间依据：{{ formatDue(task).basisLabel }}</span>
          <span v-if="task.responsible" class="badge">负责人：{{ task.responsible }}</span>
          <span v-if="task.kind" class="badge">{{ task.kind }}</span>
        </div>

        <div v-if="task?.questions?.length" class="section-box">
          <h3 class="section-label">AI 待确认疑问</h3>
          <ul class="plain-list">
            <li v-for="(q, idx) in task.questions" :key="idx">{{ q }}</li>
          </ul>
        </div>

        <div v-if="sources.length" class="section-box">
          <h3 class="section-label">来源原话（{{ sources.length }} 条）</h3>
          <div class="source-list">
            <div v-for="msg in sources" :key="msg.id" class="source-item">
              <div class="source-meta">
                <strong>{{ msg.senderName }}</strong>
                <time>{{ formatTime(msg.sentAt, true) }}</time>
              </div>
              <p class="source-text">{{ msg.content }}</p>
            </div>
          </div>
        </div>

        <details v-if="task?.history?.length" class="history-box">
          <summary class="section-label">修改记录（{{ task.history.length }} 条）</summary>
          <ul class="plain-list history-list">
            <li v-for="(h, idx) in task.history.slice().reverse()" :key="idx">
              <span class="muted">{{ formatTime(h.at, true) }}</span> · {{ h.reason }}（原：{{ h.title }}{{ h.dueDate ? ` / ${h.dueDate}` : '' }}）
            </li>
          </ul>
        </details>

        <div class="modal-footer modal-footer-inline">
          <button type="button" class="btn btn-secondary" @click="$emit('close')">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? '保存中…' : mode === 'create' ? '添加待办' : '保存并确认' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.meta-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.section-box {
  border-top: 1.5px dashed var(--stroke-soft);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  cursor: pointer;
}

.plain-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--ink-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-item {
  padding: 10px 12px;
  border-radius: var(--sketch-radius-sm);
  background: var(--paper-soft);
  border: 1.5px dashed var(--stroke-soft);
}

.source-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ink-3);
  margin-bottom: 4px;
}

.source-text {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.history-box {
  border-top: 1.5px dashed var(--stroke-soft);
  padding-top: 10px;
}

.history-list {
  margin-top: 8px;
}

.modal-footer-inline {
  margin: 4px -18px -16px;
}
</style>
