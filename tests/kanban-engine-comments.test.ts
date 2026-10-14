import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

// A user's comment goes to the agent at once when an implementer is at work, waits when it can't be typed, and is never lost
// (docs/kanban-architecture.md §4, "Comments").

const GRACE = { name: 'Grace', admin: false };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COMMENT = /Comment from Grace on task #\d+ while you work/;
const prompts = (fx: EngineFixture, re: RegExp) => fx.invocations().filter((i) => i.prompt && re.test(i.prompt));
const phases = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).map((r) => r.phase);
async function waitFor(pred: () => boolean, what: string, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!pred() && Date.now() < end) await sleep(30);
  assert.ok(pred(), `timed out waiting for ${what}`);
}
const say = (fx: EngineFixture, taskId: number, text: string, who = GRACE) => {
  const c = fx.repo.addComment({ taskId, authorKind: 'user', authorName: who.name, text }).comment;
  return { c, done: fx.engine.commented(taskId, c.id, who) };
};
/** A task at work: its agent has the prompt and is in a long turn. */
async function working(fx: EngineFixture, rules: Parameters<EngineFixture['setRules']>[0], patch: Parameters<EngineFixture['newTask']>[0] = {}) {
  fx.setRules(rules);
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  await fx.engine.start(task.id, ADA);
  await waitFor(() => fx.invocations().some((i) => i.prompt), 'the agent to get its prompt');
  await sleep(400);
  return task;
}

test('a comment while the implementer works is typed into its terminal at once; the run, phase and round go on, and its answer ends the run', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [
    { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work', delayMs: 1500 },
    { when: 'Comment from Grace', reply: 'Added the log line too.', commit: 'Log' },
  ]);
  const { c, done } = say(fx, task.id, 'Log the redirect target too.\x1b[201~ and nothing else');
  await done;
  assert.equal(fx.task(task.id).pendingMessages.length, 0, 'not queued');
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
  await waitFor(() => prompts(fx, COMMENT).length === 1, 'the comment in the terminal', 5000);
  const typed = prompts(fx, COMMENT)[0].prompt!;
  assert.match(typed, /Log the redirect target too\.\[201~ and nothing else/, 'typed as one paste, an escape can not end it');
  assert.match(typed, /end your final reply with WORK DONE as before/);
  const end = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.deepEqual(phases(fx, task.id), ['implement'], 'no run of its own');
  assert.equal(end.summary, 'Added the log line too.');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
});

test('a comment is queued, with a note, while a reviewer works; the implementer gets it after the round', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(
    fx,
    [
      { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' },
      { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1500 },
      { when: 'commented on task', reply: 'Handled it.', commit: 'Comment' },
    ],
    { useReview: true },
  );
  await fx.waitTask(task.id, (x) => x.phase === 'review' && x.runState === 'running', 'the review round');
  await sleep(400);
  const { c, done } = say(fx, task.id, 'Please also rename foo.');
  await done;
  assert.equal(fx.task(task.id).pendingMessages.length, 1);
  assert.equal(fx.repo.getComment(c.id)?.pending, true);
  assert.ok(fx.repo.listComments(task.id).comments.some((x) => x.kind === 'status' && /review round is running/.test(x.text)));
  assert.equal(prompts(fx, COMMENT).length, 0, 'the reviewer is not the one to take it');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && phases(fx, x.id).includes('resume'), 'the comment worked on', 30_000);
  assert.equal(fx.task(task.id).pendingMessages.length, 0);
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
});

test('a comment queued with files keeps them in its text', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [{ when: 'You are planning kanban task', reply: 'Plan.\n\nPLAN READY', delayMs: 1500, exitPlan: 'The plan' }], { usePlan: true, planApproval: 'manual' });
  const stored = `${'a'.repeat(32)}-mock.png`;
  mkdirSync(path.join(fx.ctx.filesDir, 'uploads'), { recursive: true });
  writeFileSync(path.join(fx.ctx.filesDir, 'uploads', stored), 'img');
  fx.repo.addAttachment({ id: 'a'.repeat(32), name: 'mock.png', mime: 'image/png', size: 3, stored, createdBy: 'Grace', createdAt: Date.now() });
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Grace', text: 'See the mock.' }).comment;
  fx.repo.linkAttachments(['a'.repeat(32)], task.id, c.id);
  await fx.engine.commented(task.id, c.id, GRACE);
  const [kept] = fx.task(task.id).pendingMessages;
  assert.ok(kept, 'a plan run is no implementer at work: the comment waits');
  assert.match(kept.text, /See the mock\./);
  assert.match(kept.text, /mock\.png/, 'its file is in the queued text, not dropped');
  assert.equal(prompts(fx, COMMENT).length, 0);
});

test('a comment made while the run stops is worked on once it has stopped; older queued ones wait for Retry or Continue', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [
    { when: 'Implement kanban task', reply: 'Never.', delayMs: 30_000, escSilent: true, escStopMs: 900 },
    { when: 'commented on task', reply: 'Handled it.', commit: 'Comment' },
  ]);
  const old = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'An older note.' }).comment;
  fx.repo.setCommentPending(old.id, true);
  fx.repo.updateTask(task.id, { pendingMessages: [{ commentId: old.id, text: 'An older note.', by: 'Ada', at: Date.now() - 60_000 }] });
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  assert.equal(fx.task(task.id).runState, 'stopping');
  const { c, done } = say(fx, task.id, 'Rename foo to bar after all.');
  await done;
  assert.equal(fx.task(task.id).pendingMessages.length, 2, 'queued while it stops');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the comment worked on after the stop', 30_000);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.status}`).slice(0, 2), ['implement/stopped', 'resume/succeeded']);
  const resume = prompts(fx, /commented on task/)[0].prompt!;
  assert.match(resume, /Rename foo to bar after all\./);
  assert.doesNotMatch(resume, /An older note/, 'the older one is not part of it');
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
});

test('a resume run stopped before its agent took the comment puts it back in the queue; Retry carries it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [{ when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' }]);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  // The comment's prompt is typed, but the agent is slow to take it (it has not submitted it).
  fx.setRules([{ when: 'commented on task', reply: 'Renamed.', commit: 'Rename', submitDelayMs: 6000 }]);
  const { c, done } = say(fx, task.id, 'Also rename foo to bar.', ADA);
  await done;
  await fx.waitTask(task.id, (x) => x.phase === 'resume' && x.runState === 'running', 'the comment run');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 30_000);
  assert.equal(stopped.pendingMessages.length, 1, 'the comment is queued again');
  assert.equal(stopped.pendingMessages[0].commentId, c.id);
  assert.equal(fx.repo.getComment(c.id)?.pending, true);
  fx.setRules([{ when: 'was cut short', reply: 'Renamed foo to bar.', commit: 'Rename' }]);
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column after Retry', 30_000);
  assert.ok(prompts(fx, /Also rename foo to bar\./).length >= 1);
  assert.equal(fx.task(task.id).pendingMessages.length, 0);
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
});

test('a comment after the run ended is typed at once even though a teammate looks busy in the log: no ten minute wait for it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = fx.newTask({ usePlan: false, useReview: false });
  fx.setRules([
    { when: 'Implement kanban task', teammates: 'Waiting for the helper.', teamEnds: 'busy', teammatesMs: 300, reply: 'All done.', commit: 'Work' },
    { when: 'commented on task', reply: 'Renamed.', commit: 'Rename' },
  ]);
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  const { done } = say(fx, task.id, 'Also rename foo to bar.', ADA);
  await done;
  await waitFor(() => prompts(fx, /Also rename foo to bar\./).length >= 1, 'the comment typed in', 5000);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && phases(fx, x.id).includes('resume'), 'the comment worked on', 30_000);
});

test('codex: a comment typed while the turn ends in WORK DONE does not end the run: the comment\'s turn answers', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(
    fx,
    [
      { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work', delayMs: 1500 },
      { when: 'Comment from Grace', reply: 'Added the log line too.', commit: 'Log' },
    ],
    { tool: 'codex' },
  );
  await say(fx, task.id, 'Log the redirect target too.').done;
  const end = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.deepEqual(phases(fx, task.id), ['implement']);
  assert.equal(end.summary, 'Added the log line too.', 'the run did not end on the first turn');
});
