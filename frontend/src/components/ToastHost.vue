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
  border-radius: var(--sketch-radius-sm);
  background: var(--marker-yellow);
  color: var(--ink);
  font-size: 13px;
  font-weight: 700;
  box-shadow: 4px 4px 0 var(--stroke);
  border: 2px solid var(--stroke);
}

.toast-error {
  background: var(--marker-rose);
  color: var(--seal);
}
</style>
