import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from '../lib/api.mjs';
import { Store } from '../lib/store.mjs';
import { publicCare } from '../lib/pet-care.mjs';

const now = new Date('2026-11-27T04:00:00Z');
const beforeMidnight = new Date('2026-11-27T15:59:00Z');
const midnight = new Date('2026-11-27T16:00:00Z');
const afterHours = hours => new Date(now.getTime() + hours * 3_600_000);

function fixture(t) {
  const store = new Store();
  t.after(() => store.close());
  return store;
}

function extractedTask(store, overrides = {}) {
  return store.putTask({
    id: randomUUID(), conversationId: null, title: '交实验报告', origin: 'ai', status: 'pending',
    dueDate: null, relevance: 'mine', revision: 1, updatedAt: now.toISOString(), ...overrides
  });
}

function changeStatus(store, task, status = 'done', at = now) {
  return store.manualTask({ revision: task.revision, status }, task.id, at);
}

test('桌宠初始状态、公开字段和北京时间日期', t => {
  const store = fixture(t);
  assert.deepEqual(store.petCare(midnight), {
    hunger: 80, mood: 70, exp: 0, snacks: 3, totalDone: 0,
    level: 1, title: '刚拆封的小日历', levelExp: 0, nextLevelExp: 60, pats: 0
  });
  assert.deepEqual(store.meta('petCare'), {
    hunger: 80, mood: 70, exp: 0, snacks: 3, totalDone: 0,
    lastTickAt: midnight.toISOString(), rewardedTaskIds: [],
    daily: { date: '2026-11-28', pats: 0, focus: 0, manualRewards: 0 }
  });
});

test('衰减按实际时长，保留小数且每次最多扣 45 饱腹和 30 心情', t => {
  const store = fixture(t);
  store.petCare(now);
  assert.equal(store.petCare(afterHours(0.25)).hunger, 79);
  assert.equal(store.meta('petCare').hunger, 79.25);
  assert.equal(store.meta('petCare').mood, 69.625);
  const afterTwoHours = store.petCare(afterHours(2));
  assert.equal(afterTwoHours.hunger, 74);
  assert.equal(afterTwoHours.mood, 67);
  const afterThreeDays = store.petCare(afterHours(74));
  assert.equal(afterThreeDays.hunger, 29);
  assert.equal(afterThreeDays.mood, 37);
  assert.equal(store.meta('petCare').lastTickAt, afterHours(74).toISOString());
  store.petCare(afterHours(146));
  const depleted = store.petCare(afterHours(218));
  assert.equal(depleted.hunger, 0);
  assert.equal(depleted.mood, 0);
});

test('仅逾期且待办的必做事项加速心情衰减，每小时最多扣 4 点', t => {
  const store = fixture(t);
  store.petCare(now);
  const overdue = { dueDate: '2026-11-26' };
  extractedTask(store, overdue);
  extractedTask(store, { ...overdue, relevance: 'other' });
  extractedTask(store, { ...overdue, obligation: 'optional' });
  extractedTask(store, { ...overdue, status: 'done' });
  extractedTask(store, { ...overdue, status: 'cancelled' });
  extractedTask(store, { dueDate: '2026-11-27', dueTime: '01:00' });
  assert.equal(store.petCare(afterHours(2)).mood, 65);
  extractedTask(store, overdue);
  extractedTask(store, overdue);
  assert.equal(store.petCare(afterHours(4)).mood, 57);
});

test('任务奖励区分按时必做、逾期必做和普通通知', t => {
  const store = fixture(t);
  const cases = [
    [{ dueDate: '2026-11-27' }, { snacks: 3, exp: 12, mood: 6 }],
    [{ dueDate: null }, { snacks: 3, exp: 12, mood: 6 }],
    [{ dueDate: '2026-11-26' }, { snacks: 2, exp: 8, mood: 2 }],
    [{ dueDate: '2026-11-26', obligation: 'optional' }, { snacks: 1, exp: 4, mood: 2 }]
  ];
  for (const [fields, expected] of cases) {
    const done = changeStatus(store, extractedTask(store, fields));
    const { care, levelUp, ...reward } = store.lastPetReward;
    assert.deepEqual(reward, expected);
    assert.equal(levelUp, false);
    assert.deepEqual(care, store.petCare(now));
    assert.equal(done.status, 'done');
  }
  const care = store.petCare(now);
  assert.deepEqual([care.snacks, care.exp, care.mood, care.totalDone], [12, 36, 86, 4]);
});

test('完成奖励结算时仍计入尚未完成的逾期任务', t => {
  const store = fixture(t);
  store.petCare(now);
  changeStatus(store, extractedTask(store, { dueDate: '2026-11-26' }), 'done', afterHours(2));
  assert.equal(store.lastPetReward.care.mood, 67);
});

test('已有任务首次完成才发奖，撤销后再次完成或新建即完成都不发奖', t => {
  const store = fixture(t);
  const completed = changeStatus(store, extractedTask(store));
  assert.equal(store.lastPetReward.care.totalDone, 1);
  const reopened = changeStatus(store, completed, 'pending');
  assert.equal(store.lastPetReward, null);
  changeStatus(store, reopened);
  assert.equal(store.lastPetReward, null);

  changeStatus(store, extractedTask(store, { status: 'cancelled' }));
  assert.equal(store.lastPetReward.care.totalDone, 2);
  const created = store.manualTask({ title: '已完成的任务', status: 'done' }, null, now);
  assert.equal(created.status, 'done');
  assert.equal(store.lastPetReward, null);
  assert.equal(store.petCare(now).totalDone, 2);
  assert.equal(store.meta('petCare').rewardedTaskIds.includes(created.id), false);
});

test('淘汰最旧的近期奖励记录后，旧任务仍不会重复发奖', t => {
  const store = fixture(t);
  store.petCare(now);
  const old = changeStatus(store, extractedTask(store));
  const care = store.meta('petCare');
  const ids = [old.id, ...Array.from({ length: 2999 }, (_, i) => `historical-${i}`)];
  store.setMeta('petCare', { ...care, rewardedTaskIds: ids });

  const latest = changeStatus(store, extractedTask(store));
  assert.deepEqual(store.meta('petCare').rewardedTaskIds, [...ids.slice(1), latest.id]);
  changeStatus(store, changeStatus(store, old, 'pending'));
  assert.equal(store.lastPetReward, null);
  assert.equal(store.petCare(now).totalDone, 2);
});

test('手动任务每日只奖前五次，跨北京时间午夜重置，超额任务仍去重', t => {
  const store = fixture(t);
  const tasks = Array.from({ length: 6 }, (_, i) => store.manualTask({
    title: `手动任务 ${i + 1}`, obligation: i % 2 === 0 ? 'required' : 'optional'
  }, null, beforeMidnight));
  for (const task of tasks.slice(0, 5)) {
    changeStatus(store, task, 'done', beforeMidnight);
    const { care, levelUp, ...reward } = store.lastPetReward;
    assert.deepEqual(reward, { snacks: 1, exp: 3, mood: 1 });
  }
  const capped = changeStatus(store, tasks.at(-1), 'done', beforeMidnight);
  assert.equal(store.lastPetReward, null);
  assert.equal(store.petCare(beforeMidnight).totalDone, 5);
  assert.ok(store.meta('petCare').rewardedTaskIds.includes(capped.id));

  changeStatus(store, changeStatus(store, capped, 'pending', midnight), 'done', midnight);
  assert.equal(store.lastPetReward, null);
  const newTask = store.manualTask({ title: '第二天的新任务' }, null, midnight);
  changeStatus(store, newTask, 'done', midnight);
  assert.equal(store.lastPetReward.care.totalDone, 6);
  assert.equal(store.lastPetReward.care.exp, 18);
});

test('喂食结算衰减，区分正常、太饱、零食耗尽，并限制饱腹上限', t => {
  const store = fixture(t);
  const fed = store.feedPet(now);
  assert.equal(fed.ate, true);
  assert.deepEqual([fed.care.hunger, fed.care.mood, fed.care.snacks], [100, 73, 2]);
  assert.deepEqual(store.feedPet(now), { ate: false, reason: 'full', care: fed.care });
  assert.equal(store.feedPet(afterHours(1)).reason, 'full');
  assert.equal(store.feedPet(afterHours(2)).ate, true);
  assert.equal(store.feedPet(afterHours(4)).care.snacks, 0);
  assert.deepEqual(store.feedPet(afterHours(4)), { ate: false, reason: 'empty', care: store.petCare(afterHours(4)) });
});

test('摸摸每天最多给 20 点心情，pats 记录当天次数并在北京时间午夜清零', t => {
  const store = fixture(t);
  for (let i = 1; i <= 10; i++) {
    const { gained, care } = store.patPet(beforeMidnight);
    assert.equal(gained, 2);
    assert.equal(care.mood, 70 + 2 * i);
    assert.equal(care.pats, i);
  }
  const capped = store.patPet(beforeMidnight);
  assert.equal(capped.gained, 0);
  assert.equal(capped.care.mood, 90);
  assert.equal(capped.care.pats, 11);
  assert.equal(store.petCare(midnight).pats, 0);
  assert.equal(store.patPet(midnight).gained, 2);
});

test('专注每天最多奖励四次，并在北京时间午夜恢复次数', t => {
  const store = fixture(t);
  for (let i = 1; i <= 4; i++) {
    const { gained, care } = store.focusPet(beforeMidnight);
    assert.equal(gained, 15);
    assert.deepEqual([care.exp, care.mood, care.hunger], [15 * i, 70 + 5 * i, 80 - 5 * i]);
  }
  assert.deepEqual(store.focusPet(beforeMidnight), { gained: 0, care: store.petCare(beforeMidnight) });
  const next = store.focusPet(midnight);
  assert.equal(next.gained, 15);
  assert.equal(next.care.exp, 75);
});

test('任务奖励跨越经验门槛时提示升级，满级没有下一级门槛', t => {
  const store = fixture(t);
  for (let i = 0; i < 4; i++) changeStatus(store, extractedTask(store));
  assert.equal(store.lastPetReward.care.level, 1);
  changeStatus(store, extractedTask(store));
  const { levelUp, care } = store.lastPetReward;
  assert.equal(levelUp, true);
  assert.deepEqual([care.exp, care.level, care.title, care.levelExp, care.nextLevelExp], [60, 2, '会打勾的小日历', 60, 160]);
  changeStatus(store, extractedTask(store));
  assert.equal(store.lastPetReward.levelUp, false);
  const max = publicCare({ ...store.meta('petCare'), exp: 1300 });
  assert.deepEqual([max.level, max.title, max.levelExp, max.nextLevelExp], [8, '传说中的时间管理大师', 1260, null]);
});

test('任务更新失败时桌宠奖励也回滚，重试可以正常发奖', t => {
  const store = fixture(t);
  const task = extractedTask(store);
  store.petCare(now);
  const before = store.meta('petCare');
  store.db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, '测试写入失败'); END");
  assert.throws(() => changeStatus(store, task, 'done', afterHours(1)), /测试写入失败/);
  assert.equal(store.task(task.id).status, 'pending');
  assert.deepEqual(store.meta('petCare'), before);
  assert.equal(store.lastPetReward, null);
  store.db.exec('DROP TRIGGER reject_update');
  changeStatus(store, task, 'done', afterHours(1));
  assert.equal(store.lastPetReward.care.totalDone, 1);
});

test('桌宠动作路由和任务 PATCH 返回约定的 JSON 结构', async t => {
  const store = fixture(t);
  const api = createApi({ store });
  async function call(path, method = 'POST', body) {
    let response;
    await api({
      req: { method }, url: new URL(path, 'http://localhost'),
      json: async () => {
        assert.notEqual(body, undefined, '动作路由应接受无请求体的 POST');
        return body;
      },
      send: value => { response = value; }
    });
    return response;
  }
  const { ate, care: fed } = await call('/api/pet/feed');
  assert.equal(ate, true);
  assert.equal(fed.snacks, 2);
  assert.equal((await call('/api/pet/pat')).gained, 2);
  assert.equal((await call('/api/pet/focus')).gained, 15);
  const task = store.manualTask({ title: 'PATCH 测试' });
  const path = `/api/tasks/${encodeURIComponent(task.id)}`;
  const { petReward, ...completed } = await call(path, 'PATCH', { status: 'done', revision: task.revision });
  assert.deepEqual(completed, store.task(task.id));
  assert.equal(petReward.exp, 3);
  assert.equal(petReward.care.exp, 18);
  assert.equal((await call(path, 'PATCH', { status: 'pending', revision: completed.revision })).petReward, null);
});
