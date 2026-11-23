<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { api } from '../api.js';
import { formatTime } from '../utils/format.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  state: { type: Object, required: true },
  pendingCount: { type: Number, default: 0 }
});
const emit = defineEmits(['close', 'toast']);

const scope = ref('all');
const turns = ref([]);
const loading = ref(false);
const sending = ref(false);
const prompt = ref('');
const logEl = ref(null);

const monitoredConversations = computed(() =>
  (props.state?.conversations || []).filter(c => c.monitored)
);

const modelName = computed(() => props.state?.model?.name || '');

async function loadTurns() {
  loading.value = true;
  try {
    turns.value = await api(`/api/chat?scope=${encodeURIComponent(scope.value)}`);
    await scrollBottom();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    loading.value = false;
  }
}

async function scrollBottom() {
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
}

watch([() => props.open, scope], ([isOpen]) => {
  if (isOpen) loadTurns();
}, { immediate: true });

async function send(textValue) {
  const q = (textValue ?? prompt.value).trim();
  if (!q || sending.value) return;
  sending.value = true;
  const nowIso = new Date().toISOString();
  turns.value.push({ role: 'user', content: q, at: nowIso });
  const pendingBubble = { role: 'assistant', content: '正在结合最新待办与通知整理回答…', at: nowIso, pending: true };
  turns.value.push(pendingBubble);
  prompt.value = '';
  await scrollBottom();
  try {
    const res = await api('/api/chat', { prompt: q, scope: scope.value }, 'POST');
    pendingBubble.content = res.reply;
    pendingBubble.at = new Date().toISOString();
    pendingBubble.pending = false;
  } catch (err) {
    pendingBubble.content = err.message;
    pendingBubble.pending = false;
    pendingBubble.error = true;
  } finally {
    sending.value = false;
    await scrollBottom();
  }
}

async function clearHistory() {
  if (sending.value) return;
  try {
    await api(`/api/chat?scope=${encodeURIComponent(scope.value)}`, undefined, 'DELETE');
    turns.value = [];
    emit('toast', '已开启新对话');
  } catch (err) {
    emit('toast', err.message, 'error');
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <aside class="drawer" :class="{ open }" aria-label="通知助手">
    <header class="drawer-head">
      <div class="drawer-brand">
        <span class="drawer-seal" aria-hidden="true">✦</span>
        <div>
          <h2 class="drawer-title">通知助手</h2>
          <p class="drawer-sub">实时对照当前 <strong class="num">{{ pendingCount }}</strong> 项未完成待办</p>
        </div>
      </div>
      <div class="drawer-head-actions">
        <button class="btn btn-ghost btn-sm" @click="clearHistory" :disabled="sending || !turns.length" title="清空当前范围的历史对话">新对话</button>
        <button class="modal-close" @click="$emit('close')" aria-label="收起通知助手">×</button>
      </div>
    </header>

    <div class="drawer-scope">
      <label class="field-label" for="assistant-scope">对话范围</label>
      <select id="assistant-scope" v-model="scope" class="select">
        <option value="all">所有已关注会话与手动待办</option>
        <option v-for="c in monitoredConversations" :key="c.id" :value="c.id">
          {{ c.platform === 'wechat' ? '微信' : 'QQ' }} · {{ c.title }}
        </option>
      </select>
    </div>

    <div ref="logEl" class="drawer-log" aria-live="polite">
      <div v-if="loading && !turns.length" class="drawer-empty muted">正在读取对话…</div>
      <div v-else-if="!turns.length" class="drawer-empty">
        <p>可以直接问我近期通知、截止时间或安排建议。</p>
        <p class="muted">所有回答均基于本机最新待办与已保存原话。</p>
      </div>
      <article v-for="(turn, idx) in turns" :key="idx" class="turn" :class="[`turn-${turn.role}`, { 'turn-err': turn.error }]">
        <div class="turn-meta">
          <span>{{ turn.role === 'user' ? '我' : '通知助手' }}</span>
          <time v-if="turn.at">{{ formatTime(turn.at) }}</time>
        </div>
        <div class="turn-body">{{ turn.content }}</div>
      </article>
    </div>

    <div class="drawer-chips">
      <button class="chip" @click="send('今天我需要处理哪些事情？')" :disabled="sending">今天需要做什么</button>
      <button class="chip" @click="send('哪些通知的截止时间还不明确？')" :disabled="sending">哪些时间待确认</button>
    </div>

    <form class="drawer-form" @submit.prevent="send()">
      <textarea
        v-model="prompt"
        class="textarea drawer-input"
        rows="2"
        maxlength="3000"
        placeholder="聊聊通知或学习安排…（Enter 发送，Shift+Enter 换行）"
        @keydown="onKeydown"
      ></textarea>
      <div class="drawer-footer">
        <span class="muted model-tag">{{ modelName }}</span>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="sending || !prompt.trim()">发送</button>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(390px, 92vw);
  background: #fffdf7;
  border-left: 2.5px solid var(--stroke);
  box-shadow: -8px 0 0 rgba(35, 33, 30, 0.14);
  display: flex;
  flex-direction: column;
  transform: translateX(102%);
  transition: transform 0.24s var(--ease);
  z-index: 45;
}

.drawer.open {
  transform: translateX(0);
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--hairline);
  background: var(--paper);
}

.drawer-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.drawer-seal {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--pine);
  color: #f7f4ed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}

.drawer-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
}

.drawer-sub {
  font-size: 12px;
  color: var(--ink-3);
  margin-top: 2px;
}

.drawer-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.drawer-scope {
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drawer-log {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.drawer-empty {
  text-align: center;
  padding: 28px 12px;
  font-size: 13px;
  color: var(--ink-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.turn {
  padding: 10px 12px;
  border-radius: var(--radius);
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.turn-user {
  background: var(--pine-wash);
  border: 1px solid var(--pine-border);
  align-self: flex-end;
  max-width: 90%;
}

.turn-assistant {
  background: var(--paper);
  border: 1px solid var(--hairline);
  align-self: stretch;
}

.turn-err {
  border-color: var(--seal-border);
  background: var(--seal-wash);
  color: var(--seal);
}

.turn-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--ink-3);
  margin-bottom: 4px;
}

.drawer-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 16px 0;
}

.chip {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong);
  background: var(--paper);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}
.chip:hover:not(:disabled) {
  background: var(--pine-wash);
  border-color: var(--pine-border);
  color: var(--pine);
}

.drawer-form {
  padding: 10px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--hairline);
  margin-top: 8px;
  background: var(--paper);
}

.drawer-input {
  min-height: 58px;
  max-height: 140px;
}

.drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.model-tag {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
