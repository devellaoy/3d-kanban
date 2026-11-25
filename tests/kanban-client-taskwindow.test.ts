// How a task opens on the kanban page: in its worker's window (Task tab, or Terminal when asked), else a task window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseGuard, planAfterWorkerGone, planTaskWindow, workerWindowClosed } from '../src/client/kanban/model.js';

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

test('the worker of the window going home leaves the task open: the other worker, else a task window', () => {
  const reviewing = { workerId: 'impl', reviewerWorkerId: 'rev', phase: 'review', project: 'api' };
  assert.deepEqual(planAfterWorkerGone(reviewing, 'rev', 'conversation'), { kind: 'worker', workerId: 'impl', project: 'api', tab: 'task' });
  // Its Terminal or Changes was the gone worker's: the next one opens on its Task tab.
  assert.equal((planAfterWorkerGone(reviewing, 'rev', 'terminal') as { tab: string }).tab, 'task');
  assert.deepEqual(planAfterWorkerGone({ workerId: 'impl', project: 'api' }, 'impl'), { kind: 'plain' });
  assert.deepEqual(planAfterWorkerGone(undefined, 'impl'), { kind: 'plain' });
});

test('an additional reviewer going home hands the task to the main reviewer while it is there, else to the implementer', () => {
  // The card's coReviewers may or may not still list the one that left: neither the implementer nor the main reviewer is what tells.
  const round = { workerId: 'impl', reviewerWorkerId: 'rev', project: 'api' };
  for (const phase of ['review', 'pr-review', 'fix', 'implement', undefined]) {
    assert.deepEqual(planAfterWorkerGone({ ...round, phase }, 'rev2', 'conversation'), { kind: 'worker', workerId: 'rev', project: 'api', tab: 'task' }, String(phase));
  }
  // The main reviewer has gone already: the implementer.
  assert.deepEqual(planAfterWorkerGone({ workerId: 'impl', phase: 'review', project: 'api' }, 'rev2'), { kind: 'worker', workerId: 'impl', project: 'api', tab: 'task' });
  // Only the main reviewer is left, or nobody.
  assert.deepEqual(planAfterWorkerGone({ reviewerWorkerId: 'rev', phase: 'review', project: 'api' }, 'rev2', 'terminal'), { kind: 'worker', workerId: 'rev', project: 'api', tab: 'task' });
  assert.deepEqual(planAfterWorkerGone({ phase: 'review', project: 'api' }, 'rev2'), { kind: 'plain' });
  // The main reviewer and the implementer going home are as before.
  assert.equal((planAfterWorkerGone({ ...round, phase: 'review' }, 'rev') as { workerId: string }).workerId, 'impl');
  assert.equal((planAfterWorkerGone({ ...round, phase: 'implement' }, 'impl') as { workerId: string }).workerId, 'rev');
});

test('a worker window closing: the user closes the task, a worker gone hands it over, a switch to another worker tab leaves it be', () => {
  assert.equal(workerWindowClosed('user'), 'close');
  assert.equal(workerWindowClosed('gone'), 'handover');
  // The other worker's window is open already and is the task's now (ui/terminal.ts closes the old one after).
  assert.equal(workerWindowClosed('switch'), 'keep');
});

test('a switch between worker windows takes a generation: the old window closing after it says nothing', () => {
  const g = new CloseGuard();
  const reviewer = g.bump();
  // A worker tab: the additional reviewer's window opens, the reviewer's closes after it.
  const second = g.bump();
  assert.equal(g.latest(reviewer), false, 'neither its close nor its worker leaving counts any more');
  assert.equal(g.latest(second), true);
});
