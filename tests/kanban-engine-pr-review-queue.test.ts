// Regressions: a review of several pull requests together (engine.reviewPrs, phase pr-review) that
// finds the office full, or no free seat, is queued as every other hire is (noRoom → runState
// 'queued' with its queuedRun), keeps the review task it made, and starts by itself once there's
// room (the drain re-runs it with the pull requests of its pr.review event). Stop, and moving the
// task to Done, take it out of the queue, recorded as a stopped run of its phase that never started,
// so Retry runs that one (the PR review, a queued review round), not the task's run before it.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Capacity } from '../src/server/machine.js';
import { DESKS } from '../src/shared/layout.js';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

const REVIEWED = { when: 'Review these pull requests', reply: 'They fit together.\n\nREVIEW: APPROVED' };
const PRS = [
  { repo: 'acme/proj', number: 3, title: 'UYT-9 Fix login' },
  { repo: 'acme/proj', number: 4 },
] as never;

/** An office worker limit the test sets, over the fixture's workers. */
function limitOf(get: () => EngineFixture | undefined) {
  const state = { limit: Infinity };
  const count = () => get()?.workers.list().length ?? 0;
  const capacity: Capacity = {
    full: () => (count() >= state.limit ? `The office is at its limit of ${state.limit} worker${state.limit === 1 ? '' : 's'} on this machine — send one home before hiring another` : undefined),
    room: () => state.limit - count(),
  };
  return { state, capacity };
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

const reviewPrompts = (fx: EngineFixture) => fx.invocations().filter((i) => i.prompt && /Review these pull requests/.test(i.prompt));

async function queuedReview(fx: EngineFixture, why: RegExp) {
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: PRS, tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', `queued, not refused: ${String(got)}`);
  if (typeof got === 'string') throw new Error(got);
  assert.equal(got.workerId, undefined, 'no reviewer yet');
  const task = fx.task(got.taskId);
  assert.ok(task, 'the review task it made is kept');
  assert.equal(task.title, 'PR review: acme/proj#3, acme/proj#4');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.phase, 'pr-review');
  assert.equal(task.runState, 'queued');
  assert.deepEqual(task.queuedRun, { phase: 'pr-review', role: 'reviewer', prompt: 'pr.review' });
  assert.ok(notes(fx, task.id).some((n) => why.test(n)), notes(fx, task.id).join(' | '));
  assert.ok(notes(fx, task.id).some((n) => /Ada asked for a review of acme\/proj#3, acme\/proj#4/.test(n)), notes(fx, task.id).join(' | '));
  assert.equal(fx.repo.listRuns(task.id).length, 0, 'no run until a reviewer is hired');
  assert.equal(reviewPrompts(fx).length, 0);
  return task;
}

test('limit 1 with a busy worker: a PR review is a queued task, and it starts when the worker goes home', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.setRules([REVIEWED]);
  state.limit = 1;
  const busy = shell(fx, DESKS[3].id);

  const task = await queuedReview(fx, /^Queued: The office is at its limit of 1 worker/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fx.task(task.id).runState, 'queued', 'still waiting while the office is full');

  await fx.workers.kill(busy);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(done.queuedRun, undefined);
  const run = fx.repo.listRuns(task.id)[0];
  assert.equal(run.phase, 'pr-review');
  assert.equal(run.verdict, 'approved');
  // The drain ran it with the pull requests the request named (its pr.review event).
  const prompt = reviewPrompts(fx)[0]?.prompt ?? '';
  assert.match(prompt, /- acme\/proj#3 “UYT-9 Fix login” https:\/\/github\.com\/acme\/proj\/pull\/3/);
  assert.match(prompt, /- acme\/proj#4 https:\/\/github\.com\/acme\/proj\/pull\/4/);
});

test('no free seat: a PR review is queued, and started when a seat frees', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([REVIEWED]);
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  let full = true;
  fx.workers.deskOccupied = (id: string) => full || occupied(id);

  const task = await queuedReview(fx, /^Queued: there's no free desk/);

  // A seat frees (a worker going home is what tells the engine).
  full = false;
  const sh = shell(fx, DESKS[5].id);
  await fx.workers.kill(sh);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(fx.repo.listRuns(done.id)[0]?.verdict, 'approved');
});

test('a queued PR review stopped, or moved to Done, leaves the queue and never starts', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.setRules([REVIEWED]);
  state.limit = 1;
  const busy = shell(fx, DESKS[3].id);

  const stopped = await queuedReview(fx, /^Queued: The office is at its limit/);
  assert.equal(await fx.engine.stop(stopped.id, ADA), undefined);
  const s = fx.task(stopped.id);
  assert.equal(s.runState, 'idle');
  assert.equal(s.queuedRun, undefined);
  assert.equal(s.status, 'waiting');
  assert.equal(s.waitingReason, 'stopped');

  const moved = await queuedReview(fx, /^Queued: The office is at its limit/);
  // As kanban.task.move does it: the column, then the engine lets go of it.
  fx.repo.updateTask(moved.id, { status: 'done' });
  await fx.engine.releaseIdle!(moved.id, ADA);
  const m = fx.task(moved.id);
  assert.equal(m.runState, 'idle');
  assert.equal(m.queuedRun, undefined);

  await fx.workers.kill(busy);
  await new Promise((r) => setTimeout(r, 600));
  for (const id of [stopped.id, moved.id]) {
    const runs = fx.repo.listRuns(id);
    assert.deepEqual(runs.map((r) => [r.phase, r.role, r.status, r.workerId, r.sessionId]), [['pr-review', 'reviewer', 'stopped', undefined, undefined]], `#${id} never started`);
    assert.match(runs[0].error ?? '', /before it started/);
    assert.equal(fx.workers.list().filter((w) => w.kanban?.taskId === id).length, 0);
  }
  assert.equal(reviewPrompts(fx).length, 0);
});

test('a genuine refusal still fails, and the review task it would have made goes again', async (t) => {
  const fx = await engineFixture({ runAs: { claudeReady: () => false, why: () => 'Sign in to Claude first', apply: (_o, env) => env } });
  t.after(() => fx.close());
  const before = fx.repo.listTasks('proj').length;
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: PRS, tool: 'claude' }, { ...ADA, accountId: 'acc-1' });
  assert.equal(typeof got, 'string');
  assert.match(String(got), /Sign in to Claude first/);
  assert.equal(fx.repo.listTasks('proj').length, before, 'no review task left behind');
});

test('a queued PR review stopped, then Retry: the PR review runs with its pull requests, not an investigate run', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.setRules([REVIEWED, { when: '.', reply: 'Not a PR review' }]);
  state.limit = 1;
  const busy = shell(fx, DESKS[3].id);

  const task = await queuedReview(fx, /^Queued: The office is at its limit/);
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  assert.equal(fx.task(task.id).waitingReason, 'stopped');
  await fx.workers.kill(busy);

  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  const runs = fx.repo.listRuns(done.id);
  assert.deepEqual(runs.map((r) => [r.phase, r.status]), [['pr-review', 'stopped'], ['pr-review', 'succeeded']]);
  assert.equal(runs[1].verdict, 'approved');
  assert.equal(fx.invocations().filter((i) => i.prompt && !/Review these pull requests/.test(i.prompt)).length, 0, 'no investigate run');
  const prompt = reviewPrompts(fx)[0]?.prompt ?? '';
  assert.match(prompt, /- acme\/proj#3 “UYT-9 Fix login” https:\/\/github\.com\/acme\/proj\/pull\/3/);
});

test('a queued review round stopped, then Retry: that review round runs, not the implement run before it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect', delayMs: 1000 },
    { when: 'This is review round 1 of', reply: 'Good.\nREVIEW: APPROVED' },
  ]);
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  let full = false;
  fx.workers.deskOccupied = (id: string) => full || occupied(id);

  const task = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (y) => y.runState === 'running' && !!y.workerId, 'its implementer hired');
  // The reviewer finds every desk taken: the round waits, queued, and is stopped there.
  full = true;
  const queued = await fx.waitTask(task.id, (y) => y.runState === 'queued', 'the review queued', 30_000);
  assert.deepEqual(queued.queuedRun, { phase: 'review', role: 'reviewer', prompt: 'review', round: 1 });
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = fx.task(task.id);
  assert.equal(stopped.waitingReason, 'stopped');
  const last = fx.repo.listRuns(task.id).at(-1)!;
  assert.deepEqual([last.phase, last.round, last.role, last.status, last.workerId], ['review', 1, 'reviewer', 'stopped', undefined]);

  full = false;
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 30_000);
  const runs = fx.repo.listRuns(done.id);
  assert.equal(runs.filter((r) => r.phase === 'implement').length, 1, 'the implement run is not run again');
  const round = runs.at(-1)!;
  assert.deepEqual([round.phase, round.round, round.role, round.verdict], ['review', 1, 'reviewer', 'approved']);
});
