// The shared contract of a task on hold (#61): the note and date of a move, how a hold reads in a
// line, and where the lounge figures sit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_NOTE_MAX, HOLD_UNTIL_MAX_MS, holdLine, validHoldUntil, type TaskHold } from '../src/shared/kanban/hold.js';
import { LOUNGE_SEATED, loungePlaces, loungeReservedPlaces, sortFigures } from '../src/shared/kanban/lounge.js';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';
import { FLOOR, SEATING_BY_ID } from '../src/shared/layout.js';
import type { KanbanTask } from '../src/shared/kanban/types.js';
import { DEPARTURE_REASONS } from '../src/shared/kanban/types.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date(2026, 9, 2, 12).getTime();
const move = (extra: Record<string, unknown>, to = 'on_hold') => parseKanbanClientMsg({ t: 'kanban.task.move', id: 1, to, ...extra });

test('the hold is on the task type and the departure reasons know it', () => {
  const hold: TaskHold = { at: now, by: 'Ada', from: 'review' };
  const task = { hold } as Pick<KanbanTask, 'hold'>;
  assert.equal(task.hold?.from, 'review');
  assert.ok(DEPARTURE_REASONS.includes('hold'));
});

test('validHoldUntil: a whole number of ms, from yesterday to two years ahead', () => {
  assert.equal(validHoldUntil(now + DAY, now), true);
  assert.equal(validHoldUntil(now - DAY / 2, now), true);
  assert.equal(validHoldUntil(now - DAY, now), false);
  assert.equal(validHoldUntil(now + HOLD_UNTIL_MAX_MS, now), true);
  assert.equal(validHoldUntil(now + HOLD_UNTIL_MAX_MS + 1, now), false);
  for (const v of [NaN, Infinity, 1.5 + now, '123', null, undefined]) assert.equal(validHoldUntil(v, now), false, String(v));
});

test('holdLine: the reason and the date, and "(passed)" when it has', () => {
  const hold: TaskHold = { at: now, by: 'Ada', from: 'waiting' };
  assert.equal(holdLine(hold, now), '⏸️ on hold');
  assert.equal(holdLine({ ...hold, note: "waiting for the customer's API keys" }, now), "⏸️ waiting for the customer's API keys");
  const until = new Date(2026, 10, 15).getTime();
  assert.equal(holdLine({ ...hold, note: 'keys', until }, now), '⏸️ keys · until 15.11.');
  assert.equal(holdLine({ ...hold, until }, now), '⏸️ on hold · until 15.11.');
  assert.equal(holdLine({ ...hold, note: 'keys', until }, until + DAY), '⏸️ keys · until 15.11. (passed)');
});

test('a move carries a note and a date only where they mean something', () => {
  const until = Date.now() + 5 * DAY;
  assert.deepEqual(move({ note: '  keys  ', until }), { t: 'kanban.task.move', id: 1, to: 'on_hold', note: 'keys', until });
  assert.deepEqual(move({ note: '   ' }), { t: 'kanban.task.move', id: 1, to: 'on_hold' });
  assert.deepEqual(move({}), { t: 'kanban.task.move', id: 1, to: 'on_hold' });
  // A message for the agent on a resume.
  assert.deepEqual(move({ note: 'keys are in' }, 'in_progress'), { t: 'kanban.task.move', id: 1, to: 'in_progress', note: 'keys are in' });
  assert.deepEqual(move({ note: 'x'.repeat(HOLD_NOTE_MAX) }), { t: 'kanban.task.move', id: 1, to: 'on_hold', note: 'x'.repeat(HOLD_NOTE_MAX) });
  assert.match(String(move({ note: 'x'.repeat(HOLD_NOTE_MAX + 1) })), /too long/);
  assert.match(String(move({ note: 5 })), /must be text/);
  assert.match(String(move({ note: 'x' }, 'done')), /note goes only/);
  assert.match(String(move({ until }, 'in_progress')), /date goes only/);
  assert.match(String(move({ until: Date.now() - 3 * DAY })), /date/);
  assert.match(String(move({ until: 'soon' })), /date/);
  assert.match(String(move({ until: Date.now() + HOLD_UNTIL_MAX_MS * 2 })), /date/);
});

test('loungePlaces: four seat (never the couch middle), eight stand, the rest overflow', () => {
  assert.deepEqual(loungePlaces(0), { placed: [], overflow: 0 });
  assert.deepEqual(loungePlaces(1), { placed: [{ kind: 'seat', seatId: 'lounge-beanbag-1', place: 0 }], overflow: 0 });
  const four = loungePlaces(LOUNGE_SEATED);
  assert.deepEqual(four.placed, [
    { kind: 'seat', seatId: 'lounge-beanbag-1', place: 0 },
    { kind: 'seat', seatId: 'lounge-beanbag-2', place: 0 },
    { kind: 'seat', seatId: 'couch', place: 0 },
    { kind: 'seat', seatId: 'couch', place: 2 },
  ]);
  assert.deepEqual(loungeReservedPlaces(4), ['lounge-beanbag-1:0', 'lounge-beanbag-2:0', 'couch:0', 'couch:2']);
  assert.deepEqual(loungeReservedPlaces(2), ['lounge-beanbag-1:0', 'lounge-beanbag-2:0']);
  assert.equal(loungePlaces(5).placed[4].kind, 'stand');
  assert.equal(loungePlaces(12).placed.filter((p) => p.kind === 'stand').length, 8);
  assert.equal(loungePlaces(12).overflow, 0);
  assert.equal(loungePlaces(13).placed.length, 12);
  assert.equal(loungePlaces(13).overflow, 1);
  for (let n = 0; n <= 14; n++) {
    const { placed } = loungePlaces(n);
    assert.ok(!placed.some((p) => p.kind === 'seat' && p.seatId === 'couch' && p.place === 1), `${n}: couch middle`);
    assert.equal(new Set(placed.map((p) => JSON.stringify(p))).size, placed.length, `${n}: distinct`);
    for (const p of placed) {
      if (p.kind === 'seat') assert.ok(p.place < SEATING_BY_ID.get(p.seatId)!.places.length);
      else {
        assert.ok(p.x > 8.9 && p.x < 9.5 && Math.abs(p.z) <= 2.8 && p.x > FLOOR.minX && p.x < FLOOR.maxX, `${n}: ${JSON.stringify(p)}`);
        assert.equal(p.rotY, Math.PI / 2);
      }
    }
  }
});

test('sortFigures: oldest first, ties by task', () => {
  const f = (taskId: number, at: number) => ({ taskId, at });
  assert.deepEqual(sortFigures([f(3, 20), f(2, 10), f(1, 20), f(4, 5)]).map((x) => x.taskId), [4, 2, 1, 3]);
});
