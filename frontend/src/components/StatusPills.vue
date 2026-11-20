<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  assistantOpen: { type: Boolean, default: false }
});
defineEmits(['navigate', 'toggle-assistant']);

const qqBadge = computed(() => {
  const qq = props.state?.qq || {};
  if (qq.online) return { text: qq.degraded ? 'QQ 重试' : 'QQ', title: qq.mode === 'local' ? `QQ 已直连（${qq.name || qq.account || ''}）` : 'QQ 已连接', dot: qq.degraded ? 'dot-warn' : 'dot-ok', cls: qq.degraded ? 'pill-warn' : 'pill-ok' };
  if (qq.blockedReason === 'desktop_in_use') return { text: 'QQ 待连', title: qq.error || '正在识别桌面 QQ', dot: 'dot-warn', cls: 'pill-warn' };
  if (qq.available || qq.launcherRunning || qq.ownedQQRunning) return { text: 'QQ 待扫码', title: 'QQ 等待扫码或启动中', dot: 'dot-warn', cls: 'pill-warn' };
  return { text: 'QQ 未连', title: '打开并登录电脑 QQ 后自动接入', dot: '', cls: '' };
});

const wxBadge = computed(() => {
  const wx = props.state?.wechat || {};
  if (wx.online) return { text: wx.degraded ? '微信重试' : '微信', title: wx.degraded ? '微信读取重试中' : `微信已接入（${wx.name || ''}）`, dot: wx.degraded ? 'dot-warn' : 'dot-ok', cls: wx.degraded ? 'pill-warn' : 'pill-ok' };
  if (wx.phase === 'client_closed') return { text: '微信未开', title: '电脑微信未打开', dot: '', cls: '' };
  return { text: '微信待登', title: '等待电脑微信登录', dot: 'dot-warn', cls: 'pill-warn' };
});

const aiBadge = computed(() => {
  const m = props.state?.model || {};
  if (m.configured) return { text: 'AI', title: `AI 已就绪（${m.name || ''}）`, dot: 'dot-ok', cls: 'pill-ok' };
  if (m.error) return { text: 'AI 异常', title: m.error, dot: 'dot-err', cls: 'pill-err' };
  return { text: 'AI 未配', title: '尚未配置 AI 模型', dot: '', cls: '' };
});
</script>

<template>
  <div class="status-cluster">
    <div class="status-rail" aria-label="连接状态">
      <button class="mini-pill" :class="qqBadge.cls" :title="qqBadge.title" @click="$emit('navigate', 'settings')">
        <span class="dot" :class="qqBadge.dot"></span>
        <span>{{ qqBadge.text }}</span>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="mini-pill" :class="wxBadge.cls" :title="wxBadge.title" @click="$emit('navigate', 'settings')">
        <span class="dot" :class="wxBadge.dot"></span>
        <span>{{ wxBadge.text }}</span>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="mini-pill" :class="aiBadge.cls" :title="aiBadge.title" @click="$emit('navigate', 'settings')">
        <span class="dot" :class="aiBadge.dot"></span>
        <span>{{ aiBadge.text }}</span>
      </button>
    </div>

    <button
      v-if="state?.model?.configured"
      class="assistant-btn"
      :class="{ active: assistantOpen }"
      @click="$emit('toggle-assistant')"
      title="展开或收起通知助手"
    >
      <span class="spark" aria-hidden="true">✦</span>
      <span>助手</span>
    </button>
  </div>
</template>

<style scoped>
.status-cluster {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.status-rail {
  display: inline-flex;
  align-items: center;
  padding: 2px 4px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  background: rgba(255, 253, 248, 0.85);
}

.mini-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink-3);
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.14s, color 0.14s;
}
.mini-pill:hover { background: var(--paper-soft); color: var(--ink); }
.pill-ok { color: var(--pine); }
.pill-warn { color: var(--ochre); }
.pill-err { color: var(--seal); }

.sep {
  width: 1px;
  height: 11px;
  background: var(--hairline);
  flex-shrink: 0;
}

.assistant-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--pine-border);
  background: var(--pine-wash);
  color: var(--pine);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.assistant-btn:hover,
.assistant-btn.active {
  background: var(--pine);
  border-color: var(--pine);
  color: #faf7f0;
}

.spark { font-size: 11px; }
</style>
