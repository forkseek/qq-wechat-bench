const TZ = 'Asia/Shanghai';

export function todayBeijing() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
}

export function datePlusDays(days) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(Date.now() + days * 86_400_000));
}

const REQUIRED_HINT_RE = /(?:作业|实验报告|预习报告|生生互评|互评|实践报告|汇报|答辩|考试|补考|体测|点名|必交|务必|必须|全员|所有人|每位同学|班会|评教|学籍|选课|重修|缓考|提交报告|交报告|交作业)/;
const OPTIONAL_HINT_RE = /(?:公示|自愿|有兴趣|有意向|表演人员|文艺演出|志愿者|志愿服务|招募|招新|讲座|观影|抢票|选修|社团|大赛报名|比赛报名|鼓励参加|欢迎参加|转发|点赞|抽奖|关注.*报名|了解.*活动)/;

export function inferTaskObligation(task) {
  if (!task || typeof task !== 'object') return 'required';
  if (task.obligation === 'required' || task.obligation === 'optional') return task.obligation;
  if (task.origin === 'manual' || task.dueBasis === 'manual') return 'required';
  if (task.relevance === 'mine') return 'required';
  const hay = `${task.title || ''} ${task.description || ''}`;
  const kind = String(task.kind || '');
  if (kind === '作业' || kind === '考试') return 'required';
  if (OPTIONAL_HINT_RE.test(hay) && !REQUIRED_HINT_RE.test(hay)) return 'optional';
  if (task.relevance === 'unclear' && !REQUIRED_HINT_RE.test(hay)) return 'optional';
  if (kind === '活动' && !REQUIRED_HINT_RE.test(hay)) return 'optional';
  return 'required';
}

export function isStaleHistoricalTask(task) {
  if (!task || task.status !== 'pending') return false;
  if (task.origin === 'manual' || task.dueBasis === 'manual') return false;
  const staleDueCutoff = datePlusDays(-7);
  return Boolean(task.dueDate && task.dueDate < staleDueCutoff);
}

export function todayHeading() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(new Date());
}

export function lunarHeading() {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      timeZone: TZ,
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).formatToParts(new Date());
    const yearName = parts.find(p => p.type === 'yearName')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    const dayNum = Number(parts.find(p => p.type === 'day')?.value || 0);
    const days = [
      '', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
      '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
      '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
    ];
    const dayLabel = days[dayNum] || (parts.find(p => p.type === 'day')?.value || '');
    const text = `${yearName ? `${yearName}年 ` : ''}${month}${dayLabel}`.trim();
    return text ? `农历${text}` : '';
  } catch {
    return '';
  }
}

export function shichenHeading() {
  try {
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (h >= 23 || h < 1) return { seal: '子时', phrase: '夜阑灯火 · 案头清卷' };
    if (h < 5) return { seal: '寅丑', phrase: '星河未落 · 静思笃行' };
    if (h < 9) return { seal: '辰卯', phrase: '晨露初曦 · 展卷迎新' };
    if (h < 13) return { seal: '午巳', phrase: '日晷正明 · 笃志于学' };
    if (h < 17) return { seal: '申未', phrase: '清风入座 · 事有条理' };
    if (h < 20) return { seal: '酉戌', phrase: '暮色归案 · 拾遗补阙' };
    return { seal: '亥时', phrase: '灯下翻阅 · 明日有备' };
  } catch {
    return { seal: '案头', phrase: '消息有出处 · 事情有着落' };
  }
}

export function monogramChar(title = '') {
  const str = String(title || '').trim();
  const cjk = str.match(/[\u4e00-\u9fa5]/g);
  if (cjk && cjk.length) {
    const skip = new Set(['级', '届', '群', '年', '班']);
    const picked = cjk.find(ch => !skip.has(ch)) || cjk[0];
    return picked;
  }
  return (str[0] || '群').toUpperCase();
}

export function formatTime(iso, withYear = false) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(date)
    === new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date());
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    ...(withYear || !sameYear ? { year: 'numeric' } : {}),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

export function formatDue(task) {
  if (!task?.dueDate) {
    return {
      text: task?.dueText ? `未明确（${task.dueText}）` : '未明确截止',
      state: 'unknown',
      basisLabel: '未明确'
    };
  }
  const today = todayBeijing();
  const dueMs = Date.parse(`${task.dueDate}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const diffDays = Math.round((dueMs - todayMs) / 86_400_000);
  const currentYear = today.slice(0, 4);
  const [y, m, d] = task.dueDate.split('-');
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' }).format(new Date(dueMs));
  const dateLabel = `${y !== currentYear ? `${y}年` : ''}${Number(m)}月${Number(d)}日 ${weekday}${task.dueTime ? ` ${task.dueTime}` : ''}`;

  let state = 'normal';
  let tag = '';
  if (task.status === 'pending') {
    if (diffDays < 0) { state = 'overdue'; tag = `已逾期 ${Math.abs(diffDays)} 天`; }
    else if (diffDays === 0) { state = 'today'; tag = '今天截止'; }
    else if (diffDays === 1) { state = 'soon'; tag = '明天截止'; }
    else if (diffDays <= 7) { state = 'soon'; tag = `${diffDays} 天后`; }
  }
  const basisMap = {
    explicit: '原文写明',
    inferred: task.dueText ? `推算（原文“${task.dueText}”）` : '按消息日推算',
    manual: '手动填写',
    none: '未明确'
  };
  return {
    text: dateLabel,
    tag,
    state,
    basisLabel: basisMap[task.dueBasis] || '按消息日推算'
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function sortPendingTasks(tasks) {
  const today = todayBeijing();
  const rank = task => {
    if (!task.dueDate) return 3;
    if (task.dueDate < today) return 0;
    if (task.dueDate === today) return 1;
    return 2;
  };
  return [...tasks].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const d = (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
    if (d !== 0) return d;
    const t = (a.dueTime || '99:99').localeCompare(b.dueTime || '99:99');
    if (t !== 0) return t;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

export function platformLabel(platform) {
  return platform === 'wechat' ? '微信' : 'QQ';
}

export function relevanceLabel(rel) {
  return { mine: '与我有关', everyone: '全体适用', other: '他人事项', unclear: '归属待确认' }[rel] || '归属待确认';
}

export function analysisStateLabel(state) {
  return {
    idle: '等待新消息',
    queued: '排队整理中',
    analyzing: 'AI 整理中…',
    ready: '已整理',
    waiting_model: '等待配置 AI',
    error: '上次整理失败'
  }[state] || state || '未开始';
}
