import { beijingDate, inferTaskObligation } from './domain.mjs';

const LEVEL_THRESHOLDS = [0, 60, 160, 300, 480, 700, 960, 1260];
const LEVEL_TITLES = [
  '刚拆封的小日历', '会打勾的小日历', '拖延克星见习生', '准时小能手',
  '时间管理学徒', 'DDL 驯兽师', '效率小火箭', '传说中的时间管理大师'
];
const REWARD_HISTORY_LIMIT = 3000;
const clampStat = value => Math.max(0, Math.min(100, value));
const dailyCounters = date => ({ date, pats: 0, focus: 0, manualRewards: 0 });
const levelIndex = exp => LEVEL_THRESHOLDS.findLastIndex(threshold => exp >= threshold);
const isOverdue = (task, date) => Boolean(task.dueDate && task.dueDate < date);

export function initialCare(now = new Date()) {
  return {
    hunger: 80, mood: 70, exp: 0, snacks: 3, totalDone: 0,
    lastTickAt: now.toISOString(), rewardedTaskIds: [], daily: dailyCounters(beijingDate(now))
  };
}

export function tickCare(care, tasks, now = new Date()) {
  if (!care) return initialCare(now);
  const date = beijingDate(now);
  const hours = Math.max(0, (now.getTime() - Date.parse(care.lastTickAt)) / 3_600_000);
  const overdue = tasks.filter(task => task.status === 'pending' && task.relevance !== 'other'
    && isOverdue(task, date) && inferTaskObligation(task) === 'required').length;
  const moodRate = Math.min(4, 1.5 + overdue);
  return {
    ...care,
    hunger: clampStat(care.hunger - Math.min(45, 3 * hours)),
    mood: clampStat(care.mood - Math.min(30, moodRate * hours)),
    lastTickAt: now.toISOString(),
    daily: care.daily.date === date ? care.daily : dailyCounters(date)
  };
}

export function publicCare(care) {
  const { hunger, mood, exp, snacks, totalDone, daily } = care;
  const index = levelIndex(exp);
  return {
    hunger: Math.round(hunger), mood: Math.round(mood), exp, snacks, totalDone,
    level: index + 1, title: LEVEL_TITLES[index], levelExp: LEVEL_THRESHOLDS[index],
    nextLevelExp: LEVEL_THRESHOLDS[index + 1] ?? null, pats: daily.pats
  };
}

export function feedCare(care) {
  if (care.snacks === 0) return { ate: false, reason: 'empty', care };
  if (care.hunger >= 95) return { ate: false, reason: 'full', care };
  return {
    ate: true,
    care: { ...care, snacks: care.snacks - 1, hunger: clampStat(care.hunger + 20), mood: clampStat(care.mood + 3) }
  };
}

export function patCare(care) {
  const gained = care.daily.pats < 10 ? 2 : 0;
  return {
    gained,
    care: { ...care, mood: clampStat(care.mood + gained), daily: { ...care.daily, pats: care.daily.pats + 1 } }
  };
}

export function focusCare(care) {
  if (care.daily.focus >= 4) return { gained: 0, care };
  const gained = 15;
  return {
    gained,
    care: {
      ...care, exp: care.exp + gained, mood: clampStat(care.mood + 5), hunger: clampStat(care.hunger - 5),
      daily: { ...care.daily, focus: care.daily.focus + 1 }
    }
  };
}

function taskReward(task, date) {
  if (task.origin === 'manual') return { snacks: 1, exp: 3, mood: 1 };
  if (inferTaskObligation(task) === 'optional') return { snacks: 1, exp: 4, mood: 2 };
  if (isOverdue(task, date)) return { snacks: 2, exp: 8, mood: 2 };
  return { snacks: 3, exp: 12, mood: 6 };
}

export function rewardTask(care, task) {
  if (care.rewardedTaskIds.includes(task.id)) return { care, reward: null };
  const ids = [...care.rewardedTaskIds, task.id];
  const evictedTaskId = ids.length > REWARD_HISTORY_LIMIT ? ids[0] : undefined;
  const nextCare = { ...care, rewardedTaskIds: ids.slice(-REWARD_HISTORY_LIMIT) };
  const manual = task.origin === 'manual';
  if (manual && care.daily.manualRewards >= 5) return { care: nextCare, reward: null, evictedTaskId };
  const reward = taskReward(task, care.daily.date);
  nextCare.snacks += reward.snacks;
  nextCare.exp += reward.exp;
  nextCare.mood = clampStat(care.mood + reward.mood);
  nextCare.totalDone += 1;
  if (manual) nextCare.daily = { ...care.daily, manualRewards: care.daily.manualRewards + 1 };
  const levelUp = levelIndex(nextCare.exp) > levelIndex(care.exp);
  return { care: nextCare, reward: { ...reward, levelUp, care: publicCare(nextCare) }, evictedTaskId };
}
