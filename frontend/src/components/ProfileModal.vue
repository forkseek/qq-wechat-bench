<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  profile: { type: Object, default: () => ({ name: '', context: '' }) }
});
const emit = defineEmits(['close', 'saved', 'toast']);

const name = ref(props.profile?.name || '');
const context = ref(props.profile?.context || '');
const saving = ref(false);

async function submit() {
  saving.value = true;
  try {
    await api('/api/profile', { name: name.value, context: context.value }, 'PUT');
    emit('toast', '个人信息与长期规则已保存');
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
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="我的信息与规则">
      <header class="modal-header">
        <h2 class="modal-title">我的信息与规则</h2>
        <button class="modal-close" @click="$emit('close')" aria-label="关闭">×</button>
      </header>
      <form class="modal-body" @submit.prevent="submit">
        <p class="muted intro">AI 整理通知时会结合这些信息判断「哪些事与你有关」，减少误判与归属待确认。</p>
        <label class="field">
          <span class="field-label">姓名或常用称呼</span>
          <input v-model="name" class="input" maxlength="100" placeholder="例如：张三 / 25级动科3班" />
        </label>
        <label class="field">
          <span class="field-label">身份与长期整理规则</span>
          <textarea
            v-model="context"
            class="textarea"
            rows="6"
            maxlength="5000"
            placeholder="例如：我是 2025 级动物科学 3 班本科生；住在仓山校区；非必选的文体娱乐活动可忽略或标待确认；课程实验和考试通知必须提取。"
          ></textarea>
        </label>
        <div class="modal-footer modal-footer-inline">
          <button type="button" class="btn btn-secondary" @click="$emit('close')">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">{{ saving ? '保存中…' : '保存设置' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.intro { font-size: 13px; }
.modal-footer-inline { margin: 4px -18px -16px; }
</style>
