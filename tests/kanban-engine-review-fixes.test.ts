// Regressions of a third review of the engine: a task counts once against the office's worker limit,
// so its reviewer never waits for the place its own implementer holds (and a queued run keeps its
// task's maxConcurrent slot, so tasks can't pile up on the desks its reviewer needs); an answer from
// the kanban to an agent asking a question in its terminal is typed in there, on the same run, and the
// task waits until the agent's hooks say it went on (a permission prompt is never typed into); and a review of
// pull requests goes into the named task only when every one of them is that task's.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Capacity } from '../src/server/machine.js';
import { DESKS } from '../src/shared/layout.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const APPROVE: Rule = { when: 'This is review round 1 of', reply: 'Good.\nREVIEW: APPROVED' };

/** An office worker limit the test sets, over the fixture's workers (upstream's Machine counts every worker, idle and done ones too). */
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

// --- 1. The worker limit: a task counts once ------------------------------------------------------

test('limit 1: after implement the review runs at once, beside its implementer; an unrelated task still waits for the limit', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.setRules([IMPLEMENT, { ...APPROVE, delayMs: 1200 }]);
  state.limit = 1;

  const a = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(a.id, ADA), undefined);
  const reviewing = await fx.waitTask(a.id, (x) => x.phase === 'review' && x.runState === 'running' && !!x.reviewerWorkerId, 'its reviewer hired', 20_000);
  assert.ok(fx.workers.get(reviewing.workerId!), 'the implementer is still at its desk');
  assert.equal(fx.workers.list().length, 2, 'the reviewer is counted while it runs');
  assert.ok(!notes(fx, a.id).some((n) => /^Queued/.test(n)), `the review never queued: ${notes(fx, a.id).join(' | ')}`);

  // Another task finds the office full: it waits, whatever A's reviewer was let past.
  const b = fx.newTask({ usePlan: false, useReview: false, title: 'Another task' });
  assert.equal(await fx.engine.start(b.id, ADA), undefined);
  assert.equal(fx.task(b.id).runState, 'queued');
  assert.ok(notes(fx, b.id).some((n) => /^Queued: The office is at its limit of 1 worker/.test(n)), notes(fx, b.id).join(' | '));

  const done = await fx.waitTask(a.id, (x) => x.status === 'review' && x.runState === 'idle', 'A in the review column', 30_000);
  assert.ok(fx.repo.listRuns(a.id).some((r) => r.phase === 'review' && r.verdict === 'approved'));
  assert.equal(done.reviewerWorkerId, undefined, 'the reviewer went home');
  // A's implementer at rest still holds the office's one place: B is still queued, never hired.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fx.task(b.id).runState, 'queued');
  assert.equal(fx.workers.list().filter((w) => w.kanban?.taskId === b.id).length, 0);
});

test('limit 2, two tasks finishing together: both reviews run; a third task waits for the limit', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 300 }, { ...APPROVE, delayMs: 1200 }]);
  state.limit = 2;

  const a = fx.newTask({ usePlan: false, useReview: true, title: 'Task A' });
  const b = fx.newTask({ usePlan: false, useReview: true, title: 'Task B' });
  assert.equal(await fx.engine.start(a.id, ADA), undefined);
  assert.equal(await fx.engine.start(b.id, ADA), undefined);
  const both = (x: { phase?: string; runState: string; reviewerWorkerId?: string }) => x.phase === 'review' && x.runState === 'running' && !!x.reviewerWorkerId;
  await fx.waitTask(a.id, both, "A's reviewer hired", 20_000);
  await fx.waitTask(b.id, both, "B's reviewer hired", 20_000);
  assert.equal(fx.workers.list().length, 4, 'two implementers and two reviewers');

  const c = fx.newTask({ usePlan: false, useReview: false, title: 'Task C' });
  assert.equal(await fx.engine.start(c.id, ADA), undefined);
  assert.equal(fx.task(c.id).runState, 'queued', 'the limit still holds for a task of its own');

  for (const id of [a.id, b.id]) {
    await fx.waitTask(id, (x) => x.status === 'review' && x.runState === 'idle', `#${id} in the review column`, 30_000);
    assert.ok(fx.repo.listRuns(id).some((r) => r.phase === 'review' && r.verdict === 'approved'), `#${id} was reviewed`);
    assert.ok(!notes(fx, id).some((n) => /^Queued/.test(n)), notes(fx, id).join(' | '));
  }
});

test('a review queued for a desk runs once one frees although the limit is full (its implementer holds the place); it keeps its maxConcurrent slot meanwhile', async (t) => {
  let fx: EngineFixture | undefined;
  const { state, capacity } = limitOf(() => fx);
  fx = await engineFixture({ capacity });
  t.after(() => fx!.close());
  fx.settings.setProject('proj', { maxConcurrent: 1 });
  fx.setRules([{ ...IMPLEMENT, delayMs: 800 }, APPROVE]);
  state.limit = 1;
  const occupied = fx.workers.deskOccupied.bind(fx.workers);
  let full = false;
  fx.workers.deskOccupied = (id: string) => full || occupied(id);

  const a = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(a.id, ADA), undefined);
  await fx.waitTask(a.id, (x) => x.runState === 'running' && !!x.workerId, 'its implementer hired');
  full = true;
  const queued = await fx.waitTask(a.id, (x) => x.runState === 'queued', 'the review queued for a desk', 20_000);
  assert.deepEqual(queued.queuedRun, { phase: 'review', role: 'reviewer', prompt: 'review', round: 1 });
  assert.ok(notes(fx, a.id).some((n) => /^Queued: there's no free desk/.test(n)));

  // The queued review still holds the project's one slot: another start waits for it, not for a desk.
  const b = fx.newTask({ usePlan: false, useReview: false, title: 'Another task' });
  assert.equal(await fx.engine.start(b.id, ADA), undefined);
  const bq = fx.task(b.id);
  assert.equal(bq.runState, 'queued');
  assert.equal(bq.queuedRun, undefined, 'a start waiting for a slot, not a run waiting for a desk');
  assert.ok(notes(fx, b.id).some((n) => /running as many tasks as it may at once/.test(n)), notes(fx, b.id).join(' | '));

  // A desk frees (a worker going home is what tells the engine): the office is still at its limit
  // of 1, held by A's own implementer, and the review runs anyway.
  full = false;
  state.limit = 5;
  const sh = shell(fx, DESKS[5].id);
  state.limit = 1;
  await fx.workers.kill(sh);
  const done = await fx.waitTask(a.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.queuedRun, undefined);
  assert.ok(fx.repo.listRuns(a.id).some((r) => r.phase === 'review' && r.verdict === 'approved'));
  assert.equal(fx.task(b.id).runState, 'queued', 'B waits: the limit is full with A’s implementer');
});

// --- 2. Answering an agent that asks in its terminal ----------------------------------------------

// answerDelayMs: the window in which the task still waits after an answer is typed (stillAsking checks it).
const ASK: Rule = { when: 'Implement kanban task', reply: 'Shall I use v1 or v2 of the API?', ask: 'question', answerDelayMs: 1000 };
const PERMISSION: Rule = { when: 'Implement kanban task', reply: 'I need to clean build/ first.', ask: true };
const ANSWERED: Rule = { when: '^yes, use v2$', reply: 'Used v2.', commit: 'Use v2' };

async function asking(fx: EngineFixture, ask: Rule = ASK) {
  fx.setRules([ANSWERED, ask]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const t = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  assert.equal(fx.workers.get(t.workerId!)?.status, 'needs_input');
  const run = fx.repo.listRuns(task.id).at(-1)!;
  assert.equal(run.status, 'running');
  return { task: t, run };
}

const typed = (fx: EngineFixture, text: string) => fx.invocations().filter((i) => i.prompt === text).length;
const stillAsking = (fx: EngineFixture, id: number) => {
  const now = fx.task(id);
  assert.equal(now.status, 'waiting');
  assert.equal(now.waitingReason, 'agent_asking');
  return now;
};

test('agent asking a question → continue with an answer: stored as a comment, typed into its terminal; waiting until its hooks say it went on, then in progress on the same run', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task, run } = await asking(fx);
  assert.equal(task.askingKind, 'question');
  assert.equal(fx.repo.card(task.id)?.askingKind, 'question', 'the card says so too');

  const mark = fx.history(task.id).length;
  assert.equal(await fx.engine.continue(task.id, ADA, 'yes, use v2'), undefined);
  // Typed, but the agent hasn't gone on yet (its PostToolUse comes later): the task still waits.
  const now = stillAsking(fx, task.id);
  assert.deepEqual(now.pendingMessages, [], 'never queued');
  const said = fx.repo.listComments(task.id).comments.filter((c) => c.authorKind === 'user');
  assert.deepEqual(said.map((c) => [c.authorName, c.text, c.pending ?? false]), [['Ada', 'yes, use v2', false]]);

  // The fake agent's turn after the answer is quick, so the task may be in review before a poll looks:
  // what counts is that it went in progress on the same run once its hook said so.
  const going = await fx.sawTask(task.id, (x) => x.status === 'in_progress', 'in progress once its hook says working', 15_000, mark);
  assert.equal(going.task.runState, 'running');
  assert.equal(going.task.waitingReason, undefined);
  assert.equal(going.task.askingKind, undefined);
  assert.equal(going.runId, run.id, 'going on on the same run');

  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(typed(fx, 'yes, use v2'), 1, 'typed into the PTY once');
  const runs = fx.repo.listRuns(task.id);
  assert.deepEqual(runs.map((r) => r.id), [run.id], 'the same run, no resume run after it');
  assert.equal(runs[0].status, 'succeeded');
  assert.ok((runs[0].finishedAt ?? 0) >= going.at, 'the run ended after it went on with the answer');
  assert.equal(done.summary, 'Used v2.', "the turn's result is the answered one");
  const after = fx.history(task.id).slice(mark);
  const from = after.indexOf(going);
  assert.ok(
    after.slice(from).every((s) => s.task.status !== 'waiting'),
    `never waiting again after it went on: ${after.map((s) => s.task.status).join(' → ')}`,
  );
});

test('agent asking a question → a plain comment is the answer, typed in at once, never queued', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task, run } = await asking(fx);

  const { comment } = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', kind: 'message', text: 'yes, use v2' });
  await fx.engine.commented(task.id, comment.id, ADA);
  const now = stillAsking(fx, task.id);
  assert.deepEqual(now.pendingMessages, []);
  assert.equal(fx.repo.getComment(comment.id)?.pending ?? false, false);
  assert.ok(!notes(fx, task.id).some((n) => /once that turn is over/.test(n)), notes(fx, task.id).join(' | '));

  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(typed(fx, 'yes, use v2'), 1);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => [r.id, r.status]), [[run.id, 'succeeded']]);
});

test('a teammate\'s hooks feed what the agent is asking, but its Stop, prompt, session start and other tools never clear the lead\'s ask', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task } = await asking(fx);
  assert.equal(task.askingKind, 'question');
  // Only the observation reaches the engine: the worker's own state is left alone.
  const w = (fx.workers as unknown as { workers: Map<string, unknown> }).workers.get(task.workerId!);
  const hear = (hookEvent: string, extra: { tool?: string; payload?: object } = {}) => {
    (fx.workers as unknown as { observe(w: unknown, o: object): void }).observe(w, { event: 'hook', hookEvent, tool: extra.tool, payload: { agent_id: 'helper@session-1', ...extra.payload } });
    return fx.repo.card(task.id)?.askingKind;
  };
  for (const [event, tool] of [['Stop'], ['UserPromptSubmit'], ['SessionStart'], ['PreToolUse', 'Bash']] as const) assert.equal(hear(event, { tool }), 'question', `${event} of a teammate`);
  assert.equal(hear('Notification', { payload: { notification_type: 'permission_prompt' } }), 'question', 'a question stays a question');
  assert.equal(hear('PostToolUse', { tool: 'Bash' }), undefined, "a teammate's finished tool forgets it");
  assert.equal(hear('PermissionRequest', { tool: 'Bash' }), 'permission');
  assert.equal(hear('PreToolUse', { tool: 'Bash' }), 'permission', "a teammate's other tool leaves it");
  assert.equal(hear('PreToolUse', { tool: 'AskUserQuestion' }), 'question');
  assert.equal(hear('PostToolUseFailure', { tool: 'AskUserQuestion' }), undefined);
  assert.equal(hear('Notification', { payload: { notification_type: 'permission_prompt' } }), 'permission');
});

test('agent asking → continue without an answer is refused, and nothing is typed or stored', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task } = await asking(fx);
  const before = fx.invocations().length;
  for (const answer of [undefined, '', '   ']) assert.equal(await fx.engine.continue(task.id, ADA, answer), 'Type your answer, or answer in the terminal');
  stillAsking(fx, task.id);
  assert.equal(fx.invocations().length, before);
  assert.equal(fx.repo.listComments(task.id).comments.filter((c) => c.authorKind === 'user').length, 0);
});

test('agent asking for a permission → continue("no") is refused and nothing is typed (Enter would pick its "Yes"); a comment is kept and queued for the turn’s end', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task } = await asking(fx, PERMISSION);
  assert.equal(task.askingKind, 'permission');
  assert.equal(fx.repo.card(task.id)?.askingKind, 'permission');
  const before = fx.invocations().length;

  assert.equal(await fx.engine.continue(task.id, ADA, 'no'), 'The agent is asking for a permission in its terminal: answer it there (⌨️ Open its terminal)');
  stillAsking(fx, task.id);
  assert.equal(fx.repo.listComments(task.id).comments.filter((c) => c.authorKind === 'user').length, 0, 'a refused answer is no comment');

  const { comment } = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', kind: 'message', text: 'no, keep build/' });
  await fx.engine.commented(task.id, comment.id, ADA);
  const now = stillAsking(fx, task.id);
  assert.deepEqual(now.pendingMessages.map((m) => m.text), ['no, keep build/'], 'queued for the turn’s end');
  assert.ok(
    notes(fx, task.id).some((n) => n === 'The agent is asking for a permission in its terminal: answer it there (⌨️ Open its terminal). The comment is kept and goes to it once that turn is over.'),
    notes(fx, task.id).join(' | '),
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fx.invocations().length, before, 'nothing typed into its terminal');
  assert.equal(fx.workers.get(task.workerId!)?.status, 'needs_input');
});

test('agent asking several questions → after the first answer is typed the task keeps waiting while needs_input persists; the last one lets it go on', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task, run } = await asking(fx, { ...ASK, questions: 2, answerDelayMs: 0 });

  assert.equal(await fx.engine.continue(task.id, ADA, 'v2'), undefined);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(typed(fx, 'v2'), 1, 'the first answer typed');
  assert.equal(fx.workers.get(task.workerId!)?.status, 'needs_input');
  assert.equal(stillAsking(fx, task.id).askingKind, 'question', 'still asking, still a question');

  const mark = fx.history(task.id).length;
  assert.equal(await fx.engine.continue(task.id, ADA, 'yes, use v2'), undefined);
  const going = await fx.sawTask(task.id, (x) => x.status === 'in_progress', 'going on after the last answer', 15_000, mark);
  assert.equal(going.runId, run.id, 'on the same run');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(done.summary, 'Used v2.');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => [r.id, r.status]), [[run.id, 'succeeded']]);
});

// --- 3. A review of PRs goes into the named task only when they're all its ----------------------------

test("a PR review naming a task whose PRs aren't all its becomes a review task of its own, naming the tasks involved; the named task is untouched", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, { when: 'Review these pull requests', reply: 'Looked at them.\n\nREVIEW: APPROVED' }]);
  const a = fx.newTask({ usePlan: false, useReview: false, title: 'Task A' });
  await fx.engine.start(a.id, ADA);
  const before = await fx.waitTask(a.id, (x) => x.status === 'review' && x.runState === 'idle', 'A in the review column', 20_000);
  assert.ok(before.branch);
  const b = fx.newTask({ title: 'Task B' });
  fx.repo.upsertPrLink(b.id, { repoId: 'proj', repo: 'acme/proj', number: 8, url: 'https://github.com/acme/proj/pull/8', state: 'OPEN', branch: 'kanban/b' });

  const prs = [
    { repo: 'acme/proj', number: 7, branch: before.branch },
    { repo: 'acme/proj', number: 8, branch: 'kanban/b' },
    { repo: 'acme/proj', number: 9, branch: 'someone-else' },
  ];
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: prs as never, taskId: a.id }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.notEqual(got.taskId, a.id, 'a new task, not A');
  const created = fx.task(got.taskId);
  assert.equal(created.type, 'investigate');
  assert.match(created.title, /^PR review: acme\/proj#7, acme\/proj#8, acme\/proj#9/);
  assert.ok(
    notes(fx, got.taskId).some((n) => n === `This review was asked for on task #${a.id}, but not every pull request is its (acme/proj#8 is #${b.id}'s; acme/proj#9 belongs to no task the kanban knows), so it is a review task of its own.`),
    notes(fx, got.taskId).join(' | '),
  );
  const event = fx.repo.listEvents(got.taskId).find((e) => e.kind === 'pr.review');
  assert.ok(event, 'the request is kept on the new task, for a Retry');
  assert.equal((event.data as { request: { taskId?: number } }).request.taskId, undefined, 'and names no task');
  await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review task done', 20_000);

  const after = fx.task(a.id);
  assert.equal(after.status, 'review');
  assert.equal(after.reviewerWorkerId, undefined);
  assert.deepEqual(fx.repo.listRuns(a.id).map((r) => r.phase), ['implement'], 'no review run on A');
  assert.equal(fx.repo.listEvents(a.id).filter((e) => e.kind === 'pr.review').length, 0);
  assert.ok(!fx.repo.listComments(a.id).comments.some((c) => c.kind === 'review'), 'no findings written into A');

  // Every PR A's (its branch, or linked to it): the review is A's.
  fx.repo.upsertPrLink(a.id, { repoId: 'proj', repo: 'acme/proj', number: 10, url: 'https://github.com/acme/proj/pull/10', state: 'OPEN' });
  const own = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 7, branch: before.branch }, { repo: 'acme/proj', number: 10 }] as never, taskId: a.id }, ADA);
  assert.ok(typeof own !== 'string', String(own));
  if (typeof own !== 'string') assert.equal(own.taskId, a.id);
});
