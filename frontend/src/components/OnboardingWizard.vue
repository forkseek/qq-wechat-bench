<script setup>
// 首次启动引导：手账风分步向导 + 右边桌宠陪聊。
// 每一步点「下一步」就把这一步的东西存掉，中途关掉也不会白填；只有「桌宠怎么叫你」是必填。
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';
import CalendarPetSprite from './CalendarPetSprite.vue';

const props = defineProps({
  state: { type: Object, required: true }
});
const emit = defineEmits(['close', 'refresh', 'toast']);

const STEPS = [
  { key: 'hello', label: '你好' },
  { key: 'name', label: '称呼' },
  { key: 'me', label: '身份' },
  { key: 'accounts', label: '登录' },
  { key: 'groups', label: '选群' },
  { key: 'prefs', label: '偏好' },
  { key: 'ai', label: 'AI' },
  { key: 'pet', label: '桌宠' },
  { key: 'done', label: '完成' }
];
const MUST_DO = ['作业', '实验报告', '考试 / 测验', '体测', '签到 / 点名', '汇报 / 答辩', '选课 / 评教', '缴费 / 学籍', '班会'];
const IGNORE = ['文艺演出', '志愿招募', '讲座宣传', '比赛宣传', '抽奖 / 转发', '社团招新', '二手 / 拼单'];
const GRADES = ['大一', '大二', '大三', '大四', '大五', '研一', '研二', '研三', '博士', '其他'];
const SUGGEST_RE = /(班|级|课|通知|学院|年级|辅导员|实验|作业|考试|体测|教务|专业|学生会|宿舍)/;

const step = ref(0);
const busy = ref(false);
const error = ref('');
const current = computed(() => STEPS[step.value].key);

const profile = props.state?.profile || {};
const companion = props.state?.companion || {};
const form = ref({
  nickname: companion.nickname || '',
  name: profile.name || '',
  aliases: profile.aliases || '',
  studentNo: profile.studentNo || '',
  school: profile.school || '',
  grade: profile.grade || '',
  major: profile.major || '',
  className: profile.className || '',
  campus: profile.campus || '',
  mustDo: profile.mustDo?.length ? [...profile.mustDo] : ['作业', '实验报告', '考试 / 测验', '体测'],
  ignore: profile.ignore?.length ? [...profile.ignore] : ['文艺演出', '志愿招募', '抽奖 / 转发'],
  context: profile.context || '',
  petName: companion.petName || '日历小助手',
  personality: companion.personality || 'lively',
  quietStart: companion.quietStart || '23:00',
  quietEnd: companion.quietEnd || '07:00',
  showPet: companion.showPet !== false,
  autostart: Boolean(props.state?.autostart)
});

// ---------------- 桌宠陪聊 ----------------
const petMood = ref('happy');
const petLine = ref('');
let moodTimer = null;
function petSay(text, mood = 'happy', ms = 1800) {
  petLine.value = text;
  petMood.value = mood;
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => { petMood.value = 'idle'; }, ms);
}
const nick = computed(() => form.value.nickname.trim() || '你');

const STEP_LINES = {
  hello: () => '嗨～我是日历小助手！先认识一下嘛，三分钟就好，填完我就能帮你盯通知啦！',
  name: () => '先告诉我，我该怎么叫你？随便起，我嘴甜得很～',
  me: () => `${nick.value}是哪个班的呀？知道了我才能帮你挑出跟你有关的通知！`,
  accounts: () => 'QQ 和微信要在这台电脑上登录着，我才看得到群里的消息喔～',
  groups: () => '勾上你在意的群！班级群、课程群一个都别漏，我先帮你圈了几个像的～',
  prefs: () => '哪些事一定要提醒你，哪些直接无视？你说了算，我照办！',
  ai: () => '最后一个技术活！填好 AI 的钥匙，我就能自己读通知、帮你挑重点啦～',
  pet: () => `给我起个名字嘛～不起的话我就继续叫「日历小助手」啰！`,
  done: () => `${nick.value}～搞定啦！以后我就跟着你混了，有事戳我，没事也可以戳我！`
};
watch(step, () => petSay(STEP_LINES[current.value](), current.value === 'done' ? 'celebrate' : 'happy', 2200), { immediate: true });

let nickTimer = null;
watch(() => form.value.nickname, v => {
  if (v.trim()) error.value = '';
  clearTimeout(nickTimer);
  nickTimer = setTimeout(() => {
    if (current.value !== 'name') return;
    const n = v.trim();
    if (!n) return;
    if (n.length > 8) petSay(`「${n}」？好长！我、我会努力念完的……`, 'startle');
    else petSay(`「${n}」！好听！以后我就这么叫你啦～`, 'happy');
  }, 500);
});
watch(() => form.value.name, v => {
  if (current.value === 'name' && v.trim()) petSay('真名是给 AI 认人用的（名单、点名、@你），我保证不乱喊！', 'shy');
});
watch(() => form.value.petName, v => {
  if (current.value !== 'pet') return;
  const n = v.trim();
  if (n && n !== '日历小助手') petSay(`「${n}」？这名字配我刚刚好！`, 'happy');
});
watch(() => form.value.personality, v => {
  if (current.value !== 'pet') return;
  petSay(v === 'quiet' ? '好嘛……那我安静一点，只在要紧的时候开口。' : '耶！活泼模式！我会多陪你说话的～', v === 'quiet' ? 'shy' : 'celebrate');
});

// ---------------- 登录状态 ----------------
const qqOnline = computed(() => Boolean(props.state?.qq?.online));
const wxOnline = computed(() => Boolean(props.state?.wechat?.online));
async function startQQ() {
  busy.value = true;
  error.value = '';
  try {
    await api('/api/qq/start', {}, 'POST');
    window.open('/qq-login', '_blank', 'noopener');
    petSay('扫码页打开啦，用手机 QQ 扫一下！扫完回来点「刷新状态」～', 'urgent');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
function refreshStatus() {
  emit('refresh');
  petSay('我看看……', 'idle', 600);
}

// ---------------- 选群 ----------------
const groups = ref([]); // { key, platform, id, title, sub, already, suggested }
const picked = ref(new Set());
const groupErrors = ref({ qq: '', wechat: '' });
const groupsLoading = ref(false);
const groupSearch = ref('');
async function loadGroups() {
  groupsLoading.value = true;
  groupErrors.value = { qq: '', wechat: '' };
  const list = [];
  const [qq, wx] = await Promise.allSettled([api('/api/qq/groups'), api('/api/wechat/groups')]);
  if (qq.status === 'fulfilled') {
    for (const g of qq.value || []) {
      list.push({ key: `qq:${g.groupId}`, platform: 'qq', id: String(g.groupId), title: g.name || g.groupId,
        sub: `群号 ${g.groupId}${g.memberCount ? ` · ${g.memberCount} 人` : ''}`, already: Boolean(g.captured), suggested: SUGGEST_RE.test(g.name || '') });
    }
  } else groupErrors.value.qq = qq.reason?.message || 'QQ 群读取失败';
  if (wx.status === 'fulfilled') {
    for (const g of wx.value || []) {
      list.push({ key: `wx:${g.id}`, platform: 'wechat', id: g.id, title: g.title, sub: '微信群',
        already: Boolean(g.monitored), suggested: SUGGEST_RE.test(g.title || '') });
    }
  } else groupErrors.value.wechat = wx.reason?.message || '微信群读取失败';
  // 已关注的排前面，其次是猜你需要的
  list.sort((a, b) => Number(b.already) - Number(a.already) || Number(b.suggested) - Number(a.suggested) || a.title.localeCompare(b.title, 'zh-CN'));
  groups.value = list;
  const next = new Set();
  for (const g of list) if (g.already || g.suggested) next.add(g.key);
  picked.value = next;
  groupsLoading.value = false;
}
const visibleGroups = computed(() => {
  const q = groupSearch.value.trim().toLowerCase();
  return q ? groups.value.filter(g => g.title.toLowerCase().includes(q) || g.id.includes(q)) : groups.value;
});
function toggleGroup(g) {
  if (g.already) return; // 引导里不取消已关注的群，去「关注群组」页管理
  const next = new Set(picked.value);
  if (next.has(g.key)) next.delete(g.key);
  else next.add(g.key);
  picked.value = next;
  const n = next.size;
  if (n >= 8) petSay(`已经 ${n} 个群了！我的小本本要写不下啦～`, 'startle');
  else petSay(`好！记下「${g.title}」${next.has(g.key) ? '' : '……啊不，划掉'}～`, next.has(g.key) ? 'happy' : 'pout');
}
watch(current, k => { if (k === 'groups' && !groups.value.length) loadGroups(); });

async function saveGroups() {
  const todo = groups.value.filter(g => picked.value.has(g.key) && !g.already);
  let ok = 0;
  const failed = [];
  for (const g of todo) {
    try {
      if (g.platform === 'qq') await api('/api/capture/groups', { groupId: g.id }, 'POST');
      else await api('/api/wechat/groups', { conversationId: g.id }, 'POST');
      g.already = true;
      ok += 1;
    } catch (err) {
      failed.push(`${g.title}：${err.message}`);
    }
  }
  if (ok) emit('toast', `已关注 ${ok} 个群`);
  if (failed.length) throw new Error(`有 ${failed.length} 个群没加上：${failed[0]}`);
}

// ---------------- 偏好 ----------------
function toggleIn(listKey, item) {
  const list = form.value[listKey];
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
  else list.push(item);
  petSay(listKey === 'mustDo' ? `「${item}」${i >= 0 ? '不用管了是吧，好～' : '一定盯紧！'}` : `「${item}」${i >= 0 ? '又要看了？好嘛～' : '直接无视！'}`, i >= 0 ? 'idle' : 'happy', 1200);
}

// ---------------- AI ----------------
const presets = computed(() => props.state?.settings?.modelPresets || []);
const aiConfigured = computed(() => Boolean(props.state?.model?.configured));
const aiEditing = ref(false);
const ai = ref({ preset: '', baseUrl: '', name: '', key: '', allowCloud: false });
const localAI = computed(() => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(ai.value.baseUrl).hostname); }
  catch { return false; }
});
const aiTest = ref({ ok: false, msg: '' });
onMounted(() => {
  const p = presets.value[0];
  ai.value = { preset: p?.id || 'custom', baseUrl: props.state?.model?.baseUrl || p?.baseUrl || '', name: props.state?.model?.name || p?.name || '', key: '', allowCloud: false };
});
function onPreset() {
  const p = presets.value.find(x => x.id === ai.value.preset);
  if (p) {
    if (ai.value.baseUrl !== p.baseUrl) changeAIEndpoint();
    ai.value.baseUrl = p.baseUrl;
    ai.value.name = p.name;
  }
}
function changeAIEndpoint() {
  ai.value.allowCloud = false;
  ai.value.key = '';
  aiTest.value = { ok: false, msg: '' };
}
async function testAI() {
  busy.value = true;
  aiTest.value = { ok: false, msg: '' };
  try {
    const res = await api('/api/model/test', { enabled: true, allowCloud: ai.value.allowCloud, baseUrl: ai.value.baseUrl, name: ai.value.name, key: ai.value.key });
    aiTest.value = { ok: true, msg: `通了：${String(res.reply || '').slice(0, 40)}` };
    petSay('通了通了！AI 说它在！', 'celebrate');
  } catch (err) {
    aiTest.value = { ok: false, msg: err.message };
    petSay('呜……没连上，看看钥匙是不是抄错了？', 'pout');
  } finally {
    busy.value = false;
  }
}
async function saveAI() {
  if (aiConfigured.value && !aiEditing.value) return;
  if (!ai.value.baseUrl.trim() || !ai.value.name.trim() || (!localAI.value && !ai.value.allowCloud)) return;
  await api('/api/model', { enabled: true, allowCloud: ai.value.allowCloud, baseUrl: ai.value.baseUrl, name: ai.value.name, key: ai.value.key }, 'PUT');
}

// ---------------- 每一步的保存 ----------------
async function saveStep(key) {
  const f = form.value;
  if (key === 'name') {
    if (!f.nickname.trim()) throw new Error('先告诉桌宠该怎么叫你吧（随便起一个也行）');
    await api('/api/companion', { nickname: f.nickname.trim() }, 'PUT');
    await api('/api/profile', { name: f.name, aliases: f.aliases, studentNo: f.studentNo }, 'PUT');
  } else if (key === 'me') {
    await api('/api/profile', { school: f.school, grade: f.grade, major: f.major, className: f.className, campus: f.campus }, 'PUT');
  } else if (key === 'groups') {
    await saveGroups();
  } else if (key === 'prefs') {
    await api('/api/profile', { mustDo: f.mustDo, ignore: f.ignore, context: f.context }, 'PUT');
  } else if (key === 'ai') {
    await saveAI();
  } else if (key === 'pet') {
    await api('/api/companion', { petName: f.petName, personality: f.personality, quietStart: f.quietStart, quietEnd: f.quietEnd, showPet: f.showPet }, 'PUT');
    if (f.autostart !== Boolean(props.state?.autostart)) await api('/api/autostart', { enabled: f.autostart }, 'PUT');
    const bridge = window.pywebview?.api;
    if (bridge) await (f.showPet ? bridge.show_pet() : bridge.hide_pet()).catch?.(() => {});
  }
}

async function next() {
  error.value = '';
  busy.value = true;
  try {
    await saveStep(current.value);
    emit('refresh');
    if (step.value < STEPS.length - 1) step.value += 1;
  } catch (err) {
    error.value = err.message;
    petSay('哎呀，这里卡住了，看看红字～', 'pout');
  } finally {
    busy.value = false;
  }
}
function skip() {
  error.value = '';
  if (step.value < STEPS.length - 1) step.value += 1;
}
function back() {
  error.value = '';
  if (step.value > 0) step.value -= 1;
}
async function finish() {
  busy.value = true;
  try {
    await api('/api/onboarding', { done: true }, 'PUT');
    emit('refresh');
    emit('close');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
async function later() {
  // 关掉不算走完，下次打开还会出现；称呼已经存过的话不影响桌宠
  emit('close');
}

const canSkip = computed(() => !['hello', 'name', 'done'].includes(current.value));
const summary = computed(() => {
  const f = form.value;
  const who = [f.school, f.grade, f.major, f.className].filter(Boolean).join(' · ');
  return [
    { k: '桌宠叫你', v: f.nickname || '（没填）' },
    { k: '真名 / 群昵称', v: [f.name, f.aliases].filter(Boolean).join(' / ') || '（没填）' },
    { k: '身份', v: who || '（没填）' },
    { k: '关注的群', v: `${groups.value.filter(g => g.already).length || (props.state?.conversations || []).filter(c => c.monitored).length} 个` },
    { k: '一定提醒', v: f.mustDo.join('、') || '（没选）' },
    { k: 'AI 整理', v: props.state?.model?.configured ? '已配置' : '还没配，先只收消息' },
    { k: '桌宠', v: `${f.petName} · ${f.personality === 'quiet' ? '安静' : '活泼'}${f.showPet ? '' : ' · 先藏起来'}` }
  ];
});
</script>

<template>
  <Teleport to="body">
    <div class="ob-backdrop">
      <div class="ob-card" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <header class="ob-head">
          <h2 id="ob-title" class="ob-title">第一次见面 · 讯课手账</h2>
          <ol class="ob-steps" aria-label="引导进度">
            <li v-for="(s, i) in STEPS" :key="s.key" :class="{ on: i === step, past: i < step }">
              <span class="ob-dot">{{ i < step ? '✓' : i + 1 }}</span>
              <span class="ob-step-label">{{ s.label }}</span>
            </li>
          </ol>
          <button class="ob-later" type="button" title="下次打开讯课还会出现" @click="later">稍后再说</button>
        </header>

        <div class="ob-body">
          <section class="ob-main">
            <!-- 1 你好 + 隐私 -->
            <template v-if="current === 'hello'">
              <h3 class="ob-h">欢迎来到讯课 ✦</h3>
              <p class="ob-p">讯课会帮你盯着班级群、课程群里的通知，自动挑出要做的事和截止时间。开始前，有几件事你应该知道：</p>
              <ul class="ob-list">
                <li>它会读取<b>你勾选的群</b>的聊天记录，没勾的群不会碰。</li>
                <li>所有消息和待办都存在<b>这台电脑上</b>。</li>
                <li>只有勾选的群的消息，会发给<b>你自己填的 AI 服务</b>去整理。</li>
                <li>以后随时可以在「关注群组」「设置与维护」里改、删。</li>
              </ul>
              <p class="ob-p muted">接下来大概 3 分钟，除了「怎么称呼你」，其它都能先跳过。</p>
            </template>

            <!-- 2 称呼 -->
            <template v-else-if="current === 'name'">
              <h3 class="ob-h">我该怎么称呼你？</h3>
              <label class="field">
                <span class="field-label">桌宠怎么叫你 <em class="req">必填</em></span>
                <input v-model="form.nickname" class="input" maxlength="20" placeholder="比如：石头 / 小王 / 学霸本霸" />
              </label>
              <p class="ob-tip">只给桌宠用，随便起。下面这些是给 AI 认人用的，和昵称分开。</p>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">真实姓名</span>
                  <input v-model="form.name" class="input" maxlength="100" placeholder="名单、点名里出现的名字" />
                </label>
                <label class="field">
                  <span class="field-label">学号后几位（可选）</span>
                  <input v-model="form.studentNo" class="input" maxlength="30" placeholder="比如：0317" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">群昵称 / 别人怎么叫你（可选）</span>
                <input v-model="form.aliases" class="input" maxlength="200" placeholder="比如：动科3班-张三、三三" />
              </label>
            </template>

            <!-- 3 身份 -->
            <template v-else-if="current === 'me'">
              <h3 class="ob-h">你是哪里的同学？</h3>
              <div class="field-row">
                <label class="field"><span class="field-label">学校</span><input v-model="form.school" class="input" maxlength="60" placeholder="比如：福建农林大学" /></label>
                <label class="field">
                  <span class="field-label">年级</span>
                  <select v-model="form.grade" class="select">
                    <option value="">选一下</option>
                    <option v-for="g in GRADES" :key="g" :value="g">{{ g }}</option>
                  </select>
                </label>
              </div>
              <div class="field-row">
                <label class="field"><span class="field-label">专业</span><input v-model="form.major" class="input" maxlength="60" placeholder="比如：动物科学" /></label>
                <label class="field"><span class="field-label">班级</span><input v-model="form.className" class="input" maxlength="60" placeholder="比如：25级3班" /></label>
              </div>
              <label class="field"><span class="field-label">校区（可选）</span><input v-model="form.campus" class="input" maxlength="60" placeholder="通知分校区时用来判断哪条是你的" /></label>
            </template>

            <!-- 4 登录 -->
            <template v-else-if="current === 'accounts'">
              <h3 class="ob-h">连上 QQ 和微信</h3>
              <div class="acct">
                <span class="acct-name">QQ</span>
                <span class="badge" :class="qqOnline ? 'badge-pine' : 'badge-ochre'">{{ qqOnline ? `已连上${state.qq?.name ? ' · ' + state.qq.name : ''}` : '还没连上' }}</span>
                <button v-if="!qqOnline" class="btn btn-secondary btn-sm" :disabled="busy" @click="startQQ">启动并扫码登录</button>
              </div>
              <div class="acct">
                <span class="acct-name">微信</span>
                <span class="badge" :class="wxOnline ? 'badge-pine' : 'badge-ochre'">{{ wxOnline ? `已连上${state.wechat?.name ? ' · ' + state.wechat.name : ''}` : '还没连上' }}</span>
                <span v-if="!wxOnline" class="ob-tip">在这台电脑上打开并登录电脑版微信就行</span>
              </div>
              <button class="btn btn-ghost btn-sm" type="button" @click="refreshStatus">刷新状态</button>
              <p class="ob-tip">都可以先跳过，之后在「设置与维护」里再连。</p>
            </template>

            <!-- 5 选群 -->
            <template v-else-if="current === 'groups'">
              <h3 class="ob-h">要帮你盯哪些群？</h3>
              <div class="grp-tools">
                <input v-model="groupSearch" class="input" placeholder="搜群名或群号" />
                <button class="btn btn-ghost btn-sm" type="button" :disabled="groupsLoading" @click="loadGroups">{{ groupsLoading ? '读取中…' : '重新读取' }}</button>
              </div>
              <p v-if="groupErrors.qq" class="ob-warn">QQ：{{ groupErrors.qq }}</p>
              <p v-if="groupErrors.wechat" class="ob-warn">微信：{{ groupErrors.wechat }}</p>
              <div class="grp-list">
                <p v-if="groupsLoading" class="ob-tip">正在读取群列表…</p>
                <p v-else-if="!groups.length" class="ob-tip">暂时读不到群。可以先跳过，登录 QQ / 微信后去「关注群组」添加。</p>
                <button
                  v-for="g in visibleGroups"
                  :key="g.key"
                  type="button"
                  class="grp"
                  :class="{ on: picked.has(g.key), locked: g.already }"
                  @click="toggleGroup(g)"
                >
                  <span class="grp-box">{{ picked.has(g.key) ? '✓' : '' }}</span>
                  <span class="grp-plat" :class="g.platform === 'qq' ? 'plat-qq' : 'plat-wx'">{{ g.platform === 'qq' ? 'QQ' : '微信' }}</span>
                  <span class="grp-text">
                    <span class="grp-title">{{ g.title }}</span>
                    <span class="grp-sub">{{ g.sub }}</span>
                  </span>
                  <span v-if="g.already" class="badge badge-pine">已关注</span>
                  <span v-else-if="g.suggested" class="badge">猜你需要</span>
                </button>
              </div>
              <p class="ob-tip">勾上的群会马上补拉一段最近的消息。已关注的群在这里不能取消，去「关注群组」页管理。</p>
            </template>

            <!-- 6 偏好 -->
            <template v-else-if="current === 'prefs'">
              <h3 class="ob-h">哪些事算你的「必做」？</h3>
              <p class="ob-label">一定要提醒我</p>
              <div class="chips">
                <button v-for="c in MUST_DO" :key="c" type="button" class="chip" :class="{ on: form.mustDo.includes(c) }" @click="toggleIn('mustDo', c)">{{ c }}</button>
              </div>
              <p class="ob-label">这些可以忽略</p>
              <div class="chips">
                <button v-for="c in IGNORE" :key="c" type="button" class="chip chip-ignore" :class="{ on: form.ignore.includes(c) }" @click="toggleIn('ignore', c)">{{ c }}</button>
              </div>
              <label class="field">
                <span class="field-label">还有别的规则吗？（可选）</span>
                <textarea v-model="form.context" class="textarea" rows="3" maxlength="5000" placeholder="比如：我住仓山校区；大学城校区的通知可以忽略。"></textarea>
              </label>
            </template>

            <!-- 7 AI -->
            <template v-else-if="current === 'ai'">
              <h3 class="ob-h">给讯课配一个 AI</h3>
              <div v-if="aiConfigured && !aiEditing" class="acct">
                <span class="badge badge-pine">已配置 · {{ state.model?.name }}</span>
                <button class="btn btn-ghost btn-sm" type="button" @click="aiEditing = true">换一个</button>
              </div>
              <template v-else>
                <div class="field-row">
                  <label class="field">
                    <span class="field-label">服务</span>
                    <select v-model="ai.preset" class="select" @change="onPreset">
                      <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.label || p.id }}</option>
                      <option value="custom">自己填</option>
                    </select>
                  </label>
                  <label class="field"><span class="field-label">模型名</span><input v-model="ai.name" class="input" placeholder="deepseek-flash" /></label>
                </div>
                <label v-if="ai.preset === 'custom'" class="field"><span class="field-label">服务地址</span><input v-model="ai.baseUrl" class="input" placeholder="http://127.0.0.1:11434/v1" @input="changeAIEndpoint" /></label>
                <label class="field"><span class="field-label">API Key</span><input v-model="ai.key" type="password" autocomplete="off" class="input" placeholder="sk-..." /></label>
                <label v-if="!localAI" class="check"><input v-model="ai.allowCloud" type="checkbox" /> 允许当前云端服务接收已关注会话的内容</label>
                <div class="acct">
                  <button class="btn btn-secondary btn-sm" type="button" :disabled="busy || !ai.baseUrl || !ai.name || (!localAI && !ai.allowCloud)" @click="testAI">测试一下</button>
                  <span v-if="aiTest.msg" :class="aiTest.ok ? 'ok-text' : 'ob-warn'">{{ aiTest.msg }}</span>
                </div>
                <p class="ob-tip">本机模型可直接配置。使用云端会发送聊天文字、发送者和待办上下文。不需要 AI 时可跳过。</p>
              </template>
            </template>

            <!-- 8 桌宠 -->
            <template v-else-if="current === 'pet'">
              <h3 class="ob-h">最后，关于我～</h3>
              <label class="field"><span class="field-label">给桌宠起个名字</span><input v-model="form.petName" class="input" maxlength="20" placeholder="日历小助手" /></label>
              <p class="ob-label">性格</p>
              <div class="chips">
                <button type="button" class="chip" :class="{ on: form.personality === 'lively' }" @click="form.personality = 'lively'">活泼：常说话、会散步</button>
                <button type="button" class="chip" :class="{ on: form.personality === 'quiet' }" @click="form.personality = 'quiet'">安静：有事才开口</button>
              </div>
              <div class="field-row">
                <label class="field"><span class="field-label">免打扰从</span><input v-model="form.quietStart" type="time" class="input" /></label>
                <label class="field"><span class="field-label">到</span><input v-model="form.quietEnd" type="time" class="input" /></label>
              </div>
              <label class="check"><input v-model="form.showPet" type="checkbox" /> 在桌面上显示桌宠</label>
              <label class="check"><input v-model="form.autostart" type="checkbox" /> 开机自动打开讯课</label>
            </template>

            <!-- 9 完成 -->
            <template v-else>
              <h3 class="ob-h">都记下啦 ✓</h3>
              <dl class="sum">
                <template v-for="row in summary" :key="row.k">
                  <dt>{{ row.k }}</dt>
                  <dd>{{ row.v }}</dd>
                </template>
              </dl>
              <p class="ob-tip">以后想改，去「我的身份与规则」「设置与维护」；想重走一遍这个引导，也在「设置与维护」里。</p>
            </template>

            <p v-if="error" class="ob-warn ob-error">{{ error }}</p>
          </section>

          <!-- 桌宠陪聊 -->
          <aside class="ob-pet" aria-live="polite">
            <div class="ob-bubble">{{ petLine }}</div>
            <CalendarPetSprite view="front" :mood="petMood" :today-day="new Date().getDate()" />
            <div class="ob-pet-name">{{ form.petName || '日历小助手' }}</div>
          </aside>
        </div>

        <footer class="ob-foot">
          <button v-if="step > 0 && current !== 'done'" class="btn btn-ghost" type="button" :disabled="busy" @click="back">上一步</button>
          <span class="ob-spacer"></span>
          <button v-if="canSkip" class="btn btn-secondary" type="button" :disabled="busy" @click="skip">先跳过</button>
          <button v-if="current !== 'done'" class="btn btn-primary" type="button" :disabled="busy" @click="next">
            {{ busy ? '保存中…' : current === 'hello' ? '开始吧' : current === 'groups' ? '关注这些群' : '下一步' }}
          </button>
          <button v-else class="btn btn-primary" type="button" :disabled="busy" @click="finish">开始用讯课</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ob-backdrop {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(35, 33, 30, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.ob-card {
  width: min(900px, 100%); max-height: calc(100vh - 32px);
  display: flex; flex-direction: column;
  background: var(--glass-modal, #fffdf8);
  border: 2.5px solid var(--stroke); border-radius: var(--sketch-radius); box-shadow: 8px 8px 0 var(--stroke);
  overflow: hidden;
}
.ob-head { display: flex; align-items: center; gap: 14px; padding: 12px 18px; background: var(--marker-yellow); border-bottom: 2px solid var(--stroke); flex-wrap: wrap; }
.ob-title { font-family: var(--font-display); font-size: 19px; font-weight: 700; color: var(--ink); }
.ob-steps { display: flex; gap: 4px; list-style: none; margin: 0; padding: 0; flex: 1; flex-wrap: wrap; }
.ob-steps li { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 700; color: var(--ink-3); }
.ob-steps li.on, .ob-steps li.past { color: var(--ink); }
.ob-dot { width: 20px; height: 20px; border-radius: var(--sketch-circle); border: 1.75px solid var(--stroke); background: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.ob-steps li.on .ob-dot { background: var(--marker-lavender-strong, #c4b5fd); }
.ob-steps li.past .ob-dot { background: var(--marker-mint); }
.ob-later { font-size: 12px; font-weight: 700; color: var(--ink-2); text-decoration: underline; text-underline-offset: 3px; }

.ob-body { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 18px; padding: 18px 20px; overflow-y: auto; }
.ob-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ob-h { font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--ink); }
.ob-p { font-size: 14px; line-height: 1.7; color: var(--ink); }
.ob-list { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; line-height: 1.6; }
.ob-tip { font-size: 12.5px; color: var(--ink-2); line-height: 1.6; }
.ob-warn { font-size: 12.5px; color: var(--seal); font-weight: 600; }
.ob-error { padding: 8px 10px; border: 1.75px dashed var(--seal); border-radius: var(--sketch-radius-sm); background: var(--seal-wash); }
.ok-text { font-size: 12.5px; color: var(--wx); font-weight: 700; }
.ob-label { font-size: 12.5px; font-weight: 700; color: var(--ink-2); }
.req { font-style: normal; font-size: 11px; color: var(--seal); margin-left: 4px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; }

.acct { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.acct-name { font-weight: 700; min-width: 40px; }

.grp-tools { display: flex; gap: 8px; }
.grp-list { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; padding: 2px 4px 2px 0; }
.grp { display: flex; align-items: center; gap: 10px; text-align: left; padding: 8px 10px; border: 1.75px solid var(--hairline); border-radius: var(--sketch-radius-sm); background: #fff; }
.grp:hover { border-color: var(--stroke); }
.grp.on { border-color: var(--stroke); background: #fffbe0; box-shadow: 2px 2px 0 var(--stroke); }
.grp.locked { cursor: default; }
.grp-box { width: 20px; height: 20px; border: 2px solid var(--stroke); border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; font-weight: 900; background: #fff; flex-shrink: 0; }
.grp.on .grp-box { background: var(--marker-mint); }
.grp-plat { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: var(--sketch-radius-pill); border: 1.5px solid var(--stroke); flex-shrink: 0; }
.plat-qq { background: var(--marker-sky); color: var(--qq); }
.plat-wx { background: var(--marker-mint); color: var(--wx); }
.grp-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.grp-title { font-weight: 700; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grp-sub { font-size: 11.5px; color: var(--ink-3); }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 5px 12px; border-radius: var(--sketch-radius-pill); border: 1.75px solid var(--stroke); background: #fff; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.chip.on { background: var(--marker-yellow); color: var(--ink); box-shadow: 2px 2px 0 var(--stroke); }
.chip-ignore.on { background: var(--marker-rose); }

.sum { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; margin: 0; font-size: 13.5px; }
.sum dt { font-weight: 700; color: var(--ink-2); }
.sum dd { margin: 0; color: var(--ink); }

.ob-pet { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 6px; }
.ob-bubble {
  position: relative; width: 100%; padding: 10px 12px; font-size: 13px; font-weight: 700; line-height: 1.55; color: var(--ink);
  background: #fffdf5; border: 2.5px solid var(--stroke); border-radius: 14px 6px 14px 8px; box-shadow: 3px 3px 0 var(--stroke);
  min-height: 64px; margin-bottom: 6px;
}
.ob-bubble::after {
  content: ''; position: absolute; left: 50%; bottom: -8px; width: 11px; height: 11px; background: #fffdf5;
  border-right: 2.5px solid var(--stroke); border-bottom: 2.5px solid var(--stroke); transform: translateX(-50%) rotate(45deg);
}
.ob-pet-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--ink-2); }

.ob-foot { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 2px dashed var(--hairline); background: var(--paper); }
.ob-spacer { flex: 1; }

@media (max-width: 760px) {
  .ob-body { grid-template-columns: 1fr; }
  .ob-pet { order: -1; flex-direction: row; }
  .ob-pet :deep(.pet-sprite-wrap) { transform: scale(0.6); width: 90px; height: 90px; }
  .field-row { grid-template-columns: 1fr; }
}
</style>
