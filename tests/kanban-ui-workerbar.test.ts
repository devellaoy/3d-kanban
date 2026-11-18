// The kanban page's bar of plain workers, without the DOM (src/client/kanban/workerbarmodel.ts): who
// gets a tab, in what order, the tab's name and tooltip, and when the bar has tabs, points elsewhere or hides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { barRooms, barState, barWorkers, isPlainWorker, tabName, tabTitle } from '../src/client/kanban/workerbarmodel.js';
import { everyRoomRunning } from '../src/shared/meetings.js';
import type { Meeting, MeetingState, WorkerInfo } from '../src/shared/protocol.js';

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

test('barWorkers: a meeting worker a room tab covers is out, one nothing covers is a plain tab, a kanban one is never in', () => {
  const list = [w('a', { createdAt: 1 }), w('m1', { createdAt: 2, meeting: 'room-1' }), w('m2', { createdAt: 3, meeting: 'room-1' }), w('t', { createdAt: 4, meeting: 'room-1', kanban: { taskId: 1 } as WorkerInfo['kanban'] }), w('k', { createdAt: 5, meeting: 'room-1', deskId: 'station-issues' })];
  assert.deepEqual(barWorkers(list).map((x) => x.id), ['a', 'm1', 'm2']);
  assert.deepEqual(barWorkers(list, new Set(['m1'])).map((x) => x.id), ['a', 'm2']);
  assert.deepEqual(barWorkers(list, new Set(['m1', 'm2'])).map((x) => x.id), ['a']);
});

const meeting = (title: string, status: Meeting['status'], ...ids: (string | undefined)[]) => ({ title, status, seats: ids.map((workerId) => ({ role: 'r', deskId: 'chair', workerId })) }) as unknown as Meeting;
const rooms = (...r: [string, Meeting | null][]) => ({ rooms: r.map(([id, current]) => ({ id, label: `Room ${id}`, current })) }) as Pick<MeetingState, 'rooms'>;
const map = (...ws: WorkerInfo[]) => new Map(ws.map((x) => [x.id, x]));

test('barRooms: no tab for an empty room or one whose workers are all gone; the rest in room order with status and workers', () => {
  const ws = map(w('a'), w('b'), w('c'));
  const state = rooms(['1', meeting('Debate', 'running', 'a', 'x', 'b')], ['2', null], ['3', meeting('Old', 'done', 'gone')], ['4', meeting('Review', 'done', 'c')], ['5', meeting('Halted', 'stopped', undefined, 'b')]);
  assert.deepEqual(barRooms(state, ws), [
    { id: '1', label: 'Room 1', title: 'Debate', status: 'running', workers: ['a', 'b'], needsInput: false },
    { id: '4', label: 'Room 4', title: 'Review', status: 'done', workers: ['c'], needsInput: false },
    { id: '5', label: 'Room 5', title: 'Halted', status: 'stopped', workers: ['b'], needsInput: false },
  ]);
});

test('barRooms: needsInput follows a worker\'s shown status, and a room the map does not have still shows', () => {
  const state = rooms(['room-x', meeting('T', 'running', 'a', 'b')]);
  assert.equal(barRooms(state, map(w('a', { status: 'working' }), w('b', { status: 'needs_input' })))[0].needsInput, true);
  assert.equal(barRooms(state, map(w('a', { status: 'working' }), w('b', { status: 'idle' })))[0].needsInput, false);
  assert.deepEqual(barRooms(state, map(w('a'))).map((r) => r.id), ['room-x']);
});

test('tabTitle: the name, its work when it has one, shell for a shell', () => {
  assert.equal(tabTitle(w('Ada')), 'Ada');
  assert.equal(tabTitle(w('Ada', { title: 'Fix login' })), 'Ada · Fix login');
  assert.equal(tabTitle(w('Ada', { task: { name: 'Card', summary: '' }, title: 'Other' })), 'Ada · Card');
  assert.equal(tabTitle(w('Sh', { kind: 'shell' })), 'Sh · shell');
});

test('tabName: what the worker is on as the 3D office names it, else its own name, at most 20 characters ending in "..."', () => {
  const on = (name: string) => w('Ada', { task: { name, summary: '' } });
  assert.equal(tabName(w('Ada')), 'Ada');
  assert.equal(tabName(on('Card')), 'Card');
  assert.equal(tabName(on('')), 'Ada');
  // The 3D office shows no title over a worker: neither does the tab.
  assert.equal(tabName(w('Ada', { title: 'Other' })), 'Ada');
  // Exactly 20 fits; one more is cut to 17 and "...".
  assert.equal(tabName(on('12345678901234567890')), '12345678901234567890');
  assert.equal(tabName(on('123456789012345678901')), '12345678901234567...');
  assert.equal(tabName(on('Fix the login page  redirect\nloop')), 'Fix the login pag...');
  assert.equal(tabName(w('A-very-long-worker-name-indeed')), 'A-very-long-worke...');
  // No space before the dots, and an emoji is never cut in half.
  assert.equal(tabName(on('Refactor the big auth module')), 'Refactor the big...');
  assert.equal(tabName(on('😀'.repeat(21))), `${'😀'.repeat(17)}...`);
});

test('barState: none on the roof, elsewhere when the picked project is not the page floor, else tabs', () => {
  assert.equal(barState('web', 'web', false), 'none');
  assert.equal(barState(null, null, false), 'none');
  assert.equal(barState('web', 'web', true), 'tabs');
  assert.equal(barState('api', 'web', true), 'elsewhere');
  assert.equal(barState(null, 'web', true), 'tabs');
});

test('everyRoomRunning: New meeting has a free room unless every room is in a meeting', () => {
  assert.equal(everyRoomRunning(rooms(['a', null])), false);
  assert.equal(everyRoomRunning(rooms(['a', meeting('m', 'running', 'x')], ['b', meeting('n', 'stopped', 'y')])), false);
  assert.equal(everyRoomRunning(rooms(['a', meeting('m', 'running', 'x')], ['b', meeting('n', 'done', 'y')])), false);
  assert.equal(everyRoomRunning(rooms(['a', meeting('m', 'running', 'x')], ['b', meeting('n', 'running', 'y')])), true);
});
