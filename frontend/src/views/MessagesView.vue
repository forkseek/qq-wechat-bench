<script setup>
import { ref, computed, watch } from 'vue';
import { api, uploadAttachment, newRequestId } from '../api.js';
import { formatTime, formatBytes, analysisStateLabel } from '../utils/format.js';

const props = defineProps({
  state: { type: Object, required: true },
  initialConversationId: { type: String, default: '' }
});
const emit = defineEmits(['refresh', 'toast']);

const platformFilter = ref('all'); // 'all' | 'wechat' | 'qq'
const convSearch = ref('');
const selectedId = ref(props.initialConversationId || '');
const messages = ref([]);
const outbox = ref([]);
const loadingMsgs = ref(false);
const msgError = ref('');
const discovering = ref(false);

const draft = ref('');
const attachments = ref([]); // [{ id, name, size, type }]
const uploading = ref(false);
const sending = ref(false);
const currentRequestId = ref(newRequestId());
const mediaBusyId = ref('');
const previewImage = ref(null); // { url, name }
const fileInput = ref(null);
let fetchSeq = 0;

const filteredConversations = computed(() => {
  const list = props.state?.conversations || [];
  const q = convSearch.value.trim().toLowerCase();
  return list.filter(c => {
    if (platformFilter.value !== 'all' && c.platform !== platformFilter.value) return false;
    if (q && !(c.title || '').toLowerCase().includes(q) && !(c.remoteId || '').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => Number(b.monitored) - Number(a.monitored) || (b.lastSeen || '').localeCompare(a.lastSeen || ''));
});

const selected = computed(() =>
  (props.state?.conversations || []).find(c => c.id === selectedId.value) || null
);

watch(() => props.initialConversationId, id => {
  if (id) selectedId.value = id;
});

watch(filteredConversations, list => {
  if (!selectedId.value && list.length) {
    selectedId.value = list[0].id;
  } else if (selectedId.value && !props.state?.conversations?.some(c => c.id === selectedId.value) && list.length) {
    selectedId.value = list[0].id;
  }
}, { immediate: true });

async function loadMessages(id = selectedId.value) {
  if (!id) {
    messages.value = [];
    outbox.value = [];
    msgError.value = '';
    return;
  }
  const seq = ++fetchSeq;
  loadingMsgs.value = true;
  msgError.value = '';
  try {
    const [msgList, sentList] = await Promise.all([
      api(`/api/conversations/${encodeURIComponent(id)}/messages`),
      api(`/api/conversations/${encodeURIComponent(id)}/outbox`)
    ]);
    if (seq !== fetchSeq || id !== selectedId.value) return;
    messages.value = msgList || [];
    outbox.value = (sentList || []).slice(0, 5);
  } catch (err) {
    if (seq !== fetchSeq || id !== selectedId.value) return;
    messages.value = [];
    msgError.value = err.message;
  } finally {
    if (seq === fetchSeq) loadingMsgs.value = false;
  }
}

watch(selectedId, id => {
  currentRequestId.value = newRequestId();
  loadMessages(id);
}, { immediate: true });

async function discover() {
  discovering.value = true;
  try {
    await api('/api/conversations/discover', {}, 'POST');
    emit('toast', '本机已接入账号的会话已刷新');
    emit('refresh');
    if (selectedId.value) await loadMessages(selectedId.value);
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    discovering.value = false;
  }
}

async function toggleMonitor() {
  if (!selected.value) return;
  try {
    const next = !selected.value.monitored;
    await api(`/api/conversations/${encodeURIComponent(selected.value.id)}`, { monitored: next }, 'PATCH');
    emit('toast', next ? `已开启「${selected.value.title}」的保存与整理` : `已停止「${selected.value.title}」的保存与整理`);
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  }
}

async function analyzeNow() {
  if (!selected.value) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(selected.value.id)}/analyze`, {}, 'POST');
    emit('toast', '已加入 AI 整理队列');
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  }
}

async function onPickFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  const maxFiles = props.state?.settings?.messaging?.maxAttachments || 5;
  if (attachments.value.length + files.length > maxFiles) {
    emit('toast', `一次最多选择 ${maxFiles} 个附件`, 'error');
    return;
  }
  uploading.value = true;
  try {
    for (const file of files) {
      const uploaded = await uploadAttachment(file);
      attachments.value.push(uploaded);
    }
    currentRequestId.value = newRequestId();
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    uploading.value = false;
  }
}

function removeAttachment(id) {
  attachments.value = attachments.value.filter(a => a.id !== id);
  currentRequestId.value = newRequestId();
}

async function sendMessage() {
  if (!selected.value || sending.value) return;
  const text = draft.value.trim();
  if (!text && !attachments.value.length) return;
  sending.value = true;
  try {
    const res = await api('/api/messages/send', {
      requestId: currentRequestId.value,
      conversationId: selected.value.id,
      text,
      attachments: attachments.value.map(a => a.id)
    }, 'POST');
    if (res.status === 'sent') {
      emit('toast', '消息已发送');
      draft.value = '';
      attachments.value = [];
      currentRequestId.value = newRequestId();
    } else if (res.status === 'failed') {
      emit('toast', res.error || '发送未提交，请检查客户端', 'error');
      currentRequestId.value = newRequestId();
    } else {
      emit('toast', res.error || '发送结果待核查，请先查看客户端避免重发', 'error');
      draft.value = '';
      attachments.value = [];
      currentRequestId.value = newRequestId();
    }
    await loadMessages(selected.value.id);
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    sending.value = false;
  }
}

async function checkOutbox(item) {
  if (!selected.value) return;
  try {
    const res = await api('/api/messages/check', { conversationId: selected.value.id, requestId: item.id }, 'POST');
    emit('toast', res.status === 'sent' ? '已核实发送成功' : '暂未在记录中匹配到，请直接查看微信客户端');
    await loadMessages(selected.value.id);
  } catch (err) {
    emit('toast', err.message, 'error');
  }
}

async function openWechatMedia(msg) {
  if (!selected.value) return;
  mediaBusyId.value = msg.id;
  try {
    const file = await api('/api/messages/media', { conversationId: selected.value.id, messageId: msg.id }, 'POST');
    const url = `/api/attachments/${encodeURIComponent(file.id)}`;
    if (file.type === 'image') {
      previewImage.value = { url, name: file.name };
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    mediaBusyId.value = '';
  }
}

function outboxStatusLabel(item) {
  if (item.status === 'sent') return '已发送';
  if (item.status === 'sending') return '发送中';
  if (item.status === 'failed') return '未提交发送';
  if (item.partial) return '部分已发送，请核查';
  return '结果待核查';
}
</script>

<template>
  <section class="messages-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">聊天与消息</h1>
        <span class="page-title-accent" aria-hidden="true"></span>
        <p class="page-subtitle">统一查看 QQ 与微信会话；开启「保存与整理」后，新消息会自动进入待办提取。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" :disabled="discovering" @click="discover">
          {{ discovering ? '刷新中…' : '刷新会话' }}
        </button>
      </div>
    </header>

    <div v-if="!state.conversations?.length" class="empty-state">
      <div class="empty-mark empty-mark-warn">!</div>
      <h2 class="empty-title">暂无可用会话</h2>
      <p class="empty-desc">正常登录电脑微信后会自动发现会话；QQ 会话需要先在接入设置中开启 QQ 采集。</p>
      <button class="btn btn-primary btn-sm" :disabled="discovering" @click="discover">发现本机会话</button>
    </div>

    <div v-else class="split-layout">
      <!-- 左侧会话列表 -->
      <aside class="card conv-pane">
        <div class="conv-pane-top">
          <div class="segmented conv-tabs">
            <button class="seg-btn" :class="{ active: platformFilter === 'all' }" @click="platformFilter = 'all'">全部</button>
            <button class="seg-btn" :class="{ active: platformFilter === 'wechat' }" @click="platformFilter = 'wechat'">微信</button>
            <button class="seg-btn" :class="{ active: platformFilter === 'qq' }" @click="platformFilter = 'qq'">QQ</button>
          </div>
          <input v-model="convSearch" class="input" placeholder="筛选会话…" />
        </div>

        <div class="conv-scroll">
          <button
            v-for="c in filteredConversations.slice(0, 80)"
            :key="c.id"
            class="conv-item"
            :class="{ active: c.id === selectedId }"
            @click="selectedId = c.id"
          >
            <div class="conv-item-top">
              <span class="platform-pill" :class="c.platform === 'wechat' ? 'pill-wx' : 'pill-qq'">
                {{ c.platform === 'wechat' ? '微信' : 'QQ' }}
              </span>
              <span class="conv-item-title">{{ c.title }}</span>
              <span v-if="c.monitored" class="follow-dot" title="已开启保存与整理"></span>
            </div>
            <div class="conv-item-sub muted">
              <span>{{ c.monitored ? `已保存 ${c.messageCount || 0} 条` : '仅临时查看' }}</span>
              <span v-if="c.lastSeen">{{ formatTime(c.lastSeen) }}</span>
            </div>
          </button>
          <p v-if="!filteredConversations.length" class="muted conv-empty">没有匹配的会话</p>
          <p v-else-if="filteredConversations.length > 80" class="muted conv-empty">仅显示前 80 个会话，请用上方搜索定位</p>
        </div>
      </aside>

      <!-- 右侧聊天详情 -->
      <div class="card thread-pane">
        <!-- 窄屏下的快捷会话切换 -->
        <div class="mobile-conv-picker">
          <select v-model="selectedId" class="select">
            <option v-for="c in filteredConversations.slice(0, 80)" :key="c.id" :value="c.id">
              {{ c.platform === 'wechat' ? '微信' : 'QQ' }} · {{ c.title }}
            </option>
          </select>
        </div>

        <template v-if="selected">
          <header class="thread-head">
            <div class="thread-title-group">
              <span class="badge" :class="selected.platform === 'wechat' ? 'badge-wx' : 'badge-qq'">
                {{ selected.platform === 'wechat' ? '微信' : 'QQ' }}
              </span>
              <h2 class="thread-name">{{ selected.title }}</h2>
              <span class="badge" :class="selected.monitored ? 'badge-pine' : ''">
                {{ selected.monitored ? analysisStateLabel(selected.analysisState) : '未开启保存' }}
              </span>
            </div>
            <div class="thread-actions">
              <button class="btn btn-secondary btn-sm" @click="toggleMonitor">
                {{ selected.monitored ? '停止保存与整理' : '开启保存与整理' }}
              </button>
              <button
                v-if="selected.monitored && state.model?.configured"
                class="btn btn-primary btn-sm"
                @click="analyzeNow"
              >
                整理新消息
              </button>
              <button class="btn btn-ghost btn-sm" :disabled="loadingMsgs" @click="loadMessages(selected.id)">刷新</button>
            </div>
          </header>

          <div v-if="selected.summary" class="summary-strip">
            <span class="summary-seal">要</span>
            <span>{{ selected.summary }}</span>
          </div>

          <div v-if="selected.analysisError" class="banner banner-err thread-banner">
            <span>{{ selected.analysisError }}</span>
          </div>

          <!-- 消息流 -->
          <div class="msg-stream">
            <div v-if="loadingMsgs && !messages.length" class="empty-state msg-empty">
              <div class="empty-mark">◷</div>
              <p class="muted">正在读取消息…</p>
            </div>

            <div v-else-if="msgError" class="empty-state msg-empty">
              <div class="empty-mark empty-mark-warn">!</div>
              <h3 class="empty-title">消息暂时不可读取</h3>
              <p class="empty-desc">{{ msgError }}</p>
              <button class="btn btn-secondary btn-sm" @click="loadMessages(selected.id)">重新读取</button>
            </div>

            <div v-else-if="!messages.length" class="empty-state msg-empty">
              <div class="empty-mark">▤</div>
              <h3 class="empty-title">暂无消息记录</h3>
              <p class="empty-desc">这个会话目前还没有可展示的历史消息。</p>
            </div>

            <template v-else>
              <article v-for="msg in messages" :key="msg.id" class="msg-row" :class="{ 'msg-self': msg.isSelf }">
                <div class="msg-bubble">
                  <div class="msg-meta">
                    <strong>{{ msg.senderName }}<span v-if="msg.isSelf"> · 我</span></strong>
                    <time class="muted num">{{ formatTime(msg.sentAt, true) }}</time>
                  </div>
                  <p class="msg-content">{{ msg.content }}</p>
                  <div v-if="selected.platform === 'wechat' && ['图片', '文件/链接/卡片'].includes(msg.messageType)" class="msg-media">
                    <button
                      class="btn btn-secondary btn-sm"
                      :disabled="mediaBusyId === msg.id"
                      @click="openWechatMedia(msg)"
                    >
                      {{ mediaBusyId === msg.id ? '读取中…' : msg.messageType === '图片' ? '查看本机图片' : '打开本机文件' }}
                    </button>
                  </div>
                </div>
              </article>
            </template>
          </div>

          <!-- 最近发送回执 -->
          <div v-if="outbox.length" class="outbox-strip">
            <span class="muted outbox-label">最近发送：</span>
            <div v-for="item in outbox.slice(0, 3)" :key="item.id" class="outbox-item">
              <span class="num muted">{{ formatTime(item.at) }}</span>
              <span>{{ outboxStatusLabel(item) }}</span>
              <span v-if="item.attachments?.length" class="muted">({{ item.attachments.length }} 附件)</span>
              <button
                v-if="selected.platform === 'wechat' && item.status === 'uncertain' && !item.attachments?.length"
                class="btn-link"
                @click="checkOutbox(item)"
              >
                核查结果
              </button>
            </div>
          </div>

          <!-- 发送区 -->
          <form class="composer" @submit.prevent="sendMessage">
            <div v-if="attachments.length" class="attach-chips">
              <span v-for="a in attachments" :key="a.id" class="badge">
                {{ a.name }} ({{ formatBytes(a.size) }})
                <button type="button" class="chip-rm" @click="removeAttachment(a.id)" aria-label="移除附件">×</button>
              </span>
            </div>
            <textarea
              v-model="draft"
              class="textarea composer-input"
              rows="2"
              maxlength="6000"
              :placeholder="`发送给 ${selected.title}…（仅在你点击发送时触发）`"
            ></textarea>
            <div class="composer-bar">
              <div class="composer-left">
                <input ref="fileInput" type="file" multiple class="hidden-file" @change="onPickFiles" />
                <button type="button" class="btn btn-secondary btn-sm" :disabled="uploading" @click="fileInput?.click()">
                  {{ uploading ? '上传中…' : '＋ 图片 / 文件' }}
                </button>
                <span class="muted composer-tip">最多 5 个附件，单个上限 50 MB</span>
              </div>
              <button
                type="submit"
                class="btn btn-primary"
                :disabled="sending || uploading || (!draft.trim() && !attachments.length)"
              >
                {{ sending ? '发送中…' : '发送' }}
              </button>
            </div>
          </form>
        </template>
      </div>
    </div>

    <!-- 图片预览模态框 -->
    <div v-if="previewImage" class="modal-backdrop" @click.self="previewImage = null">
      <div class="modal-card modal-image">
        <header class="modal-header">
          <h2 class="modal-title">{{ previewImage.name }}</h2>
          <button class="modal-close" @click="previewImage = null" aria-label="关闭">×</button>
        </header>
        <div class="modal-body image-body">
          <img :src="previewImage.url" :alt="previewImage.name" class="preview-img" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.messages-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 156px);
  min-height: 460px;
  min-width: 0;
}

.split-layout {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: 270px minmax(0, 1fr);
  gap: 14px;
}

.conv-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.conv-pane-top {
  padding: 10px;
  border-bottom: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--paper);
}

.conv-tabs {
  width: 100%;
  justify-content: space-between;
}
.conv-tabs .seg-btn { flex: 1; text-align: center; }

.conv-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.conv-item {
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background 0.14s;
}
.conv-item:hover { background: var(--paper); }
.conv-item.active {
  background: var(--pine-wash);
  border-left: 3px solid var(--pine);
  padding-left: 9px;
}

.conv-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.platform-pill {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pill-wx { background: var(--wx-wash); color: var(--wx); }
.pill-qq { background: var(--qq-wash); color: var(--qq); }

.conv-item-title {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.follow-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pine);
  flex-shrink: 0;
}

.conv-item-sub {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  gap: 6px;
}

.conv-empty { text-align: center; padding: 20px 12px; font-size: 12.5px; }

.thread-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.mobile-conv-picker {
  display: none;
  padding: 10px 12px 0;
}

.thread-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--hairline);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--paper);
}

.thread-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.thread-name {
  font-size: 15.5px;
  font-weight: 600;
  color: var(--ink);
  word-break: break-word;
}

.thread-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.summary-strip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 16px;
  background: var(--pine-wash);
  border-bottom: 1px solid var(--pine-border);
  font-size: 13px;
  color: var(--pine);
}

.summary-seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--pine);
  color: #f7f4ed;
  font-family: var(--font-display);
  font-size: 12px;
  flex-shrink: 0;
  margin-top: 1px;
}

.thread-banner { margin: 10px 16px 0; }

.msg-stream {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--paper);
  min-width: 0;
}

.msg-empty { margin: auto; width: 100%; }

.msg-row {
  display: flex;
  justify-content: flex-start;
  min-width: 0;
  max-width: 100%;
}
.msg-row.msg-self { justify-content: flex-end; }

.msg-bubble {
  max-width: min(620px, 88%);
  min-width: 0;
  padding: 10px 13px;
  border-radius: var(--radius);
  background: var(--paper-card);
  border: 1px solid var(--hairline);
  overflow-wrap: anywhere;
}

.msg-self .msg-bubble {
  background: var(--pine-wash);
  border-color: var(--pine-border);
}

.msg-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  margin-bottom: 4px;
}

.msg-content {
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.msg-media { margin-top: 8px; }

.outbox-strip {
  padding: 7px 16px;
  border-top: 1px solid var(--hairline);
  background: var(--paper-soft);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
}

.outbox-item { display: inline-flex; align-items: center; gap: 5px; }

.composer {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--hairline);
  background: var(--paper-card);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attach-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-rm { margin-left: 4px; font-size: 14px; color: var(--ink-3); }
.chip-rm:hover { color: var(--seal); }

.composer-input { min-height: 54px; max-height: 140px; }

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.composer-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.composer-tip { font-size: 12px; }
.hidden-file { display: none; }

.modal-image { width: min(760px, 96vw); }
.image-body { align-items: center; }
.preview-img { max-width: 100%; max-height: 70vh; border-radius: var(--radius-sm); }

@media (max-width: 860px) {
  .messages-page { height: auto; min-height: 0; }
  .split-layout { grid-template-columns: 1fr; }
  .conv-pane { display: none; }
  .mobile-conv-picker { display: block; }
  .msg-stream { min-height: 280px; max-height: 52vh; }
}
</style>
