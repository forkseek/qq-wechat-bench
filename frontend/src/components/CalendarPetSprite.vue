<script setup>
// 日历小助手 · 手账画风：炭黑粗描边 + 荧光笔平涂色 + 右下实心墨影（跟讯课卡片的硬投影一个路子），不用渐变。
// 透明靠颜色抠图，所以不能有半透明阴影 / 发光；描边是深墨色，抗锯齿边缘也看不出毛边。
import { computed } from 'vue';

const props = defineProps({
  /** 'front' | 'left' | 'back' | 'right' */
  view: { type: String, default: 'front' },
  /** idle happy celebrate urgent focus walk sleep drag shy laugh pout angry startle dizzy fly */
  mood: { type: String, default: 'idle' },
  blinking: { type: Boolean, default: false },
  todayDay: { type: [String, Number], default: '' },
  flipping: { type: Boolean, default: false },
  /** 眼睛看向：x、y 各在 -1..1 */
  look: { type: Object, default: () => ({ x: 0, y: 0 }) },
  /** 被拎着甩时的身体倾斜角度 */
  tilt: { type: Number, default: 0 },
  /** 落地时压扁一下 */
  squash: { type: Boolean, default: false },
  /** 被戳的部位，用来做一下局部反应 */
  poke: { type: String, default: '' },
  /** 散步时往哪边转：-1 左、1 右、0 不转（中间值是正在转身，用来平滑过渡） */
  turn: { type: Number, default: 0 }
});

const turnAmt = computed(() => Math.max(-1, Math.min(1, props.turn || 0)));

const INK = '#23211e';
const PAGE = '#fffdf5';
const HEADER = '#93cff9';
const BACK = '#7dbdf2';
const ROSE = '#fda4af';
const BUTTER = '#fde047';
const MINT = '#86efac';
const BLUSH = '#fda4af';
const BLUSH_DEEP = '#fb7185';
const BOW = '#f9a8d4';

const rootClasses = computed(() => [
  'pet-sprite-wrap',
  `view-${props.view}`,
  `mood-${props.mood}`,
  { 'is-flipping': props.flipping, 'is-squash': props.squash, [`poke-${props.poke}`]: !!props.poke }
]);

const eyeShift = computed(() => {
  let x = Math.max(-1, Math.min(1, props.look?.x || 0));
  let y = Math.max(-1, Math.min(1, props.look?.y || 0));
  if (props.mood === 'shy') { x *= 0.4; y = 0.9; }
  if (props.mood === 'sulky') { x = 0.95; y = 0.15; } // 生闷气：故意不看你
  // 散步：眼睛看着前进方向（转得越多，越不理光标）
  const t = turnAmt.value;
  if (t) { x = x * (1 - Math.abs(t)) + t; y = y * (1 - Math.abs(t)) + 0.1 * Math.abs(t); }
  return `translate(${(x * 4.2).toFixed(2)} ${(y * 3.4).toFixed(2)})`;
});

const faceShift = computed(() => {
  // 晕、飞、回神的时候脸不跟光标走（晕眼要绕自己的中心转，脸一偏就转歪了）
  if (['dizzy', 'fly', 'recover'].includes(props.mood)) return 'translate(0 0)';
  const x = Math.max(-1, Math.min(1, props.look?.x || 0));
  const y = Math.max(-1, Math.min(1, props.look?.y || 0));
  // 散步时整张脸往前进方向挪一截，像侧过半个身子（四分之三侧脸），眼睛嘴巴都还看得清
  const t = turnAmt.value;
  const fx = x * 2.2 * (1 - Math.abs(t)) + t * 8;
  const fy = y * 1.4 * (1 - Math.abs(t));
  return `translate(${fx.toFixed(2)} ${fy.toFixed(2)})`;
});

// 往前进方向微微前倾（绕脚底转）
const leanTransform = computed(() => `rotate(${(turnAmt.value * 5).toFixed(2)} 100 172)`);

const eyeKind = computed(() => {
  const m = props.mood;
  if (m === 'sleep') return 'sleep';
  if (['happy', 'celebrate', 'eat', 'dance', 'wave', 'fireworks'].includes(m)) return 'arc';
  if (['laugh', 'fly', 'recover', 'spin', 'flip'].includes(m)) return 'squeeze';
  if (m === 'hungry' || m === 'starving') return 'tired';
  if (m === 'startle') return 'wide';
  if (m === 'dizzy') return 'spiral';
  if (props.blinking && m !== 'drag' && m !== 'urgent') return 'blink';
  return 'normal';
});

const mouthKind = computed(() => {
  const m = props.mood;
  if (m === 'sleep') return 'o-small';
  if (m === 'drag' || m === 'urgent' || m === 'startle' || m === 'fly') return 'o-big';
  if (m === 'focus') return 'line';
  if (m === 'pout' || m === 'sulky') return 'pout';
  if (m === 'angry' || m === 'dizzy' || m === 'starving') return 'wave';
  if (m === 'shy') return 'shy';
  if (m === 'hungry') return 'sad';
  if (m === 'eat') return 'chomp';
  return 'smile';
});

const cheeksPuffed = computed(() => ['pout', 'angry', 'eat', 'sulky'].includes(props.mood));
const blushColor = computed(() => (['shy', 'laugh', 'pout', 'angry', 'sulky'].includes(props.mood) ? BLUSH_DEEP : BLUSH));
const browKind = computed(() => {
  if (props.mood === 'angry' || props.mood === 'sulky') return 'angry';
  if (['shy', 'dizzy', 'recover', 'hungry', 'starving'].includes(props.mood)) return 'worried';
  return 'normal';
});

const bodyPath = 'M46 56 L154 56 L168 148 C170 158 163 164 153 164 L47 164 C37 164 30 158 32 148 Z';
const pagePath = 'M44 52 C45 44 51 39 59 39 L141 39 C149 39 155 44 156 52 L162 142 C163 151 156 156 146 156 L54 156 C44 156 37 151 38 142 Z';
const backPath = 'M44 52 C45 43 51 39 59 39 L141 39 C149 39 155 43 156 52 L166 146 C167 156 160 162 150 162 L50 162 C40 162 33 156 34 146 Z';
const sidePath = 'M96 42 C100 37 108 37 112 43 L148 148 C151 156 146 162 137 162 L76 162 C67 162 63 156 66 147 Z';
const ringL = 'M68 48 C63 40 64 24 75 24 C86 24 88 38 83 47';
const ringR = 'M117 47 C112 38 114 24 125 24 C136 24 137 40 132 48';
</script>

<template>
  <div :class="rootClasses" :style="{ '--tilt': `${tilt}deg` }">
    <!-- 装饰：爱心 / 撒花 / Zzz / 惊叹 / 晕星 / 速度线 -->
    <div v-if="mood === 'happy' || mood === 'shy'" class="pet-fx" aria-hidden="true">
      <span class="fx-item fx-h1">♥</span>
      <span class="fx-item fx-h2">✦</span>
      <span v-if="mood === 'happy'" class="fx-item fx-h3">♥</span>
    </div>
    <div v-else-if="mood === 'celebrate' || mood === 'laugh'" class="pet-fx" aria-hidden="true">
      <span class="fx-item fx-c1">★</span>
      <span class="fx-item fx-c2">{{ mood === 'laugh' ? '哈' : '✿' }}</span>
      <span class="fx-item fx-c3">✦</span>
      <span class="fx-item fx-c4">{{ mood === 'laugh' ? '哈' : '★' }}</span>
      <span class="fx-item fx-c5">♥</span>
    </div>
    <div v-else-if="mood === 'sleep'" class="pet-fx" aria-hidden="true">
      <span class="fx-z fx-z1">z</span>
      <span class="fx-z fx-z2">Z</span>
    </div>
    <div v-else-if="mood === 'urgent' || mood === 'startle'" class="pet-fx" aria-hidden="true">
      <span class="fx-bang">!</span>
    </div>
    <div v-else-if="mood === 'angry'" class="pet-fx" aria-hidden="true">
      <span class="fx-anger">#</span>
    </div>
    <div v-else-if="mood === 'dizzy'" class="pet-fx" aria-hidden="true">
      <!-- 三颗星星沿椭圆绕着头顶转，转到前面变大、转到后面变小 -->
      <div class="fx-orbit">
        <span class="fx-star s1">★</span>
        <span class="fx-star s2">✦</span>
        <span class="fx-star s3">★</span>
      </div>
    </div>
    <div v-else-if="mood === 'fly'" class="pet-fx" aria-hidden="true">
      <span class="fx-speed sp1"></span>
      <span class="fx-speed sp2"></span>
      <span class="fx-speed sp3"></span>
    </div>
    <div v-else-if="mood === 'hungry' || mood === 'starving'" class="pet-fx" aria-hidden="true">
      <span class="fx-growl">{{ mood === 'starving' ? '咕……' : '咕~' }}</span>
    </div>
    <div v-else-if="mood === 'eat'" class="pet-fx" aria-hidden="true">
      <span class="fx-crumb c1"></span>
      <span class="fx-crumb c2"></span>
      <span class="fx-crumb c3"></span>
    </div>
    <div v-else-if="mood === 'sulky'" class="pet-fx" aria-hidden="true">
      <span class="fx-sulk">哼</span>
    </div>
    <div v-else-if="mood === 'fireworks' || mood === 'dance' || mood === 'wave'" class="pet-fx" aria-hidden="true">
      <span class="fx-item fx-c1">★</span>
      <span class="fx-item fx-c3">♪</span>
      <span class="fx-item fx-c4">{{ mood === 'fireworks' ? '✸' : '♪' }}</span>
      <template v-if="mood === 'fireworks'">
        <span class="fx-burst b1"></span>
        <span class="fx-burst b2"></span>
        <span class="fx-burst b3"></span>
      </template>
    </div>
    <div v-else-if="mood === 'focus'" class="pet-fx" aria-hidden="true">
      <span class="fx-item fx-f1">✦</span>
      <span class="fx-item fx-f2">✎</span>
    </div>

    <svg class="pet-svg" viewBox="0 0 200 200" width="148" height="148" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="日历小助手桌宠">
      <!-- ===================== 正面 ===================== -->
      <g v-if="view === 'front'" :transform="leanTransform">
      <g class="pet-body-group">
        <!-- 活力线：散步时放到身后，当速度线用 -->
        <g v-if="mood !== 'sleep'" class="energy-lines" :transform="turnAmt < -0.5 ? 'translate(200,0) scale(-1,1)' : ''">
          <path d="M24 44 L15 36" :stroke="INK" stroke-width="4.5" stroke-linecap="round" />
          <path d="M20 56 L10 55" :stroke="INK" stroke-width="4.5" stroke-linecap="round" />
          <path d="M32 36 L27 26" :stroke="INK" stroke-width="4.5" stroke-linecap="round" />
        </g>

        <!-- 实心墨影 -->
        <path :d="bodyPath" :fill="INK" transform="translate(6 6)" />

        <g class="foot-left">
          <rect x="65" y="156" width="16" height="14" rx="6" :fill="PAGE" :stroke="INK" stroke-width="3.6" />
          <ellipse cx="67" cy="172" rx="17" ry="10.5" :fill="HEADER" :stroke="INK" stroke-width="3.8" />
          <polygon points="65,165 67.1,169.5 72,170 68.3,173.2 69.3,178 65,175.4 60.7,178 61.7,173.2 58,170 62.9,169.5" :fill="BUTTER" :stroke="INK" stroke-width="1.4" stroke-linejoin="round" />
        </g>
        <g class="foot-right">
          <rect x="119" y="156" width="16" height="14" rx="6" :fill="PAGE" :stroke="INK" stroke-width="3.6" />
          <ellipse cx="133" cy="172" rx="17" ry="10.5" :fill="HEADER" :stroke="INK" stroke-width="3.8" />
          <polygon points="135,165 137.1,169.5 142,170 138.3,173.2 139.3,178 135,175.4 130.7,178 131.7,173.2 128,170 132.9,169.5" :fill="BUTTER" :stroke="INK" stroke-width="1.4" stroke-linejoin="round" />
        </g>

        <path :d="bodyPath" :fill="BACK" :stroke="INK" stroke-width="4.2" stroke-linejoin="round" />
        <path d="M36 149 C40 160 47 162 56 162 L144 162 C153 162 160 159 164 148 L156 142 L44 142 Z" :fill="ROSE" :stroke="INK" stroke-width="3" />
        <path d="M38 145 C42 155 48 158 57 158 L143 158 C152 158 158 155 162 144 L154 138 L46 138 Z" :fill="BUTTER" :stroke="INK" stroke-width="2.6" />

        <g class="calendar-page">
          <path :d="pagePath" :fill="PAGE" :stroke="INK" stroke-width="4" stroke-linejoin="round" />
          <path d="M44 52 C45 44 51 39 59 39 L141 39 C149 39 155 44 156 52 L158 72 L42 72 Z" :fill="HEADER" :stroke="INK" stroke-width="3.8" stroke-linejoin="round" />
          <path d="M48 67 L152 67" :stroke="PAGE" stroke-width="1.8" stroke-dasharray="4 4" stroke-linecap="round" />
          <g transform="translate(56, 51)">
            <rect x="0" y="2" width="16" height="13" rx="3" :fill="PAGE" :stroke="INK" stroke-width="1.9" />
            <line x1="0" y1="6.5" x2="16" y2="6.5" :stroke="INK" stroke-width="1.7" />
            <circle cx="4.5" cy="10" r="1.2" :fill="INK" />
            <circle cx="8" cy="10" r="1.2" :fill="INK" />
            <circle cx="11.5" cy="10" r="1.2" :fill="INK" />
          </g>
          <text x="77" y="63.5" font-size="14" font-weight="800" :fill="INK" font-family="'YouYuan','Microsoft YaHei UI',sans-serif">
            {{ todayDay ? `${todayDay}日` : '日历' }}
          </text>
          <circle cx="124" cy="59" r="2.4" :fill="PAGE" :stroke="INK" stroke-width="1.2" />
          <circle cx="132" cy="59" r="2.4" :fill="PAGE" :stroke="INK" stroke-width="1.2" />
          <circle cx="140" cy="59" r="2.4" :fill="PAGE" :stroke="INK" stroke-width="1.2" />

          <path d="M122 154 A26 26 0 0 1 157 132" fill="none" :stroke="ROSE" stroke-width="4.5" stroke-linecap="round" />
          <path d="M127 154 A21 21 0 0 1 157 137" fill="none" :stroke="BUTTER" stroke-width="4.5" stroke-linecap="round" />
          <path d="M132 154 A16 16 0 0 1 157 142" fill="none" :stroke="MINT" stroke-width="4.5" stroke-linecap="round" />
          <path d="M137 154 A11 11 0 0 1 157 147" fill="none" :stroke="HEADER" stroke-width="4.5" stroke-linecap="round" />

          <g transform="translate(55, 138)">
            <circle cx="0" cy="-6" r="5" :fill="ROSE" :stroke="INK" stroke-width="1.6" />
            <circle cx="5.7" cy="-1.8" r="5" :fill="ROSE" :stroke="INK" stroke-width="1.6" />
            <circle cx="3.5" cy="4.8" r="5" :fill="ROSE" :stroke="INK" stroke-width="1.6" />
            <circle cx="-3.5" cy="4.8" r="5" :fill="ROSE" :stroke="INK" stroke-width="1.6" />
            <circle cx="-5.7" cy="-1.8" r="5" :fill="ROSE" :stroke="INK" stroke-width="1.6" />
            <circle cx="0" cy="0" r="3.4" :fill="BUTTER" :stroke="INK" stroke-width="1.3" />
          </g>
          <polygon points="56,82 57.6,86 62,87.2 57.6,88.6 56,92.5 54.4,88.6 50,87.2 54.4,86" :fill="BUTTER" :stroke="INK" stroke-width="1.2" />

          <g class="sticky-check" transform="translate(132, 76)">
            <rect x="0" y="0" width="28" height="22" rx="5" :fill="MINT" :stroke="INK" stroke-width="2.8" />
            <path d="M7.5 11.5 L12 15.8 L20.5 7.2" fill="none" :stroke="INK" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          </g>

          <!-- ===== 脸（整体随视线微微挪动） ===== -->
          <g class="face" :transform="faceShift">
            <!-- 眉毛 -->
            <g v-if="browKind === 'angry'">
              <path d="M68 82 L84 88" :stroke="INK" stroke-width="3.4" stroke-linecap="round" />
              <path d="M132 82 L116 88" :stroke="INK" stroke-width="3.4" stroke-linecap="round" />
            </g>
            <g v-else-if="browKind === 'worried'">
              <path d="M70 87 Q76 82 82 84" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" />
              <path d="M130 87 Q124 82 118 84" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" />
            </g>
            <g v-else-if="mood !== 'sleep'">
              <path d="M71 84 Q76 80 81 84" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" />
              <path d="M119 84 Q124 80 129 84" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" />
            </g>

            <!-- 腮红 / 鼓腮 -->
            <g v-if="cheeksPuffed">
              <circle cx="62" cy="116" r="11" :fill="blushColor" :stroke="INK" stroke-width="2.2" />
              <circle cx="138" cy="116" r="11" :fill="blushColor" :stroke="INK" stroke-width="2.2" />
            </g>
            <g v-else>
              <ellipse cx="63" cy="117" rx="9" ry="5.2" :fill="blushColor" />
              <path d="M59 119 L61 115 M63 119 L65 115 M67 119 L69 115" :stroke="INK" stroke-width="1.3" stroke-linecap="round" />
              <ellipse cx="137" cy="117" rx="9" ry="5.2" :fill="blushColor" />
              <path d="M131 119 L133 115 M135 119 L137 115 M139 119 L141 115" :stroke="INK" stroke-width="1.3" stroke-linecap="round" />
            </g>

            <!-- 眼睛 -->
            <g v-if="eyeKind === 'sleep'">
              <path d="M67 104 Q76 111 85 104" fill="none" :stroke="INK" stroke-width="3.6" stroke-linecap="round" />
              <path d="M115 104 Q124 111 133 104" fill="none" :stroke="INK" stroke-width="3.6" stroke-linecap="round" />
            </g>
            <g v-else-if="eyeKind === 'arc'">
              <path d="M67 105 Q76 94 85 105" fill="none" :stroke="INK" stroke-width="3.9" stroke-linecap="round" />
              <path d="M115 105 Q124 94 133 105" fill="none" :stroke="INK" stroke-width="3.9" stroke-linecap="round" />
            </g>
            <g v-else-if="eyeKind === 'squeeze'">
              <path d="M68 96 L83 103 L68 110" fill="none" :stroke="INK" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M132 96 L117 103 L132 110" fill="none" :stroke="INK" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
            </g>
            <!-- 饿得没精神：上眼皮耷拉下来 -->
            <!-- 饿了也要跟着光标看（以前这里是死的，饿着的时候整只像不理人） -->
            <g v-else-if="eyeKind === 'tired'" :transform="eyeShift">
              <path d="M66.5 103 Q76 98 85.5 103 Q85 113 76 114 Q67 113 66.5 103 Z" :fill="INK" />
              <path d="M114.5 103 Q124 98 133.5 103 Q133 113 124 114 Q115 113 114.5 103 Z" :fill="INK" />
              <path d="M65 102 Q76 96 87 102" fill="none" :stroke="INK" stroke-width="3.4" stroke-linecap="round" />
              <path d="M113 102 Q124 96 135 102" fill="none" :stroke="INK" stroke-width="3.4" stroke-linecap="round" />
              <circle cx="79" cy="106" r="1.8" :fill="PAGE" />
              <circle cx="127" cy="106" r="1.8" :fill="PAGE" />
            </g>
            <g v-else-if="eyeKind === 'blink'">
              <path d="M67 103 L85 103" :stroke="INK" stroke-width="3.7" stroke-linecap="round" />
              <path d="M115 103 L133 103" :stroke="INK" stroke-width="3.7" stroke-linecap="round" />
            </g>
            <g v-else-if="eyeKind === 'wide'">
              <circle cx="76" cy="102" r="11" :fill="PAGE" :stroke="INK" stroke-width="3" />
              <circle cx="124" cy="102" r="11" :fill="PAGE" :stroke="INK" stroke-width="3" />
              <g :transform="eyeShift">
                <circle cx="76" cy="102" r="3.4" :fill="INK" />
                <circle cx="124" cy="102" r="3.4" :fill="INK" />
              </g>
            </g>
            <!-- 晕眼：两只螺旋各自原地转（一左一右反着转），不是整张脸绕着转 -->
            <g v-else-if="eyeKind === 'spiral'">
              <circle cx="76" cy="103" r="10.5" :fill="PAGE" :stroke="INK" stroke-width="2.6" />
              <circle cx="124" cy="103" r="10.5" :fill="PAGE" :stroke="INK" stroke-width="2.6" />
              <g class="spiral spiral-l">
                <path d="M76 103 m-7.5 0 a7.5 7.5 0 1 0 15 0 a5.5 5.5 0 1 0 -11 0 a3.5 3.5 0 1 0 7 0 a1.5 1.5 0 1 0 -3 0" fill="none" :stroke="INK" stroke-width="2.2" stroke-linecap="round" />
              </g>
              <g class="spiral spiral-r">
                <path d="M124 103 m-7.5 0 a7.5 7.5 0 1 0 15 0 a5.5 5.5 0 1 0 -11 0 a3.5 3.5 0 1 0 7 0 a1.5 1.5 0 1 0 -3 0" fill="none" :stroke="INK" stroke-width="2.2" stroke-linecap="round" />
              </g>
            </g>
            <g v-else :transform="eyeShift">
              <ellipse cx="76" cy="103" :rx="mood === 'angry' ? 7 : 9.2" :ry="mood === 'angry' ? 8 : 11.5" :fill="INK" />
              <circle cx="79.5" cy="98" r="3.4" :fill="PAGE" />
              <circle cx="72.5" cy="105" r="1.8" :fill="PAGE" />
              <ellipse cx="124" cy="103" :rx="mood === 'angry' ? 7 : 9.2" :ry="mood === 'angry' ? 8 : 11.5" :fill="INK" />
              <circle cx="127.5" cy="98" r="3.4" :fill="PAGE" />
              <circle cx="120.5" cy="105" r="1.8" :fill="PAGE" />
            </g>
            <g v-if="mood === 'focus'">
              <circle cx="76" cy="103" r="14.5" fill="none" :stroke="INK" stroke-width="2.8" />
              <circle cx="124" cy="103" r="14.5" fill="none" :stroke="INK" stroke-width="2.8" />
              <line x1="90.5" y1="103" x2="109.5" y2="103" :stroke="INK" stroke-width="2.8" />
            </g>
            <g v-if="mood === 'shy'">
              <path d="M66 111 L69 108 M72 112 L75 109" :stroke="INK" stroke-width="1.6" stroke-linecap="round" />
              <path d="M126 112 L129 109 M132 111 L135 108" :stroke="INK" stroke-width="1.6" stroke-linecap="round" />
            </g>

            <!-- 嘴巴 -->
            <ellipse v-if="mouthKind === 'o-small'" cx="100" cy="118" rx="4.2" ry="3" :fill="ROSE" :stroke="INK" stroke-width="2.2" />
            <ellipse v-else-if="mouthKind === 'o-big'" cx="100" cy="119" rx="6.5" ry="7.8" :fill="BLUSH_DEEP" :stroke="INK" stroke-width="2.8" />
            <path v-else-if="mouthKind === 'line'" d="M94 118 Q100 122 106 118" fill="none" :stroke="INK" stroke-width="2.9" stroke-linecap="round" />
            <g v-else-if="mouthKind === 'pout'">
              <path d="M97 113 Q103 115.5 97 118 Q103 120.5 97 123" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />
            </g>
            <path v-else-if="mouthKind === 'wave'" d="M90 121 Q94 116 98 121 T106 121 T114 121" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" />
            <path v-else-if="mouthKind === 'shy'" d="M94 119 Q97 116 100 119 Q103 122 106 119" fill="none" :stroke="INK" stroke-width="2.8" stroke-linecap="round" />
            <path v-else-if="mouthKind === 'sad'" d="M92 123 Q100 115 108 123" fill="none" :stroke="INK" stroke-width="3" stroke-linecap="round" />
            <g v-else-if="mouthKind === 'chomp'" class="mouth-chomp">
              <ellipse cx="100" cy="119" rx="7" ry="6" :fill="BLUSH_DEEP" :stroke="INK" stroke-width="2.6" />
            </g>
            <g v-else>
              <path d="M91 113 Q100 111 109 113 C109 124 105 128 100 128 C95 128 91 124 91 113 Z" :fill="BLUSH_DEEP" :stroke="INK" stroke-width="2.7" stroke-linejoin="round" />
              <path d="M95 123 Q100 120 105 123" fill="none" :stroke="ROSE" stroke-width="2.6" stroke-linecap="round" />
            </g>
          </g>
        </g>

        <g class="binding-rings">
          <circle cx="72" cy="48" r="5" :fill="INK" />
          <path :d="ringL" fill="none" :stroke="INK" stroke-width="11" stroke-linecap="round" />
          <path :d="ringL" fill="none" :stroke="PAGE" stroke-width="5" stroke-linecap="round" />
          <circle cx="128" cy="48" r="5" :fill="INK" />
          <path :d="ringR" fill="none" :stroke="INK" stroke-width="11" stroke-linecap="round" />
          <path :d="ringR" fill="none" :stroke="PAGE" stroke-width="5" stroke-linecap="round" />
        </g>

        <g class="top-star" transform="translate(148, 39)">
          <polygon points="0,-13 3.7,-4.5 13,-3.5 6,2.8 8,12 0,7.2 -8,12 -6,2.8 -13,-3.5 -3.7,-4.5" :fill="BUTTER" :stroke="INK" stroke-width="2.8" stroke-linejoin="round" />
        </g>

        <g class="arm-left">
          <ellipse cx="30" cy="126" rx="13" ry="10.5" transform="rotate(-22 30 126)" :fill="PAGE" :stroke="INK" stroke-width="3.8" />
        </g>
        <g class="arm-right">
          <ellipse cx="170" cy="126" rx="13" ry="10.5" transform="rotate(22 170 126)" :fill="PAGE" :stroke="INK" stroke-width="3.8" />
        </g>
      </g>
      </g>

      <!-- ===================== 背面 ===================== -->
      <g v-else-if="view === 'back'" class="pet-body-group">
        <path :d="backPath" :fill="INK" transform="translate(6 6)" />
        <g class="foot-left">
          <rect x="65" y="156" width="16" height="14" rx="6" :fill="PAGE" :stroke="INK" stroke-width="3.6" />
          <ellipse cx="70" cy="172" rx="16" ry="10" :fill="HEADER" :stroke="INK" stroke-width="3.8" />
        </g>
        <g class="foot-right">
          <rect x="119" y="156" width="16" height="14" rx="6" :fill="PAGE" :stroke="INK" stroke-width="3.6" />
          <ellipse cx="130" cy="172" rx="16" ry="10" :fill="HEADER" :stroke="INK" stroke-width="3.8" />
        </g>
        <path :d="backPath" :fill="BACK" :stroke="INK" stroke-width="4" stroke-linejoin="round" />
        <path d="M43 69 L157 69" :stroke="INK" stroke-width="2.8" />
        <path d="M46 64 L154 64" :stroke="PAGE" stroke-width="1.8" stroke-dasharray="4 4" stroke-linecap="round" />
        <path d="M38 152 Q52 142 66 150 Q80 140 96 150 Q112 142 126 152 L126 159 L38 159 Z" :fill="PAGE" :stroke="INK" stroke-width="2" />
        <path d="M118 159 A32 32 0 0 1 161 130" fill="none" :stroke="ROSE" stroke-width="5" stroke-linecap="round" />
        <path d="M124 159 A26 26 0 0 1 161 136" fill="none" :stroke="BUTTER" stroke-width="5" stroke-linecap="round" />
        <path d="M130 159 A20 20 0 0 1 161 142" fill="none" :stroke="MINT" stroke-width="5" stroke-linecap="round" />
        <g transform="translate(100, 108)">
          <ellipse cx="0" cy="4" rx="28" ry="9" transform="rotate(-14)" fill="none" :stroke="PAGE" stroke-width="3.2" />
          <rect x="-15" y="-14" width="30" height="26" rx="6" :fill="HEADER" :stroke="INK" stroke-width="3" />
          <line x1="-15" y1="-5" x2="15" y2="-5" :stroke="INK" stroke-width="2.6" />
          <line x1="-7" y1="-18" x2="-7" y2="-11" :stroke="INK" stroke-width="3" stroke-linecap="round" />
          <line x1="7" y1="-18" x2="7" y2="-11" :stroke="INK" stroke-width="3" stroke-linecap="round" />
          <circle cx="-6" cy="2" r="2" :fill="INK" />
          <circle cx="0" cy="2" r="2" :fill="INK" />
          <circle cx="6" cy="2" r="2" :fill="INK" />
          <circle cx="-6" cy="8" r="2" :fill="INK" />
          <circle cx="0" cy="8" r="2" :fill="INK" />
        </g>
        <g transform="translate(62, 138)">
          <ellipse cx="-6" cy="-12" rx="4" ry="8" :fill="PAGE" :stroke="INK" stroke-width="2.2" />
          <ellipse cx="6" cy="-12" rx="4" ry="8" :fill="PAGE" :stroke="INK" stroke-width="2.2" />
          <ellipse cx="0" cy="0" rx="13" ry="10.5" :fill="PAGE" :stroke="INK" stroke-width="2.2" />
          <circle cx="-4.5" cy="-1" r="1.6" :fill="INK" />
          <circle cx="4.5" cy="-1" r="1.6" :fill="INK" />
          <ellipse cx="-8" cy="2" rx="2.4" ry="1.3" :fill="BLUSH" />
          <ellipse cx="8" cy="2" rx="2.4" ry="1.3" :fill="BLUSH" />
        </g>
        <polygon points="64,84 66.8,90.5 73.5,91.2 68.4,95.8 69.8,102.5 64,99 58.2,102.5 59.6,95.8 54.5,91.2 61.2,90.5" :fill="BUTTER" :stroke="INK" stroke-width="1.8" />
        <path d="M142 84 C142 80 147 78 150 82 C153 78 158 80 158 84 C158 89 150 94 150 94 C150 94 142 89 142 84 Z" :fill="ROSE" :stroke="INK" stroke-width="1.9" />
        <g class="binding-rings">
          <path :d="ringL" fill="none" :stroke="INK" stroke-width="11" stroke-linecap="round" />
          <path :d="ringL" fill="none" :stroke="PAGE" stroke-width="5" stroke-linecap="round" />
          <path :d="ringR" fill="none" :stroke="INK" stroke-width="11" stroke-linecap="round" />
          <path :d="ringR" fill="none" :stroke="PAGE" stroke-width="5" stroke-linecap="round" />
        </g>
        <g transform="translate(100, 48)">
          <path d="M-4 4 L-16 24 L-7 22 L-1 10 Z" :fill="BOW" :stroke="INK" stroke-width="2.6" stroke-linejoin="round" />
          <path d="M4 4 L16 24 L7 22 L1 10 Z" :fill="BOW" :stroke="INK" stroke-width="2.6" stroke-linejoin="round" />
          <path d="M-3 0 C-14 -14 -28 -8 -24 5 C-21 14 -10 12 -3 4 Z" :fill="BOW" :stroke="INK" stroke-width="2.9" stroke-linejoin="round" />
          <path d="M3 0 C14 -14 28 -8 24 5 C21 14 10 12 3 4 Z" :fill="BOW" :stroke="INK" stroke-width="2.9" stroke-linejoin="round" />
          <circle cx="0" cy="2" r="6.5" :fill="ROSE" :stroke="INK" stroke-width="2.6" />
        </g>
        <g class="arm-left">
          <ellipse cx="30" cy="126" rx="13" ry="10.5" transform="rotate(-22 30 126)" :fill="PAGE" :stroke="INK" stroke-width="3.8" />
        </g>
        <g class="arm-right">
          <ellipse cx="170" cy="126" rx="13" ry="10.5" transform="rotate(22 170 126)" :fill="PAGE" :stroke="INK" stroke-width="3.8" />
        </g>
      </g>

      <!-- ===================== 侧面（左 / 右镜像） ===================== -->
      <g v-else class="pet-body-group" :transform="view === 'right' ? 'translate(200,0) scale(-1,1)' : ''">
        <path :d="sidePath" :fill="INK" transform="translate(6 6)" />
        <g class="foot-left">
          <rect x="86" y="156" width="14" height="14" rx="5" :fill="PAGE" :stroke="INK" stroke-width="3.6" />
          <ellipse cx="86" cy="172" rx="16" ry="10" :fill="HEADER" :stroke="INK" stroke-width="3.8" />
        </g>
        <g class="foot-right">
          <rect x="102" y="156" width="14" height="14" rx="5" :fill="PAGE" :stroke="INK" stroke-width="3.6" />
          <ellipse cx="107" cy="172" rx="15" ry="9.5" :fill="HEADER" :stroke="INK" stroke-width="3.8" />
        </g>
        <path d="M84 44 C82 26 92 20 104 22 C116 24 120 38 114 48" fill="none" :stroke="INK" stroke-width="11" stroke-linecap="round" />
        <path d="M84 44 C82 26 92 20 104 22 C116 24 120 38 114 48" fill="none" :stroke="PAGE" stroke-width="5" stroke-linecap="round" />
        <path :d="sidePath" :fill="BACK" :stroke="INK" stroke-width="4" stroke-linejoin="round" />
        <path d="M104 48 L142 153 L75 153 Z" fill="none" :stroke="PAGE" stroke-width="1.8" stroke-dasharray="4 4" stroke-linejoin="round" />
        <path d="M92 48 L60 144 C58 151 64 157 72 157 L80 157 L101 52 Z" :fill="ROSE" :stroke="INK" stroke-width="2.6" />
        <path d="M90 48 L56 141 C54 148 59 154 67 154 L73 154 L96 52 Z" :fill="BUTTER" :stroke="INK" stroke-width="2.4" />
        <path d="M88 48 L52 138 C50 145 55 151 64 151 L70 151 L94 52 Z" :fill="PAGE" :stroke="INK" stroke-width="3.6" stroke-linejoin="round" />
        <ellipse cx="69" cy="104" rx="3.6" ry="6.4" :fill="INK" />
        <circle cx="69" cy="101.5" r="1.4" :fill="PAGE" />
        <ellipse cx="72" cy="116" rx="4.2" ry="2.6" :fill="BLUSH" />
        <path d="M62 114 Q65 117 67 113" fill="none" :stroke="INK" stroke-width="2.2" stroke-linecap="round" />
        <rect x="86" y="60" width="14" height="14" rx="3" transform="rotate(-14 93 67)" :fill="ROSE" :stroke="INK" stroke-width="2.2" />
        <rect x="81" y="79" width="14" height="14" rx="3" transform="rotate(-14 88 86)" :fill="view === 'right' ? MINT : BUTTER" :stroke="INK" stroke-width="2.2" />
        <polygon points="118,104 121,111 128,112 123,117 124,124 118,120.5 112,124 113,117 108,112 115,111" :fill="BUTTER" :stroke="INK" stroke-width="1.9" />
        <path d="M117 137 C117 133 122 131 125 135 C128 131 133 133 133 137 C133 142 125 147 125 147 C125 147 117 142 117 137 Z" :fill="ROSE" :stroke="INK" stroke-width="1.9" />
        <g class="arm-side">
          <circle cx="94" cy="128" r="12" :fill="PAGE" :stroke="INK" stroke-width="3.8" />
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.pet-sprite-wrap {
  position: relative;
  width: 148px;
  height: 148px;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  -webkit-user-drag: none;
  transform: rotate(var(--tilt, 0deg));
  transform-origin: 50% 18%;
  transition: transform 0.12s ease-out;
}
.pet-svg { display: block; overflow: visible; }

/* 落地压扁 */
.is-squash .pet-svg { animation: squash 0.32s ease-out; transform-origin: 50% 92%; }

/* 被戳的部位小反应 */
.poke-face .face { animation: poke-face 0.35s ease-out; transform-box: fill-box; transform-origin: center; }
.poke-ring .binding-rings { animation: poke-ring 0.4s ease-out; transform-origin: 100px 48px; }

/* ===== 各种心情的身体动作 ===== */
.mood-idle .pet-body-group { transform-origin: 100px 168px; animation: pet-breathe 2.8s ease-in-out infinite; }
.mood-idle .arm-left { transform-origin: 42px 124px; animation: arm-sway-l 2.8s ease-in-out infinite; }
.mood-idle .arm-right { transform-origin: 158px 124px; animation: arm-sway-r 2.8s ease-in-out infinite; }

.mood-happy .pet-body-group { transform-origin: 100px 172px; animation: pet-bounce 0.55s ease-in-out infinite; }
.mood-happy .arm-left, .mood-celebrate .arm-left, .mood-laugh .arm-left { transform-origin: 42px 124px; animation: arm-wave-l 0.32s ease-in-out infinite; }
.mood-happy .arm-right, .mood-celebrate .arm-right, .mood-laugh .arm-right { transform-origin: 158px 124px; animation: arm-wave-r 0.32s ease-in-out infinite; }

.mood-celebrate .pet-body-group { transform-origin: 100px 172px; animation: pet-jump 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
.mood-laugh .pet-body-group { transform-origin: 100px 172px; animation: pet-laugh 0.22s ease-in-out infinite; }
.mood-urgent .pet-body-group { transform-origin: 100px 168px; animation: pet-wiggle 0.48s ease-in-out infinite; }
.mood-urgent .arm-right { transform-origin: 158px 124px; animation: arm-wave-r 0.28s ease-in-out infinite; }
.mood-focus .pet-body-group { transform-origin: 100px 168px; animation: pet-breathe 3.6s ease-in-out infinite; }
.mood-walk .pet-body-group { transform-origin: 100px 170px; animation: pet-walk-bob 0.44s ease-in-out infinite; }
/* 散步改成正面走（脸转向前进方向），脚和手按正面的位置摆 */
.mood-walk .foot-left { transform-origin: 73px 158px; animation: foot-walk-l 0.44s ease-in-out infinite; }
.mood-walk .foot-right { transform-origin: 127px 158px; animation: foot-walk-r 0.44s ease-in-out infinite; }
.mood-walk .arm-left { transform-origin: 40px 120px; animation: arm-swing 0.44s ease-in-out infinite; }
.mood-walk .arm-right { transform-origin: 160px 120px; animation: arm-swing 0.44s ease-in-out infinite reverse; }
.mood-sleep .pet-body-group { transform-origin: 100px 172px; animation: pet-sleep 3.6s ease-in-out infinite; }
.mood-drag .pet-body-group { transform-origin: 100px 40px; animation: pet-dangle 0.55s ease-in-out infinite; }
.mood-drag .foot-left, .mood-fly .foot-left { transform-origin: 73px 158px; animation: foot-step-l 0.2s ease-in-out infinite; }
.mood-drag .foot-right, .mood-fly .foot-right { transform-origin: 127px 158px; animation: foot-step-r 0.2s ease-in-out infinite; }
.mood-shy .pet-body-group { transform-origin: 100px 170px; animation: pet-shy 1.1s ease-in-out infinite; }
.mood-shy .arm-left { transform-origin: 42px 124px; transform: rotate(-38deg) translate(10px, -6px); }
.mood-shy .arm-right { transform-origin: 158px 124px; transform: rotate(38deg) translate(-10px, -6px); }
.mood-pout .pet-body-group { transform-origin: 100px 170px; animation: pet-puff 0.9s ease-in-out infinite; }
.mood-angry .pet-body-group { transform-origin: 100px 170px; animation: pet-stomp 0.24s ease-in-out infinite; }
.mood-startle .pet-body-group { transform-origin: 100px 172px; animation: pet-startle 0.5s ease-out; }
.mood-dizzy .pet-body-group { transform-origin: 100px 170px; animation: pet-dizzy 1.1s ease-in-out infinite; }
.mood-dizzy .arm-left { transform-origin: 42px 124px; animation: arm-flop-l 1.1s ease-in-out infinite; }
.mood-dizzy .arm-right { transform-origin: 158px 124px; animation: arm-flop-r 1.1s ease-in-out infinite; }
/* 两只螺旋各绕自己的中心转（SVG 里的 transform-origin 按 viewBox 坐标算） */
.spiral-l { transform-origin: 76px 103px; animation: spin 0.75s linear infinite; }
.spiral-r { transform-origin: 124px 103px; animation: spin-rev 0.75s linear infinite; }
/* 晕完回神：甩甩脑袋 */
.mood-recover .pet-body-group { transform-origin: 100px 165px; animation: pet-shake-off 0.7s ease-out; }
.mood-fly .pet-body-group { transform-origin: 100px 110px; animation: pet-fly 0.5s linear infinite; }

/* ===== 养成：饿、饿扁、闹脾气、吃东西 ===== */
.mood-hungry .pet-body-group { transform-origin: 100px 172px; animation: pet-droop 3.2s ease-in-out infinite; }
.mood-hungry .arm-left { transform-origin: 42px 124px; transform: rotate(14deg) translate(4px, 4px); }
.mood-hungry .arm-right { transform-origin: 158px 124px; transform: rotate(-14deg) translate(-4px, 4px); }
.mood-starving .pet-body-group { transform-origin: 100px 180px; transform: scale(1.14, 0.64); animation: pet-flat 3s ease-in-out infinite; }
.mood-sulky .pet-body-group { transform-origin: 100px 170px; animation: pet-sulk 2.4s ease-in-out infinite; }
.mood-eat .pet-body-group { transform-origin: 100px 170px; animation: pet-bounce 0.5s ease-in-out infinite; }
.mouth-chomp { transform-origin: 100px 119px; animation: chomp 0.24s ease-in-out infinite; }

/* ===== 升级解锁的动作 ===== */
.mood-dance .pet-body-group { transform-origin: 100px 172px; animation: pet-dance 0.6s ease-in-out infinite; }
.mood-dance .arm-left, .mood-wave .arm-left, .mood-fireworks .arm-left { transform-origin: 42px 124px; animation: arm-wave-l 0.3s ease-in-out infinite; }
.mood-dance .arm-right, .mood-fireworks .arm-right { transform-origin: 158px 124px; animation: arm-wave-r 0.3s ease-in-out infinite; }
.mood-dance .foot-left { transform-origin: 73px 158px; animation: foot-step-l 0.3s ease-in-out infinite; }
.mood-dance .foot-right { transform-origin: 127px 158px; animation: foot-step-r 0.3s ease-in-out infinite; }
.mood-spin .pet-svg { animation: pet-spin 0.9s ease-in-out 2; }
.mood-wave .pet-body-group { transform-origin: 100px 172px; animation: pet-breathe 1.4s ease-in-out infinite; }
.mood-wave .arm-right { transform-origin: 158px 124px; animation: arm-big-wave 0.4s ease-in-out infinite; }
.mood-flip .pet-svg { transform-origin: 50% 55%; animation: pet-flip 1s cubic-bezier(0.4, 0, 0.3, 1) 1; }
.mood-fireworks .pet-body-group { transform-origin: 100px 172px; animation: pet-jump 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }

.is-flipping .calendar-page { transform-origin: 100px 44px; animation: page-flip 0.45s ease-in-out; }

/* ===== 装饰（全部不透明纯色，适配抠图透明） ===== */
.pet-fx { position: absolute; inset: 0; pointer-events: none; }
.fx-item { position: absolute; font-weight: 900; font-size: 15px; animation: fx-float 1.1s ease-out infinite; -webkit-text-stroke: 0.6px #23211e; }
.fx-h1 { left: 16px; top: 14px; color: #fb7185; }
.fx-h2 { right: 14px; top: 8px; color: #fde047; animation-delay: 0.25s; }
.fx-h3 { right: 6px; top: 34px; color: #fb7185; font-size: 13px; animation-delay: 0.5s; }
.fx-c1 { left: 10px; top: 16px; color: #fde047; }
.fx-c2 { left: 30px; top: 0; color: #fb7185; animation-delay: 0.15s; }
.fx-c3 { right: 28px; top: 0; color: #93cff9; animation-delay: 0.3s; }
.fx-c4 { right: 8px; top: 18px; color: #86efac; animation-delay: 0.45s; }
.fx-c5 { left: 66px; top: -6px; color: #fb7185; animation-delay: 0.2s; }
.fx-f1 { left: 14px; top: 16px; color: #c4b5fd; font-size: 14px; }
.fx-f2 { right: 12px; top: 14px; color: #93cff9; animation-delay: 0.4s; }
.fx-z { position: absolute; font-weight: 900; color: #93cff9; -webkit-text-stroke: 0.8px #23211e; animation: zzz-rise 2.2s ease-in-out infinite; }
.fx-z1 { right: 20px; top: 26px; font-size: 15px; }
.fx-z2 { right: 6px; top: 8px; font-size: 20px; animation-delay: 0.7s; }
.fx-bang, .fx-anger {
  position: absolute; right: 10px; top: 6px; width: 24px; height: 24px; border-radius: 50%;
  border: 2.5px solid #23211e; color: #23211e; font-size: 14px; font-weight: 900;
  display: flex; align-items: center; justify-content: center; animation: bang-pop 0.6s ease-in-out infinite;
}
.fx-bang { background: #fde047; }
.fx-anger { background: #fb7185; color: #fffdf5; right: 16px; top: 2px; }
.fx-orbit { position: absolute; left: 50%; top: 16px; width: 0; height: 0; }
.fx-star {
  position: absolute; left: -8px; top: -9px; color: #fde047; font-size: 16px; font-weight: 900; line-height: 1;
  -webkit-text-stroke: 0.8px #23211e; animation: orbit 1.25s linear infinite;
}
.fx-star.s2 { color: #fb7185; animation-delay: -0.4167s; }
.fx-star.s3 { color: #93cff9; animation-delay: -0.8333s; }
.fx-growl {
  position: absolute; right: 2px; bottom: 34px; font-size: 13px; font-weight: 900; color: #23211e;
  background: #fde047; border: 2px solid #23211e; border-radius: 10px; padding: 0 5px; animation: growl 1.6s ease-in-out infinite;
}
.fx-sulk {
  position: absolute; left: 4px; top: 22px; font-size: 14px; font-weight: 900; color: #fffdf5;
  background: #fb7185; border: 2px solid #23211e; border-radius: 50%; width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center; animation: bang-pop 1s ease-in-out infinite;
}
.fx-crumb { position: absolute; width: 6px; height: 6px; border-radius: 2px; background: #fbbf24; border: 1.5px solid #23211e; top: 92px; left: 70px; animation: crumb 0.7s ease-out infinite; }
.fx-crumb.c2 { left: 76px; animation-delay: 0.23s; }
.fx-crumb.c3 { left: 64px; animation-delay: 0.46s; }
.fx-burst { position: absolute; width: 10px; height: 10px; border-radius: 50%; border: 3px dashed #fb7185; animation: burst 0.9s ease-out infinite; }
.fx-burst.b1 { left: 8px; top: 8px; }
.fx-burst.b2 { right: 10px; top: 2px; border-color: #93cff9; animation-delay: 0.3s; }
.fx-burst.b3 { left: 64px; top: -10px; border-color: #fde047; animation-delay: 0.6s; }
.fx-speed { position: absolute; left: -6px; height: 4px; border-radius: 4px; background: #23211e; animation: speed 0.3s linear infinite; }
.sp1 { top: 46px; width: 26px; }
.sp2 { top: 72px; width: 38px; animation-delay: 0.1s; }
.sp3 { top: 98px; width: 22px; animation-delay: 0.2s; }

@keyframes pet-breathe { 0%, 100% { transform: scaleY(1) translateY(0); } 50% { transform: scaleY(1.03) translateY(-2.5px); } }
@keyframes pet-bounce { 0%, 100% { transform: translateY(0) scale(1, 1); } 45% { transform: translateY(-9px) scale(0.97, 1.04); } 80% { transform: translateY(1px) scale(1.04, 0.96); } }
@keyframes pet-jump { 0%, 100% { transform: translateY(0) rotate(0deg); } 35% { transform: translateY(-13px) rotate(-4deg); } 70% { transform: translateY(-5px) rotate(4deg); } }
@keyframes pet-laugh { 0%, 100% { transform: rotate(-5deg) translateY(0); } 50% { transform: rotate(5deg) translateY(-3px); } }
@keyframes pet-wiggle { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
@keyframes pet-walk-bob { 0%, 100% { transform: translateY(0) rotate(-1.5deg); } 50% { transform: translateY(-5px) rotate(1.5deg); } }
@keyframes pet-sleep { 0%, 100% { transform: scale(1.02, 0.96) translateY(2px); } 50% { transform: scale(1.05, 0.93) translateY(4px); } }
@keyframes pet-dangle { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
@keyframes pet-shy { 0%, 100% { transform: rotate(-3deg) scale(0.98); } 50% { transform: rotate(3deg) scale(0.98); } }
@keyframes pet-puff { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05, 0.97); } }
@keyframes pet-stomp { 0%, 100% { transform: translateX(-2px) rotate(-2deg); } 50% { transform: translateX(2px) rotate(2deg); } }
@keyframes pet-startle { 0% { transform: translateY(0) scale(1); } 30% { transform: translateY(-22px) scale(0.92, 1.1); } 70% { transform: translateY(2px) scale(1.06, 0.94); } 100% { transform: translateY(0) scale(1); } }
/* 晕乎乎地画「8」字晃 */
@keyframes pet-dizzy {
  0%, 100% { transform: rotate(-8deg) translateX(-3px); }
  25% { transform: rotate(0deg) translateY(2px) scale(1.02, 0.97); }
  50% { transform: rotate(8deg) translateX(3px); }
  75% { transform: rotate(0deg) translateY(2px) scale(1.02, 0.97); }
}
@keyframes pet-shake-off {
  0% { transform: rotate(0deg); }
  15% { transform: rotate(-12deg); }
  35% { transform: rotate(10deg); }
  55% { transform: rotate(-6deg); }
  75% { transform: rotate(3deg); }
  100% { transform: rotate(0deg); }
}
@keyframes arm-flop-l { 0%, 100% { transform: rotate(-18deg); } 50% { transform: rotate(16deg); } }
@keyframes arm-flop-r { 0%, 100% { transform: rotate(16deg); } 50% { transform: rotate(-18deg); } }
@keyframes spin-rev { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
@keyframes pet-droop { 0%, 100% { transform: translateY(3px) scale(1, 0.97); } 50% { transform: translateY(5px) scale(1.02, 0.95); } }
@keyframes pet-flat { 0%, 100% { transform: scale(1.14, 0.64); } 50% { transform: scale(1.17, 0.6); } }
@keyframes pet-sulk { 0%, 100% { transform: rotate(-4deg) scale(0.98); } 50% { transform: rotate(-2deg) scale(0.98, 1); } }
@keyframes chomp { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(0.25); } }
@keyframes growl { 0%, 100% { transform: translateX(0) rotate(0); } 25% { transform: translateX(-2px) rotate(-6deg); } 75% { transform: translateX(2px) rotate(6deg); } }
/* 桌宠窗口靠颜色抠图透明，半透明像素会出黑边，所以这里用缩到 0 代替淡出 */
@keyframes crumb { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(-14px, 40px) rotate(120deg) scale(0); } }
@keyframes burst { 0% { transform: scale(0.3); } 80% { transform: scale(2.2); } 100% { transform: scale(0); } }
@keyframes pet-dance { 0%, 100% { transform: translateX(-6px) rotate(-6deg); } 50% { transform: translateX(6px) rotate(6deg); } }
@keyframes pet-spin { 0% { transform: scaleX(1); } 25% { transform: scaleX(0.05); } 50% { transform: scaleX(-1); } 75% { transform: scaleX(0.05); } 100% { transform: scaleX(1); } }
@keyframes pet-flip { 0% { transform: translateY(0) rotate(0); } 25% { transform: translateY(-34px) rotate(-120deg); } 55% { transform: translateY(-30px) rotate(-280deg); } 85% { transform: translateY(0) rotate(-360deg) scale(1.08, 0.9); } 100% { transform: translateY(0) rotate(-360deg); } }
@keyframes arm-big-wave { 0%, 100% { transform: rotate(-30deg) translate(-4px, -12px); } 50% { transform: rotate(-70deg) translate(-4px, -12px); } }
/* 椭圆轨道（8 个点近似），前面大、后面小 */
@keyframes orbit {
  0% { transform: translate(-46px, 0) scale(1); }
  12.5% { transform: translate(-32.5px, 7px) scale(1.18); }
  25% { transform: translate(0, 10px) scale(1.25); }
  37.5% { transform: translate(32.5px, 7px) scale(1.18); }
  50% { transform: translate(46px, 0) scale(1); }
  62.5% { transform: translate(32.5px, -7px) scale(0.78); }
  75% { transform: translate(0, -10px) scale(0.7); }
  87.5% { transform: translate(-32.5px, -7px) scale(0.78); }
  100% { transform: translate(-46px, 0) scale(1); }
}
@keyframes pet-fly { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes squash { 0% { transform: scale(1.18, 0.78); } 55% { transform: scale(0.94, 1.08); } 100% { transform: scale(1, 1); } }
@keyframes poke-face { 0% { transform: scale(1); } 40% { transform: scale(0.9, 0.86); } 100% { transform: scale(1); } }
@keyframes poke-ring { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-9deg); } 65% { transform: rotate(7deg); } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes arm-sway-l { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(8deg); } }
@keyframes arm-sway-r { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-8deg); } }
@keyframes arm-wave-l { 0%, 100% { transform: rotate(-10deg); } 50% { transform: rotate(24deg); } }
@keyframes arm-wave-r { 0%, 100% { transform: rotate(10deg); } 50% { transform: rotate(-24deg); } }
@keyframes foot-walk-l { 0%, 100% { transform: translateY(0); } 25% { transform: translateY(-6px) rotate(-6deg); } 50%, 75% { transform: translateY(0); } }
@keyframes foot-walk-r { 0%, 50% { transform: translateY(0); } 75% { transform: translateY(-6px) rotate(6deg); } 100% { transform: translateY(0); } }
@keyframes arm-swing { 0%, 100% { transform: translateY(-2px) rotate(-10deg); } 50% { transform: translateY(2px) rotate(10deg); } }
@keyframes foot-step-l { 0%, 100% { transform: translateX(-3px) rotate(8deg); } 50% { transform: translateX(4px) rotate(-10deg); } }
@keyframes foot-step-r { 0%, 100% { transform: translateX(4px) rotate(-10deg); } 50% { transform: translateX(-3px) rotate(8deg); } }
@keyframes page-flip { 0% { transform: scaleY(1); } 45% { transform: scaleY(0.84) skewX(-6deg); } 100% { transform: scaleY(1); } }
@keyframes fx-float { 0% { transform: translateY(6px) scale(0.75); } 60% { transform: translateY(-8px) scale(1.1); } 100% { transform: translateY(-14px) scale(0.85); } }
@keyframes zzz-rise { 0%, 100% { transform: translate(0, 4px) scale(0.85); } 50% { transform: translate(5px, -8px) scale(1.1); } }
@keyframes bang-pop { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
@keyframes speed { from { transform: translateX(0); } to { transform: translateX(-14px); } }

@media (prefers-reduced-motion: reduce) {
  .pet-body-group, .arm-left, .arm-right, .foot-left, .foot-right, .pet-fx, .fx-item, .fx-z, .spiral, .fx-star { animation: none !important; }
}
</style>
