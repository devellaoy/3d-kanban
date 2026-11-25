// The worker tabs of a task worker's terminal window (src/client/kanban/tasktabs.ts): one per worker of
// the task, the implementer, the main reviewer, then the additional reviewers by seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSiblings, watchTaskSiblings, type TaskTabWorker } from '../src/client/kanban/tasktabs.js';

const impl: TaskTabWorker = { id: 'impl', name: 'Ada', kanban: { taskId: 14, role: 'implementer' }, tool: 'Claude' };
const main: TaskTabWorker = { id: 'rev', name: 'Bo', kanban: { taskId: 14, role: 'reviewer' }, tool: 'Claude' };
const second: TaskTabWorker = { id: 'rev2', name: 'Cy', kanban: { taskId: 14, role: 'reviewer', seat: 1 }, tool: 'Codex' };
const fourth: TaskTabWorker = { id: 'rev4', name: 'Di', kanban: { taskId: 14, role: 'reviewer', seat: 3 }, tool: 'Claude' };
const elsewhere: TaskTabWorker = { id: 'other', name: 'Eve', kanban: { taskId: 15, role: 'implementer' }, tool: 'Claude' };
const plain: TaskTabWorker = { id: 'shell', name: 'Fay' };

test('the tabs come in order: the implementer, the main reviewer, the additional reviewers by seat', () => {
  // Whatever order the office lists them in, and whoever's window it is.
  const workers = [fourth, plain, second, elsewhere, main, impl];
  for (const self of ['impl', 'rev', 'rev2', 'rev4']) {
    assert.deepEqual(
      taskSiblings(self, workers).map((s) => s.workerId),
      ['impl', 'rev', 'rev2', 'rev4'],
      self,
    );
  }
});

test('the implementer is "Terminal", the main reviewer "Reviewer · Tool", an additional one is numbered by its seat + 1', () => {
  assert.deepEqual(taskSiblings('impl', [impl, main, second, fourth]), [
    { workerId: 'impl', label: 'Terminal', title: 'Ada · implementer' },
    { workerId: 'rev', label: 'Reviewer · Claude', title: 'Bo · main reviewer' },
    { workerId: 'rev2', label: 'Reviewer 2 · Codex', title: 'Cy · reviewer 2' },
    { workerId: 'rev4', label: 'Reviewer 4 · Claude', title: 'Di · reviewer 4' },
  ]);
});

test('a reviewer without a seat, or with seat 0, is the main reviewer', () => {
  const zero: TaskTabWorker = { ...main, kanban: { taskId: 14, role: 'reviewer', seat: 0 } };
  for (const m of [main, zero]) {
    const tabs = taskSiblings('rev2', [second, m]);
    assert.deepEqual(tabs.map((s) => s.label), ['Reviewer · Claude', 'Reviewer 2 · Codex']);
    assert.equal(tabs[0].title, 'Bo · main reviewer');
  }
});

test('a reviewer whose tool is not known is just "Reviewer"', () => {
  assert.equal(taskSiblings('impl', [impl, { ...main, tool: undefined }])[1].label, 'Reviewer');
  assert.equal(taskSiblings('impl', [impl, { ...second, tool: undefined }])[1].label, 'Reviewer 2');
});

test('a task with one worker, a worker without a task and an unknown worker get no tabs', () => {
  assert.deepEqual(taskSiblings('impl', [impl, elsewhere, plain]), []);
  assert.deepEqual(taskSiblings('shell', [impl, main, plain]), []);
  assert.deepEqual(taskSiblings('gone', [impl, main]), []);
  // Another task's workers are not this one's.
  assert.deepEqual(taskSiblings('other', [impl, main, elsewhere]), []);
});

test('the tabs follow the workers while the window is open: a reviewer arrives and leaves', () => {
  let workers = [impl];
  const heard: (() => void)[] = [];
  const seen: string[][] = [];
  const stop = watchTaskSiblings(
    'impl',
    {
      workers: () => workers,
      onChange: (fn) => {
        heard.push(fn);
        return () => void heard.splice(heard.indexOf(fn), 1);
      },
    },
    (list) => seen.push(list.map((s) => s.label)),
  );
  assert.deepEqual(seen, [[]]);
  workers = [impl, main];
  heard.forEach((fn) => fn());
  // A worker's status changing fires the same topic: the row is not handed over again.
  heard.forEach((fn) => fn());
  workers = [impl, main, second];
  heard.forEach((fn) => fn());
  workers = [impl];
  heard.forEach((fn) => fn());
  assert.deepEqual(seen, [[], ['Terminal', 'Reviewer · Claude'], ['Terminal', 'Reviewer · Claude', 'Reviewer 2 · Codex'], []]);
  stop();
  assert.equal(heard.length, 0);
});
