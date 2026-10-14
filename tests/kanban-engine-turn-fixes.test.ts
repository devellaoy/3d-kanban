import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

// Review round 1 of #392: the turn end waits for unheard comments even on the Stop hook's answer, queue-started runs keep what they took,
// a Stop's older comments stay parked through the automatic chain, Codex comments queue, and files whose link was removed are not listed.

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
async function working(fx: EngineFixture, rules: Parameters<EngineFixture['setRules']>[0], patch: Parameters<EngineFixture['newTask']>[0] = {}) {
  fx.setRules(rules);
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  await fx.engine.start(task.id, ADA);
  await waitFor(() => fx.invocations().some((i) => i.prompt), 'the agent to get its prompt');
  await sleep(400);
  return task;
}

test('an older turn\'s WORK DONE on the Stop hook\'s answer does not end the run before a comment typed meanwhile is heard', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [
    // The log never gets the first turn's final answer: only the Stop hook carries it.
    { when: 'Implement kanban task', earlier: 'Working on it.', reply: 'Implemented.', commit: 'Work', delayMs: 1500, lateLogMs: -1 },
    // Its agent is slow to take the comment: when the first turn stops, the log does not show it yet.
    { when: 'Comment from Grace', reply: 'Added the log line too.', commit: 'Log', submitDelayMs: 4000 },
  ]);
  await say(fx, task.id, 'Log the redirect target too.').done;
  const end = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.ok(prompts(fx, COMMENT).length >= 1, 'the comment reached the terminal');
  assert.deepEqual(phases(fx, task.id), ['implement']);
  assert.equal(end.summary, 'Added the log line too.', 'the run did not end on the older turn');
});

test('a queued run that took several comments puts them all back when it is stopped before its agent has the prompt; Retry carries them', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(
    fx,
    [
      { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' },
      { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1500 },
    ],
    { useReview: true },
  );
  await fx.waitTask(task.id, (x) => x.phase === 'review' && x.runState === 'running', 'the review round');
  await sleep(400);
  fx.setRules([{ when: 'commented on task', reply: 'Handled.', commit: 'Comment', submitDelayMs: 6000 }]);
  const a = say(fx, task.id, 'First note.');
  await a.done;
  const b = say(fx, task.id, 'Second note.');
  await b.done;
  assert.equal(fx.task(task.id).pendingMessages.length, 2);
  await fx.waitTask(task.id, (x) => x.phase === 'resume' && x.runState === 'running', 'the delivery run');
  assert.equal(fx.task(task.id).pendingMessages.length, 0, 'taken for the run');
  const runId = fx.repo.listRuns(task.id).at(-1)!.id;
  assert.deepEqual(fx.repo.runLaunch(runId)?.taken?.map((m) => m.commentId), [a.c.id, b.c.id], 'kept with the run (and so over a restart) until its prompt is acknowledged');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 30_000);
  assert.deepEqual(stopped.pendingMessages.map((m) => m.commentId), [a.c.id, b.c.id], 'both are queued again');
  assert.equal(fx.repo.getComment(a.c.id)?.pending, true);
  assert.equal(fx.repo.getComment(b.c.id)?.pending, true);
  fx.setRules([
    { when: 'was cut short', reply: 'Handled both.', commit: 'Both' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column after Retry', 30_000);
  assert.ok(prompts(fx, /First note\./).length && prompts(fx, /Second note\./).length, 'Retry carried both');
  assert.equal(fx.task(task.id).pendingMessages.length, 0);
});

test('after a Stop only the comments made since it are delivered, and the older ones stay put through the run that follows', async (t) => {
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
  await say(fx, task.id, 'Rename foo to bar after all.').done;
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the comment worked on after the stop', 30_000);
  // The chain is over with the second turn end: the older note did not start a run of its own.
  await sleep(1500);
  assert.deepEqual(phases(fx, task.id), ['implement', 'resume']);
  const left = fx.task(task.id).pendingMessages;
  assert.deepEqual(left.map((m) => [m.commentId, m.parked]), [[old.id, true]]);
  assert.equal(fx.repo.getComment(old.id)?.pending, true);
});

test('codex: a comment while the turn works is typed in at once; a WORK DONE turn before it is heard does not end the run', async (t) => {
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
  assert.equal(fx.task(task.id).pendingMessages.length, 0, 'not queued');
  const end = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.ok(prompts(fx, COMMENT).length >= 1, 'typed into the terminal');
  assert.deepEqual(phases(fx, task.id), ['implement']);
  assert.equal(end.summary, 'Added the log line too.', 'the run did not end on the first turn');
});

test('a file uploaded for a comment and taken out of the text before sending is nobody\'s: the next prompt does not list it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [{ when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' }]);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  const [gone, kept] = ['1'.repeat(32), '2'.repeat(32)];
  mkdirSync(path.join(fx.ctx.filesDir, 'uploads'), { recursive: true });
  for (const [id, name] of [[gone, 'removed.png'], [kept, 'kept.png']] as const) {
    writeFileSync(path.join(fx.ctx.filesDir, 'uploads', `${id}-${name}`), 'img');
    // The boxes upload unattached (no ?task=): the message links what its text still has.
    fx.repo.addAttachment({ id, name, mime: 'image/png', size: 3, stored: `${id}-${name}`, createdBy: 'Grace', createdAt: Date.now() });
  }
  fx.setRules([{ when: 'commented on task', reply: 'Handled it.', commit: 'Comment' }]);
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Grace', text: `See ![kept](/api/kanban/attachments/${kept})` }).comment;
  fx.repo.linkAttachments([kept], task.id, c.id);
  await fx.engine.commented(task.id, c.id, GRACE);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && phases(fx, x.id).includes('resume'), 'the comment worked on', 30_000);
  assert.deepEqual(fx.repo.listAttachments(task.id).map((a) => a.id), [kept], 'the removed one never became the task\'s');
  const sent = prompts(fx, /kept\.png|grants/).map((i) => i.prompt!).join('\n');
  assert.doesNotMatch(sent, /removed\.png/);
});
