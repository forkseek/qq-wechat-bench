// 桌宠成长：等级门槛和称号由后端（lib/pet-care.mjs）算，这里只管「每级解锁什么」。
// 动作对应 CalendarPetSprite 里的 mood；台词组对应 lines.js 里按等级追加的台词。

export const UNLOCKS = {
  2: { action: 'dance', label: '扭扭舞' },
  3: { action: 'spin', label: '原地转圈圈' },
  4: { action: 'wave', label: '挥手打招呼' },
  5: { action: 'flip', label: '后空翻' },
  6: { lines: true, label: '更贫的嘴（新台词）' },
  7: { lines: true, label: '大人模式台词' },
  8: { action: 'fireworks', label: '放烟花' }
};

/** 到这一级为止解锁的所有动作 */
export function unlockedActions(level = 1) {
  const list = [];
  for (const [lv, u] of Object.entries(UNLOCKS)) {
    if (Number(lv) <= level && u.action) list.push(u.action);
  }
  return list;
}

/** 下一级会解锁什么（满级返回 null） */
export function nextUnlock(level = 1) {
  const u = UNLOCKS[level + 1];
  return u ? { level: level + 1, label: u.label } : null;
}

/** 这一级新解锁的东西 */
export function unlockAt(level) {
  return UNLOCKS[level] || null;
}
