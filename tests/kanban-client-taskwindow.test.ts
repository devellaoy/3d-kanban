// How a task opens on the kanban page: in its worker's window (Task tab, or Terminal when asked), else a task window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseGuard, planTaskWindow } from '../src/client/kanban/model.js';

test('a task with a worker opens in the worker window on the Task tab', () => {
  assert.deepEqual(planTaskWindow({ workerId: 'w1', project: 'api' }), { kind: 'worker', workerId: 'w1', project: 'api', tab: 'task' });
  assert.equal((planTaskWindow({ workerId: 'w1', project: 'api' }, 'plan') as { tab: string }).tab, 'task');
});

test('tab=terminal opens the worker window on its Terminal tab', () => {
  assert.equal((planTaskWindow({ workerId: 'w1', project: 'api' }, 'terminal') as { tab: string }).tab, 'terminal');
});

test('a task without a worker, or an unknown one, opens as a task window', () => {
  assert.deepEqual(planTaskWindow({ project: 'api' }, 'terminal'), { kind: 'plain' });
  assert.deepEqual(planTaskWindow(undefined), { kind: 'plain' });
});

const both = { workerId: 'impl', reviewerWorkerId: 'rev', project: 'api' };

test('the reviewer is the active worker during a review, the implementer otherwise', () => {
  for (const phase of ['review', 'pr-review']) {
    assert.equal((planTaskWindow({ ...both, phase }) as { workerId: string }).workerId, 'rev');
  }
  for (const phase of ['implement', 'plan', undefined]) {
    assert.equal((planTaskWindow({ ...both, phase }) as { workerId: string }).workerId, 'impl');
  }
  // A review without a reviewer at the desk stays with the implementer.
  assert.equal((planTaskWindow({ workerId: 'impl', phase: 'review', project: 'api' }) as { workerId: string }).workerId, 'impl');
});

test('a task with only a reviewer opens in the reviewer window', () => {
  assert.deepEqual(planTaskWindow({ reviewerWorkerId: 'rev', project: 'api' }), { kind: 'worker', workerId: 'rev', project: 'api', tab: 'task' });
});

test('tab=changes plans the worker, tab changes; without a worker it is a plain window', () => {
  assert.deepEqual(planTaskWindow({ workerId: 'w1', project: 'api' }, 'changes'), { kind: 'worker', workerId: 'w1', project: 'api', tab: 'changes' });
  assert.deepEqual(planTaskWindow({ project: 'api' }, 'changes'), { kind: 'plain' });
});

test('only the latest window of a task closing is the user closing the task', () => {
  const g = new CloseGuard();
  const worker = g.bump();
  assert.equal(g.latest(worker), true);
  // 🌿 Changes: the transition begins, the terminal closes after it.
  const changes = g.bump();
  assert.equal(g.latest(worker), false);
  // ⌨️ Terminal: back to the worker's window; the Changes window closes after.
  const worker2 = g.bump();
  assert.equal(g.latest(changes), false);
  assert.equal(g.latest(worker2), true);
  // The user closes it.
  assert.equal(g.latest(worker2), true);
});

test('a task that ended hears nothing from its windows', () => {
  const g = new CloseGuard();
  const w = g.bump();
  g.end();
  assert.equal(g.latest(w), false);
});
