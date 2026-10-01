// Sending a task worker home from the 3D office (docs/kanban-coupling.md, "3D actions → task events"):
// every departure path records its intent on the worker, the engine applies the rules with exactly
// one status line, and a task's worktree stays while it is still needed there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import type { DepartureIntent } from '../src/shared/kanban/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const APPROVE: Rule = { when: 'review round \\d+ of', reply: 'Fine.\n\nREVIEW: APPROVED' };
const RESUME: Rule = { when: 'commented on task', reply: 'Renamed.', commit: 'Rename' };
const SENT: DepartureIntent = { by: 'Ada', reason: 'sent-home' };

/** The office's lines about workers going home. */
const homeNotes = (fx: EngineFixture, id: number) =>
  fx.repo
    .listComments(id)
    .comments.filter((c) => c.kind === 'status' && / home/.test(c.text))
    .map((c) => c.text);

/** The task goes through its work into the review column, its implementer left at its desk. */
async function inReview(fx: EngineFixture, patch: Parameters<EngineFixture['newTask']>[0] = {}) {
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
}

const worktreeOf = (fx: EngineFixture, t: { workspace?: { worktree: { path: string } } }) => path.join(fx.dir, t.workspace!.worktree.path);

test('an implementer at rest sent home with done: the task is done, with one line', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, { ...SENT, done: true });
  const d = await fx.waitTask(r.id, (x) => x.status === 'done', 'done');
  assert.ok(d.doneAt);
  assert.equal(d.workerId, undefined);
  assert.ok(d.workspace && existsSync(worktreeOf(fx, d)), 'kept as asked');
  const notes = homeNotes(fx, r.id);
  assert.equal(notes.length, 1, notes.join(' | '));
  assert.match(notes[0], /^Ada sent .+ home, and the task is done\.$/);
});

test('an implementer at rest sent home without done keeps its column; when its worktree is deleted the workspace is dropped, and the branch kept while git has it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, RESUME]);
  const r = await inReview(fx);
  const wt = worktreeOf(fx, r);
  await fx.workers.kill(r.workerId!, 'worktree', undefined, undefined, SENT);
  const a = await fx.waitTask(r.id, (x) => !x.workerId && !x.workspace, 'the workspace dropped');
  assert.equal(a.status, 'review', 'nothing moves it');
  assert.equal(existsSync(wt), false);
  assert.equal(a.branch, r.branch, 'the branch is still there, so the task keeps it');
  assert.equal(a.sessionId, undefined, 'the session ran in the folder that is gone');
  assert.deepEqual(homeNotes(fx, r.id).length, 1);

  // A comment now carries on in a fresh worktree on the same branch.
  const { comment } = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', kind: 'message', text: 'Rename it please' });
  await fx.engine.commented(r.id, comment.id, ADA);
  const b = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(r.id).length === 2, 'the comment worked on', 30_000);
  assert.ok(b.workspace && worktreeOf(fx, b) !== wt && existsSync(worktreeOf(fx, b)), 'a fresh worktree');
  assert.equal(b.branch, r.branch);
});

test("the task's branch is dropped with its worktree when git has it nowhere any more", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.ok(r.branch);
  await fx.workers.kill(r.workerId!, 'all', undefined, undefined, SENT);
  const a = await fx.waitTask(r.id, (x) => !x.workspace, 'the workspace dropped');
  assert.equal(a.branch, undefined);
});

test('an implementer at rest in a usage-limit wait: it no longer carries on by itself, and keeps waiting', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  fx.repo.updateTask(r.id, { status: 'waiting', waitingReason: 'usage_limit', waitingText: 'A usage limit', retryAt: Date.now() + 3_600_000, retryAttempts: 1 });
  await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, SENT);
  const a = await fx.waitTask(r.id, (x) => !x.workerId && x.retryAt === undefined, 'retryAt cleared');
  assert.equal(a.status, 'waiting');
  assert.equal(a.waitingReason, 'usage_limit');
  assert.equal(homeNotes(fx, r.id).length, 1);
});

test('an implementer of a task in progress with nothing running: the task waits, with Retry', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  fx.repo.updateTask(r.id, { status: 'in_progress', runState: 'idle', phase: 'implement' });
  await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, SENT);
  const a = await fx.waitTask(r.id, (x) => x.status === 'waiting', 'waiting');
  assert.equal(a.waitingReason, 'interrupted');
  assert.match(a.waitingText ?? '', /Ada sent .+ home: Retry to carry on/);
  const notes = homeNotes(fx, r.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Retry to carry on/);
});

test('an implementer sent home mid-run: the run is stopped, the task waits with Retry, cleanup all is forced to keep, and Retry carries on there', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 4000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.runState === 'running' && !!x.workerId && !!x.workspace, 'running', 15_000);
  await sleep(500);
  const wt = worktreeOf(fx, r);
  await fx.workers.kill(r.workerId!, 'all', undefined, undefined, SENT);
  const a = await fx.waitTask(task.id, (x) => x.status === 'waiting', 'waiting', 5000);
  assert.equal(a.waitingReason, 'stopped');
  assert.match(a.waitingText ?? '', /^Ada sent .+ home mid-run: Retry to carry on$/);
  assert.equal(fx.repo.listRuns(task.id)[0].status, 'stopped');
  assert.ok(existsSync(wt), 'a run was going there: its worktree stays');
  assert.ok(a.workspace);
  const notes = homeNotes(fx, task.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /its implement run was stopped\. Retry to carry on\.$/);

  fx.setRules([IMPLEMENT]);
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  const b = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(worktreeOf(fx, b), wt, 'in the same worktree');
});

test('an implementer sent home mid-run with done: the run stops and the task is done', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 4000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.runState === 'running' && !!x.workerId, 'running', 15_000);
  await sleep(500);
  await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, { ...SENT, done: true });
  const a = await fx.waitTask(task.id, (x) => x.status === 'done', 'done', 5000);
  assert.equal(a.runState, 'idle');
  assert.equal(fx.repo.listRuns(task.id)[0].status, 'stopped');
  assert.equal(homeNotes(fx, task.id).length, 1);
});

test('a reviewer sent home mid-review: the round is dropped and the task goes to Review; the implementer keeps the worktree', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, { ...APPROVE, delayMs: 4000 }]);
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.phase === 'review' && x.runState === 'running' && !!x.reviewerWorkerId, 'reviewing', 30_000);
  await sleep(500);
  await fx.workers.kill(r.reviewerWorkerId!, 'all', undefined, undefined, SENT);
  const a = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 5000);
  assert.equal(a.reviewerWorkerId, undefined);
  assert.ok(fx.workers.get(a.workerId!), 'the implementer is still at its desk');
  assert.ok(existsSync(worktreeOf(fx, a)), 'the implementer sits in it: it stays');
  assert.equal(fx.repo.listRuns(task.id).find((x) => x.phase === 'review')?.status, 'stopped');
  const notes = homeNotes(fx, task.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /its review round was dropped, and the task is in Review\.$/);
});

test('a reviewer sent home with comments queued: they go to the agent, and its work is reviewed again', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, { ...APPROVE, delayMs: 4000 }, RESUME]);
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.phase === 'review' && x.runState === 'running' && !!x.reviewerWorkerId, 'reviewing', 30_000);
  const { comment } = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', kind: 'message', text: 'Rename it please' });
  await fx.engine.commented(task.id, comment.id, ADA);
  assert.equal(fx.task(task.id).pendingMessages.length, 1);
  fx.setRules([IMPLEMENT, APPROVE, RESUME]);
  await fx.workers.kill(r.reviewerWorkerId!, 'keep', undefined, undefined, SENT);
  const b = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length >= 4, 'worked on and reviewed', 30_000);
  assert.deepEqual(fx.repo.listRuns(task.id).map((x) => `${x.phase}/${x.status}`), ['implement/succeeded', 'review/stopped', 'resume/succeeded', 'review/succeeded']);
  assert.deepEqual(b.pendingMessages, []);
  const notes = homeNotes(fx, task.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /comments that came in meanwhile go to the agent now/);
});

test('an implementer at rest sent home with cleanup all while its reviewer works: the worktree stays for the reviewer, and the rounds go on', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    IMPLEMENT,
    { when: 'review round 1 of', reply: '1. a bug\n\nREVIEW: CHANGES_REQUESTED', delayMs: 3000 },
    { when: 'asks for changes', reply: 'Fixed.', commit: 'fix' },
    { when: 'round 2 of', reply: 'ok\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.phase === 'review' && x.runState === 'running' && !!x.reviewerWorkerId, 'reviewing', 30_000);
  const wt = worktreeOf(fx, r);
  await fx.workers.kill(r.workerId!, 'all', undefined, undefined, SENT);
  assert.ok(existsSync(wt), 'kept: the reviewer sits in it');
  assert.ok(fx.workers.get(r.reviewerWorkerId!), 'the reviewer is still at its desk');
  await sleep(100);
  assert.equal(fx.task(task.id).status, 'in_progress', 'a run is going: nothing moves');
  const b = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.deepEqual(fx.repo.listRuns(task.id).map((x) => `${x.phase}:${x.round ?? ''}/${x.role}/${x.status}`), ['implement:/implementer/succeeded', 'review:1/reviewer/succeeded', 'fix:1/implementer/succeeded', 'review:2/reviewer/succeeded']);
  assert.equal(worktreeOf(fx, b), wt, 'the fix was made in the same worktree');
  assert.equal(homeNotes(fx, task.id).length, 1, 'the engine sending its reviewer home says nothing of its own');
});

test('sendWorkersHome (a reset to To do, a delete): the worker at rest goes home, the worktree stays and the task says where; a running task is refused', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  const wt = worktreeOf(fx, r);
  assert.equal(await fx.engine.sendWorkersHome(r.id, ADA, 'reset'), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  assert.equal(fx.workers.get(r.workerId!), undefined, 'it went home');
  assert.ok(existsSync(wt), 'its worktree stayed');
  const kept = fx.repo.listComments(r.id).comments.find((c) => c.kind === 'status' && /worktree was kept/.test(c.text));
  assert.ok(kept, 'the task says where the worktree stayed');
  assert.ok(kept!.text.includes(wt) && kept!.text.includes(r.workspace!.worktree.branch), kept!.text);
  fx.repo.updateTask(r.id, { runState: 'running' });
  assert.match(String(await fx.engine.sendWorkersHome(r.id, ADA, 'delete')), /Stop it first/);
});

test('a re-hired implementer sitting in the task worktree, sent home with cleanup all when nobody else is there and nothing runs: the worktree goes', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, RESUME]);
  const r = await inReview(fx);
  await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, { by: 'Ada', reason: 'released' });
  await fx.waitTask(r.id, (x) => !x.workerId, 'released');
  const { comment } = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', kind: 'message', text: 'Rename it please' });
  await fx.engine.commented(r.id, comment.id, ADA);
  const b = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.workerId !== r.workerId, 're-hired', 30_000);
  const wt = worktreeOf(fx, b);
  assert.equal(wt, worktreeOf(fx, r), 'seated in the task worktree');
  await fx.workers.kill(b.workerId!, 'all', undefined, undefined, SENT);
  await fx.waitTask(r.id, (x) => !x.workspace, 'the workspace dropped');
  assert.equal(existsSync(wt), false);
});

test("every path says who sent the worker home in one line; the engine's own departures say nothing", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const paths: [DepartureIntent, RegExp | null][] = [
    [{ by: 'Ada', reason: 'sent-home' }, /^Ada sent .+ home\.$/],
    [{ by: 'The queue', reason: 'queue' }, /^The queue sent .+ home to make room for its next task\.$/],
    [{ by: 'The meeting', reason: 'meeting' }, /^The meeting sent .+ home\.$/],
    [{ by: 'Bob', reason: 'released' }, /^Bob sent .+ home\.$/],
    [{ by: 'Kanban', reason: 'engine' }, null],
  ];
  for (const [intent, line] of paths) {
    const r = await inReview(fx);
    await fx.workers.kill(r.workerId!, 'keep', undefined, undefined, intent);
    const a = await fx.waitTask(r.id, (x) => !x.workerId, `${intent.reason}: the worker gone from the task`);
    await sleep(50);
    assert.equal(a.status, 'review', intent.reason);
    const notes = homeNotes(fx, r.id);
    if (!line) assert.deepEqual(notes, [], intent.reason);
    else {
      assert.equal(notes.length, 1, `${intent.reason}: ${notes.join(' | ')}`);
      assert.match(notes[0], line);
    }
  }
  // Without an intent (an older caller), it's someone's plain send-home.
  const r = await inReview(fx);
  await fx.workers.kill(r.workerId!, 'keep');
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  await sleep(50);
  assert.deepEqual(homeNotes(fx, r.id).length, 1);
});
