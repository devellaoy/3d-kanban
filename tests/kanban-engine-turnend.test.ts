import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

// The end of a turn is the agent's final marker (WORK DONE, PLAN READY / QUESTIONS:, the review's verdict), not what the log heuristics
// guess: a turn without it is an interim update the run waits through, and an agent that rested without giving it is nudged (docs/kanban-architecture.md §4).

const NUDGE = 'If your work on this task is finished';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reviewRuns = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).filter((r) => r.phase === 'review').length;
const nudges = (fx: EngineFixture) => fx.invocations().filter((i) => i.prompt?.includes(NUDGE)).length;
const results = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'result').map((c) => c.text);

test('#358: a reply that only waits for a teammate (no WORK DONE, counters 0) is no end: no review, no comment; the next reply with the marker is', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Waiting for the UI implementer for more information.', noMarker: true, commit: 'Work' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await fx.waitTask(task.id, () => fx.workers.get(fx.task(task.id).workerId!)?.status === 'done', 'the first Stop');
  await sleep(800);
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  assert.equal(reviewRuns(fx, task.id), 0);
  assert.deepEqual(results(fx, task.id), [], 'an interim update is no comment');
  // The agent goes on by itself and gives the marker: that turn is the end.
  fx.setRules([
    { when: 'Implement kanban task', reply: 'unused', noMarker: true },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
    { when: 'UI implementer answered', reply: 'Implemented it with the UI parts.\nWORK DONE', commit: 'More' },
  ]);
  fx.workers.prompt(fx.task(task.id).workerId!, 'The UI implementer answered: use the new endpoint.');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review after the marker', 30_000);
  assert.deepEqual(results(fx, task.id), ['Implemented it with the UI parts.'], 'the marker line is not in the comment');
  assert.equal(fx.task(task.id).summary, 'Implemented it with the UI parts.');
});

test('a resting agent that never gave its marker is nudged for it, and the answer to the nudge ends the run', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 700 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Changed the redirect.', noMarker: true, commit: 'Work' },
    { when: NUDGE, reply: 'Yes, finished: the redirect keeps the query.' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await sleep(300);
  assert.equal(nudges(fx), 0, 'not before the agent has rested a while');
  assert.equal(fx.task(task.id).status, 'in_progress');
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column after the nudge', 20_000);
  assert.equal(nudges(fx), 1);
  assert.deepEqual(results(fx, task.id), ['Yes, finished: the redirect keeps the query.']);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
});

test('an agent that is nudged as often as it may be without ever giving the marker: the run ends, the task waits for the user with the last text shown', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 150, maxNudges: 2 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Changed the redirect.', noMarker: true, commit: 'Work' },
    { when: NUDGE, reply: 'Still looking at it.', noMarker: true },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the task waiting', 30_000);
  assert.match(waiting.waitingText ?? '', /never gave its final answer \(WORK DONE\)/);
  assert.equal(nudges(fx), 2, 'asked as many times as allowed, no more');
  assert.deepEqual(results(fx, task.id), [], 'not a result');
  assert.equal(fx.repo.listComments(task.id).comments.find((c) => c.kind === 'message')?.text, 'Still looking at it.', 'its last text stays visible');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'failed');
  assert.equal(reviewRuns(fx, task.id), 0);
});

test('an agent working in the log (a background agent out) is not nudged: the next Stop decides', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 150 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'The helper agent is at it; I will wait.', reply: 'Changed the redirect.', commit: 'Work', backgroundMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 20_000);
  assert.equal(nudges(fx), 0);
  assert.deepEqual(results(fx, task.id), ['Changed the redirect.']);
});

test('the marker ends the run whatever the counters say: a teammate whose transcript still ends mid-tool does not hold it (and one that approved its shutdown never did)', async (t) => {
  for (const teamEnds of ['busy', 'shutdown'] as const) {
    const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
    t.after(() => fx.close());
    fx.setRules([
      { when: 'Implement kanban task', teammates: 'Waiting for the helper.', teamEnds, teammatesMs: 300, reply: `All done (${teamEnds}).`, commit: 'Work' },
      { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
    ]);
    const task = fx.newTask({ usePlan: false, useReview: true });
    await fx.engine.start(task.id, ADA);
    await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, `the review after the final reply (${teamEnds})`, 30_000);
    assert.deepEqual(results(fx, task.id), [`All done (${teamEnds}).`]);
  }
});

test('codex: a task_complete without the marker is an interim update; the run waits, and the nudge gets the marker', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 900 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Looking at the helper output.', noMarker: true, commit: 'Work' },
    { when: NUDGE, reply: 'The redirect is fixed.' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false, tool: 'codex' });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await sleep(500);
  assert.equal(fx.task(task.id).status, 'in_progress', 'without the marker it waits');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column after the nudge', 20_000);
  assert.deepEqual(results(fx, task.id), ['The redirect is fixed.']);
});

test('a review reply without a verdict line is an interim update too: nudged for the verdict', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 500 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'You are reviewing the work', reply: 'Reading the diff.' },
    { when: 'If your review is finished', reply: 'Looks right.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review column after the verdict', 30_000);
  assert.deepEqual(fx.repo.listRuns(task.id).filter((r) => r.phase === 'review').map((r) => r.verdict), ['approved']);
});

// #464: a person's prompt typed while the office's turn works is absorbed into it; the Stop can come before the final answer is logged.
const typedWhileWorking = { when: 'Implement kanban task', earlier: 'Working on it.', queuedMidTurn: 'How is it going?', commit: 'Work' };

test('#464: a typed prompt absorbed into the turn, the Stop before the log has the final answer: the Stop hook\'s WORK DONE ends the run', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000, readTries: 3 } });
  t.after(() => fx.close());
  fx.setRules([{ ...typedWhileWorking, reply: 'Changed the redirect.', lateLogMs: -1 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 20_000);
  assert.deepEqual(results(fx, task.id), ['Changed the redirect.']);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
  assert.equal(nudges(fx), 0);
});

test('#464: the same, the final answer reaching the log during the read retries: the run ends on the log\'s own answer', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([{ ...typedWhileWorking, reply: 'From the Stop.', lateLogReply: 'From the log.\nWORK DONE', lateLogMs: 300 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 20_000);
  assert.deepEqual(results(fx, task.id), ['From the log.']);
});

test('#464: an interim answer of the office\'s (complete, no marker), then a typed turn that ends WORK DONE with its Stop before its log line: the run ends', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'I have a draft, tell me if I should finish.', noMarker: true, commit: 'Work', typedAfterStop: 'yes finish it', typedReply: 'Finished it.\nWORK DONE', typedLagMs: 300 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 20_000);
  assert.deepEqual(results(fx, task.id), ['Finished it.']);
  assert.equal(nudges(fx), 0);
});

test('#464: a hold for a typed turn\'s Stop that never comes is looked at again after the nudge interval: the log then decides', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 1000, readTries: 2 } });
  t.after(() => fx.close());
  // The Stop carries no text and no other Stop follows; the log has the final answer 400 ms after it.
  fx.setRules([{ ...typedWhileWorking, reply: '', noMarker: true, lateLogReply: 'Changed the redirect.\nWORK DONE', lateLogMs: 400 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await sleep(700);
  assert.equal(fx.task(task.id).status, 'in_progress', 'held before the look');
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column after the look', 20_000);
  assert.deepEqual(results(fx, task.id), ['Changed the redirect.']);
  assert.equal(nudges(fx), 0);
});

test('#464: a typed turn that really is still running (no answer in the log, no Stop text; or a tool still running) stays held', async (t) => {
  for (const open of [false, true]) {
    const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000, readTries: 2 } });
    t.after(() => fx.close());
    fx.setRules([open ? { ...typedWhileWorking, queuedToolOpen: true, reply: 'Stopped mid tool.', lateLogMs: -1 } : { ...typedWhileWorking, reply: '', noMarker: true, lateLogMs: -1 }]);
    const task = fx.newTask({ usePlan: false, useReview: false });
    await fx.engine.start(task.id, ADA);
    await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
    await sleep(1500);
    assert.equal(fx.task(task.id).status, 'in_progress', `open tool: ${open}`);
    assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
    assert.equal(nudges(fx), 0);
  }
});
