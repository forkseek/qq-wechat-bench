<script setup>
// 扭蛋抽签（嵌在待办清单正上方）：不知道先做哪个必做事项时转一下；越快截止的越容易抽到。
// 默认用 three.js 手绘卡通 3D 机器（gacha3d/GachaScene.js，按需加载）；WebGL 起不来时退回下面的 CSS 机器。
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { sfx, soundEnabled, setSoundEnabled } from '../utils/gacha-sfx.js';

const props = defineProps({
  // [{ id, title, group, dueText, tag, state, weight }]
  tasks: { type: Array, required: true }
});
const emit = defineEmits(['pick']);

// 收起 / 展开记在本机浏览器里
const FOLD_KEY = 'xunke.gachaFolded';
function loadFolded() {
  try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
}
const folded = ref(loadFolded());
function toggleFold() {
  folded.value = !folded.value;
  try { localStorage.setItem(FOLD_KEY, folded.value ? '1' : '0'); } catch { /* ignore */ }
}

const stage = ref('idle'); // idle | spinning | dropped | opening | open
// 三步：拧一圈 → 拆胶囊 → 看签。右边一直显示走到哪一步，不会突然空掉
const step = computed(() => (stage.value === 'open' ? 3 : stage.value === 'dropped' || stage.value === 'opening' ? 2 : 1));
const STEPS = ['拧一圈', '拆胶囊', '看签'];
const slipEl = ref(null);
const knobTurns = ref(0);
const picked = ref(null);
const capsuleColor = ref('#fda4af');
let lastId = '';
let timer = 0;
let chimeTimer = 0;
const soundOn = ref(soundEnabled());

function toggleSound() {
  soundOn.value = !soundOn.value;
  setSoundEnabled(soundOn.value);
  if (soundOn.value) sfx.blip();
}

const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const totalWeight = computed(() => props.tasks.reduce((s, t) => s + t.weight, 0));

const STATE_COLORS = {
  overdue: '#fda4af',
  today: '#fde047',
  soon: '#7dd3fc',
  normal: '#c4b5fd',
  unknown: '#86efac'
};
const CAP_COLORS = ['#fda4af', '#fde047', '#7dd3fc', '#c4b5fd', '#86efac', '#fdba74'];

// 球在罩子里的位置：按序号铺开，固定不乱跳
const balls = computed(() => {
  const list = props.tasks.slice(0, 16);
  return list.map((t, i) => {
    const row = Math.floor(i / 4);
    const col = i % 4;
    return {
      key: t.id,
      color: STATE_COLORS[t.state] || STATE_COLORS.normal,
      left: 30 + col * 52 + (row % 2 ? 22 : 0) + ((i * 7) % 6),
      top: 168 - row * 42 + ((i * 11) % 8),
      delay: (i % 5) * 0.06
    };
  });
});

function weightedPick() {
  const list = props.tasks;
  if (!list.length) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r = Math.random() * totalWeight.value;
    let choice = list[list.length - 1];
    for (const t of list) {
      r -= t.weight;
      if (r < 0) { choice = t; break; }
    }
    if (choice.id !== lastId || list.length === 1) return choice;
  }
  return list.find(t => t.id !== lastId) || list[0];
}

// ---------- 3D 机器 ----------
const mode = ref('3d'); // 3d | css
const host3d = ref(null);
const ready3d = ref(false);
let scene = null;
let ballSig = '';
let creating = null;

function ballList() {
  return props.tasks.slice(0, 16).map(t => ({ id: t.id, color: STATE_COLORS[t.state] || STATE_COLORS.normal }));
}

function syncBalls() {
  if (!scene) return;
  const list = ballList();
  const sig = list.map(b => `${b.id}:${b.color}`).join('|');
  if (sig === ballSig) return;
  ballSig = sig;
  scene.setBalls(list);
}

async function createScene(el) {
  if (scene || creating) return;
  creating = (async () => {
    try {
      const { GachaScene } = await import('../gacha3d/GachaScene.js');
      if (host3d.value !== el) return; // 加载期间面板被收起了
      scene = new GachaScene(el, {
        onTick: () => {
          sfx.tick();
          if (stage.value === 'idle') stage.value = 'spinning';
        },
        onImpact: s => sfx.clack(s),
        onDropLand: s => sfx.land(s),
        onPop: () => sfx.pop(),
        onIntroTick: () => sfx.tick(),
        onIntroShine: () => sfx.sparkle(),
        onTurned: onTurned3d,
        onCapsuleClick: openCapsule
      });
      ballSig = '';
      syncBalls();
      ready3d.value = true;
      // 入场：机器掉下来、弹一弹、玻璃闪一下（系统设了「减少动态效果」时直接跳过）
      scene.playIntro();
    } catch (err) {
      console.warn('[扭蛋机] 3D 起不来，改用平面版：', err);
      mode.value = 'css';
    } finally {
      creating = null;
    }
  })();
}

function destroyScene() {
  scene?.dispose();
  scene = null;
  ready3d.value = false;
  ballSig = '';
  if (stage.value !== 'open') stage.value = 'idle';
}

watch(host3d, el => {
  if (el) createScene(el);
  else destroyScene();
}, { flush: 'post' });

watch(() => props.tasks, () => syncBalls());

async function onTurned3d() {
  stage.value = 'spinning';
  picked.value = weightedPick();
  lastId = picked.value?.id || '';
  if (!picked.value || !scene) return;
  const color = STATE_COLORS[picked.value.state] || STATE_COLORS.normal;
  await scene.dropCapsule(picked.value.id, color);
  stage.value = 'dropped';
}

function spin3d() {
  if (!scene || !props.tasks.length) return;
  if (stage.value === 'open' || stage.value === 'dropped') {
    scene.reset();
    picked.value = null;
    stage.value = 'idle';
  }
  scene.spin();
}

// ---------- 统一入口（3D / 平面版共用按钮） ----------
function spin() {
  if (mode.value === '3d') return spin3d();
  return spinCss();
}

function spinCss() {
  if (!props.tasks.length || stage.value === 'spinning') return;
  clearTimeout(timer);
  clearTimeout(chimeTimer);
  knobTurns.value += 1;
  stage.value = 'spinning';
  picked.value = null;
  sfx.crank();
  sfx.rattle();
  timer = setTimeout(() => {
    picked.value = weightedPick();
    lastId = picked.value?.id || '';
    capsuleColor.value = CAP_COLORS[Math.floor(Math.random() * CAP_COLORS.length)];
    stage.value = 'dropped';
    sfx.drop();
  }, reduceMotion ? 0 : 820);
}

async function openCapsule() {
  if (stage.value !== 'dropped') return;
  if (mode.value === '3d' && scene) {
    // 3D 版的「啵」由场景在真正弹开的那一刻放（前面还有一小段蓄力抖动）
    stage.value = 'opening';
    await scene.openCapsule();
    const from = scene?.capsuleScreenPos();
    stage.value = 'open';
    sfx.chime();
    await nextTick();
    flySlip(from);
    return;
  }
  sfx.pop();
  stage.value = 'open';
  chimeTimer = setTimeout(() => sfx.chime(), 180);
}

// 签条从托盘上的胶囊里飞出来，落到右边（以前是凭空冒出来，和胶囊对不上）
function flySlip(from) {
  const el = slipEl.value;
  if (!el || !from || reduceMotion || typeof el.animate !== 'function') return;
  const r = el.getBoundingClientRect();
  const dx = from.x - (r.left + r.width / 2);
  const dy = from.y - (r.top + r.height / 2);
  el.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(0.1) rotate(-24deg)`, opacity: 0.4 },
    { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 46}px) scale(0.75) rotate(-10deg)`, opacity: 1, offset: 0.55 },
    { transform: 'translate(0, 0) scale(1.04) rotate(-0.5deg)', offset: 0.85 },
    { transform: 'rotate(-1.5deg)' }
  ], { duration: 640, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)', fill: 'backwards' });
}

function chance(t) {
  if (!t || !totalWeight.value) return 0;
  return Math.round((t.weight / totalWeight.value) * 100);
}

function confirmPick() {
  if (picked.value) emit('pick', picked.value.id);
}

onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(chimeTimer);
  destroyScene();
});
</script>

<template>
  <section class="book-sheet gacha-panel" :class="{ folded }" aria-labelledby="gacha-title">
      <div class="gacha-head">
        <div class="gacha-head-left">
          <span class="gacha-head-icon" aria-hidden="true"></span>
          <h2 id="gacha-title" class="gacha-title">扭蛋抽签 · 先做哪个？</h2>
          <span v-if="folded" class="gacha-folded-hint">必做 {{ tasks.length }} 颗在里面</span>
        </div>
        <div class="head-actions">
          <button
            class="sound-toggle"
            :class="{ off: !soundOn }"
            :aria-pressed="soundOn"
            :title="soundOn ? '关掉音效' : '打开音效'"
            @click="toggleSound"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path v-if="soundOn" d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
              <path v-else d="m22 9-6 6M16 9l6 6" />
            </svg>
            <span>{{ soundOn ? '音效开' : '静音' }}</span>
          </button>
          <button class="fold-btn" :aria-expanded="!folded" @click="toggleFold">
            {{ folded ? '展开 ▾' : '收起 ▴' }}
          </button>
        </div>
      </div>

      <div v-if="!folded" class="gacha-body">
        <div v-if="!tasks.length" class="gacha-empty">
          <div class="gacha-empty-mark">✓</div>
          <p>今天没有必做事项，扭蛋机放假。</p>
        </div>

        <div v-else class="gacha-stage">
          <div v-if="mode === '3d'" ref="host3d" class="machine3d" :class="{ loading: !ready3d }">
            <span v-if="!ready3d" class="machine3d-loading">扭蛋机组装中…</span>
          </div>
          <div v-else class="machine" :class="{ shaking: stage === 'spinning' }">
            <div class="dome">
              <span
                v-for="b in balls"
                :key="b.key"
                class="ball"
                :style="{ left: `${b.left}px`, top: `${b.top}px`, background: b.color, animationDelay: `${b.delay}s` }"
              ></span>
              <span class="dome-shine" aria-hidden="true"></span>
            </div>
            <div class="stand">
              <div class="chute" aria-hidden="true"></div>
              <button
                class="knob"
                :style="{ transform: `rotate(${knobTurns * 360}deg)` }"
                :disabled="stage === 'spinning'"
                aria-label="转动扭蛋机"
                title="转一下"
                @click="spin"
              >
                <span class="knob-bar"></span>
              </button>
            </div>
            <div class="stand-label num">必做 × {{ tasks.length }}</div>
          </div>

          <div class="tray">
            <ol class="gacha-steps" aria-label="抽签步骤">
              <li
                v-for="(label, i) in STEPS"
                :key="label"
                :class="{ on: step === i + 1, done: step > i + 1 }"
                :aria-current="step === i + 1 ? 'step' : undefined"
              >
                <span class="step-dot">{{ step > i + 1 ? '✓' : i + 1 }}</span>{{ label }}
              </li>
            </ol>

            <template v-if="mode === '3d'">
              <template v-if="stage === 'idle'">
                <p class="tray-hint">抓住机器右边的<b>黄色旋钮</b>顺时针拧一圈，<br />或者直接点它一下。<br /><span class="tray-sub">越快截止的，越容易掉出来。</span></p>
                <button class="btn btn-primary btn-sm" :disabled="!ready3d" @click="spin">帮我转一下</button>
              </template>
              <p v-else-if="stage === 'spinning'" class="tray-hint">咔啦咔啦……<br /><span class="tray-sub">在摇了在摇了</span></p>
              <template v-else-if="stage === 'dropped'">
                <p class="tray-hint">掉出来一颗！<br /><span class="tray-sub">点左下托盘上的胶囊，或者按下面的按钮。</span></p>
                <button class="btn btn-primary btn-sm" @click="openCapsule">拆开胶囊</button>
              </template>
              <p v-else-if="stage === 'opening'" class="tray-hint">拆开看看……</p>
            </template>

            <template v-else>
              <p v-if="stage === 'idle'" class="tray-hint">转右下角的旋钮。<br />越快截止的，越容易掉出来。</p>
              <p v-else-if="stage === 'spinning'" class="tray-hint">咔啦咔啦……</p>
            </template>

            <button
              v-if="mode === 'css' && (stage === 'dropped' || stage === 'open')"
              class="capsule"
              :class="{ opened: stage === 'open' }"
              :aria-label="stage === 'open' ? '扭蛋已打开' : '点开扭蛋'"
              @click="openCapsule"
            >
              <span class="cap-top" :style="{ background: capsuleColor }"></span>
              <span class="cap-bottom"></span>
            </button>
            <p v-if="mode === 'css' && stage === 'dropped'" class="tray-hint">掉出来一颗，点开它</p>

            <div v-if="stage === 'open' && picked" ref="slipEl" class="slip" :class="{ 'slip-css': mode === 'css' }">
              <div class="slip-kicker">先做这个</div>
              <div class="slip-title">{{ picked.title }}</div>
              <div class="slip-meta">
                <span class="slip-due" :class="`slip-${picked.state}`">{{ picked.dueText }}</span>
                <span v-if="picked.tag" class="muted">{{ picked.tag }}</span>
              </div>
              <div class="slip-meta muted">
                <span>{{ picked.group }}</span>
                <span class="nowrap">抽中概率 <span class="num">{{ chance(picked) }}%</span></span>
              </div>
            </div>

            <div v-if="stage === 'open' && picked" class="tray-actions">
              <button class="btn btn-primary btn-sm" @click="confirmPick">就它了，去看看</button>
              <button class="btn btn-secondary btn-sm" @click="spin">不想做，再转一次</button>
            </div>
          </div>
        </div>
      </div>
  </section>
</template>

<style scoped>
.gacha-panel { overflow: hidden; background: #fffdf5; }

.gacha-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 20px;
  background: var(--marker-rose);
  border-bottom: 2px solid var(--stroke);
  flex-wrap: wrap;
}
.gacha-panel.folded .gacha-head { border-bottom: 0; }
.gacha-head-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gacha-head-icon {
  width: 26px; height: 26px; flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid var(--stroke);
  background: linear-gradient(180deg, #fda4af 0 50%, #ffffff 50% 100%);
  box-shadow: 2px 2px 0 var(--stroke);
}
.gacha-title { font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--ink); }
.gacha-folded-hint { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
.fold-btn {
  padding: 4px 11px;
  border-radius: var(--sketch-radius-sm);
  border: 1.75px solid var(--stroke);
  background: #ffffff;
  font-size: 12.5px; font-weight: 700; color: var(--ink);
  box-shadow: 2px 2px 0 var(--stroke);
}
.fold-btn:hover { background: var(--marker-yellow); transform: translate(-1px, -1px); }

.gacha-body { padding: 8px 20px 18px; }
.gacha-body .gacha-stage { gap: 28px; }
/* 右栏定宽定高：以前每一步内容宽窄不一，整台机器会跟着左右挪 */
.gacha-body .tray { flex: 0 0 300px; width: 300px; max-width: 100%; min-width: 0; min-height: 330px; justify-content: center; }

.gacha-steps { display: flex; gap: 6px; list-style: none; margin: 0 0 4px; padding: 0; flex-wrap: wrap; }
.gacha-steps li {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px 3px 4px;
  border: 1.75px solid var(--stroke);
  border-radius: var(--sketch-radius-pill);
  background: #ffffff;
  font-size: 12.5px; font-weight: 700; color: var(--ink-3);
}
.gacha-steps li.on { background: var(--marker-yellow); color: var(--ink); box-shadow: 2px 2px 0 var(--stroke); }
.gacha-steps li.done { background: var(--marker-mint); color: var(--ink-2); }
.step-dot {
  width: 18px; height: 18px; border-radius: 50%;
  border: 1.5px solid var(--stroke); background: #ffffff;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1;
}
.tray-hint b { color: var(--ink); background: linear-gradient(transparent 55%, var(--marker-yellow) 55%); }
.tray-sub { font-size: 13px; color: var(--ink-3); }

.machine3d {
  position: relative;
  width: 340px;
  height: 400px;
  flex-shrink: 0;
  touch-action: none;
}
.machine3d :deep(.gacha3d-canvas) { display: block; outline: none; }
.machine3d.loading { display: flex; align-items: center; justify-content: center; }
.machine3d-loading { font-size: 13px; font-weight: 600; color: var(--ink-3); }
@media (max-width: 780px) {
  .machine3d { width: 280px; height: 330px; }
  .gacha-body .tray { min-height: 0; }
}
.tray-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.head-actions { display: flex; align-items: center; gap: 10px; }
.sound-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 11px;
  border-radius: var(--sketch-radius-pill);
  border: 1.75px solid var(--stroke);
  background: var(--marker-mint);
  color: var(--ink);
  font-size: 12.5px; font-weight: 700;
  box-shadow: 2px 2px 0 var(--stroke);
}
.sound-toggle svg { width: 16px; height: 16px; }
.sound-toggle.off { background: #ffffff; color: var(--ink-3); }
.sound-toggle:hover { transform: translate(-1px, -1px); }

.gacha-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 26px 0; font-weight: 600; color: var(--ink-2); }
.gacha-empty-mark {
  width: 44px; height: 44px; border-radius: var(--sketch-circle);
  border: 2px solid var(--stroke); background: var(--marker-mint); color: var(--wx);
  display: inline-flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700;
  box-shadow: 2.5px 2.5px 0 var(--stroke);
}

.gacha-stage { display: flex; gap: 44px; align-items: flex-end; flex-wrap: wrap; justify-content: center; padding: 14px 0 8px; }

.machine { display: flex; flex-direction: column; align-items: center; transform-origin: 50% 100%; }
.machine.shaking { animation: machine-shake 0.4s ease-in-out 2; }

.dome {
  position: relative;
  width: 264px; height: 246px;
  border: 3px solid var(--stroke);
  border-radius: 50% 50% 18px 18px / 58% 58% 18px 18px;
  background: #ffffff;
  overflow: hidden;
  box-shadow: 6px 6px 0 var(--stroke);
}
.dome-shine {
  position: absolute; left: 32px; top: 24px; width: 26px; height: 72px;
  border-radius: 50%; border-left: 4px solid rgba(35, 33, 30, 0.16);
  transform: rotate(18deg); pointer-events: none;
}
.ball {
  position: absolute; width: 44px; height: 44px;
  border-radius: var(--sketch-circle);
  border: 2.5px solid var(--stroke);
}
.ball::after {
  content: ""; position: absolute; left: 3px; right: 3px; top: 50%;
  border-top: 2.5px solid var(--stroke);
}
.shaking .ball { animation: ball-jiggle 0.26s ease-in-out 3; }

.stand {
  width: 264px; height: 96px; box-sizing: border-box;
  margin-top: -3px;
  border: 3px solid var(--stroke);
  border-radius: 8px 8px 24px 20px;
  background: var(--marker-rose);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px;
  box-shadow: 6px 6px 0 var(--stroke);
}
.chute { width: 78px; height: 50px; border: 2.5px solid var(--stroke); border-radius: 14px 14px 8px 8px; background: var(--ink); }
.knob {
  width: 66px; height: 66px; border-radius: var(--sketch-circle);
  border: 3px solid var(--stroke); background: var(--marker-yellow);
  box-shadow: 3px 3px 0 var(--stroke);
  display: inline-flex; align-items: center; justify-content: center;
  transition: transform 0.8s cubic-bezier(0.3, 1.3, 0.5, 1);
  cursor: pointer;
}
.knob:hover:not(:disabled) { background: var(--marker-yellow-deep); }
.knob:disabled { cursor: progress; }
.knob-bar { width: 42px; height: 11px; border: 2.5px solid var(--stroke); border-radius: 8px; background: #ffffff; }
.stand-label { margin-top: 10px; font-size: 13px; font-weight: 700; color: var(--ink-2); }

.tray { min-width: 280px; max-width: 310px; min-height: 300px; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start; gap: 14px; }
.tray-hint { font-size: 15px; font-weight: 600; color: var(--ink); line-height: 1.7; }

.capsule {
  position: relative; width: 96px; height: 96px; padding: 0;
  animation: capsule-drop 0.6s cubic-bezier(0.3, 1.5, 0.5, 1);
  cursor: pointer;
}
.capsule.opened { cursor: default; }
.cap-top, .cap-bottom {
  position: absolute; left: 0; width: 96px; height: 48px; box-sizing: border-box;
  border: 3px solid var(--stroke);
  transition: transform 0.45s cubic-bezier(0.3, 1.4, 0.5, 1);
}
.cap-top { top: 0; border-radius: 48px 48px 5px 5px; }
.cap-bottom { bottom: 0; border-radius: 5px 5px 48px 48px; background: #ffffff; }
.capsule:not(.opened):hover .cap-top { transform: translateY(-4px) rotate(-6deg); }
.capsule:not(.opened) { animation: capsule-drop 0.6s cubic-bezier(0.3, 1.5, 0.5, 1), capsule-wobble 1.4s ease-in-out 0.8s infinite; }
.capsule.opened .cap-top { transform: translate(-16px, -30px) rotate(-32deg); }
.capsule.opened .cap-bottom { transform: translate(10px, 12px) rotate(10deg); }

.slip {
  width: 100%;
  padding: 14px 16px;
  border: 2px solid var(--stroke);
  border-radius: var(--sketch-radius-sm);
  background: #fff9db;
  box-shadow: 3px 3px 0 var(--stroke);
  transform: rotate(-1.5deg);
  transform-origin: 20% 100%;
  display: flex; flex-direction: column; gap: 4px;
}
/* 平面版没有胶囊可飞，照旧原地弹出来；3D 版由脚本让它从胶囊里飞出来 */
.slip.slip-css { animation: slip-pop 0.5s cubic-bezier(0.3, 1.5, 0.5, 1) both; }
.slip-kicker { font-size: 12.5px; font-weight: 700; color: var(--ochre); }
.slip-title { font-family: var(--font-display); font-size: 19px; font-weight: 700; color: var(--ink); line-height: 1.4; }
.slip-meta { font-size: 13px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.nowrap { white-space: nowrap; }
.slip-due {
  font-weight: 700; padding: 1px 8px; border: 1.5px solid var(--stroke);
  border-radius: var(--sketch-radius-pill); background: #ffffff;
}
.slip-overdue { background: var(--marker-rose); color: var(--seal); }
.slip-today { background: var(--marker-yellow); color: var(--ochre); }
.slip-soon { background: var(--marker-sky); color: var(--qq); }

@keyframes machine-shake {
  0%, 100% { transform: rotate(0); }
  25% { transform: rotate(-2.5deg); }
  75% { transform: rotate(2.5deg); }
}
@keyframes ball-jiggle {
  0%, 100% { transform: translate(0, 0); }
  33% { transform: translate(-8px, -14px) rotate(-24deg); }
  66% { transform: translate(8px, -6px) rotate(18deg); }
}
@keyframes capsule-wobble {
  0%, 100% { transform: rotate(0); }
  20% { transform: rotate(-7deg); }
  40% { transform: rotate(6deg); }
  60% { transform: rotate(0); }
}
@keyframes capsule-drop {
  0% { transform: translateY(-120px) rotate(-40deg); opacity: 0; }
  60% { opacity: 1; }
  100% { transform: translateY(0) rotate(0); }
}
@keyframes slip-pop {
  0% { transform: scale(0.3) rotate(-8deg); opacity: 0; }
  100% { transform: scale(1) rotate(-1.5deg); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .machine.shaking, .shaking .ball, .capsule, .capsule:not(.opened), .slip { animation: none; }
  .knob, .cap-top, .cap-bottom { transition: none; }
}
</style>
