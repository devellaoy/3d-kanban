// A task's reviewer takes no desk: it stands behind its implementer's chair, watching over its
// shoulder (the seat's watch spot, see WATCH_SPOTS in shared/layout.ts), so a review round leaves every
// other desk free, and runs even when they're all taken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type Rule } from './kanban-engine-fixture.js';
import { DESK_BY_ID, SEATS, WATCH_SPOTS, watchSpotOf } from '../src/shared/layout.js';
import { OFFICE_PLAN, planOf } from '../src/shared/maps/index.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
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
