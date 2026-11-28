import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';

// 必做事项不能手动降级为普通通知；普通通知仍可升为必做
test('必做事项手动保存为普通通知会被拒绝，其余字段照常可改', () => {
  const store = new Store();
  try {
    const created = store.manualTask({ title: '交实验报告', obligation: 'required', status: 'pending' });
    assert.equal(created.obligation, 'required');

    assert.throws(
      () => store.manualTask({ revision: created.revision, obligation: 'optional' }, created.id),
      /必做事项不能手动降级/
    );
    assert.equal(store.task(created.id).obligation, 'required');

    const edited = store.manualTask({ revision: created.revision, title: '交实验报告（第 6 次）', status: 'done' }, created.id);
    assert.equal(edited.obligation, 'required');
    assert.equal(edited.status, 'done');
  } finally {
    store.close();
  }
});

test('普通通知可以升为必做，升了之后就降不回去', () => {
  const store = new Store();
  try {
    const notice = store.manualTask({ title: '讲座签到', obligation: 'optional', status: 'pending' });
    assert.equal(notice.obligation, 'optional');

    const promoted = store.manualTask({ revision: notice.revision, obligation: 'required' }, notice.id);
    assert.equal(promoted.obligation, 'required');

    assert.throws(
      () => store.manualTask({ revision: promoted.revision, obligation: 'optional' }, promoted.id),
      /必做事项不能手动降级/
    );
  } finally {
    store.close();
  }
});

test('新建时选普通通知不算降级', () => {
  const store = new Store();
  try {
    const task = store.manualTask({ title: '社团招新', obligation: 'optional' });
    assert.equal(task.obligation, 'optional');
  } finally {
    store.close();
  }
});
