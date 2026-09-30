// The kanban and the 3D office as one world (docs/kanban-coupling.md, "Task events → 3D"): a task
// that can't get a desk, or finds the office's worker limit full, is queued and starts when there's
// room, as its creator's account, at its own desk when that's free; and a task never hires on the
// office's sign-in for an account that isn't signed in to Claude.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { DESKS } from '../src/shared/layout.js';
import type { Capacity } from '../src/server/machine.js';
import type { RunAs } from '../src/server/workers.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const NOT_SIGNED_IN = "You aren't signed in to Claude: sign in under ☰ → 🔐 Your sign-ins";

/** An office worker limit the test sets, over the fixture's workers. */
function limitOf(get: () => EngineFixture | undefined) {
  const state = { limit: Infinity };
  const capacity: Capacity = {
    full: () => ((get()?.workers.list().length ?? 0) >= state.limit ? `The office is at its limit of ${state.limit} worker${state.limit === 1 ? '' : 's'} on this machine — send one home before hiring another` : undefined),
    room: () => state.limit - (get()?.workers.list().length ?? 0),
  };
  return { state, capacity };
}

/** Accounts signed in to Claude, as upstream's RunAs sees them. */
function signIns(ready: Set<string>): RunAs {
  return { claudeReady: (o) => ready.has(o), why: () => NOT_SIGNED_IN, apply: (_o, env) => env };
}

const notes = (fx: EngineFixture, id: number) =>
  fx.repo
    .listComments(id)
    .comments.filter((c) => c.kind === 'status')
    .map((c) => c.text);

const shell = (fx: EngineFixture, desk: string) => {
  const w = fx.workers.spawn(desk, 'test', undefined, false, 'shell');
  assert.equal(typeof w, 'object', String(w));
  return (w as { id: string }).id;
};

test('a full worker limit queues the start; a worker going home drains it as its creator, at its desk or the next free one', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity, runAs: signIns(new Set(['acct-ada'])) });
  t.after(() => fx!.close());
  fx.setRules([IMPLEMENT]);
  const [d0, d1] = [DESKS[0].id, DESKS[1].id];

  state.limit = 1;
  const a = shell(fx, d0);
  const task = fx.newTask({ usePlan: false, useReview: false, createdByAccount: 'acct-ada' });
  assert.equal(await fx.engine.start(task.id, ADA, { deskId: d1 }), undefined);
  const queued = fx.task(task.id);
  assert.equal(queued.status, 'in_progress');
  assert.equal(queued.runState, 'queued');
  assert.equal(queued.deskId, d1, 'the queued start keeps its desk');
  assert.deepEqual(queued.queuedRun, { phase: 'implement', role: 'implementer', prompt: 'implement' });
  assert.ok(notes(fx, task.id).some((n) => /^Queued: The office is at its limit of 1 worker/.test(n)), notes(fx, task.id).join('\n'));
  assert.equal(fx.ctx.repo.listRuns(task.id).length, 0, 'no run until it has a worker');
  assert.equal(fx.workers.list().length, 1);

  // Its desk is taken meanwhile; then a worker goes home, and the office has room.
  state.limit = 2;
  shell(fx, d1);
  await fx.workers.kill(a);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.queuedRun, undefined);
  const worker = fx.workers.get(done.workerId!)!;
  assert.equal(worker.deskId, d0, 'the next free desk');
  assert.equal(done.deskId, d0, 'where it sits now is its desk');
  assert.equal(fx.workers.ownerOf(worker.id), 'acct-ada', "its creator's account, not the office's");
  assert.ok(notes(fx, task.id).some((n) => n === `${DESKS[1].label} is taken, so ${worker.name} sits at ${DESKS[0].label}.`), notes(fx, task.id).join('\n'));
});

test('no free desk queues a start and a phase hire; each starts as it was once a desk frees', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 1500 }, { when: 'This is review round 1 of', reply: 'Good.\nREVIEW: APPROVED' }]);
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  let full = true;
  fx.workers.deskOccupied = (id: string) => full || occupied(id);
  const freeAgain = async () => {
    full = false;
    // A worker going home is what tells the engine a desk freed.
    await fx.workers.kill(shell(fx, DESKS[5].id));
  };

  const task = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  let x = fx.task(task.id);
  assert.equal(x.runState, 'queued');
  assert.ok(notes(fx, task.id).some((n) => /^Queued: there's no free desk on the floor/.test(n)));
  await freeAgain();
  await fx.waitTask(task.id, (y) => y.runState === 'running' && !!y.workerId, 'its implementer hired');

  // The reviewer finds every desk taken: the review round waits, queued, and runs when one frees.
  full = true;
  x = await fx.waitTask(task.id, (y) => y.runState === 'queued', 'the review queued', 30_000);
  assert.equal(x.status, 'in_progress');
  assert.deepEqual(x.queuedRun, { phase: 'review', role: 'reviewer', prompt: 'review', round: 1 });
  await freeAgain();
  const done = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.queuedRun, undefined);
  assert.ok(fx.repo.listRuns(task.id).some((r) => r.phase === 'review' && r.verdict === 'approved'));
});

test('stopping a queued task takes it out of the queue', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.workers.deskOccupied = () => true;
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  assert.equal(fx.task(task.id).runState, 'queued');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const x = fx.task(task.id);
  assert.equal(x.status, 'waiting');
  assert.equal(x.waitingReason, 'stopped');
  assert.equal(x.queuedRun, undefined);
});

test("an account not signed in to Claude: the task waits with upstream's reason and never hires on the office's sign-in; Retry runs as its creator", async (t) => {
  const ready = new Set<string>();
  const fx = await engineFixture({ runAs: signIns(ready) });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const task = fx.newTask({ usePlan: false, useReview: false, createdByAccount: 'acct-bob' });
  // Ada presses Start on the shared password (no account): the task still runs as Bob, who made it,
  // and upstream's reason says whose sign-in is missing.
  const missing = `Task #${task.id} runs as its creator, ${task.createdBy}, whose Claude sign-in is missing. ${NOT_SIGNED_IN}`;
  assert.equal(await fx.engine.start(task.id, ADA), missing);
  const x = fx.task(task.id);
  assert.equal(x.status, 'waiting');
  assert.equal(x.waitingReason, 'failed');
  assert.equal(x.waitingText, missing);
  assert.equal(fx.workers.list().length, 0, 'nobody was hired');
  assert.equal(fx.invocations().length, 0);

  // Bob signs in; Grace presses Retry: the hire is still Bob's.
  ready.add('acct-bob');
  assert.equal(await fx.engine.retry(task.id, { name: 'Grace', admin: false, accountId: 'acct-grace' }), undefined);
  const done = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 30_000);
  assert.equal(fx.workers.ownerOf(done.workerId!), 'acct-bob');
});
