<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  assistantOpen: { type: Boolean, default: false }
});
defineEmits(['navigate', 'toggle-assistant']);

const qqBadge = computed(() => {
  const qq = props.state?.qq || {};
  if (qq.online) {
    return {
      text: qq.degraded ? 'QQ 重试' : (qq.name ? `QQ · ${qq.name}` : 'QQ 直连'),
      title: qq.mode === 'local' ? `桌面 QQ 已直连（${qq.name || qq.account || ''}）` : 'QQ 已连接',
      dot: qq.degraded ? 'dot-warn' : 'dot-ok',
      cls: qq.degraded ? 'pill-warn' : 'pill-ok'
    };
  }
  if (qq.blockedReason === 'desktop_in_use') return { text: 'QQ 待连', title: qq.error || '正在识别桌面 QQ', dot: 'dot-warn', cls: 'pill-warn' };
  if (qq.available || qq.launcherRunning || qq.ownedQQRunning) return { text: 'QQ 待扫码', title: 'QQ 等待扫码或启动中', dot: 'dot-warn', cls: 'pill-warn' };
  return { text: 'QQ 未连', title: '打开并登录电脑 QQ 后自动接入', dot: '', cls: '' };
});

const wxBadge = computed(() => {
  const wx = props.state?.wechat || {};
  if (wx.online) {
    return {
      text: wx.degraded ? '微信重试' : (wx.name ? `微信 · ${wx.name}` : '微信直连'),
      title: wx.degraded ? '微信读取重试中' : `电脑微信已直连（${wx.name || ''}）`,
      dot: wx.degraded ? 'dot-warn' : 'dot-ok',
      cls: wx.degraded ? 'pill-warn' : 'pill-ok'
    };
  }
  if (wx.phase === 'client_closed') return { text: '微信未开', title: '电脑微信未打开', dot: '', cls: '' };
  return { text: '微信待登', title: '等待电脑微信登录', dot: 'dot-warn', cls: 'pill-warn' };
});

const aiBadge = computed(() => {
  const m = props.state?.model || {};
  if (m.configured) return { text: 'AI 智录', title: `AI 已就绪（${m.name || ''}）`, dot: 'dot-ok', cls: 'pill-ok' };
  if (m.error) return { text: 'AI 异常', title: m.error, dot: 'dot-err', cls: 'pill-err' };
  return { text: 'AI 未配', title: '尚未配置 AI 模型', dot: '', cls: '' };
});
</script>

<template>
  <div class="status-cluster">
    <div class="status-rail" aria-label="连接状态">
      <button class="mini-pill" :class="qqBadge.cls" :title="qqBadge.title" @click="$emit('navigate', 'settings')">
        <span class="dot" :class="qqBadge.dot"></span>
        <span class="pill-label">{{ qqBadge.text }}</span>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="mini-pill" :class="wxBadge.cls" :title="wxBadge.title" @click="$emit('navigate', 'settings')">
        <span class="dot" :class="wxBadge.dot"></span>
        <span class="pill-label">{{ wxBadge.text }}</span>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="mini-pill" :class="aiBadge.cls" :title="aiBadge.title" @click="$emit('navigate', 'settings')">
        <span class="dot" :class="aiBadge.dot"></span>
        <span class="pill-label">{{ aiBadge.text }}</span>
      </button>
    </div>

    <button
      v-if="state?.model?.configured"
      class="assistant-btn"
      :class="{ active: assistantOpen }"
      @click="$emit('toggle-assistant')"
      title="展开或收起案头通知助手"
    >
      <span class="spark" aria-hidden="true">✦</span>
      <span>案头助手</span>
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
  padding: 3px 5px;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong);
  background: rgba(255, 253, 248, 0.92);
  box-shadow: 0 1px 3px rgba(22, 31, 26, 0.04), 0 1px 0 #fff inset;
}

.mini-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink-3);
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.14s, color 0.14s;
}
.mini-pill:hover { background: var(--paper-soft); color: var(--ink); }
.pill-ok { color: var(--pine); font-weight: 500; }
.pill-warn { color: var(--ochre); font-weight: 500; }
.pill-err { color: var(--seal); font-weight: 500; }

.pill-label {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  width: 1px;
  height: 12px;
  background: var(--hairline-strong);
  flex-shrink: 0;
}

.assistant-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--pine-border);
  background: linear-gradient(180deg, #eff6f1 0%, var(--pine-wash) 100%);
  color: var(--pine);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  box-shadow: 0 1px 2px rgba(27, 73, 56, 0.08), 0 1px 0 rgba(255, 255, 255, 0.8) inset;
  transition: all 0.16s var(--ease);
}
.assistant-btn:hover,
.assistant-btn.active {
  background: linear-gradient(180deg, var(--pine-hi) 0%, var(--pine) 100%);
  border-color: var(--pine-deep);
  color: #faf7f0;
  box-shadow: 0 3px 10px rgba(27, 73, 56, 0.24);
}

.spark { font-size: 11px; color: var(--seal); }
.assistant-btn:hover .spark,
.assistant-btn.active .spark { color: #ffd9cf; }
</style>
