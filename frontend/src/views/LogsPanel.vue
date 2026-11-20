<script setup>
import { ref, watch } from 'vue';
import { api } from '../api.js';
import { formatTime } from '../utils/format.js';

const emit = defineEmits(['toast']);

const platform = ref('');
const level = ref('');
const q = ref('');
const excludeRoutine = ref(true);
const page = ref(1);
const loading = ref(false);
const data = ref({ items: [], total: 0, pageSize: 30, hasMore: false });

async function load(reset = false) {
  if (reset) page.value = 1;
  loading.value = true;
  try {
    const params = new URLSearchParams({
      paged: '1',
      page: String(page.value),
      pageSize: '30',
      excludeRoutine: excludeRoutine.value ? '1' : '0'
    });
    if (platform.value) params.set('platform', platform.value);
    if (level.value) params.set('level', level.value);
    if (q.value.trim()) params.set('q', q.value.trim());
    data.value = await api(`/api/logs?${params.toString()}`);
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    loading.value = false;
  }
}

watch([platform, level, excludeRoutine], () => load(true), { immediate: true });

function levelLabel(lv) {
  if (lv >= 50) return { text: '错误', cls: 'badge-seal' };
  if (lv >= 40) return { text: '警告', cls: 'badge-ochre' };
  return { text: '信息', cls: '' };
}
</script>

<template>
  <div class="logs-panel card">
    <form class="logs-toolbar" @submit.prevent="load(true)">
      <select v-model="platform" class="select narrow-select">
        <option value="">全部平台</option>
        <option value="wechat">微信</option>
        <option value="qq">QQ</option>
      </select>
      <select v-model="level" class="select narrow-select">
        <option value="">全部级别</option>
        <option value="warn">警告</option>
        <option value="error">错误</option>
        <option value="info">普通信息</option>
      </select>
      <input v-model="q" class="input logs-search" placeholder="搜索事件、接口路由或错误代码…" />
      <label class="toggle-check">
        <input v-model="excludeRoutine" type="checkbox" />
        <span>隐藏空定时记录</span>
      </label>
      <button type="submit" class="btn btn-secondary btn-sm" :disabled="loading">刷新</button>
    </form>

    <div v-if="loading && !data.items.length" class="muted center-note">正在读取运行日志…</div>
    <div v-else-if="!data.items.length" class="muted center-note">当前筛选条件下没有日志记录。</div>
    <div v-else class="log-table">
      <div v-for="(row, idx) in data.items" :key="idx" class="log-row">
        <time class="log-time muted num">{{ formatTime(row.time, true) }}</time>
        <span class="badge" :class="levelLabel(row.level).cls">{{ levelLabel(row.level).text }}</span>
        <span v-if="row.platform" class="badge" :class="row.platform === 'wechat' ? 'badge-wx' : 'badge-qq'">
          {{ row.platform === 'wechat' ? '微信' : 'QQ' }}
        </span>
        <div class="log-main">
          <span class="log-msg">{{ row.msg }}</span>
          <span v-if="row.detail" class="log-detail muted">· {{ row.detail }}</span>
          <span v-if="row.route" class="log-code">{{ row.route }}</span>
          <span v-if="row.code" class="log-code">{{ row.code }}</span>
          <span v-if="row.job" class="log-code">{{ row.job }}</span>
          <span v-if="row.status" class="log-code">{{ row.status }}</span>
          <span v-if="row.count !== undefined" class="muted num">数量 {{ row.count }}</span>
        </div>
      </div>
    </div>

    <div v-if="data.total > 0" class="logs-pager">
      <span class="muted">共 <strong class="num">{{ data.total }}</strong> 条 · 第 <strong class="num">{{ page }}</strong> 页</span>
      <div class="pager-btns">
        <button class="btn btn-secondary btn-sm" :disabled="page <= 1 || loading" @click="page--; load()">上一页</button>
        <button class="btn btn-secondary btn-sm" :disabled="!data.hasMore || loading" @click="page++; load()">下一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logs-panel {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.logs-toolbar {
  padding: 12px 14px;
  border-bottom: 1px solid var(--hairline);
  background: var(--paper);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.narrow-select { width: 118px; flex-shrink: 0; }
.logs-search { flex: 1; min-width: 170px; }

.toggle-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
  white-space: nowrap;
  cursor: pointer;
}
.toggle-check input { accent-color: var(--pine); }

.log-table {
  display: flex;
  flex-direction: column;
}

.log-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--hairline);
  font-size: 13px;
  flex-wrap: wrap;
}
.log-row:last-child { border-bottom: 0; }
.log-row:hover { background: var(--paper); }

.log-time { font-size: 12px; width: 122px; flex-shrink: 0; }

.log-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 200px;
}

.log-msg { font-weight: 500; color: var(--ink); }
.log-detail { font-size: 12.5px; }

.log-code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--paper-soft);
  color: var(--ink-2);
}

.logs-pager {
  padding: 10px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--paper);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
}

.pager-btns { display: flex; gap: 6px; }
.center-note { text-align: center; padding: 28px 12px; font-size: 13px; }
</style>
