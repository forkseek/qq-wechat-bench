<script setup>
import { ref, computed, watch } from 'vue';
import { api } from '../api.js';
import { formatTime, analysisStateLabel, monogramChar } from '../utils/format.js';

const props = defineProps({
  state: { type: Object, required: true }
});
const emit = defineEmits(['refresh', 'open-rules', 'open-add', 'open-messages', 'toast']);

const activeQQ = ref([]);
const loadingActiveQQ = ref(false);
const showUnmonitored = ref(false);
const unmonPlatform = ref('');
const unmonQuery = ref('');
const unmonPage = ref(1);
const unmonData = ref({ items: [], total: 0, hasMore: false, pageSize: 20 });
const loadingUnmon = ref(false);
const busyId = ref('');

const monitored = computed(() =>
  (props.state?.conversations || [])
    .filter(c => c.monitored)
    .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || a.title.localeCompare(b.title, 'zh-CN'))
);

const totalUnmonitored = computed(() => {
  const total = props.state?.conversationCount ?? (props.state?.conversations || []).length;
  return Math.max(0, total - monitored.value.length);
});

async function loadActiveQQ() {
  if (!props.state?.qq?.online) {
    activeQQ.value = [];
    return;
  }
  loadingActiveQQ.value = true;
  try {
    activeQQ.value = await api('/api/qq/active-groups');
  } catch {
    activeQQ.value = [];
  } finally {
    loadingActiveQQ.value = false;
  }
}

async function loadUnmonitored(resetPage = false) {
  if (resetPage) unmonPage.value = 1;
  loadingUnmon.value = true;
  try {
    const params = new URLSearchParams({
      monitored: 'false',
      page: String(unmonPage.value),
      pageSize: '20'
    });
    if (unmonPlatform.value) params.set('platform', unmonPlatform.value);
    if (unmonQuery.value.trim()) params.set('q', unmonQuery.value.trim());
    unmonData.value = await api(`/api/conversations?${params.toString()}`);
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    loadingUnmon.value = false;
  }
}

watch(() => props.state?.qq?.online, loadActiveQQ, { immediate: true });
watch([showUnmonitored, unmonPlatform], ([open]) => {
  if (open) loadUnmonitored(true);
});

async function removeConversation(conv) {
  busyId.value = conv.id;
  try {
    if (conv.platform === 'qq' && conv.kind === 'group' && props.state?.capture) {
      await api(`/api/capture/groups/${encodeURIComponent(conv.remoteId)}`, {}, 'DELETE');
    } else {
      await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { monitored: false }, 'PATCH');
    }
    emit('toast', `已停止关注「${conv.title}」，历史消息与待办仍保留`);
    emit('refresh');
    if (showUnmonitored.value) await loadUnmonitored();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busyId.value = '';
  }
}

async function restoreConversation(conv) {
  busyId.value = conv.id;
  try {
    if (conv.platform === 'qq' && conv.kind === 'group' && props.state?.capture) {
      await api('/api/capture/groups', { groupId: conv.remoteId }, 'POST');
    } else if (conv.platform === 'wechat' && conv.kind === 'group') {
      await api('/api/wechat/groups', { conversationId: conv.id }, 'POST');
    } else {
      await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { monitored: true }, 'PATCH');
    }
    emit('toast', `已恢复关注「${conv.title}」`);
    emit('refresh');
    if (showUnmonitored.value) await loadUnmonitored();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busyId.value = '';
  }
}

async function addQuickQQ(groupId, name) {
  busyId.value = groupId;
  try {
    await api('/api/capture/groups', { groupId }, 'POST');
    emit('toast', `已接入「${name || groupId}」`);
    emit('refresh');
    await loadActiveQQ();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <section class="conv-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">会话管理</h1>
        <span class="page-title-accent" aria-hidden="true"></span>
        <p class="page-subtitle">只保存和整理你关注的群聊与会话，未关注的聊天正文不会入库或发给 AI。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" @click="$emit('open-add')">＋ 添加群聊</button>
      </div>
    </header>

    <!-- 已关注群聊 -->
    <div class="section-head">
      <h2 class="section-title">正在关注（<span class="num">{{ monitored.length }}</span>）</h2>
      <span class="muted section-note">移除后停止拉取新消息，已保存的消息和待办保留</span>
    </div>

    <div v-if="monitored.length" class="monitored-grid">
      <article
        v-for="c in monitored"
        :key="c.id"
        class="card conv-card"
        :class="c.platform === 'wechat' ? 'conv-wx' : 'conv-qq'"
      >
        <div class="conv-card-head">
          <div class="conv-card-title-wrap">
            <span class="conv-monogram" :class="c.platform === 'wechat' ? 'mono-wx' : 'mono-qq'">
              {{ monogramChar(c.title) }}
            </span>
            <div class="conv-title-col">
              <div class="conv-title-line">
                <h3 class="conv-card-title">{{ c.title }}</h3>
                <span class="badge" :class="c.platform === 'wechat' ? 'badge-wx' : 'badge-qq'">
                  {{ c.platform === 'wechat' ? '微信' : 'QQ' }}
                </span>
              </div>
              <div class="conv-card-meta muted">
                <span>已保存 <strong class="num">{{ c.messageCount || 0 }}</strong> 条</span>
                <span v-if="c.lastSeen">· 最近 {{ formatTime(c.lastSeen) }}</span>
                <span v-if="c.rules" class="rule-flag">· 专属规则</span>
              </div>
            </div>
          </div>
          <span class="badge badge-pine">{{ analysisStateLabel(c.analysisState) }}</span>
        </div>

        <div v-if="c.summary" class="conv-card-summary">
          <span class="summary-seal" aria-hidden="true">要</span>
          <p class="summary-clamp">{{ c.summary }}</p>
        </div>

        <div class="conv-card-actions">
          <button class="btn btn-secondary btn-sm" @click="$emit('open-messages', c.id)">查看消息</button>
          <button class="btn btn-ghost btn-sm" @click="$emit('open-rules', c)">名称与规则</button>
          <button class="btn btn-danger btn-sm remove-btn" :disabled="busyId === c.id" @click="removeConversation(c)">
            {{ busyId === c.id ? '处理中…' : '移除' }}
          </button>
        </div>
      </article>
    </div>

    <div v-else class="empty-state">
      <div class="empty-mark">◇</div>
      <h2 class="empty-title">还没有关注的群聊</h2>
      <p class="empty-desc">点击右上角「添加群聊」，选择需要自动整理待办的 QQ 群或微信群。</p>
      <button class="btn btn-primary btn-sm" @click="$emit('open-add')">＋ 添加群聊</button>
    </div>

    <!-- QQ 最近活跃未接入 -->
    <div v-if="state.qq?.online && activeQQ.length" class="card active-qq-card">
      <div class="section-head">
        <h2 class="section-title">QQ · 最近有消息但尚未接入的群</h2>
        <button class="btn btn-ghost btn-sm" :disabled="loadingActiveQQ" @click="loadActiveQQ">刷新</button>
      </div>
      <div class="active-qq-list">
        <div v-for="g in activeQQ" :key="g.groupId" class="active-qq-row">
          <div class="active-qq-info">
            <strong>{{ g.name || g.groupId }}</strong>
            <span class="muted">群号 {{ g.groupId }}<span v-if="g.lastAt"> · {{ formatTime(g.lastAt) }}</span></span>
          </div>
          <button class="btn btn-secondary btn-sm" :disabled="busyId === g.groupId" @click="addQuickQQ(g.groupId, g.name)">
            接入关注
          </button>
        </div>
      </div>
    </div>

    <!-- 其他未关注会话（默认折叠 + 服务端搜索分页） -->
    <div class="card unmon-card">
      <div class="unmon-head">
        <div>
          <h2 class="section-title">其他已发现但未关注的会话（<span class="num">{{ totalUnmonitored }}</span>）</h2>
          <p class="muted section-note">默认收起以保持页面清爽；展开后可按平台筛选或搜索恢复关注。</p>
        </div>
        <button class="btn btn-secondary btn-sm" @click="showUnmonitored = !showUnmonitored">
          {{ showUnmonitored ? '收起列表' : '展开查找' }}
        </button>
      </div>

      <div v-if="showUnmonitored" class="unmon-body">
        <form class="unmon-toolbar" @submit.prevent="loadUnmonitored(true)">
          <div class="segmented">
            <button type="button" class="seg-btn" :class="{ active: unmonPlatform === '' }" @click="unmonPlatform = ''">全部</button>
            <button type="button" class="seg-btn" :class="{ active: unmonPlatform === 'wechat' }" @click="unmonPlatform = 'wechat'">微信</button>
            <button type="button" class="seg-btn" :class="{ active: unmonPlatform === 'qq' }" @click="unmonPlatform = 'qq'">QQ</button>
          </div>
          <input v-model="unmonQuery" class="input unmon-search" placeholder="输入群名称或群号回车搜索…" />
          <button type="submit" class="btn btn-secondary btn-sm" :disabled="loadingUnmon">搜索</button>
        </form>

        <div v-if="loadingUnmon" class="muted center-note">正在查询…</div>
        <div v-else-if="!unmonData.items.length" class="muted center-note">没有找到符合条件的未关注会话。</div>
        <div v-else class="unmon-list">
          <div v-for="c in unmonData.items" :key="c.id" class="unmon-row">
            <div class="unmon-info">
              <span class="badge" :class="c.platform === 'wechat' ? 'badge-wx' : 'badge-qq'">
                {{ c.platform === 'wechat' ? '微信' : 'QQ' }}
              </span>
              <span class="unmon-title">{{ c.title }}</span>
              <span v-if="c.messageCount" class="muted num">已存 {{ c.messageCount }} 条</span>
            </div>
            <button class="btn btn-secondary btn-sm" :disabled="busyId === c.id" @click="restoreConversation(c)">
              恢复关注
            </button>
          </div>
        </div>

        <div v-if="unmonData.total > unmonData.pageSize" class="pager">
          <span class="muted">共 <strong class="num">{{ unmonData.total }}</strong> 个 · 第 <strong class="num">{{ unmonPage }}</strong> 页</span>
          <div class="pager-btns">
            <button class="btn btn-secondary btn-sm" :disabled="unmonPage <= 1 || loadingUnmon" @click="unmonPage--; loadUnmonitored()">上一页</button>
            <button class="btn btn-secondary btn-sm" :disabled="!unmonData.hasMore || loadingUnmon" @click="unmonPage++; loadUnmonitored()">下一页</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.conv-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.section-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
}

.section-note { font-size: 12.5px; }

.monitored-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.conv-card {
  position: relative;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 3px solid var(--pine);
  box-shadow: var(--shadow-float);
}
.conv-card.conv-wx { border-top-color: var(--wx); }
.conv-card.conv-qq { border-top-color: var(--qq); }
.conv-card:hover { border-color: var(--hairline-strong); }

.conv-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.conv-card-title-wrap {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  min-width: 0;
  flex: 1;
}

.conv-monogram {
  width: 36px;
  height: 36px;
  border-radius: 7px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 1px 3px rgba(22, 31, 26, 0.06);
}
.mono-wx { background: var(--wx-wash); color: var(--wx); border: 1px solid var(--wx-border); }
.mono-qq { background: var(--qq-wash); color: var(--qq); border: 1px solid var(--qq-border); }

.conv-title-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.conv-title-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.conv-card-title {
  font-size: 15.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-card-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}

.rule-flag { color: var(--pine); font-weight: 500; }

.conv-card-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
  background: rgba(246, 241, 229, 0.65);
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
}

.summary-seal {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: var(--pine);
  color: #faf7f0;
  font-family: var(--font-display);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.summary-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.conv-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 4px;
}

.remove-btn { margin-left: auto; }

.active-qq-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.active-qq-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--hairline);
}

.active-qq-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--hairline);
}
.active-qq-row:last-child { border-bottom: 0; padding-bottom: 0; }

.active-qq-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 13.5px;
}

.unmon-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.unmon-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.unmon-body {
  border-top: 1px solid var(--hairline);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.unmon-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.unmon-search { flex: 1; min-width: 180px; }

.unmon-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.unmon-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--hairline);
  background: var(--paper-card);
}
.unmon-row:last-child { border-bottom: 0; }

.unmon-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.unmon-title {
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  flex-wrap: wrap;
}

.pager-btns { display: flex; gap: 6px; }
.center-note { text-align: center; padding: 18px 10px; font-size: 13px; }

@media (max-width: 820px) {
  .monitored-grid { grid-template-columns: 1fr; }
}
</style>
