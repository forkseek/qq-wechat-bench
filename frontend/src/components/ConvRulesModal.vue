<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  conversation: { type: Object, required: true }
});
const emit = defineEmits(['close', 'saved', 'toast']);

const title = ref(props.conversation.title || '');
const rules = ref(props.conversation.rules || '');
const saving = ref(false);

async function submit() {
  if (!title.value.trim()) {
    emit('toast', '请输入会话名称', 'error');
    return;
  }
  saving.value = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(props.conversation.id)}`, {
      title: title.value.trim(),
      rules: rules.value
    }, 'PATCH');
    emit('toast', '会话名称与规则已更新');
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
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="会话名称与整理规则">
      <header class="modal-header">
        <h2 class="modal-title">名称与整理规则</h2>
        <button class="modal-close" @click="$emit('close')" aria-label="关闭">×</button>
      </header>
      <form class="modal-body" @submit.prevent="submit">
        <div class="meta">
          <span class="badge" :class="conversation.platform === 'wechat' ? 'badge-wx' : 'badge-qq'">
            {{ conversation.platform === 'wechat' ? '微信' : 'QQ' }}
          </span>
          <span class="muted id-text">编号：{{ conversation.remoteId }}</span>
        </div>
        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="title" class="input" maxlength="100" required />
        </label>
        <label class="field">
          <span class="field-label">本群专属整理规则（可选）</span>
          <textarea
            v-model="rules"
            class="textarea"
            rows="5"
            maxlength="5000"
            placeholder="例如：本群是我的必修课群，只关注老师和助教的作业/考试通知，忽略同学讨论和闲聊。"
          ></textarea>
        </label>
        <div class="modal-footer modal-footer-inline">
          <button type="button" class="btn btn-secondary" @click="$emit('close')">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.id-text { font-size: 12.5px; word-break: break-all; }
.modal-footer-inline { margin: 4px -18px -16px; }
</style>
