const TZ = 'Asia/Shanghai';

export function todayBeijing() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
}

export function datePlusDays(days) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(Date.now() + days * 86_400_000));
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
