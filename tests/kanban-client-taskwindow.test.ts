// How a task opens on the kanban page: in its worker's window (Task tab, or Terminal when asked), else a task window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTaskWindow } from '../src/client/kanban/model.js';

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
