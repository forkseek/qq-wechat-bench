<script setup>
// 日历小助手桌宠。
// 桌面版里，鼠标事件不是浏览器给的（桌宠窗口对 Windows 来说是穿透的），而是 pet_touch.py 的
// 「隐形触感层」接住后批量推到 window.__petInput；页面再把自己的可点区域报回去。
// 在普通浏览器里预览时，退回用页面自己的鼠标事件，方便调试。
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { api } from './api.js';
import { bindPetPreview } from './pet/preview.js';
import {
  todayBeijing,
  datePlusDays,
  formatDue,
  sortPendingTasks,
  isStaleHistoricalTask,
  inferTaskObligation
} from './utils/format.js';
import CalendarPetSprite from './components/CalendarPetSprite.vue';
import { say, setNickname, setLevel } from './pet/lines.js';
import { unlockedActions, nextUnlock, unlockAt } from './pet/levels.js';

const lifetime = new AbortController();
const previewInput = new AbortController();
const timers = new Set();
const frames = new Set();
function later(fn, ms) {
  if (lifetime.signal.aborted) return;
  const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
  return id;
}
function cancelLater(id) {
  window.clearTimeout(id);
  timers.delete(id);
}
function frame(fn) {
  if (lifetime.signal.aborted) return;
  const id = window.requestAnimationFrame(() => { frames.delete(id); fn(); });
  frames.add(id);
  return id;
}

const state = ref(null);
const view = ref('front');
const mood = ref('idle');
const blinking = ref(false);
const flipping = ref(false);
const look = ref({ x: 0, y: 0 });
const tilt = ref(0);
const squash = ref(false);
const poke = ref('');

const bubble = ref(null); // { text, tag, kind, action }
const menuOpen = ref(false);
const patrolEnabled = ref(true);
const onTop = ref(true);
const lockedView = ref('');
const desktop = ref(false);

const stageEl = ref(null);
const actorEl = ref(null);
// 窗口有多少伸到了屏幕外（CSS 像素，由触感层的 edge 事件告诉我们）
const edgeLeft = ref(0);
const edgeRight = ref(0);
const edgeTop = ref(0);
const panelEl = ref(null);
const panelH = ref(110);
const STAGE_W = 240;
const ACTOR_TOP = 146;   // 与样式里 .pet-actor 的 top 一致
const ACTOR_CX = 118;    // 角色水平中心（left 44 + 148/2）
const PANEL_MAX_W = 214;
// 上面放不下气泡 / 菜单 / 状态卡时，翻到角色下方
const placeBelow = computed(() => edgeTop.value > ACTOR_TOP - 6 - panelH.value);
// 气泡 / 菜单 / 状态卡只能放在屏幕上看得见的那一段里：
// 先按看得见的宽度收窄（放不下就变窄、文字多折几行），再尽量居中在角色头上，但不越过左右可见边。
const panelBox = computed(() => {
  const visL = Math.max(0, edgeLeft.value);
  const visR = Math.min(STAGE_W, STAGE_W - edgeRight.value);
  const width = Math.max(120, Math.min(PANEL_MAX_W, visR - visL - 8));
  const left = Math.min(Math.max(ACTOR_CX - width / 2, visL + 4), visR - 4 - width);
  return { left: Math.round(left), width: Math.round(width) };
});

// 番茄钟（重启后接着算）
const POMODORO_SECONDS = 25 * 60;
const FOCUS_KEY = 'xunke.pet.focus';
const focusActive = ref(false);
const focusEndsAt = ref(0);
const focusRemaining = ref(POMODORO_SECONDS);
const focusCompletedCount = ref(0);

// 身体状态
let dragging = false;
let flying = false;
let walking = false;
let walkReason = '';
let sleepingIdle = false;
// 散步转身：-1 朝左、1 朝右；每帧往目标挪一点，起步和停下都是慢慢转过去，不是一下子跳
const turn = ref(0);
let turnTarget = 0;
let turnRaf = 0;
function setTurn(target) {
  turnTarget = target;
  if (!turnRaf) turnRaf = frame(stepTurn) || 0;
}
function stepTurn() {
  const next = turn.value + (turnTarget - turn.value) * 0.18;
  const done = Math.abs(turnTarget - next) < 0.02;
  turn.value = done ? turnTarget : next;
  turnRaf = done ? 0 : frame(stepTurn) || 0;
}
// 不在走了（走完、被拎起来、被扔出去……）就转回正脸
watch(() => mood.value, m => { if (m !== 'walk') setTurn(0); });

// 光标相关
let lastCur = null;
let lastCursorAt = performance.now();
let hovering = false;
let shyTimer = null;
const tickle = { dir: 0, count: 0, start: 0, lastX: 0 };
let clickTimes = [];
let dayOffset = 0;
let dayResetTimer = null;
let menuHoverEl = null;
const cooldown = {};

// 数据变化
let lastDoneIds = null;
let lastPendingIds = null;
let lastReminderAt = 0;

// 定时器
let pollTimer = null;
let bubbleTimer = null;
let moodTimer = null;
let focusTimer = null;
let patrolTimer = null;
let senseTimer = null;

const todayDay = computed(() => Number(todayBeijing().split('-')[2] || new Date().getDate()));

const activePendingTasks = computed(() =>
  sortPendingTasks((state.value?.tasks || []).filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t)))
);
const requiredTasks = computed(() => activePendingTasks.value.filter(t => inferTaskObligation(t) === 'required'));
const urgentTasks = computed(() => requiredTasks.value.filter(t => ['overdue', 'today'].includes(formatDue(t).state)));
const pendingCount = computed(() => activePendingTasks.value.length);

const focusClock = computed(() => {
  const s = Math.max(0, focusRemaining.value);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
});

// 首次引导里的陪伴设置：称呼、桌宠名、性格、免打扰
const companion = computed(() => state.value?.companion || {});
const petName = computed(() => companion.value.petName || '日历小助手');
const lively = computed(() => companion.value.personality !== 'quiet');
watch(() => companion.value.nickname, n => setNickname(n), { immediate: true });
let askedNickname = false;

function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** 免打扰时段里，不主动开口（被戳、被摸照样回应） */
function quietNow() {
  const start = minutesOf(companion.value.quietStart);
  const end = minutesOf(companion.value.quietEnd);
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':');
  const now = Number(parts[0]) * 60 + Number(parts[1]);
  return start < end ? now >= start && now < end : now >= start || now < end;
}
const mayChatter = () => !quietNow();

// ---------- 养成：饱腹 / 心情 / 成长（数值由后端算，这里只负责表现） ----------
const care = computed(() => state.value?.petCare || null);
const careOpen = ref(false);
const feeding = ref(false);
const snackFly = ref(null); // { x0, y0, x1, y1 } 饼干飞向嘴巴的起止点
let lastCare = null;
let careRevision = 0;
let polling = false;
let lastPatAt = 0;
watch(() => care.value?.level, lv => setLevel(lv || 1), { immediate: true });

const careBars = computed(() => {
  const c = care.value;
  if (!c) return [];
  const expSpan = c.nextLevelExp ? c.nextLevelExp - c.levelExp : 1;
  return [
    { key: 'hunger', label: '饱腹', value: c.hunger, pct: c.hunger, low: c.hunger < 30 },
    { key: 'mood', label: '心情', value: c.mood, pct: c.mood, low: c.mood < 30 },
    {
      key: 'exp', label: '成长',
      value: c.nextLevelExp ? `${c.exp - c.levelExp}/${expSpan}` : '满级',
      pct: c.nextLevelExp ? Math.round(((c.exp - c.levelExp) / expSpan) * 100) : 100,
      low: false
    }
  ];
});
const nextUnlockText = computed(() => {
  const u = nextUnlock(care.value?.level || 1);
  return u ? `Lv${u.level} 解锁：${u.label}` : '已经满级啦';
});

function applyCare(next) {
  if (next && state.value && !lifetime.signal.aborted) {
    careRevision++;
    state.value = { ...state.value, petCare: next };
  }
}

async function feedPet() {
  if (feeding.value) return;
  feeding.value = true;
  try {
    const res = await api('/api/pet/feed', {}, 'POST', lifetime.signal);
    if (lifetime.signal.aborted) return;
    applyCare(res?.care);
    if (!res?.ate) {
      careOpen.value = false; // 状态卡和气泡共用一个位置，先收卡，不然这句话看不见
      showBubble(say(res?.reason === 'full' ? 'feedFull' : 'feedEmpty'), { tag: res?.reason === 'full' ? '吃饱啦' : '零食罐空了', kind: 'info', duration: 3600 });
      setMood(res?.reason === 'full' ? 'happy' : 'pout', 1600);
      return;
    }
    // 饼干从「喂它一口」按钮飞到嘴巴
    const btn = stageEl.value?.querySelector('.care-feed');
    const actor = actorEl.value?.getBoundingClientRect();
    if (btn && actor) {
      const b = btn.getBoundingClientRect();
      snackFly.value = { x0: b.left + b.width / 2 - 9, y0: b.top, x1: actor.left + actor.width / 2 - 9, y1: actor.top + actor.height * 0.58 };
      await new Promise(r => later(r, 520));
      if (lifetime.signal.aborted) return;
      snackFly.value = null;
    }
    careOpen.value = false;
    setMood('eat', 1600);
    showBubble(say('eat'), { tag: `饱腹 ${res.care?.hunger ?? ''}`, kind: 'celebrate', duration: 3200 });
  } catch {
    if (lifetime.signal.aborted) return;
    showBubble('哎呀，讯课后台好像没连上，等等再喂我～', { tag: '没喂成', kind: 'urgent', duration: 3200 });
  } finally {
    feeding.value = false;
  }
}

async function patReward() {
  const now = performance.now();
  if (now - lastPatAt < 8000) return;
  lastPatAt = now;
  try { applyCare((await api('/api/pet/pat', {}, 'POST', lifetime.signal))?.care); } catch { /* 摸摸没算上也无所谓 */ }
}

function doAction(action, ms = 2400) {
  setMood(action, ms);
}

function randomUnlockedAction() {
  const list = unlockedActions(care.value?.level || 1).filter(a => a !== 'fireworks');
  return list.length ? list[Math.floor(Math.random() * list.length)] : '';
}

function careChanged(prev, next) {
  if (!prev || !next) return;
  const gained = next.snacks - prev.snacks;
  if (next.level > prev.level) {
    const unlock = unlockAt(next.level);
    careOpen.value = false;
    menuOpen.value = false;
    flipPage();
    setMood('celebrate', 2200);
    showBubble(say('levelUp', next.level, next.title, unlock?.label), { tag: `升级 Lv${next.level}`, kind: 'celebrate', duration: 7000 });
    if (unlock?.action) later(() => { if (!busy()) doAction(unlock.action, 2800); }, 2300);
    return true;
  }
  if (gained > 0 && next.totalDone > prev.totalDone) {
    showBubble(say('snackGain', gained), { tag: `零食罐 +${gained}`, kind: 'celebrate', duration: 5000, action: 'care' });
    return true;
  }
  return false;
}

const busy = () => dragging || flying || walking || menuOpen.value;
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
function ready(key, ms) {
  const now = performance.now();
  if (cooldown[key] && now - cooldown[key] < ms) return false;
  cooldown[key] = now;
  return true;
}
function shortTitle(title, max = 14) {
  const s = String(title || '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ------------------------------------------------------------ 气泡 / 心情

function showBubble(text, { tag = '', kind = 'info', duration = 5200, action = '' } = {}) {
  if (!text) return;
  cancelLater(bubbleTimer);
  bubble.value = { text, tag, kind, action };
  if (duration > 0) bubbleTimer = later(() => { bubble.value = null; }, duration);
}
function dismissBubble() {
  cancelLater(bubbleTimer);
  bubble.value = null;
}

function baseMood() {
  if (focusActive.value) return 'focus';
  if (sleepingIdle) return 'sleep';
  const c = care.value;
  if (c && c.hunger < 10) return 'starving';
  if (c && c.hunger < 30) return 'hungry';
  if (c && c.mood < 30) return 'sulky';
  return 'idle';
}
const BASE_MOODS = ['idle', 'hungry', 'starving', 'sulky'];
function setMood(next, ms = 2400, nextView = 'front') {
  cancelLater(moodTimer);
  mood.value = next;
  if (!lockedView.value && nextView) view.value = nextView;
  if (ms > 0) moodTimer = later(restoreMood, ms);
}
function restoreMood() {
  if (dragging || flying || walking) return;
  mood.value = baseMood();
  if (!lockedView.value) view.value = 'front';
}
function flipPage() {
  flipping.value = false;
  frame(() => {
    flipping.value = true;
    later(() => { flipping.value = false; }, 480);
  });
}
function doPoke(part) {
  poke.value = part;
  later(() => { if (poke.value === part) poke.value = ''; }, 450);
}
function doSquash() {
  squash.value = false;
  frame(() => {
    squash.value = true;
    later(() => { squash.value = false; }, 340);
  });
}

function dutyLine() {
  const urgent = urgentTasks.value;
  if (urgent.length) {
    const due = formatDue(urgent[0]);
    return { text: say('urgent', shortTitle(urgent[0].title), due.tag), tag: due.state === 'overdue' ? '逾期啦' : '今天截止', kind: 'urgent', action: 'widget' };
  }
  if (requiredTasks.value.length) return { text: say('dutyCount', requiredTasks.value.length), tag: `必做 ${requiredTasks.value.length} 项`, kind: 'info', action: 'widget' };
  if (pendingCount.value) return { text: say('onlyNotices', pendingCount.value), tag: `通知 ${pendingCount.value} 条`, kind: 'info', action: 'main' };
  return { text: say('allClear'), tag: '今日清零', kind: 'celebrate', action: '' };
}

// ------------------------------------------------------------ 可点区域 → 触感层

function rectOf(el, pad = 0, tail = 0) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 + tail };
}
function reportZones() {
  if (!desktop.value) return;
  const zones = [];
  const actor = actorEl.value?.getBoundingClientRect();
  if (actor) zones.push({ x: actor.left + 10, y: actor.top + 6, w: actor.width - 20, h: actor.height - 6, r: 30 });
  const stage = stageEl.value;
  const bubbleZone = rectOf(stage?.querySelector('.pet-bubble'), 2, 10);
  if (bubbleZone) zones.push({ ...bubbleZone, r: 14 });
  const menuZone = rectOf(stage?.querySelector('.pet-menu'), 2);
  if (menuZone) zones.push({ ...menuZone, r: 14 });
  const pill = rectOf(stage?.querySelector('.focus-pill'), 2);
  if (pill) zones.push({ ...pill, r: 14 });
  const careCard = rectOf(stage?.querySelector('.pet-care'), 2);
  if (careCard) zones.push({ ...careCard, r: 14 });
  const sprite = actor ? { x: actor.left, y: actor.top, w: actor.width, h: actor.height } : null;
  // 脚底在精灵框里大约 91.5% 的高度
  const ground = actor ? Math.max(0, window.innerHeight - (actor.top + actor.height * 0.915)) : 8;
  window.pywebview?.api?.set_pet_hotzones?.(zones, sprite, ground)?.catch?.(() => {});
}
watch([bubble, menuOpen, focusActive, careOpen, panelBox, placeBelow], () => nextTick(() => {
  // 量一下面板现在多高，决定上面放不放得下
  const h = panelEl.value?.offsetHeight;
  if (h) panelH.value = h;
  reportZones();
}), { flush: 'post' });

// ------------------------------------------------------------ 输入：来自触感层（或浏览器预览）

function spriteRect() {
  return actorEl.value?.getBoundingClientRect() || null;
}
function insideSprite(x, y, r = spriteRect()) {
  return !!r && x >= r.left + 10 && x <= r.right - 10 && y >= r.top + 6 && y <= r.bottom;
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

function onCursor(x, y) {
  const now = performance.now();
  const r = spriteRect();
  if (!r) return;
  if (sleepingIdle) wakeUp();
  const idleFor = now - lastCursorAt;
  lastCursorAt = now;

  const cx = r.left + r.width / 2;
  const cy = r.top + r.height * 0.52;
  aimEyes(x - cx, y - cy);
  const inside = insideSprite(x, y, r);

  // 光标飙车掠过 → 吓一跳
  if (lastCur && !inside && !busy() && !focusActive.value) {
    const dt = (now - lastCur.t) / 1000;
    if (dt > 0 && dt < 0.2) {
      const speed = Math.hypot(x - lastCur.x, y - lastCur.y) / dt;
      if (speed > 2600 && distToSegment({ x: cx, y: cy }, lastCur, { x, y }) < 95 && ready('startle', 12000)) {
        setMood('startle', 1300);
        if (lively.value && mayChatter()) showBubble(say('startle'), { tag: '吓一跳', kind: 'urgent', duration: 2600 });
      }
    }
  }

  // 悬停 → 害羞；在身上来回蹭 → 挠痒痒
  if (inside && !hovering) {
    hovering = true;
    tickle.count = 0;
    tickle.dir = 0;
    tickle.start = now;
    tickle.lastX = x;
    cancelLater(shyTimer);
    shyTimer = later(() => {
      if (hovering && !busy() && [...BASE_MOODS, 'sleep', 'focus'].includes(mood.value) && !focusActive.value) {
        setMood('shy', 2600);
        patReward();
        if (ready('shy', 20000)) showBubble(say('shy'), { tag: '害羞', kind: 'happy', duration: 3000 });
      }
    }, 450);
  } else if (!inside && hovering) {
    endHover();
  }
  if (inside && !busy()) {
    const dx = x - tickle.lastX;
    if (Math.abs(dx) > 5) {
      const dir = Math.sign(dx);
      if (now - tickle.start > 1300) { tickle.count = 0; tickle.start = now; }
      if (tickle.dir && dir !== tickle.dir) tickle.count += 1;
      tickle.dir = dir;
      tickle.lastX = x;
      if (tickle.count >= 4 && ready('tickle', 4000)) {
        tickle.count = 0;
        setMood('laugh', 2600);
        patReward();
        showBubble(say('tickle'), { tag: '好痒', kind: 'celebrate', duration: 3000 });
      }
    }
  }

  // 菜单按钮的悬停高亮（桌面版浏览器拿不到 :hover）
  if (menuOpen.value) {
    const btn = document.elementFromPoint(x, y)?.closest?.('.menu-btn') || null;
    if (btn !== menuHoverEl) {
      menuHoverEl?.classList.remove('is-hover');
      btn?.classList.add('is-hover');
      menuHoverEl = btn;
    }
  }

  if (idleFor > 180000 && !focusActive.value && ready('wake', 30000)) {
    setMood('happy', 1800);
    showBubble(say('wake'), { tag: '回来啦', kind: 'happy', duration: 3600 });
  }
  lastCur = { x, y, t: now };
}

// ---------- 眼睛跟光标 ----------
// 以前两个方向各自卡在 ±1，光标在斜对角时眼珠会走到 1.4 倍远、还一跳一跳的。
// 现在：按距离算一个圆形的幅度（离脸 28px 内不动，再往外 200px 内慢慢看过去），
// 竖直方向收一点（眼睛扁），再每帧往目标挪 22%，看起来是「转过去」而不是「跳过去」。
const EYE_DEAD = 28;
const EYE_RANGE = 200;
let lookTarget = { x: 0, y: 0 };
let lookRaf = 0;
function aimEyes(dx, dy) {
  const dist = Math.hypot(dx, dy);
  if (dist <= EYE_DEAD) {
    lookTarget = { x: 0, y: 0 };
  } else {
    const mag = Math.min(1, (dist - EYE_DEAD) / EYE_RANGE);
    const eased = 1 - (1 - mag) * (1 - mag);
    lookTarget = { x: (dx / dist) * eased, y: (dy / dist) * eased * 0.85 };
  }
  if (!lookRaf) lookRaf = frame(stepEyes);
}
function stepEyes() {
  const cur = look.value;
  const nx = cur.x + (lookTarget.x - cur.x) * 0.22;
  const ny = cur.y + (lookTarget.y - cur.y) * 0.22;
  const done = Math.abs(lookTarget.x - nx) < 0.01 && Math.abs(lookTarget.y - ny) < 0.01;
  look.value = done ? { ...lookTarget } : { x: nx, y: ny };
  lookRaf = done ? 0 : frame(stepEyes);
}

// ---------- 落地：按撞击力度分级 ----------
// 轻落地：没事；中等：眯眼甩甩头；重摔：转圈圈晕（越重晕越久），晕完甩甩头回神。
const LAND_SHAKE = 900;
const LAND_DIZZY = 1700;
let dizzyTimer = null;
function landReaction(impact) {
  cancelLater(dizzyTimer);
  if (impact > LAND_DIZZY) {
    const ms = Math.round(1600 + Math.min(2000, (impact - LAND_DIZZY) * 0.7));
    cancelLater(moodTimer);
    mood.value = 'dizzy';
    if (!lockedView.value) view.value = 'front';
    showBubble(say('landHard'), { tag: '晕晕', kind: 'urgent', duration: ms + 600 });
    dizzyTimer = later(() => {
      if (mood.value === 'dizzy') setMood('recover', 750);
    }, ms);
  } else if (impact > LAND_SHAKE) {
    setMood('recover', 750);
    showBubble(say('landSoft'), { tag: '着陆', kind: 'celebrate', duration: 2400 });
  } else {
    setMood('happy', 1400);
    showBubble(say('landSoft'), { tag: '着陆', kind: 'celebrate', duration: 2400 });
  }
}

function endHover() {
  hovering = false;
  cancelLater(shyTimer);
  if (mood.value === 'shy') restoreMood();
}

function onClick(x, y) {
  if (insideSprite(x, y)) {
    petClick(x, y);
    return;
  }
  const btn = document.elementFromPoint(x, y)?.closest?.('button');
  if (btn) btn.click();
}

function onDblClick(x, y) {
  if (insideSprite(x, y)) openMainWorkbench();
}

function petClick(x, y) {
  const r = spriteRect();
  if (!r) return;
  // 菜单或状态卡开着时，点一下身体就是「收起来」
  if (menuOpen.value || careOpen.value) {
    menuOpen.value = false;
    careOpen.value = false;
    return;
  }
  const now = performance.now();
  clickTimes = clickTimes.filter(t => now - t < 1300);
  clickTimes.push(now);
  if (clickTimes.length >= 3) {
    clickTimes = [];
    doPoke('face');
    setMood('angry', 2600);
    showBubble(say('angry'), { tag: '哼！', kind: 'urgent', duration: 3200 });
    return;
  }
  if (focusActive.value) {
    setMood('focus', 1500);
    showBubble(say('focusPoke', focusClock.value), { tag: '番茄专注', kind: 'focus', duration: 3200 });
    return;
  }
  const vx = ((x - r.left) / r.width) * 200;
  const vy = ((y - r.top) / r.height) * 200;
  if (view.value === 'front' && vy < 52) {
    doPoke('ring');
    setMood('happy', 1400);
    showBubble(say('pokeRing'), { tag: '叮', kind: 'happy', duration: 2800 });
  } else if (view.value === 'front' && vy > 76 && vy < 132 && vx > 50 && vx < 150) {
    doPoke('face');
    setMood('pout', 1900);
    showBubble(say('pokeFace'), { tag: '戳脸', kind: 'happy', duration: 3000 });
  } else if (vy >= 132 || Math.random() < 0.5) {
    flipPage();
    const line = dutyLine();
    setMood(line.kind === 'urgent' ? 'urgent' : 'happy', 2400);
    showBubble(line.text, { tag: line.tag, kind: line.kind, duration: 5200, action: line.action });
  } else if (care.value && care.value.mood < 30) {
    setMood('sulky', 2000);
    showBubble(say('sulky'), { tag: '闹脾气', kind: 'urgent', duration: 3200, action: 'care' });
  } else {
    const action = Math.random() < 0.35 ? randomUnlockedAction() : '';
    if (action) doAction(action, 2400);
    else setMood('happy', 1800);
    showBubble(say('pokeGeneric'), { tag: '戳戳', kind: 'happy', duration: 3000 });
  }
}

function dayLabel(offset) {
  if (offset === 0) return '今天';
  if (offset === 1) return '明天';
  if (offset === 2) return '后天';
  const d = datePlusDays(offset);
  const [, m, dd] = d.split('-');
  const wk = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${d}T00:00:00Z`));
  return `${Number(m)}月${Number(dd)}日${wk}`;
}

function onWheel(delta) {
  if (busy()) return;
  dayOffset = Math.max(0, Math.min(14, dayOffset + (delta < 0 ? 1 : -1)));
  cancelLater(dayResetTimer);
  dayResetTimer = later(() => { dayOffset = 0; }, 8000);
  flipPage();
  const date = datePlusDays(dayOffset);
  const list = requiredTasks.value.filter(t => t.dueDate === date);
  const label = dayLabel(dayOffset);
  const text = list.length
    ? `${label}要做：${list.slice(0, 3).map(t => `「${shortTitle(t.title, 12)}」`).join('')}${list.length > 3 ? ` 等 ${list.length} 项` : ''}`
    : say('dayEmpty', label);
  setMood(list.length ? 'urgent' : 'happy', 1400);
  showBubble(text, { tag: `翻到${label}`, kind: list.length ? 'urgent' : 'info', duration: 5200, action: list.length ? 'widget' : '' });
}

function onDragStart() {
  cancelLater(dizzyTimer);
  dragging = true;
  walking = false;
  endHover();
  cancelLater(moodTimer);
  mood.value = 'drag';
  if (!lockedView.value) view.value = 'front';
  if (ready('pickup', 8000)) showBubble(say('pickUp'), { tag: '被拎起来了', kind: 'urgent', duration: 2600 });
}

function handle(ev) {
  switch (ev.type) {
    case 'cursor': onCursor(ev.x, ev.y); break;
    case 'leave': if (hovering) endHover(); break;
    case 'click': onClick(ev.x, ev.y); break;
    case 'dblclick': onDblClick(ev.x, ev.y); break;
    case 'rclick': menuOpen.value = !menuOpen.value; dismissBubble(); break;
    case 'wheel': onWheel(ev.delta); break;
    case 'dragstart': onDragStart(); break;
    case 'dragmove': tilt.value = clamp((ev.vx || 0) / 40, -30, 30); break;
    case 'drop':
      dragging = false;
      tilt.value = 0;
      setMood('happy', 1500);
      if (ready('drop', 6000)) showBubble(say('dropGently'), { tag: '安家', kind: 'happy', duration: 2600 });
      break;
    case 'thrown':
      dragging = false;
      flying = true;
      tilt.value = 0;
      cancelLater(moodTimer);
      mood.value = 'fly';
      showBubble(say('thrown'), { tag: '起飞', kind: 'celebrate', duration: 2200 });
      break;
    case 'caught':
      flying = false;
      walking = false;
      showBubble(say('caught'), { tag: '接住了', kind: 'happy', duration: 2400 });
      break;
    case 'bump':
      doSquash();
      if (ready('bump', 2500)) showBubble(say('bump'), { tag: '咚', kind: 'urgent', duration: 1800 });
      break;
    case 'bounce': doSquash(); break;
    case 'edge':
      edgeLeft.value = ev.left || 0;
      edgeRight.value = ev.right || 0;
      edgeTop.value = ev.top || 0;
      break;
    case 'land':
      flying = false;
      doSquash();
      landReaction(ev.impact || 0);
      break;
    case 'walkdone':
      walking = false;
      if (walkReason === 'nuzzle' && !ev.stopped) {
        setMood('shy', 2400);
        showBubble(say('nuzzle'), { tag: '蹭蹭', kind: 'happy', duration: 3200 });
      } else {
        restoreMood();
      }
      walkReason = '';
      break;
    default: break;
  }
}

window.__petInput = events => {
  for (const ev of Array.isArray(events) ? events : [events]) {
    try { handle(ev); } catch { /* 单个事件出错不影响后面的 */ }
  }
};

// 浏览器预览：用页面自己的鼠标事件模拟
function bindPreviewInput() {
  bindPetPreview(window, previewInput.signal, {
    inside: insideSprite, click: petClick, doubleClick: onDblClick, cursor: onCursor,
    menu: () => handle({ type: 'rclick' }), wheel: onWheel
  });
}

// ------------------------------------------------------------ 自己会动：散步、凑过来、打盹

function walkBy(dx, reason = 'patrol', speed = 70) {
  if (!desktop.value || busy() || focusActive.value) return;
  walking = true;
  walkReason = reason;
  cancelLater(moodTimer);
  // 以前切到侧面三角形，脸只剩一条细缝看不清；现在正面走，脸转向前进方向
  if (!lockedView.value) view.value = 'front';
  setTurn(dx > 0 ? 1 : -1);
  mood.value = 'walk';
  window.pywebview.api.pet_walk(dx, speed).then(ok => {
    if (!ok) { walking = false; restoreMood(); }
  }).catch(() => { walking = false; restoreMood(); });
}

function patrolTick() {
  if (!patrolEnabled.value || busy() || focusActive.value || lockedView.value || sleepingIdle) return;
  const roll = Math.random();
  if (!lively.value) {
    // 安静性格：不出门散步，偶尔转个身
    if (roll < 0.1) setMood('idle', 3200, 'back');
    return;
  }
  if (roll < 0.42 && desktop.value) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    walkBy(dir * (70 + Math.random() * 150));
  } else if (roll < 0.55) {
    setMood(baseMood(), 3200, 'back');
  } else if (roll < 0.66) {
    // 心情好、不饿的时候，自己耍一下已经学会的动作
    const action = care.value && care.value.hunger >= 30 && care.value.mood >= 30 ? randomUnlockedAction() : '';
    if (action) doAction(action, 2400);
    else setMood('happy', 1600);
  }
}

function senseTick() {
  const now = performance.now();
  const r = spriteRect();
  // 太久没动鼠标 → 打盹
  if (!sleepingIdle && !focusActive.value && !busy() && now - lastCursorAt > 180000) {
    sleepingIdle = true;
    mood.value = 'sleep';
    if (!lockedView.value) view.value = 'front';
    if (mayChatter()) showBubble(say('sleep'), { tag: '打盹中', kind: 'info', duration: 4000 });
    return;
  }
  // 光标停在附近发呆 → 走过去蹭蹭（只有活泼性格会主动凑过来）
  if (lively.value && desktop.value && r && lastCur && patrolEnabled.value && !busy() && !focusActive.value && !sleepingIdle && !lockedView.value) {
    const still = now - lastCursorAt;
    const cx = r.left + r.width / 2;
    const dx = lastCur.x - cx;
    const dy = lastCur.y - (r.top + r.height / 2);
    if (still > 5000 && still < 60000 && Math.abs(dx) > 140 && Math.abs(dx) < 460 && Math.abs(dy) < 260 && !insideSprite(lastCur.x, lastCur.y, r) && ready('nuzzle', 90000)) {
      walkBy(dx - Math.sign(dx) * 70, 'nuzzle', 95);
    }
  }
}

function wakeUp() {
  sleepingIdle = false;
  if (mood.value === 'sleep') {
    setMood('startle', 900);
    showBubble(say('wake'), { tag: '醒啦', kind: 'happy', duration: 3400 });
  }
}

// ------------------------------------------------------------ 数据

async function refreshState() {
  if (polling || lifetime.signal.aborted) return;
  polling = true;
  const revision = careRevision;
  try {
    const data = await api('/api/state?compact=1', undefined, 'GET', lifetime.signal);
    if (lifetime.signal.aborted) return;
    if (revision !== careRevision) data.petCare = care.value;
    state.value = data;
    void settleFocusRewards();
    const tasks = data?.tasks || [];
    const doneIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
    const pendingIds = new Set(tasks.filter(t => t.status === 'pending' && t.relevance !== 'other' && !isStaleHistoricalTask(t)).map(t => t.id));
    if (lastDoneIds !== null) {
      let newlyDone = 0;
      for (const id of doneIds) if (!lastDoneIds.has(id)) newlyDone += 1;
      if (newlyDone > 0 && !busy()) {
        flipPage();
        setMood('celebrate', 4200);
        showBubble(say('done', newlyDone), { tag: '完成庆祝', kind: 'celebrate', duration: 5500 });
      } else if (lastPendingIds !== null && !focusActive.value && !busy() && mayChatter()) {
        let added = 0;
        for (const id of pendingIds) if (!lastPendingIds.has(id)) added += 1;
        if (added > 0) {
          flipPage();
          setMood('urgent', 3200);
          showBubble(say('newTasks', added), { tag: '新消息', kind: 'urgent', duration: 5500, action: 'widget' });
        }
      }
    }
    lastDoneIds = doneIds;
    lastPendingIds = pendingIds;

    // 养成：零食到账 / 升级；数值变了之后，饿 / 饿扁 / 闹脾气的常态也跟着换
    const nextCare = data?.petCare || null;
    if (lastCare && nextCare && !busy()) careChanged(lastCare, nextCare);
    lastCare = nextCare;
    if (BASE_MOODS.includes(mood.value) && !busy()) restoreMood();
    if (nextCare && nextCare.hunger < 30 && !focusActive.value && !busy() && mayChatter() && !bubble.value
      && ready('hungry', (lively.value ? 30 : 90) * 60 * 1000)) {
      const starving = nextCare.hunger < 10;
      showBubble(say(starving ? 'starving' : 'hungry'), { tag: starving ? '饿扁了' : '饿了', kind: 'urgent', duration: 6000, action: 'care' });
    }

    const now = Date.now();
    const remindEvery = (lively.value ? 20 : 60) * 60 * 1000;
    if (!focusActive.value && !busy() && mayChatter() && urgentTasks.value.length && now - lastReminderAt > remindEvery && !bubble.value) {
      lastReminderAt = now;
      const line = dutyLine();
      setMood('urgent', 3400);
      showBubble(line.text, { tag: line.tag, kind: line.kind, duration: 6000, action: line.action });
    }
  } catch {
    // 后台重启空当，静默
  } finally {
    polling = false;
  }
}

// ------------------------------------------------------------ 番茄钟

const rewardPrefix = FOCUS_KEY + '.reward.';
const pendingRewards = new Set();
let settling = false;
async function settleFocusRewards() {
  if (settling || !pendingRewards.size) return;
  settling = true;
  try {
    for (const id of pendingRewards) {
      const res = await api('/api/pet/focus?endedAt=' + id, {}, 'POST', lifetime.signal);
      if (lifetime.signal.aborted) return;
      pendingRewards.delete(id);
      try { localStorage.removeItem(rewardPrefix + id); } catch { /* ignore */ }
      const prev = care.value;
      applyCare(res?.care);
      if (res?.gained && !careChanged(prev, res.care)) {
        later(() => showBubble(say('focusReward', res.gained), { tag: `成长 +${res.gained}`, kind: 'focus', duration: 4000 }), 8200);
      }
      lastCare = res?.care || lastCare;
    }
  } catch { /* 后台恢复后，随下一次状态轮询重试 */ }
  finally { settling = false; }
}

function restoreFocus() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
    if (!saved) return;
    focusCompletedCount.value = Number(saved.done) || 0;
    if (Number.isSafeInteger(saved.endsAt) && saved.endsAt > 0) {
      if (!focusActive.value || focusEndsAt.value !== saved.endsAt) startFocus(saved.endsAt);
    } else if (focusActive.value) stopFocus(false);
  } catch { /* ignore */ }
}

function saveFocus() {
  try {
    if (focusActive.value) localStorage.setItem(FOCUS_KEY, JSON.stringify({ endsAt: focusEndsAt.value, done: focusCompletedCount.value }));
    else localStorage.setItem(FOCUS_KEY, JSON.stringify({ endsAt: 0, done: focusCompletedCount.value }));
  } catch { /* ignore */ }
}
function tickFocus() {
  focusRemaining.value = Math.max(0, Math.ceil((focusEndsAt.value - Date.now()) / 1000));
  if (focusRemaining.value <= 0) stopFocus(true);
}
function startFocus(endsAt) {
  cancelLater(moodTimer);
  sleepingIdle = false;
  if (walking) window.pywebview?.api?.pet_stop?.()?.catch?.(() => {});
  walking = false;
  walkReason = '';
  focusActive.value = true;
  focusEndsAt.value = endsAt;
  mood.value = 'focus';
  if (!lockedView.value) view.value = 'front';
  clearInterval(focusTimer);
  focusTimer = setInterval(tickFocus, 1000);
  saveFocus();
  tickFocus();
}
function toggleFocus() {
  menuOpen.value = false;
  if (focusActive.value) {
    stopFocus(false);
    showBubble(say('focusStop'), { tag: '番茄钟', kind: 'info', duration: 3600 });
    return;
  }
  startFocus(Date.now() + POMODORO_SECONDS * 1000);
  showBubble(say('focusStart'), { tag: '进入专注', kind: 'focus', duration: 4500 });
}
function stopFocus(completed) {
  clearInterval(focusTimer);
  focusTimer = null;
  focusActive.value = false;
  focusRemaining.value = POMODORO_SECONDS;
  if (completed) {
    focusCompletedCount.value += 1;
    flipPage();
    setMood('celebrate', 5500);
    showBubble(say('focusDone', focusCompletedCount.value), { tag: '专注完成', kind: 'celebrate', duration: 8000 });
    const id = String(focusEndsAt.value);
    pendingRewards.add(id);
    try { localStorage.setItem(rewardPrefix + id, '1'); } catch { /* 当前页面仍可重试 */ }
    void settleFocusRewards();
  } else {
    restoreMood();
  }
  saveFocus();
}

// ------------------------------------------------------------ 菜单动作

function openMainWorkbench() {
  menuOpen.value = false;
  if (desktop.value) window.pywebview.api.show_main().catch?.(() => {});
  else window.open('/', '_blank');
}
function toggleMiniWidget() {
  menuOpen.value = false;
  if (desktop.value) window.pywebview.api.toggle_widget().catch?.(() => {});
  else window.open('/widget', '_blank');
}
function onBubbleClick() {
  const act = bubble.value?.action;
  dismissBubble();
  if (act === 'widget') toggleMiniWidget();
  else if (act === 'main') openMainWorkbench();
  else if (act === 'care') openCare();
}
function openCare() {
  menuOpen.value = false;
  dismissBubble();
  careOpen.value = true;
}
function cycleView() {
  const order = ['', 'front', 'left', 'back', 'right'];
  const next = order[(order.indexOf(lockedView.value) + 1) % order.length];
  lockedView.value = next;
  view.value = next || 'front';
  const names = { front: '正面', left: '左侧', back: '背面', right: '右侧' };
  showBubble(next ? `锁定「${names[next]}」视角啦，再点可以换～` : '恢复自动视角！', { tag: '视角', kind: 'info', duration: 2800 });
}
function togglePatrol() {
  patrolEnabled.value = !patrolEnabled.value;
  if (!patrolEnabled.value) window.pywebview?.api?.pet_stop?.()?.catch?.(() => {});
  showBubble(say(patrolEnabled.value ? 'patrolOn' : 'patrolOff'), { tag: '散步', kind: 'info', duration: 2800 });
}
async function toggleOnTop() {
  onTop.value = !onTop.value;
  if (desktop.value) {
    try { await window.pywebview.api.set_pet_on_top(onTop.value); } catch { /* ignore */ }
  }
  showBubble(say(onTop.value ? 'topOn' : 'topOff'), { tag: '置顶', kind: 'info', duration: 2600 });
}
function hidePet() {
  menuOpen.value = false;
  if (desktop.value) window.pywebview.api.hide_pet().catch?.(() => {});
}

// ------------------------------------------------------------ 生命周期

function scheduleBlink() {
  later(() => {
    if (['idle', 'walk', 'focus', 'urgent', 'shy'].includes(mood.value)) {
      blinking.value = true;
      later(() => { blinking.value = false; }, 140);
    }
    scheduleBlink();
  }, 2400 + Math.random() * 3400);
}

async function enterDesktopMode() {
  if (lifetime.signal.aborted || desktop.value || !window.pywebview?.api) return;
  desktop.value = true;
  previewInput.abort();
  try {
    const st = await window.pywebview.api.get_pet_state();
    if (st && typeof st.on_top === 'boolean') onTop.value = st.on_top;
  } catch { /* ignore */ }
  await nextTick();
  if (!lifetime.signal.aborted) reportZones();
}

onMounted(() => {
  scheduleBlink();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(rewardPrefix) && /^\d+$/.test(key.slice(rewardPrefix.length))) pendingRewards.add(key.slice(rewardPrefix.length));
    }
  } catch { /* ignore */ }
  restoreFocus();
  window.addEventListener('storage', e => { if (e.key === FOCUS_KEY) restoreFocus(); }, { signal: lifetime.signal });
  bindPreviewInput();
  if (window.pywebview?.api) enterDesktopMode();
  else window.addEventListener('pywebviewready', enterDesktopMode, { once: true, signal: lifetime.signal });
  window.addEventListener('resize', reportZones);

  void refreshState();
  pollTimer = setInterval(refreshState, 8000);
  patrolTimer = setInterval(patrolTick, 18000);
  senseTimer = setInterval(senseTick, 1000);

  later(() => {
    if (focusActive.value) return;
    const n = requiredTasks.value.length;
    if (mayChatter()) showBubble(n > 0 ? say('greetWithTasks', n) : say('greet'), { tag: petName.value, kind: 'happy', duration: 5200 });
    setMood('happy', 1800);
  }, 700);
  // 还不知道怎么称呼用户：打完招呼后问一句，点气泡打开讯课去填
  later(() => {
    if (!focusActive.value && !askedNickname && state.value && !companion.value.nickname && !busy()) {
      askedNickname = true;
      setMood('shy', 2400);
      showBubble(say('askNickname'), { tag: '想认识你', kind: 'happy', duration: 9000, action: 'main' });
    }
  }, 7000);
});

onUnmounted(() => {
  [pollTimer, focusTimer, patrolTimer, senseTimer].forEach(clearInterval);
  lifetime.abort();
  previewInput.abort();
  timers.forEach(id => window.clearTimeout(id));
  timers.clear();
  frames.forEach(id => window.cancelAnimationFrame(id));
  frames.clear();
  window.removeEventListener('resize', reportZones);
  delete window.__petInput;
});
</script>

<template>
  <div ref="stageEl" class="pet-stage">
    <div
      ref="panelEl"
      class="pet-panel"
      :class="placeBelow ? 'below' : 'above'"
      :style="{ left: `${panelBox.left}px`, width: `${panelBox.width}px` }"
    >
      <!-- 两列紧凑菜单：桌宠窗口上方只有一百来像素，单列会顶出窗口被裁掉 -->
      <div v-if="menuOpen" class="pet-menu" @click.stop>
        <button class="menu-btn" type="button" @click="openMainWorkbench">打开工作台</button>
        <button class="menu-btn" type="button" @click="toggleMiniWidget">桌面小便签</button>
        <button class="menu-btn" type="button" @click="toggleFocus">
          {{ focusActive ? `结束 ${focusClock}` : '专注 25 分' }}
        </button>
        <button class="menu-btn" type="button" @click="togglePatrol">散步：{{ patrolEnabled ? '开' : '关' }}</button>
        <button class="menu-btn" type="button" @click="cycleView">
          视角：{{ lockedView ? { front: '正面', left: '左侧', back: '背面', right: '右侧' }[lockedView] : '自动' }}
        </button>
        <button class="menu-btn" type="button" @click="toggleOnTop">置顶：{{ onTop ? '开' : '关' }}</button>
        <button class="menu-btn menu-btn-muted" type="button" @click="hidePet">先藏起来</button>
        <button class="menu-btn menu-btn-care" type="button" title="看看我的状态，顺便喂一口" @click="openCare">喂食·状态</button>
      </div>

      <!-- 养成状态卡：等级称号、饱腹 / 心情 / 成长、零食罐 -->
      <div v-else-if="careOpen && care" class="pet-care" @click.stop>
        <div class="care-head" :title="nextUnlockText">
          <span class="care-lv">Lv{{ care.level }}</span>
          <span class="care-title">{{ care.title }}</span>
        </div>
        <div v-for="b in careBars" :key="b.key" class="care-row" :class="[`bar-${b.key}`, { low: b.low }]">
          <span class="care-label">{{ b.label }}</span>
          <span class="care-track"><span class="care-fill" :style="{ width: `${Math.max(4, b.pct)}%` }"></span></span>
          <span class="care-val">{{ b.value }}</span>
        </div>
        <div class="care-foot">
          <span class="care-jar" title="完成任务就会往罐子里掉零食">零食罐 × {{ care.snacks }}</span>
          <button class="care-btn care-feed" type="button" :disabled="feeding" @click="feedPet">喂它一口</button>
          <button class="care-btn" type="button" @click="careOpen = false">收起</button>
        </div>
      </div>

      <button
        v-else-if="bubble"
        type="button"
        class="pet-bubble"
        :class="`kind-${bubble.kind}`"
        title="点一下关掉或跳转"
        @click="onBubbleClick"
      >
        <span v-if="bubble.tag" class="bubble-tag">{{ bubble.tag }}</span>
        <span class="bubble-text">{{ bubble.text }}</span>
      </button>

      <button v-else-if="focusActive" type="button" class="focus-pill" title="点一下结束专注" @click="toggleFocus">
        <span class="focus-dot"></span>
        <span>专注 {{ focusClock }}</span>
      </button>
    </div>

    <span
      v-if="snackFly"
      class="snack-fly"
      :style="{ '--x0': `${snackFly.x0}px`, '--y0': `${snackFly.y0}px`, '--x1': `${snackFly.x1}px`, '--y1': `${snackFly.y1}px` }"
      aria-hidden="true"
    ></span>

    <div ref="actorEl" class="pet-actor" title="摸摸、戳戳、拖着走、甩出去；双击打开工作台；右键菜单；滚轮翻日历">
      <CalendarPetSprite
        :view="view"
        :mood="mood"
        :blinking="blinking"
        :today-day="todayDay"
        :flipping="flipping"
        :look="look"
        :tilt="tilt"
        :squash="squash"
        :poke="poke"
        :turn="turn"
      />
      <span
        v-if="requiredTasks.length > 0 && !menuOpen"
        class="pet-badge"
        :class="{ 'badge-urgent': urgentTasks.length > 0 }"
        :title="`必做待办 ${requiredTasks.length} 项`"
      >{{ requiredTasks.length > 99 ? '99+' : requiredTasks.length }}</span>
    </div>
  </div>
</template>

<style>
html, body, .pet-body, #app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent !important;
  font-family: 'YouYuan', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif;
  user-select: none;
  -webkit-user-select: none;
}
</style>

<style scoped>
/* 讯课手账风：炭黑粗框 + 奶油纸 + 实心偏移墨影。透明靠颜色抠图，所以只用不透明纯色，不用半透明阴影。 */
/* 窗口 240×440：角色固定在正中（top 146），上下各一块透明空位。
   气泡 / 菜单 / 状态卡平时放上面；角色贴近屏幕顶、上面放不下时翻到下面（参考 QQ 宠物）。 */
.pet-stage {
  position: relative;
  width: 240px;
  height: 440px;
  box-sizing: border-box;
  background: transparent;
}
.pet-panel {
  position: absolute;
  left: 12px;
  width: 214px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pet-panel.above { bottom: 298px; justify-content: flex-end; }
.pet-panel.below { top: 300px; justify-content: flex-start; }
.pet-panel.below > * { margin-bottom: 0 !important; margin-top: 8px; }
.pet-panel.below .pet-bubble::after {
  bottom: auto;
  top: -8px;
  transform: translateX(-50%) rotate(225deg);
}
.pet-actor {
  position: absolute;
  left: 44px;
  top: 146px;
  width: 148px;
  height: 148px;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pet-bubble {
  position: relative;
  max-width: 100%;
  box-sizing: border-box;
  padding: 8px 11px 9px;
  border-radius: 14px 6px 14px 8px;
  border: 2.5px solid #23211e;
  background: #fffdf5;
  box-shadow: 3px 3px 0 #23211e;
  color: #23211e;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 6px;
}
.pet-bubble::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -8px;
  transform: translateX(-50%) rotate(45deg);
  width: 11px;
  height: 11px;
  background: inherit;
  border-right: 2.5px solid #23211e;
  border-bottom: 2.5px solid #23211e;
}
.pet-bubble.kind-urgent { background: #ffe4e6; }
.pet-bubble.kind-celebrate { background: #dcfce7; }
.pet-bubble.kind-focus { background: #ede9fe; }
.pet-bubble.kind-happy { background: #fef9c3; }
.bubble-tag {
  align-self: flex-start;
  padding: 0 8px;
  border-radius: 999px;
  border: 1.5px solid #23211e;
  font-size: 10.5px;
  font-weight: 800;
  background: #fde047;
  color: #23211e;
}
.kind-urgent .bubble-tag { background: #fb7185; color: #fffdf5; }
.kind-celebrate .bubble-tag { background: #86efac; }
.kind-focus .bubble-tag { background: #c4b5fd; }
.kind-info .bubble-tag { background: #93cff9; }
.bubble-text { font-weight: 700; word-break: break-word; }

.focus-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 2.5px solid #23211e;
  background: #ede9fe;
  box-shadow: 2px 2px 0 #23211e;
  color: #23211e;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 800;
  cursor: pointer;
  margin-bottom: 6px;
}
.focus-dot { width: 8px; height: 8px; border-radius: 50%; background: #fb7185; border: 1.5px solid #23211e; }

.pet-menu {
  width: 100%;
  padding: 6px;
  border-radius: 14px 6px 14px 8px;
  border: 2.5px solid #23211e;
  background: #fffdf5;
  box-shadow: 3px 3px 0 #23211e;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-bottom: 6px;
  box-sizing: border-box;
}
.menu-btn {
  width: 100%;
  min-width: 0;
  border: 1.5px solid transparent;
  border-radius: 8px;
  background: #f3ecdc;
  color: #23211e;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 700;
  text-align: center;
  padding: 4px 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu-btn:hover, .menu-btn.is-hover { background: #fef08a; border-color: #23211e; }
.menu-btn-muted { background: #ffe4e6; }
.menu-btn-care { background: #dcfce7; }

/* ===== 养成状态卡（上方只有一百三十来像素，紧凑排） ===== */
.pet-care {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px 8px;
  border-radius: 14px 6px 14px 8px;
  border: 2.5px solid #23211e;
  background: #fffdf5;
  box-shadow: 3px 3px 0 #23211e;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
  color: #23211e;
}
.care-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.care-lv {
  flex-shrink: 0; font-size: 11px; font-weight: 900; padding: 0 7px; border-radius: 999px;
  border: 1.5px solid #23211e; background: #fde047;
}
.care-title { font-size: 12px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.care-row { display: grid; grid-template-columns: 26px 1fr 44px; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; }
.care-track { height: 9px; border: 1.75px solid #23211e; border-radius: 6px; background: #f3ecdc; overflow: hidden; }
.care-fill { display: block; height: 100%; background: #86efac; transition: width 0.4s ease; }
.bar-mood .care-fill { background: #f9a8d4; }
.bar-exp .care-fill { background: #93cff9; }
.care-row.low .care-fill { background: #fb7185; }
.care-row.low .care-val { color: #be123c; }
.care-val { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.care-foot { display: flex; align-items: center; gap: 5px; margin-top: 1px; }
.care-jar { flex: 1; font-size: 11.5px; font-weight: 800; white-space: nowrap; }
.care-btn {
  border: 1.75px solid #23211e; border-radius: 8px; background: #f3ecdc; color: #23211e;
  font-family: inherit; font-size: 11.5px; font-weight: 800; padding: 2px 7px; cursor: pointer; white-space: nowrap;
}
.care-feed { background: #fde047; box-shadow: 2px 2px 0 #23211e; }
.care-btn:disabled { opacity: 1; background: #e5e7eb; }

/* 喂食：饼干从按钮飞进嘴巴 */
.snack-fly {
  position: fixed; left: 0; top: 0; width: 18px; height: 18px; border-radius: 50%;
  background: #fbbf24; border: 2.5px solid #23211e; z-index: 10; pointer-events: none;
  background-image: radial-gradient(circle at 35% 35%, #7c2d12 0 2px, transparent 2.5px), radial-gradient(circle at 65% 60%, #7c2d12 0 2px, transparent 2.5px);
  animation: snack-fly 0.52s cubic-bezier(0.3, 0, 0.6, 1) forwards;
}
@keyframes snack-fly {
  0% { transform: translate(var(--x0), var(--y0)) scale(1) rotate(0); }
  50% { transform: translate(calc((var(--x0) + var(--x1)) / 2), calc(var(--y0) - 26px)) scale(1.15) rotate(200deg); }
  100% { transform: translate(var(--x1), var(--y1)) scale(0.4) rotate(380deg); }
}

/* 必做数字角标：挂在台历右上角（像 App 的未读红点），以前在右下角正好压住手和脚 */
.pet-badge {
  position: absolute;
  right: 6px;
  top: 30px;
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 999px;
  border: 2.5px solid #23211e;
  background: #86efac;
  color: #23211e;
  font-size: 12px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.pet-badge.badge-urgent { background: #fb7185; color: #fffdf5; }
</style>
