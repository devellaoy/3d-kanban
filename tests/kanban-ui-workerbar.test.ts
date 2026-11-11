// The kanban page's bar of plain workers, without the DOM (src/client/kanban/workerbarmodel.ts): who
// gets a tab, in what order, the tab's tooltip, and when the bar has tabs, points elsewhere or hides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { barState, barWorkers, isPlainWorker, tabTitle } from '../src/client/kanban/workerbarmodel.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const DESK = 'desk-1';
const w = (id: string, o: Partial<WorkerInfo> = {}) => ({ id, kind: 'agent', deskId: DESK, name: id, createdAt: 1, ...o }) as WorkerInfo;

test('isPlainWorker: a shell and a plain agent are in; a task worker, a board agent and a meeting agent are out', () => {
  assert.equal(isPlainWorker(w('a')), true);
  assert.equal(isPlainWorker(w('s', { kind: 'shell' })), true);
  assert.equal(isPlainWorker(w('impl', { kanban: { taskId: 3 } as WorkerInfo['kanban'] })), false);
  assert.equal(isPlainWorker(w('rev', { kanban: { taskId: 3, role: 'reviewer' } as unknown as WorkerInfo['kanban'] })), false);
  assert.equal(isPlainWorker(w('kiosk', { deskId: 'station-issues' })), false);
  assert.equal(isPlainWorker(w('m', { meeting: 'room-1' })), false);
});

test('barWorkers: only the plain ones, oldest first, ties by id, whatever the input order', () => {
  const list = [w('c', { createdAt: 5 }), w('b', { createdAt: 2 }), w('a', { createdAt: 2 }), w('t', { createdAt: 1, kanban: { taskId: 1 } as WorkerInfo['kanban'] })];
  assert.deepEqual(barWorkers(list).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(barWorkers(new Map(list.map((x) => [x.id, x])).values()).map((x) => x.id), ['a', 'b', 'c']);
});

test('tabTitle: the name, its work when it has one, 🐚 shell for a shell', () => {
  assert.equal(tabTitle(w('Ada')), 'Ada');
  assert.equal(tabTitle(w('Ada', { title: 'Fix login' })), 'Ada · Fix login');
  assert.equal(tabTitle(w('Ada', { task: { name: 'Card', summary: '' }, title: 'Other' })), 'Ada · Card');
  assert.equal(tabTitle(w('Sh', { kind: 'shell' })), 'Sh · 🐚 shell');
});

test('barState: none on the roof, elsewhere when the picked project is not the page floor, else tabs', () => {
  assert.equal(barState('web', 'web', false), 'none');
  assert.equal(barState(null, null, false), 'none');
  assert.equal(barState('web', 'web', true), 'tabs');
  assert.equal(barState('api', 'web', true), 'elsewhere');
  assert.equal(barState(null, 'web', true), 'tabs');
});
