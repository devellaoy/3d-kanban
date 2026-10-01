// The kanban and the 3D office as one world (docs/kanban-coupling.md), the devil's advocate's cases:
// every hire of a task runs as its creator's account, whoever set it off (a comment resumes the
// creator's session); a queued run of a task moved out of the process (done, archived, to do) is
// never hired by the drain; and releasing a worker leaves a usage-limit auto-resume due.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { DESKS } from '../src/shared/layout.js';
import { checkMove } from '../src/shared/kanban/moves.js';
import { hireOwner } from '../src/server/kanban/engine/orchestrator.js';
import { archiveOldTasks, createCorePlugin } from '../src/server/kanban/ws.js';
import type { KanbanClient, KanbanContext } from '../src/server/kanban/registry.js';
import type { Capacity } from '../src/server/machine.js';
import type { RunAs } from '../src/server/workers.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed.', commit: 'Fix' };
const RESUME: Rule = { when: 'commented on task', reply: 'Renamed.', commit: 'Rename' };
const ADA_ACCT = { name: 'Ada', admin: true, accountId: 'acct-ada' };
const BOB = { name: 'Bob', admin: false, accountId: 'acct-bob' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every hire the engine makes: the account it runs as, the session it resumes, its role. */
function recordHires(fx: EngineFixture) {
  const hires: { owner?: string; resume?: string; role?: string }[] = [];
  const orig = fx.workers.spawn.bind(fx.workers);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fx.workers as any).spawn = (...a: any[]) => {
    hires.push({ owner: a[9], resume: a[12]?.resumeSessionId, role: a[12]?.kanban?.role });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any)(...a);
  };
  return hires;
}

async function releasedInReview(fx: EngineFixture, patch: Parameters<EngineFixture['newTask']>[0] = {}, who = ADA) {
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  assert.equal(await fx.engine.start(task.id, who), undefined);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'review', 30_000);
  await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, { by: who.name, reason: 'released' });
  return fx.waitTask(r.id, (x) => !x.workerId, 'released');
}

test('the account a hire runs as: the task’s creator, else the caller, else the office', () => {
  assert.equal(hireOwner({ createdByAccount: 'acct-ada' }, BOB), 'acct-ada');
  assert.equal(hireOwner({ createdByAccount: 'acct-ada' }, { accountId: undefined }), 'acct-ada');
  assert.equal(hireOwner({ createdByAccount: undefined }, BOB), 'acct-bob', 'no creator account (shared password, migrated): the caller');
  assert.equal(hireOwner({ createdByAccount: undefined }, ADA), undefined, 'nobody’s account: the office’s sign-in');
  assert.equal(hireOwner({ createdByAccount: undefined }), undefined);
});

test("Bob's comment on Ada's task hires as Ada and resumes Ada's session", async (t) => {
  const ready = new Set(['acct-ada', 'acct-bob']);
  const runAs: RunAs = { claudeReady: (o) => ready.has(o), why: () => 'not signed in', apply: (o, env) => ({ ...env, CLAUDE_CONFIG_DIR: `/cfg/${o}` }) };
  const fx = await engineFixture({ runAs });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, RESUME]);
  const hires = recordHires(fx);
  const r = await releasedInReview(fx, { createdByAccount: 'acct-ada' }, ADA_ACCT);
  const session = fx.task(r.id).sessionId;
  assert.ok(session, 'the first run left a session on the task');

  const { comment } = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', kind: 'message', text: 'Rename it please' });
  await fx.engine.commented(r.id, comment.id, BOB);
  const done = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && x.summary === 'Renamed.', 'the comment worked on', 30_000);
  assert.deepEqual(
    hires.map((h) => h.owner),
    ['acct-ada', 'acct-ada'],
    'both hires as the creator, not the commenter',
  );
  assert.equal(hires[1].resume, session, "Ada's session, resumed on Ada's account");
  assert.equal(fx.workers.ownerOf(done.workerId!), 'acct-ada');
  // The comment is still Bob's.
  assert.equal(fx.repo.getComment(comment.id)?.authorName, 'Bob');
});

test('a task with no creator account hires as the caller', async (t) => {
  const ready = new Set(['acct-ada', 'acct-bob']);
  const fx = await engineFixture({ runAs: { claudeReady: (o) => ready.has(o), why: () => 'not signed in', apply: (_o, env) => env } });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, RESUME]);
  const hires = recordHires(fx);
  // Made on the shared password (a migrated task, say): Bob's comment hires as Bob.
  const r = await releasedInReview(fx, {}, ADA);
  assert.equal(hires[0].owner, undefined, 'started by nobody’s account: the office’s sign-in');
  const { comment } = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', kind: 'message', text: 'Rename it please' });
  await fx.engine.commented(r.id, comment.id, BOB);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && x.summary === 'Renamed.', 'the comment worked on', 30_000);
  assert.equal(hires[1].owner, 'acct-bob');
});

/** An office worker limit the test sets, over the fixture's workers. */
function limitOf(get: () => EngineFixture | undefined) {
  const state = { limit: Infinity };
  const capacity: Capacity = {
    full: () => ((get()?.workers.list().length ?? 0) >= state.limit ? 'full' : undefined),
    room: () => state.limit - (get()?.workers.list().length ?? 0),
  };
  return { state, capacity };
}

/** A released task in Review with a review queued behind a full office; `sh` is the shell filling it. */
async function queuedReview(fx: EngineFixture, state: { limit: number }) {
  const r = await releasedInReview(fx);
  await sleep(300);
  const sh = fx.workers.spawn(DESKS[3].id, 'test', undefined, false, 'shell') as { id: string };
  state.limit = 1;
  // Queued as the engine does for a review (it would move the card to In progress, so set here: the task keeps its column).
  fx.repo.updateTask(r.id, { runState: 'queued', queuedRun: { phase: 'review', role: 'reviewer', prompt: 'review' } });
  const q = fx.task(r.id);
  assert.equal(q.runState, 'queued');
  assert.ok(q.queuedRun, 'the review waits in the queue');
  return { q, sh };
}

const coreOf = (fx: EngineFixture) => {
  const ctx = { ...fx.ctx, taskChanged: () => {}, card: (id: number) => fx.repo.card(id) } as KanbanContext;
  const plugin = createCorePlugin(ctx, { subscribe() {}, unsubscribe() {} });
  const client: KanbanClient = { clientId: 'c1', name: 'Ada', admin: true, send: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (msg: any) => (plugin.ws as any)[msg.t](client, msg) as Promise<void>;
  return { ctx, send };
};

{
  // The only way out of the process a queued task has on the board (it's running for the others).
  const to = 'done' as const;
  test('a queued review on a Review task, moved to done, leaves the queue and is never hired', async (t) => {
    let fx: EngineFixture | undefined;
    const { state, capacity } = limitOf(() => fx);
    fx = await engineFixture({ capacity });
    t.after(() => fx!.close());
    fx.setRules([IMPLEMENT]);
    const { q, sh } = await queuedReview(fx, state);
    assert.equal(checkMove({ status: q.status, runState: q.runState }, to).ok, true);
    await coreOf(fx).send({ t: 'kanban.task.move', rid: 'm1', id: q.id, to });
    const moved = fx.task(q.id);
    assert.equal(moved.status, to);
    assert.equal(moved.runState, 'idle');
    assert.equal(moved.queuedRun, undefined);
    state.limit = Infinity;
    await fx.workers.kill(sh.id);
    await sleep(1500);
    assert.equal(fx.workers.list().filter((w) => w.kanban?.taskId === q.id).length, 0, 'the drain hired nobody');
    assert.equal(fx.task(q.id).status, to);
  });
}

test('the drain looks at the task’s column again: a queued run of a task that left the process is dropped, not hired', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.setRules([IMPLEMENT]);
  const { q, sh } = await queuedReview(fx, state);
  // Behind the move's back (another path to done): still queued in the database.
  fx.repo.updateTask(q.id, { status: 'done', doneAt: Date.now() });
  state.limit = Infinity;
  await fx.workers.kill(sh.id);
  await sleep(1500);
  const after = fx.task(q.id);
  assert.equal(after.status, 'done');
  assert.equal(after.runState, 'idle');
  assert.equal(after.queuedRun, undefined);
  assert.equal(fx.workers.list().filter((w) => w.kanban?.taskId === q.id).length, 0);
});

test('the auto-archive takes a queued run out of the queue too', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = fx.newTask({ usePlan: false, useReview: false });
  fx.repo.updateTask(task.id, { status: 'done', doneAt: 1, runState: 'queued', queuedRun: { phase: 'review', role: 'reviewer', prompt: 'review' } });
  const ctx = { ...fx.ctx, taskChanged: () => {}, card: (id: number) => fx.repo.card(id) } as KanbanContext;
  assert.deepEqual(archiveOldTasks(ctx), [task.id]);
  const x = fx.task(task.id);
  assert.equal(x.status, 'archived');
  assert.equal(x.runState, 'idle');
  assert.equal(x.queuedRun, undefined);
});

test('releasing the worker of a task waiting on a usage limit keeps its auto-resume, and the sweep hires again later', async (t) => {
  let clock = Date.now();
  const fx = await engineFixture({ engine: { sweepMs: 150, now: () => clock } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: `You've hit your limit · resets at ${new Date(clock + 3_600_000).getHours()}:00` }]);
  const task = fx.newTask({ usePlan: false, useReview: false, createdByAccount: 'acct-ada' });
  await fx.engine.start(task.id, ADA_ACCT);
  const limited = await fx.waitTask(task.id, (x) => x.waitingReason === 'usage_limit' && !!x.workerId, 'the usage limit');
  const first = limited.workerId!;
  assert.ok(limited.retryAt);

  await fx.workers.kill(first, 'keep', undefined, undefined, { by: BOB.name, reason: 'released' });
  const released = await fx.waitTask(task.id, (x) => !x.workerId && !fx.workers.get(first), 'released');
  assert.equal(released.retryAt, limited.retryAt, 'a release leaves the auto-resume due');
  assert.equal(released.waitingReason, 'usage_limit');

  fx.setRules([{ when: 'kanban task', reply: 'Finished it.', commit: 'Work' }]);
  clock = limited.retryAt! + 1000;
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the carry-on', 30_000);
  assert.ok(done.workerId && done.workerId !== first, 'a new hire carried on');
  assert.equal(fx.workers.ownerOf(done.workerId), 'acct-ada', 'as the task’s creator');
  assert.equal(done.retryAt, undefined);
});
