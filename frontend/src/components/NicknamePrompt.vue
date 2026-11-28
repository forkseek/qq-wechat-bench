<script setup>
// 老用户（早就设置好了、不需要走整套引导）第一次用到新版时，只问一句：桌宠该怎么叫你。
import { ref } from 'vue';
import { api } from '../api.js';
import CalendarPetSprite from './CalendarPetSprite.vue';

const emit = defineEmits(['close', 'saved', 'toast', 'later']);
const nickname = ref('');
const saving = ref(false);
const error = ref('');

async function submit() {
  const n = nickname.value.trim();
  if (!n) {
    error.value = '随便起一个就行～';
    return;
  }
  saving.value = true;
  try {
    await api('/api/companion', { nickname: n }, 'PUT');
    emit('toast', `好嘞，以后叫你「${n}」`);
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('later')">
    <div class="modal-card nick-card" role="dialog" aria-modal="true" aria-labelledby="nick-title">
      <header class="modal-header">
        <h2 id="nick-title" class="modal-title">桌宠想认识你</h2>
        <button class="modal-close" aria-label="以后再说" @click="emit('later')">×</button>
      </header>
      <form class="modal-body nick-body" @submit.prevent="submit">
        <CalendarPetSprite view="front" mood="shy" :today-day="new Date().getDate()" />
        <div class="nick-right">
          <p class="nick-line">诶嘿……我们都认识这么久了，我还不知道该怎么叫你耶！</p>
          <input v-model="nickname" class="input" maxlength="20" placeholder="比如：石头" autofocus @input="error = ''" />
          <p v-if="error" class="nick-error">{{ error }}</p>
        </div>
      </form>
      <footer class="modal-footer">
        <button class="btn btn-secondary btn-sm" type="button" @click="emit('later')">以后再说</button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="saving" @click="submit">就这么叫我</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.nick-card { width: min(520px, 100%); }
.nick-body { flex-direction: row; align-items: center; gap: 14px; }
.nick-right { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; }
.nick-line { font-size: 14px; font-weight: 700; line-height: 1.6; color: var(--ink); }
.nick-error { font-size: 12.5px; color: var(--seal); font-weight: 600; }
</style>
