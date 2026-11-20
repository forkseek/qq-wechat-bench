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
  padding: 10px 15px;
  border-radius: var(--radius);
  background: var(--pine-deep);
  color: #f7f4ed;
  font-size: 13px;
  box-shadow: var(--shadow-md);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.toast-error {
  background: var(--seal);
}
</style>
