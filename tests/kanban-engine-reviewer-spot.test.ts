// A task's reviewer takes no desk: it stands behind its implementer's chair, watching over its
// shoulder (the seat's watch spot, see WATCH_SPOTS in shared/layout.ts), so a review round leaves every
// other desk free, and runs even when they're all taken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { DESK_BY_ID, SEATS, WATCH_SPOTS, watchSpotOf } from '../src/shared/layout.js';
import { OFFICE_PLAN, planOf } from '../src/shared/maps/index.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const SENT = { by: 'Ada', reason: 'sent-home' as const };
const MANUAL: Rule = { when: 'This is review round', reply: 'Good.\nREVIEW: APPROVED' };

/** The task's status lines, as its conversation shows them. */
const notes = (fx: EngineFixture, id: number) =>
  fx.repo
    .listComments(id)
    .comments.filter((c) => c.kind === 'status')
    .map((c) => c.text);

/** A shell worker at `desk` (someone else's), its id. */
const shell = (fx: EngineFixture, desk: string) => {
  const w = fx.workers.spawn(desk, 'test', undefined, false, 'shell');
  assert.equal(typeof w, 'object', String(w));
  return (w as { id: string }).id;
};

/** A task implemented without review, waiting in the Review column with its implementer at its desk. */
async function implemented(fx: EngineFixture) {
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 30_000);
}

/** Where the reviewer of a review round run by hand stood (its run's worker's desk, while it ran). */
async function reviewedFrom(fx: EngineFixture, taskId: number): Promise<string> {
  assert.equal(await fx.engine.review(taskId, ADA), undefined);
  const x = await fx.waitTask(taskId, (y) => !!y.reviewerWorkerId, 'its reviewer hired', 30_000);
  const desk = fx.workers.get(x.reviewerWorkerId!)!.deskId;
  await fx.waitTask(taskId, (y) => y.status === 'review' && y.runState === 'idle' && !y.reviewerWorkerId, 'the review done', 30_000);
  return desk;
}

const REVIEW: Rule = { when: 'This is review round 1 of', reply: 'Good.\nREVIEW: APPROVED', delayMs: 1500 };

test('the reviewer stands behind its implementer, at no desk of its own, and goes home from there', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, REVIEW]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);

  const x = await fx.waitTask(task.id, (y) => !!y.reviewerWorkerId && y.runState === 'running', 'its reviewer hired', 30_000);
  const implementer = fx.workers.get(x.workerId!)!;
  const reviewer = fx.workers.get(x.reviewerWorkerId!)!;
  assert.equal(reviewer.deskId, watchSpotOf(implementer.deskId), 'behind the implementer');
  assert.equal(DESK_BY_ID.get(reviewer.deskId)?.watch, implementer.deskId);
  assert.equal(x.deskId, implementer.deskId, "the task's desk stays the implementer's");
  assert.deepEqual(
    SEATS.filter((d) => fx.workers.deskOccupied(d.id)).map((d) => d.id),
    [implementer.deskId],
    'the review takes no seat',
  );

  const done = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.reviewerWorkerId, undefined, 'the reviewer went home');
  assert.ok(!fx.workers.deskOccupied(watchSpotOf(implementer.deskId)), 'the spot behind the chair is free again');
});

test('with every other desk taken, the review still runs, behind the implementer', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, { ...REVIEW, delayMs: 0 }]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const running = await fx.waitTask(task.id, (y) => !!y.workerId, 'its implementer hired');
  // Every seat is taken from here on (the implementer's is, by it); the spots behind them aren't.
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  fx.workers.deskOccupied = (id: string) => !DESK_BY_ID.get(id)?.watch || occupied(id);

  const done = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 30_000);
  assert.ok(!fx.history(task.id).some((s) => s.task.queuedRun?.role === 'reviewer'), 'the review never waited for a desk');
  const review = fx.repo.listRuns(task.id).find((r) => r.phase === 'review')!;
  assert.equal(review.verdict, 'approved');
  assert.ok(running.workerId);
  assert.equal(done.workerId, running.workerId);
});

test('nobody but a task reviewer is hired at a spot behind a seat', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const spot = watchSpotOf('desk-2');
  assert.match(String(fx.workers.spawn(spot, 'Ada', undefined, false, 'shell')), /reviewer/);
  assert.match(String(fx.workers.spawn(spot, 'Ada', 'hi', false, 'agent', 'claude')), /reviewer/);
  assert.ok(!fx.workers.deskOccupied(spot));
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.match(String(await fx.engine.start(task.id, ADA, { deskId: spot })), /isn't a desk/);
  assert.equal(fx.task(task.id).status, 'todo');
});

test('every seat has a spot behind it, on every map, where the seat is', () => {
  assert.equal(WATCH_SPOTS.length, SEATS.length);
  for (const plan of [OFFICE_PLAN, planOf('castle')]) {
    for (const d of [...plan.desks, ...plan.overflow]) {
      const spot = plan.byId.get(watchSpotOf(d.id));
      assert.ok(spot, `${plan.id}: behind ${d.id}`);
      assert.equal(spot.watch, d.id);
      assert.deepEqual([spot.x, spot.z, spot.rotY, spot.wing], [d.x, d.z, d.rotY, d.wing]);
    }
  }
});

test("with its implementer gone, the reviewer stands behind the task's desk only while nobody else sits there", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, MANUAL]);
  const x = await implemented(fx);
  const desk = x.deskId!;
  await fx.workers.kill(x.workerId!, 'keep', undefined, undefined, SENT);
  await fx.waitTask(x.id, (y) => !y.workerId, 'its implementer gone');

  // Its desk is free: behind it, where the implementer comes back for the fixes.
  assert.equal(await reviewedFrom(fx, x.id), watchSpotOf(desk));

  // Someone else sits there now: not behind them, but at a seat of its own.
  shell(fx, desk);
  const from = await reviewedFrom(fx, x.id);
  assert.notEqual(from, watchSpotOf(desk), "never behind another's worker");
  assert.ok(!DESK_BY_ID.get(from)?.watch, 'at a seat');
});

test("with the spot behind its implementer taken, the reviewer takes the next free seat, and the task says so", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, MANUAL]);
  const x = await implemented(fx);
  const spot = watchSpotOf(x.deskId!);
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  fx.workers.deskOccupied = (id: string) => id === spot || occupied(id);

  const from = await reviewedFrom(fx, x.id);
  assert.ok(SEATS.some((d) => d.id === from) && from !== x.deskId, `at a free seat, not ${from}`);
  const said = `${DESK_BY_ID.get(spot)!.label} is taken, so `;
  assert.ok(notes(fx, x.id).some((n) => n.startsWith(said) && n.endsWith(`sits at ${DESK_BY_ID.get(from)!.label}.`)), notes(fx, x.id).join('\n'));
});

test('a queued review round starts behind its implementer once the spot frees, with every seat still taken', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, MANUAL]);
  const x = await implemented(fx);
  const spot = watchSpotOf(x.deskId!);
  const other = shell(fx, SEATS.find((d) => !fx.workers.deskOccupied(d.id))!.id);
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  // Every seat taken, and the spot behind the implementer too: the round waits, queued.
  let spotTaken = true;
  fx.workers.deskOccupied = (id: string) => (DESK_BY_ID.get(id)?.watch ? spotTaken && id === spot : true) || occupied(id);
  assert.equal(await fx.engine.review(x.id, ADA), undefined);
  let y = fx.task(x.id);
  assert.ok(notes(fx, x.id).some((n) => /^Queued: there's no free desk on the floor/.test(n)));
  assert.equal(y.runState, 'queued');
  assert.equal(y.queuedRun?.role, 'reviewer');

  // The spot frees (the seats don't): a worker going home drains the queue, and the round starts there.
  spotTaken = false;
  await fx.workers.kill(other, 'keep');
  y = await fx.waitTask(x.id, (z) => !!z.reviewerWorkerId, 'its reviewer hired from the queue', 30_000);
  assert.equal(fx.workers.get(y.reviewerWorkerId!)!.deskId, spot);
  await fx.waitTask(x.id, (z) => z.status === 'review' && z.runState === 'idle', 'the review done', 30_000);
});
