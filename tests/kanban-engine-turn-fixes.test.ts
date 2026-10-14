import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hearPrompt } from '../src/server/kanban/engine/comments.js';
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

test('a Stop while the resume run waits for its starting worker puts the comment it was started with back in the queue', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [{ when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' }]);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  // Its worker is (made to look) still starting: the comment's run waits for it.
  const [w] = fx.workers.list();
  (fx.workers.get(w.id) as { status: string }).status = 'starting';
  // The run holds the task's chain while it waits, so the comment is not awaited here.
  const { c, done } = say(fx, task.id, 'Also rename foo to bar.', ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'resume' && x.runState === 'starting', 'the comment run');
  await sleep(300);
  assert.equal(fx.task(task.id).pendingMessages.length, 0, 'taken for the run');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  await done;
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 30_000);
  assert.deepEqual(stopped.pendingMessages.map((m) => m.commentId), [c.id], 'the comment is not lost');
  assert.equal(fx.repo.getComment(c.id)?.pending, true);
});

/** An upload that is nobody's yet (as the answer, comment and request-changes boxes leave it), with its file on disk. */
function orphan(fx: EngineFixture, id: string, name: string) {
  mkdirSync(path.join(fx.ctx.filesDir, 'uploads'), { recursive: true });
  writeFileSync(path.join(fx.ctx.filesDir, 'uploads', `${id}-${name}`), 'img');
  fx.repo.addAttachment({ id, name, mime: 'image/png', size: 3, stored: `${id}-${name}`, createdBy: 'Ada', createdAt: Date.now() });
  return `![${name}](/api/kanban/attachments/${id})`;
}
const GRANT = /grants[\\/]task-\d+[\\/]/;

test('Continue\'s answer and a plan change request turn the links of their unattached uploads into paths, before the files are linked', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [{ when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' }, { when: 'was cut short', reply: 'Handled.', commit: 'More' }]);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  fx.repo.updateTask(task.id, { status: 'waiting', waitingReason: 'stopped', runState: 'idle' });
  const link = orphan(fx, '3'.repeat(32), 'cont.png');
  assert.equal(await fx.engine.continue(task.id, ADA, `Like this ${link}`, ['3'.repeat(32)]), undefined);
  await waitFor(() => prompts(fx, /Like this/).length > 0, 'the answer in a prompt');
  const sent = prompts(fx, /Like this/)[0].prompt!;
  assert.match(sent, GRANT, 'a path the agent can read');
  assert.doesNotMatch(sent, /api\/kanban\/attachments/);
  assert.equal(fx.repo.getAttachment('3'.repeat(32))?.taskId, task.id);
});

test('an answer typed to a question and a plan change request resolve their uploads to paths too', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Which colour?', ask: 'question' }, { when: 'grants', reply: 'Blue then.\n\nWORK DONE', commit: 'Blue' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  const link = orphan(fx, '4'.repeat(32), 'ans.png');
  assert.equal(await fx.engine.continue(task.id, ADA, `This one ${link}`, ['4'.repeat(32)]), undefined);
  await waitFor(() => prompts(fx, /This one/).length > 0, 'the answer typed in');
  const typed = prompts(fx, /This one/)[0].prompt!;
  assert.match(typed, GRANT);
  assert.doesNotMatch(typed, /api\/kanban\/attachments/);

  const fx2 = await engineFixture();
  t.after(() => fx2.close());
  fx2.setRules([{ when: 'You are planning kanban task', reply: 'Plan.\n\nPLAN READY', exitPlan: 'The plan' }, { when: 'Like this', reply: 'Plan 2.\n\nPLAN READY', exitPlan: 'Plan two' }]);
  const t2 = fx2.newTask({ usePlan: true, planApproval: 'manual', useReview: false });
  await fx2.engine.start(t2.id, ADA);
  await fx2.waitTask(t2.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan');
  const link2 = orphan(fx2, '5'.repeat(32), 'plan.png');
  assert.equal(await fx2.engine.requestPlanChanges(t2.id, ADA, `Like this ${link2}`, ['5'.repeat(32)]), undefined);
  await waitFor(() => prompts(fx2, /Like this/).length > 0, 'the change request in a prompt');
  const sent = prompts(fx2, /Like this/)[0].prompt!;
  assert.match(sent, GRANT);
  assert.doesNotMatch(sent, /api\/kanban\/attachments/);
});

test('claude: a typed comment the log never shows within the wait is not answered by the older turn\'s WORK DONE: the run ends unfinished and the comment is kept', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [
    { when: 'Implement kanban task', earlier: 'Working on it.', reply: 'Implemented.', commit: 'Work', delayMs: 1500, lateLogMs: -1 },
    { when: 'Comment from Grace', reply: 'Added the log line too.', commit: 'Log', submitDelayMs: 30_000 },
  ]);
  const { c, done } = say(fx, task.id, 'Log the redirect target too.');
  await done;
  // The wait for the comment to show in the log (15 min) is over when the first turn stops.
  const real = Date.now;
  mock.method(Date, 'now', () => real() + 20 * 60_000);
  t.after(() => mock.restoreAll());
  const end = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the task waiting', 30_000);
  assert.deepEqual(end.pendingMessages.map((m) => m.commentId), [c.id], 'the comment is queued again');
  assert.equal(fx.repo.getComment(c.id)?.pending, true);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'failed');
  assert.ok(fx.repo.listComments(task.id).comments.some((x) => x.kind === 'status' && /never received a comment/.test(x.text)));
  assert.ok(!fx.repo.listComments(task.id).comments.some((x) => x.kind === 'result'), 'the older turn\'s answer is not shown as the result');
});

test('codex: a typed comment the rollout never shows within the wait is not answered by the older turn\'s WORK DONE either', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(
    fx,
    [
      { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work', delayMs: 1500 },
      { when: 'Comment from Grace', reply: 'Added the log line too.', commit: 'Log', submitDelayMs: 30_000 },
    ],
    { tool: 'codex' },
  );
  const { c, done } = say(fx, task.id, 'Log the redirect target too.');
  await done;
  const real = Date.now;
  mock.method(Date, 'now', () => real() + 20 * 60_000);
  t.after(() => mock.restoreAll());
  const end = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the task waiting', 30_000);
  assert.deepEqual(end.pendingMessages.map((m) => m.commentId), [c.id]);
  assert.ok(!fx.repo.listComments(task.id).comments.some((x) => x.kind === 'result'));
});

test('a prompt hook hears only the comment it carries, or the oldest one waiting when it names none', () => {
  const mk = () => [{ head: 'Comment from Grace on task #3 while you work: A' }, { head: 'Comment from Grace on task #3 while you work: B' }];
  const p = mk();
  hearPrompt(p, 'Comment from  Grace on task #3 while you work:\nB please');
  assert.deepEqual(p.map((x) => (x as { heard?: boolean }).heard), [undefined, true]);
  hearPrompt(p, 'Something somebody typed');
  assert.deepEqual(p.map((x) => (x as { heard?: boolean }).heard), [undefined, true], 'not the office\'s comment');
  const q = mk();
  hearPrompt(q, undefined);
  hearPrompt(q, undefined);
  assert.deepEqual(q.map((x) => (x as { heard?: boolean }).heard), [true, true]);
});

test('a Stop before the agent took a comment typed into it gives the comment back; Retry carries it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await working(fx, [
    { when: 'Implement kanban task', reply: 'Never.', delayMs: 30_000, escSilent: true, escStopMs: 900 },
    { when: 'Comment from Grace', reply: 'Took it.', submitDelayMs: 30_000 },
  ]);
  const { c, done } = say(fx, task.id, 'Rename foo to bar.');
  await done;
  assert.equal(fx.task(task.id).pendingMessages.length, 0, 'typed in, not queued');
  await sleep(50); // a comment made in the very millisecond of the Stop counts as made during it
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 30_000);
  assert.deepEqual(stopped.pendingMessages.map((m) => m.commentId), [c.id], 'back in the queue');
  assert.equal(fx.repo.getComment(c.id)?.pending, true);
  fx.setRules([{ when: 'was cut short', reply: 'Renamed.\n\nWORK DONE', commit: 'Rename' }]);
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column after Retry', 30_000);
  assert.ok(prompts(fx, /Rename foo to bar\./).length >= 2, 'the retry prompt carries it');
  assert.equal(fx.task(task.id).pendingMessages.length, 0);
});
