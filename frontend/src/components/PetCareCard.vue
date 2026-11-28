<script setup>
// 讯课主界面侧栏的「桌宠小屋」：桌宠的等级称号、饱腹 / 心情 / 成长、零食罐，可以直接在这里喂。
// 数值来自 /api/state 的 petCare（后端 lib/pet-care.mjs 结算），喂食走 POST /api/pet/feed。
import { ref, computed } from 'vue';
import { api } from '../api.js';
import CalendarPetSprite from './CalendarPetSprite.vue';
import { nextUnlock } from '../pet/levels.js';

const props = defineProps({
  state: { type: Object, required: true }
});
const emit = defineEmits(['refresh', 'toast']);

const care = computed(() => props.state?.petCare || null);
const petName = computed(() => props.state?.companion?.petName || '日历小助手');
const feeding = ref(false);
const eating = ref(false);

const mood = computed(() => {
  const c = care.value;
  if (eating.value) return 'eat';
  if (!c) return 'idle';
  if (c.hunger < 10) return 'starving';
  if (c.hunger < 30) return 'hungry';
  if (c.mood < 30) return 'sulky';
  return 'idle';
});

const bars = computed(() => {
  const c = care.value;
  if (!c) return [];
  const span = c.nextLevelExp ? c.nextLevelExp - c.levelExp : 1;
  return [
    { key: 'hunger', label: '饱腹', text: `${c.hunger}`, pct: c.hunger, low: c.hunger < 30 },
    { key: 'mood', label: '心情', text: `${c.mood}`, pct: c.mood, low: c.mood < 30 },
    {
      key: 'exp', label: '成长',
      text: c.nextLevelExp ? `${c.exp - c.levelExp}/${span}` : '满级',
      pct: c.nextLevelExp ? Math.round(((c.exp - c.levelExp) / span) * 100) : 100,
      low: false
    }
  ];
});

const hint = computed(() => {
  const c = care.value;
  if (!c) return '';
  if (c.hunger < 30 && c.snacks > 0) return '它饿了，喂一口吧～';
  if (c.hunger < 30) return '它饿了，完成一个必做就能换零食';
  if (c.mood < 30) return '它在闹脾气：按时交作业、摸摸它都能哄好';
  if (c.snacks === 0) return '零食罐空了，打个勾就会掉零食';
  const next = nextUnlock(c.level);
  if (!next || !c.nextLevelExp) return '已经满级，是时间管理大师了！';
  return `再 ${c.nextLevelExp - c.exp} 成长升 Lv${next.level}，解锁「${next.label}」`;
});

async function feed() {
  if (feeding.value || !care.value) return;
  feeding.value = true;
  try {
    const res = await api('/api/pet/feed', {});
    if (res?.ate) {
      eating.value = true;
      setTimeout(() => { eating.value = false; }, 1500);
      emit('toast', `${petName.value}吃掉一块零食 · 饱腹 ${res.care?.hunger ?? ''}`);
    } else {
      emit('toast', res?.reason === 'full' ? `${petName.value}说吃不下啦` : '零食罐空了，完成任务就会掉零食', res?.reason === 'full' ? 'info' : 'error');
    }
    emit('refresh');
  } catch (err) {
    emit('toast', err.message, 'error');
  } finally {
    feeding.value = false;
  }
}
</script>

<template>
  <section v-if="care" class="pet-home" aria-label="桌宠小屋">
    <span class="home-tape" aria-hidden="true"></span>
    <div class="home-head">
      <div class="home-avatar" aria-hidden="true">
        <CalendarPetSprite view="front" :mood="mood" :today-day="new Date().getDate()" />
      </div>
      <div class="home-id">
        <div class="home-name">{{ petName }}</div>
        <div class="home-level">
          <span class="lv-pill">Lv{{ care.level }}</span>
          <span class="lv-title" :title="care.title">{{ care.title }}</span>
        </div>
      </div>
    </div>

    <div v-for="b in bars" :key="b.key" class="home-row" :class="[`bar-${b.key}`, { low: b.low }]">
      <span class="row-label">{{ b.label }}</span>
      <span class="row-track"><span class="row-fill" :style="{ width: `${Math.max(4, b.pct)}%` }"></span></span>
      <span class="row-val num">{{ b.text }}</span>
    </div>

    <div class="home-foot">
      <span class="jar" title="完成任务就会往罐子里掉零食">零食罐 × <b class="num">{{ care.snacks }}</b></span>
      <button class="feed-btn" type="button" :disabled="feeding" @click="feed">{{ feeding ? '喂食中…' : '喂它一口' }}</button>
    </div>
    <p class="home-hint">{{ hint }}</p>
  </section>
</template>

<style scoped>
.pet-home {
  position: relative;
  margin-top: 16px;
  padding: 12px 11px 9px;
  border-radius: var(--sketch-radius-sm);
  border: 2px solid var(--stroke);
  background: #f0f9ff;
  box-shadow: 3.5px 3.5px 0 var(--stroke);
  transform: rotate(0.6deg);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.home-tape {
  position: absolute;
  top: -8px;
  left: 50%;
  width: 54px;
  height: 14px;
  transform: translateX(-50%) rotate(3deg);
  background: rgba(253, 164, 175, 0.75);
  border: 1.5px solid rgba(35, 33, 30, 0.35);
}
.home-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.home-avatar {
  position: relative;
  width: 54px;
  height: 54px;
  flex-shrink: 0;
}
/* 精灵原尺寸 148×148，绝对定位缩到 0.38 塞进 54×54 的头像框，不撑开侧栏 */
.home-avatar :deep(.pet-sprite-wrap) {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.38);
  transform-origin: center;
}
.home-avatar :deep(.pet-fx) { display: none; }
.home-id { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.home-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--ink); }
.home-level { display: flex; align-items: center; gap: 5px; min-width: 0; }
.lv-pill {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 800;
  padding: 0 7px;
  border-radius: var(--sketch-radius-pill);
  border: 1.5px solid var(--stroke);
  background: var(--marker-yellow);
  color: var(--ink);
}
.lv-title { font-size: 11px; font-weight: 700; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.home-row { display: grid; grid-template-columns: 28px 1fr 46px; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--ink-2); }
.row-track { height: 9px; border: 1.5px solid var(--stroke); border-radius: 6px; background: #fff; overflow: hidden; }
.row-fill { display: block; height: 100%; background: var(--marker-mint); transition: width 0.4s var(--ease); }
.bar-hunger .row-fill { background: #86efac; }
.bar-mood .row-fill { background: #f9a8d4; }
.bar-exp .row-fill { background: #93c5fd; }
.home-row.low .row-fill { background: #fb7185; }
.home-row.low .row-val { color: var(--seal); }
.row-val { text-align: right; white-space: nowrap; color: var(--ink); }

.home-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 3px; }
.jar { font-size: 11.5px; font-weight: 700; color: var(--ink); }
.feed-btn {
  font-size: 11.5px;
  font-weight: 800;
  padding: 2px 9px;
  border-radius: var(--sketch-radius-sm);
  border: 1.75px solid var(--stroke);
  background: var(--marker-yellow);
  color: var(--ink);
  box-shadow: 2px 2px 0 var(--stroke);
  cursor: pointer;
}
.feed-btn:hover:not(:disabled) { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 var(--stroke); }
.feed-btn:disabled { background: var(--paper-soft); cursor: default; }
.home-hint { font-size: 10.5px; color: var(--ink-3); line-height: 1.45; margin-top: 1px; }
</style>
