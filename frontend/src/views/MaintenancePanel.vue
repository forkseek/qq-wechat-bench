<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import { formatTime, formatBytes } from '../utils/format.js';

const emit = defineEmits(['toast', 'refresh']);

const loading = ref(true);
const saving = ref(false);
const runningJob = ref('');
const showAllBackups = ref(false);
const snapshot = ref({
  config: { enabled: true, analysisMinutes: 5, backupHour: 4, optimizeMinutes: 60 },
  active: [],
  runs: [],
  backups: []
});
const form = ref({ enabled: true, analysisMinutes: 5, backupHour: 4, optimizeMinutes: 60 });

async function load() {
  loading.value = true;
  try {
    const res = await api('/api/maintenance');
    snapshot.value = res;
    form.value = { ...res.config };
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function saveConfig() {
  saving.value = true;
  try {
    const res = await api('/api/maintenance', {
      enabled: Boolean(form.value.enabled),
      analysisMinutes: Number(form.value.analysisMinutes),
      backupHour: Number(form.value.backupHour),
      optimizeMinutes: Number(form.value.optimizeMinutes)
    }, 'PUT');
    snapshot.value = res;
    emit('toast', '定时安排已保存');
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    saving.value = false;
  }
}

async function runJob(job) {
  runningJob.value = job;
  try {
    const res = await api('/api/maintenance/run', { job }, 'POST');
    emit('toast', res.status === 'failed' ? (res.error || '执行失败') : '处理已完成', res.status === 'failed' ? 'error' : 'info');
    await load();
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    runningJob.value = '';
  }
}

function jobLabel(job) {
  return { analysis: '消息整理', backup: '一致性备份', optimize: '检查与优化' }[job] || job;
}
</script>

<template>
  <div class="maint-wrap">
    <div class="card section-card">
      <div class="card-head">
        <div>
          <h2 class="card-title">定时安排（北京时间）</h2>
          <p class="muted card-sub">仅维护本机工作台数据库，不删除原始聊天，微信源库保持只读。</p>
        </div>
        <label class="toggle-check">
          <input v-model="form.enabled" type="checkbox" />
          <span>启用定时处理</span>
        </label>
      </div>

      <form class="sched-form" @submit.prevent="saveConfig">
        <div class="sched-grid">
          <label class="field">
            <span class="field-label">消息整理间隔（分钟，整除 60）</span>
            <select v-model.number="form.analysisMinutes" class="select">
              <option v-for="m in [5, 10, 15, 20, 30, 60]" :key="m" :value="m">每 {{ m }} 分钟</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">每日备份时间</span>
            <select v-model.number="form.backupHour" class="select">
              <option v-for="h in 24" :key="h - 1" :value="h - 1">每天 {{ String(h - 1).padStart(2, '0') }}:00</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">数据库检查与优化</span>
            <select v-model.number="form.optimizeMinutes" class="select">
              <option v-for="m in [15, 20, 30, 60]" :key="m" :value="m">每 {{ m }} 分钟</option>
            </select>
          </label>
        </div>
        <div class="sched-actions">
          <button type="submit" class="btn btn-primary btn-sm" :disabled="saving">{{ saving ? '保存中…' : '保存安排' }}</button>
        </div>
      </form>
    </div>

    <div class="card section-card">
      <h2 class="card-title">立即执行</h2>
      <div class="run-btns">
        <button class="btn btn-secondary btn-sm" :disabled="Boolean(runningJob)" @click="runJob('analysis')">
          {{ runningJob === 'analysis' ? '整理中…' : '立即整理新消息' }}
        </button>
        <button class="btn btn-secondary btn-sm" :disabled="Boolean(runningJob)" @click="runJob('backup')">
          {{ runningJob === 'backup' ? '备份中…' : '立即备份数据库' }}
        </button>
        <button class="btn btn-secondary btn-sm" :disabled="Boolean(runningJob)" @click="runJob('optimize')">
          {{ runningJob === 'optimize' ? '检查中…' : '立即检查与优化' }}
        </button>
      </div>
    </div>

    <div class="two-col">
      <div class="card section-card">
        <h2 class="card-title">最近处理记录</h2>
        <div v-if="!snapshot.runs.length" class="muted empty-line">暂无处理记录</div>
        <div v-else class="simple-list">
          <div v-for="r in snapshot.runs.slice(0, 10)" :key="r.id" class="simple-row">
            <div>
              <strong>{{ jobLabel(r.job) }}</strong>
              <span class="muted num"> · {{ formatTime(r.startedAt, true) }}</span>
              <p v-if="r.error" class="err-line">{{ r.error }}</p>
            </div>
            <span class="badge" :class="r.status === 'success' ? 'badge-pine' : r.status === 'failed' ? 'badge-seal' : 'badge-ochre'">
              {{ r.status === 'success' ? '成功' : r.status === 'failed' ? '失败' : '进行中' }}
            </span>
          </div>
        </div>
      </div>

      <div class="card section-card">
        <div class="card-head">
          <h2 class="card-title">本机备份（<span class="num">{{ snapshot.backups.length }}</span>）</h2>
          <button v-if="snapshot.backups.length > 6" class="btn btn-ghost btn-sm" @click="showAllBackups = !showAllBackups">
            {{ showAllBackups ? '收起' : `查看全部 ${snapshot.backups.length} 份` }}
          </button>
        </div>
        <div v-if="!snapshot.backups.length" class="muted empty-line">尚未生成备份</div>
        <div v-else class="simple-list">
          <div v-for="b in (showAllBackups ? snapshot.backups : snapshot.backups.slice(0, 6))" :key="b.name" class="simple-row">
            <span class="backup-name">{{ b.name }}</span>
            <span class="muted num">{{ formatBytes(b.bytes) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.maint-wrap { display: flex; flex-direction: column; gap: 14px; }
.section-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.card-title { font-family: var(--font-display); font-size: 18px; font-weight: 600; }
.card-sub { font-size: 12.5px; margin-top: 2px; }

.toggle-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; white-space: nowrap; }
.toggle-check input { accent-color: var(--pine); }

.sched-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.sched-actions { margin-top: 10px; }

.run-btns { display: flex; gap: 8px; flex-wrap: wrap; }

.two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }

.simple-list { display: flex; flex-direction: column; }
.simple-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1.5px dashed var(--stroke-soft);
  font-size: 13px;
}
.simple-row:last-child { border-bottom: 0; padding-bottom: 0; }

.backup-name {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.err-line { font-size: 12px; color: var(--seal); margin-top: 2px; }
.empty-line { font-size: 13px; }

@media (max-width: 820px) {
  .sched-grid, .two-col { grid-template-columns: 1fr; }
}
</style>
