import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';

test('资料：只改传了的字段，老弹窗只存姓名和规则时不清掉引导里填的信息', () => {
  const store = new Store();
  try {
    store.saveProfile({ name: '张三', aliases: '小张 / 三三', className: '25级动科3班', mustDo: ['作业', '体测', ''], ignore: ['志愿招募'] });
    const after = store.saveProfile({ name: '张三丰', context: '仓山校区' });
    assert.equal(after.name, '张三丰');
    assert.equal(after.context, '仓山校区');
    assert.equal(after.aliases, '小张 / 三三');
    assert.equal(after.className, '25级动科3班');
    assert.deepEqual(after.mustDo, ['作业', '体测']);
    assert.deepEqual(store.profile().ignore, ['志愿招募']);
    assert.equal(store.profile().timezone, 'Asia/Shanghai');
  } finally {
    store.close();
  }
});

test('老数据里只有 name / context 的资料，读出来会补齐新字段', () => {
  const store = new Store();
  try {
    store.setMeta('profile', { name: '老用户', context: '旧规则', timezone: 'Asia/Shanghai' });
    const p = store.profile();
    assert.equal(p.name, '老用户');
    assert.equal(p.aliases, '');
    assert.deepEqual(p.mustDo, []);
  } finally {
    store.close();
  }
});

test('陪伴设置：称呼、桌宠名、性格、免打扰；不合法的会被拒绝', () => {
  const store = new Store();
  try {
    assert.equal(store.companion().petName, '日历小助手');
    assert.equal(store.companion().personality, 'lively');
    const c = store.saveCompanion({ nickname: '石头', personality: 'quiet', quietStart: '23:00', quietEnd: '7:00', showPet: false });
    assert.equal(c.nickname, '石头');
    assert.equal(c.quietEnd, '07:00');
    assert.equal(c.showPet, false);
    assert.equal(store.saveCompanion({ petName: '' }).petName, '日历小助手');
    assert.equal(store.saveCompanion({ quietStart: '' }).quietStart, '');
    assert.throws(() => store.saveCompanion({ personality: 'grumpy' }), /活泼或安静/);
    assert.throws(() => store.saveCompanion({ quietStart: '半夜' }), /时:分/);
    assert.equal(store.companion().nickname, '石头');
  } finally {
    store.close();
  }
});

test('引导完成标记', () => {
  const store = new Store();
  try {
    assert.equal(store.onboarding().done, false);
    const done = store.saveOnboarding({ done: true });
    assert.equal(done.done, true);
    assert.ok(done.at);
    assert.equal(store.saveOnboarding({ done: false }).done, false);
  } finally {
    store.close();
  }
});
