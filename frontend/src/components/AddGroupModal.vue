<script setup>
import { ref, computed, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  initialTab: { type: String, default: 'wechat' }
});
const emit = defineEmits(['close', 'saved', 'toast']);

const tab = ref(props.initialTab);
const search = ref('');
const loading = ref(false);
const error = ref('');
const qqGroups = ref([]);
const wxGroups = ref([]);
const manualGroupId = ref('');
const busyId = ref('');

async function loadList() {
  loading.value = true;
  error.value = '';
  try {
    if (tab.value === 'qq') {
      qqGroups.value = await api('/api/qq/groups');
    } else {
      wxGroups.value = await api('/api/wechat/groups');
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(tab, loadList, { immediate: true });

const filteredQQ = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return qqGroups.value;
  return qqGroups.value.filter(g => (g.name || '').toLowerCase().includes(q) || String(g.groupId).includes(q));
});

const filteredWX = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return wxGroups.value;
  return wxGroups.value.filter(g => (g.title || '').toLowerCase().includes(q) || (g.remoteId || '').toLowerCase().includes(q));
});

async function addQQ(groupId) {
  const id = String(groupId || '').trim();
  if (!id) return;
  busyId.value = id;
  try {
    const res = await api('/api/capture/groups', { groupId: id }, 'POST');
    const info = res.backfill?.error ? `已添加（${res.backfill.error}）` : res.backfill ? `已添加并补拉 ${res.backfill.imported} 条消息` : '已添加 QQ 群';
    emit('toast', info);
    manualGroupId.value = '';
    emit('saved');
    if (tab.value === 'qq' && qqGroups.value.length) await loadList();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busyId.value = '';
  }
}

async function addWechat(conv) {
  busyId.value = conv.id;
  try {
    const res = await api('/api/wechat/groups', { conversationId: conv.id }, 'POST');
    const info = res.backfill?.error ? res.backfill.error : `已添加「${conv.title}」，导入 ${res.backfill?.imported ?? 0} 条消息`;
    emit('toast', info);
    emit('saved');
    await loadList();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal-card modal-wide" role="dialog" aria-modal="true" aria-label="添加关注的群聊">
      <header class="modal-header">
        <h2 class="modal-title">添加群聊</h2>
        <button class="modal-close" @click="$emit('close')" aria-label="关闭">×</button>
      </header>

      <div class="modal-body">
        <div class="toolbar">
          <div class="segmented">
            <button class="seg-btn" :class="{ active: tab === 'wechat' }" @click="tab = 'wechat'">微信群</button>
            <button class="seg-btn" :class="{ active: tab === 'qq' }" @click="tab = 'qq'">QQ 群</button>
          </div>
          <input v-model="search" class="input search-box" placeholder="搜索群名称或群号…" />
          <button class="btn btn-secondary btn-sm" @click="loadList" :disabled="loading">刷新列表</button>
        </div>

        <form v-if="tab === 'qq'" class="manual-row" @submit.prevent="addQQ(manualGroupId)">
          <input v-model="manualGroupId" class="input" placeholder="QQ 未登录时，也可直接输入 QQ 群号添加…" />
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!manualGroupId.trim() || Boolean(busyId)">按群号添加</button>
        </form>

        <div v-if="error" class="banner">
          <span>{{ error }}</span>
        </div>

        <div v-if="loading" class="muted center-note">正在读取群聊列表…</div>

        <div v-else-if="tab === 'wechat'" class="group-list">
          <p v-if="!filteredWX.length" class="muted center-note">没有找到微信群。请先在电脑微信中打开该群，再点击「刷新列表」。</p>
          <div v-for="g in filteredWX" :key="g.id" class="group-row">
            <div class="group-info">
              <div class="group-name">{{ g.title }}</div>
              <div class="muted group-sub">{{ g.remoteId }}</div>
            </div>
            <span v-if="g.monitored" class="badge badge-pine">已关注</span>
            <button v-else class="btn btn-primary btn-sm" :disabled="busyId === g.id" @click="addWechat(g)">
              {{ busyId === g.id ? '添加中…' : '添加关注' }}
            </button>
          </div>
        </div>

        <div v-else class="group-list">
          <p v-if="!filteredQQ.length && !error" class="muted center-note">没有匹配的 QQ 群。</p>
          <div v-for="g in filteredQQ" :key="g.groupId" class="group-row">
            <div class="group-info">
              <div class="group-name">{{ g.name || g.groupId }}</div>
              <div class="muted group-sub">群号 {{ g.groupId }}<span v-if="g.memberCount"> · {{ g.memberCount }} 人</span></div>
            </div>
            <span v-if="g.captured" class="badge badge-pine">已关注</span>
            <button v-else class="btn btn-primary btn-sm" :disabled="busyId === g.groupId" @click="addQQ(g.groupId)">
              {{ busyId === g.groupId ? '添加中…' : '添加关注' }}
            </button>
          </div>
        </div>
      </div>

      <footer class="modal-footer">
        <button class="btn btn-secondary" @click="$emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-wide { width: min(640px, 100%); }

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.search-box {
  flex: 1;
  min-width: 160px;
}

.manual-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.group-list {
  display: flex;
  flex-direction: column;
  border: 2px solid var(--stroke);
  border-radius: var(--sketch-radius-sm);
  max-height: 360px;
  overflow-y: auto;
  background: var(--paper-card);
  box-shadow: 3px 3px 0 var(--stroke);
}

.group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1.5px dashed var(--stroke-soft);
  background: var(--paper-card);
}
.group-row:hover { background: var(--marker-yellow-soft); }
.group-row:last-child { border-bottom: 0; }

.group-info { min-width: 0; flex: 1; }
.group-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-sub { font-size: 12px; margin-top: 2px; }

.center-note { text-align: center; padding: 20px 12px; font-size: 13px; }
</style>
