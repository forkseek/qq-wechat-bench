<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  assistantOpen: { type: Boolean, default: false }
});
defineEmits(['navigate', 'toggle-assistant']);

const qqBadge = computed(() => {
  const qq = props.state?.qq || {};
  if (qq.online) return { text: 'QQ 已连接', dot: 'dot-ok', cls: 'badge-pine' };
  if (qq.blockedReason === 'desktop_in_use') return { text: qq.pausedByDesktop ? 'QQ 暂让桌面版' : '桌面 QQ 运行中', dot: 'dot-warn', cls: 'badge-ochre' };
  if (qq.available || qq.launcherRunning || qq.ownedQQRunning) return { text: 'QQ 待扫码/启动中', dot: 'dot-warn', cls: 'badge-ochre' };
  return { text: 'QQ 未连接', dot: '', cls: '' };
});

const wxBadge = computed(() => {
  const wx = props.state?.wechat || {};
  if (wx.online) return { text: wx.degraded ? '微信重试中' : '微信已接入', dot: wx.degraded ? 'dot-warn' : 'dot-ok', cls: wx.degraded ? 'badge-ochre' : 'badge-pine' };
  if (wx.phase === 'client_closed') return { text: '微信未打开', dot: '', cls: '' };
  return { text: '微信等待登录', dot: 'dot-warn', cls: 'badge-ochre' };
});

const aiBadge = computed(() => {
  const m = props.state?.model || {};
  if (m.configured) return { text: 'AI 已就绪', dot: 'dot-ok', cls: 'badge-pine' };
  if (m.error) return { text: 'AI 配置异常', dot: 'dot-err', cls: 'badge-seal' };
  return { text: 'AI 未配置', dot: '', cls: '' };
});
</script>

<template>
  <div class="status-group">
    <button class="badge status-btn" :class="qqBadge.cls" @click="$emit('navigate', 'settings')" title="查看 QQ 接入状态">
      <span class="dot" :class="qqBadge.dot"></span>
      <span>{{ qqBadge.text }}</span>
    </button>
    <button class="badge status-btn" :class="wxBadge.cls" @click="$emit('navigate', 'settings')" title="查看微信接入状态">
      <span class="dot" :class="wxBadge.dot"></span>
      <span>{{ wxBadge.text }}</span>
    </button>
    <button class="badge status-btn" :class="aiBadge.cls" @click="$emit('navigate', 'settings')" title="查看 AI 模型设置">
      <span class="dot" :class="aiBadge.dot"></span>
      <span>{{ aiBadge.text }}</span>
    </button>
    <button
      v-if="state?.model?.configured"
      class="btn btn-sm assistant-trigger"
      :class="assistantOpen ? 'btn-primary' : 'btn-secondary'"
      @click="$emit('toggle-assistant')"
    >
      <span aria-hidden="true">✦</span>
      <span>通知助手</span>
    </button>
  </div>
</template>

<style scoped>
.status-group {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-btn {
  transition: filter 0.15s, border-color 0.15s;
}
.status-btn:hover {
  filter: brightness(0.96);
  border-color: var(--pine-border);
}

.assistant-trigger {
  margin-left: 2px;
}
</style>
