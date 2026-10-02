// The lounge figures' pure side in the 3D office (src/client/kanban/loungemodel.ts): where each goes,
// what changes between two lists, and what the hint and the overflow sign say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLounge, layoutLounge, loungeHint, overflowText } from '../src/client/kanban/loungemodel.js';
import type { LoungeFigure } from '../src/shared/kanban/lounge.js';

const fig = (taskId: number, over: Partial<LoungeFigure> = {}): LoungeFigure => ({ taskId, title: `Task ${taskId}`, name: 'Ada', color: '#ff0000', at: taskId * 10, ...over });
const shownOf = (figures: LoungeFigure[]) => new Map(layoutLounge(figures).placed.map((p) => [p.figure.taskId, p.key]));

test('the oldest hold takes the first place: the beanbags, then the couch ends, then standing', () => {
  const { placed, overflow } = layoutLounge([fig(3, { at: 5 }), fig(1, { at: 50 }), fig(2, { at: 5 })]);
  assert.deepEqual(
    placed.map((p) => p.figure.taskId),
    [2, 3, 1],
  );
  assert.deepEqual(placed[0].place, { kind: 'seat', seatId: 'lounge-beanbag-1', place: 0 });
  assert.equal(overflow, 0);
  const many = layoutLounge(Array.from({ length: 13 }, (_, i) => fig(i + 1)));
  assert.equal(many.placed.length, 12);
  assert.equal(many.overflow, 1);
  assert.equal(many.placed[4].place.kind, 'stand');
  assert.ok(!many.placed.some((p) => p.place.kind === 'seat' && p.place.seatId === 'couch' && p.place.place === 1), 'the couch middle stays free');
});

test('nothing changes: nothing is dropped or made', () => {
  const figures = [fig(1), fig(2)];
  assert.deepEqual(diffLounge(shownOf(figures), layoutLounge(figures).placed), { drop: [], make: [] });
});

test('one comes and one goes: only those', () => {
  const next = layoutLounge([fig(1), fig(3)]).placed;
  const { drop, make } = diffLounge(shownOf([fig(1), fig(2)]), next);
  assert.deepEqual(drop, [2]);
  assert.deepEqual(
    make.map((p) => p.figure.taskId),
    [3],
  );
});

test('a changed note or a moved place makes the figure again', () => {
  const was = shownOf([fig(1), fig(2)]);
  assert.deepEqual(diffLounge(was, layoutLounge([fig(1), fig(2, { note: 'keys' })]).placed).drop, [2]);
  // 1 goes: 2 moves up to the first beanbag.
  const { drop, make } = diffLounge(was, layoutLounge([fig(2)]).placed);
  assert.deepEqual(drop.sort(), [1, 2]);
  assert.deepEqual(
    make.map((p) => p.figure.taskId),
    [2],
  );
});

test('the hint: task, title, reason and date', () => {
  const until = new Date(2026, 10, 15).getTime();
  assert.equal(loungeHint(fig(14, { title: 'Fix it', note: 'waiting for the API keys', until }), new Date(2026, 9, 1).getTime()), '⏸️ #14 Fix it — waiting for the API keys · until 15.11.');
  assert.equal(loungeHint(fig(14, { title: 'Fix it', until }), new Date(2026, 10, 20).getTime()), '⏸️ #14 Fix it · until 15.11. (passed)');
  assert.equal(loungeHint(fig(7, { title: 'x'.repeat(80) }), 0), `⏸️ #7 ${'x'.repeat(47)}…`);
});

test('the overflow sign', () => {
  assert.equal(overflowText(3), '⏸️ +3 more on hold');
});
