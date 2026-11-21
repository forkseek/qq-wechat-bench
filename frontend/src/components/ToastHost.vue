<script setup>
defineProps({
  items: { type: Array, default: () => [] }
});
</script>

<template>
  <div class="toast-stack" role="status" aria-live="polite">
    <div v-for="item in items" :key="item.id" class="toast-item" :class="item.kind === 'error' ? 'toast-error' : ''">
      {{ item.text }}
    </div>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast-item {
  pointer-events: auto;
  max-width: 360px;
  padding: 10px 16px;
  border-radius: 12px;
  background: rgba(20, 27, 45, 0.92);
  backdrop-filter: blur(20px);
  color: #f8fafc;
  font-size: 13px;
  box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(129, 140, 248, 0.35);
}

.toast-error {
  background: rgba(159, 18, 57, 0.92);
  border-color: rgba(251, 113, 133, 0.45);
}
</style>
