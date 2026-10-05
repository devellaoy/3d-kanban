// A kanban run that was mid-step when the whole office was shut down and started again carries on by itself
// (docs/kanban-architecture.md §4, "After a full restart"; engine/restart.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

const RESTARTED = /The office was restarted while you were working on this task, and your turn was cut off/;
const fixture = () => engineFixture({ engine: { restartStaggerMs: 50 } });
const prompts = (fx: EngineFixture, re: RegExp) => fx.invocations().filter((i) => i.prompt && re.test(i.prompt));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The implement run's agent has its prompt and is mid-turn. */
async function midTurn(fx: EngineFixture, taskId: number) {
  await fx.engine.start(taskId, ADA);
  await fx.waitTask(taskId, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement run');
  const end = Date.now() + 15_000;
  while (!prompts(fx, /Implement kanban task/).length && Date.now() < end) await sleep(30);
  const run = fx.repo.activeRun(taskId)!;
  while (fx.workers.get(run.workerId!)?.status !== 'working' && Date.now() < end) await sleep(30);
  return run;
}

const RULES = [
  { when: 'office was restarted', reply: 'Finished after the restart.', commit: 'Work' },
  { when: 'Implement kanban task', reply: 'Finished before the restart.', commit: 'Work', delayMs: 60_000 },
];

test('a run cut off mid-turn by a full restart carries on by itself and the task finishes normally', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished after the restart.');
  assert.equal(prompts(fx, RESTARTED).length, 1, 'the continue prompt says the office was restarted');
  assert.match(prompts(fx, RESTARTED)[0].prompt!, /Your last turn on task #\d+ was cut short/);
  assert.equal(fx.repo.getRun(run.id)?.status, 'interrupted');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.status}`), ['implement/interrupted', 'implement/succeeded']);
});

test('a turn that had finished when the office stopped is handled, not run again', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Finished before the restart.', commit: 'Work', delayMs: 1500 }, { when: 'office was restarted', reply: 'Should not be asked.' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  // The office is gone before the Stop is heard, so the run is still `running` in the database when the worker is done.
  fx.engine.dispose();
  const end = Date.now() + 15_000;
  while (fx.workers.get(run.workerId!)?.status !== 'done' && Date.now() < end) await sleep(30);
  assert.equal(fx.repo.getRun(run.id)?.status, 'running');
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished before the restart.');
  assert.equal(fx.repo.getRun(run.id)?.status, 'succeeded');
  assert.equal(fx.repo.listRuns(task.id).length, 1, 'no run was started again');
  await sleep(300);
  assert.equal(fx.invocations().filter((i) => i.prompt).length, 1, 'nothing was typed after the restart');
});

test('a run held for background work carries on after a full restart', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'office was restarted', reply: 'Finished after the restart.', commit: 'Work' }, { when: 'Implement kanban task', background: 'Waiting for the helper agent.', releaseFile: path.join(fx.root, 'never'), reply: 'unused' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  const end = Date.now() + 15_000;
  while (fx.repo.runHeldAt(run.id) === undefined && Date.now() < end) await sleep(30);
  assert.ok(fx.repo.runHeldAt(run.id), 'the hold is kept on the run');
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished after the restart.');
  assert.equal(prompts(fx, RESTARTED).length, 1);
});

test('tasks waiting for the user stay waiting: nobody is nudged', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Plan kanban task', reply: 'Plan ready.', exitPlan: 'The plan.' }]);
  const task = fx.newTask({ usePlan: true, planApproval: 'manual', useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan waiting for approval');
  const before = fx.invocations().filter((i) => i.prompt).length;
  await fx.restartOffice();
  await sleep(600);
  const after = fx.task(task.id);
  assert.deepEqual([after.status, after.waitingReason, after.runState], ['waiting', 'plan_approval', 'idle']);
  assert.equal(fx.invocations().filter((i) => i.prompt).length, before, 'no prompt was typed');
});

test('an agent asking a question keeps the task waiting; its run is finished and the question is noted', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Which colour?', ask: 'question' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  await fx.restartOffice();
  const end = Date.now() + 15_000;
  while (fx.repo.getRun(run.id)?.status === 'running' && Date.now() < end) await sleep(30);
  assert.equal(fx.repo.getRun(run.id)?.status, 'interrupted');
  const after = fx.task(task.id);
  assert.deepEqual([after.status, after.waitingReason], ['waiting', 'agent_asking']);
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => /restarted while its agent was asking/.test(c.text)));
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a run cut off at a permission prompt (needs input) keeps the task waiting for the user, even with its worktree gone', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'May I?', ask: true }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  const tree = fx.task(task.id).workspace!.worktree.path;
  await fx.restartOffice({ beforeStart: () => rmSync(path.join(fx.dir, tree), { recursive: true, force: true }) });
  const end = Date.now() + 15_000;
  while (fx.repo.getRun(run.id)?.status === 'running' && Date.now() < end) await sleep(30);
  assert.equal(fx.repo.getRun(run.id)?.status, 'interrupted');
  await sleep(300);
  assert.deepEqual([fx.task(task.id).status, fx.task(task.id).waitingReason], ['waiting', 'agent_asking']);
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => /restarted while its agent was asking/.test(c.text)));
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('with the office budget spent a cut-off run is only interrupted, with a note why', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await midTurn(fx, task.id);
  fx.ctx.hiringPaused = () => 'The daily budget is spent';
  await fx.restartOffice();
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /Retry to carry on/);
  await sleep(500);
  assert.equal(fx.task(task.id).status, 'waiting');
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => /daily budget is spent/.test(c.text)));
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('with the setting off a cut-off run is interrupted and waits for a Retry', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await midTurn(fx, task.id);
  await fx.restartOffice({ carryOn: false });
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /Retry to carry on/);
  await sleep(500);
  assert.equal(fx.task(task.id).status, 'waiting', 'it stays');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a worktree that is gone is not carried on in: the run is interrupted with the reason', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await midTurn(fx, task.id);
  const tree = fx.task(task.id).workspace!.worktree.path;
  await fx.restartOffice({ beforeStart: () => rmSync(path.join(fx.dir, tree), { recursive: true, force: true }) });
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /worktree is gone/);
  await sleep(500);
  assert.equal(fx.task(task.id).status, 'waiting');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a Claude session that is gone is not resumed: the run is interrupted with the reason', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  // The worker's own session (the task hasn't stored one yet) has no transcript any more, in a projects folder that knows no other.
  rmSync(fx.workers.transcripts(run.workerId!)!.claude!, { force: true });
  mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'x'), { recursive: true });
  assert.equal(fx.task(task.id).sessionId, undefined);
  await fx.restartOffice();
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /session is gone/);
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a turn that ended with background work still out in its log carries on instead of being handled as finished', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'office was restarted', reply: 'Finished after the restart.', commit: 'Work' }, { when: 'Implement kanban task', background: 'Waiting for the helper agent.', releaseFile: path.join(fx.root, 'never'), reply: 'unused', delayMs: 800 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  // The office is gone before it hears the Stop, so the run isn't held in the database although its helper is out.
  fx.engine.dispose();
  const end = Date.now() + 15_000;
  while (fx.workers.get(run.workerId!)?.status !== 'done' && Date.now() < end) await sleep(30);
  assert.equal(fx.repo.runHeldAt(run.id), undefined);
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished after the restart.');
  assert.equal(prompts(fx, RESTARTED).length, 1);
});

test('with the project at its limit of 2, a restart never lets a third task start before one of the two finishes', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const [a, b, c] = [fx.newTask({ usePlan: false, useReview: false }), fx.newTask({ usePlan: false, useReview: false }), fx.newTask({ usePlan: false, useReview: false })];
  for (const x of [a, b]) {
    await fx.engine.start(x.id, ADA);
    await fx.waitTask(x.id, (y) => y.runState === 'running', 'running');
  }
  await fx.engine.start(c.id, ADA);
  assert.equal(fx.task(c.id).runState, 'queued');
  await sleep(1000);
  await fx.restartOffice();
  const end = Date.now() + 60_000;
  while ((fx.task(a.id).status !== 'review' || fx.task(b.id).status !== 'review') && Date.now() < end) {
    const active = [a, b, c].filter((x) => fx.repo.listRuns(x.id).some((r) => r.status === 'running') || (fx.task(x.id).status === 'in_progress' && fx.task(x.id).queuedRun)).length;
    assert.ok(active <= 2, `${active} tasks active at once`);
    if (fx.task(a.id).status === 'in_progress' && fx.task(b.id).status === 'in_progress') assert.equal(fx.repo.listRuns(c.id).length, 0, 'the third has no run yet');
    await sleep(40);
  }
  assert.equal(fx.task(a.id).status, 'review');
  assert.equal(fx.task(b.id).status, 'review');
});

test('two restarts in a row before the stagger fires: both runs still carry on', async (t) => {
  const fx = await engineFixture({ engine: { restartStaggerMs: 1500 } });
  t.after(() => fx.close());
  fx.setRules(RULES);
  const [a, b] = [fx.newTask({ usePlan: false, useReview: false }), fx.newTask({ usePlan: false, useReview: false })];
  for (const x of [a, b]) {
    await fx.engine.start(x.id, ADA);
    await fx.waitTask(x.id, (y) => y.runState === 'running', 'running');
  }
  await sleep(1000);
  await fx.restartOffice();
  await fx.restartOffice();
  for (const x of [a, b]) {
    const done = await fx.waitTask(x.id, (y) => y.status === 'review' && y.runState === 'idle', 'the review column', 90_000);
    assert.equal(done.summary, 'Finished after the restart.');
  }
});

test('the setting turned off between the restart and the run starting: the task waits interrupted with a note', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const [a, b] = [fx.newTask({ usePlan: false, useReview: false }), fx.newTask({ usePlan: false, useReview: false })];
  for (const x of [a, b]) {
    await fx.engine.start(x.id, ADA);
    await fx.waitTask(x.id, (y) => y.runState === 'running', 'running');
  }
  await sleep(1000);
  await fx.restartOffice();
  // The first run is already on its way; the second waits behind it in the queue.
  fx.ctx.hiringPaused = () => 'The daily budget is spent';
  const waiting = await fx.waitTask(b.id, (y) => y.status === 'waiting' && y.waitingReason === 'interrupted', 'the second task waiting', 60_000);
  assert.match(waiting.waitingText ?? '', /Retry to carry on/);
  assert.ok(fx.repo.listComments(b.id).comments.some((c) => /daily budget is spent/.test(c.text)));
  await fx.waitTask(a.id, (y) => y.status === 'review', 'the first task done', 60_000);
});

test('a pull-request review cut off by a restart goes on with its own reviewer, not a fresh one', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'office was restarted', reply: 'They fit together.\n\nREVIEW: APPROVED' }, { when: 'Review these pull requests', reply: 'unused', delayMs: 60_000 }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 3 }, { repo: 'acme/proj', number: 4 }] as never, tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  const taskId = (got as { taskId: number }).taskId;
  const end = Date.now() + 15_000;
  while (!prompts(fx, /Review these pull requests/).length && Date.now() < end) await sleep(30);
  const first = fx.repo.activeRun(taskId)!;
  await fx.restartOffice();
  await fx.waitTask(taskId, (x) => x.runState === 'idle' && x.status !== 'in_progress', 'the review done', 60_000);
  const runs = fx.repo.listRuns(taskId);
  assert.deepEqual(runs.map((r) => `${r.phase}/${r.status}`), ['pr-review/interrupted', 'pr-review/succeeded']);
  assert.equal(runs[1].workerId, first.workerId, 'the same reviewer');
  assert.equal(prompts(fx, /Review these pull requests/).length, 1, 'no second review prompt: nobody was hired fresh');
  assert.equal(prompts(fx, RESTARTED).length, 1);
});

/** The worker's stored session is one Claude no longer has (a stale- one makes the fake agent exit at once), so the woken terminal is gone before the engine looks. */
const staleSession = (fx: EngineFixture, workerId: string) => void (fx.workers.get(workerId)!.sessionId = 'stale-1');

test('a woken terminal that exited already: the saved session check still speaks', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'x'), { recursive: true });
  staleSession(fx, run.workerId!);
  await fx.restartOffice({ exitedFirst: true });
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /session is gone/);
});

test('a woken terminal that exited already: a finished turn is still handled', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Finished before the restart.', commit: 'Work', delayMs: 1500 }, { when: 'office was restarted', reply: 'Should not be asked.' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  fx.engine.dispose();
  const end = Date.now() + 15_000;
  while (fx.workers.get(run.workerId!)?.status !== 'done' && Date.now() < end) await sleep(30);
  staleSession(fx, run.workerId!);
  await fx.restartOffice({ exitedFirst: true });
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished before the restart.');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a woken terminal that exited already: an agent that was asking keeps the task waiting', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Which colour?', ask: 'question' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const run = await midTurn(fx, task.id);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  staleSession(fx, run.workerId!);
  await fx.restartOffice({ exitedFirst: true });
  const end = Date.now() + 15_000;
  while (fx.repo.getRun(run.id)?.status === 'running' && Date.now() < end) await sleep(30);
  await sleep(300);
  assert.deepEqual([fx.task(task.id).status, fx.task(task.id).waitingReason], ['waiting', 'agent_asking']);
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => /restarted while its agent was asking/.test(c.text)));
});

/** Two tasks cut off; the office restarts again before the second one's queued run starts, with `spoil` done to it while the office is down. */
async function queuedThenSpoiled(t: import('node:test').TestContext, spoil: (fx: EngineFixture, taskId: number, workerId: string) => string[] | void) {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules(RULES);
  const [a, b] = [fx.newTask({ usePlan: false, useReview: false }), fx.newTask({ usePlan: false, useReview: false })];
  const runs = [] as Awaited<ReturnType<typeof midTurn>>[];
  for (const x of [a, b]) {
    await fx.engine.start(x.id, ADA);
    await fx.waitTask(x.id, (y) => y.runState === 'running', 'running');
    runs.push(fx.repo.activeRun(x.id)!);
  }
  await sleep(1000);
  await fx.restartOffice();
  assert.equal(fx.task(b.id).runState, 'queued', 'the second is queued behind the first');
  const workspace = fx.task(b.id).workspace;
  await fx.restartOffice({ beforeStart: () => void spoil(fx, b.id, runs[1].workerId!) });
  return { fx, b, workspace };
}

test('a queued carry-on whose worktree vanished while the office was down waits interrupted, no fresh worktree', async (t) => {
  const { fx, b, workspace } = await queuedThenSpoiled(t, (fx, id) => {
    rmSync(path.join(fx.dir, fx.task(id).workspace!.worktree.path), { recursive: true, force: true });
  });
  const waiting = await fx.waitTask(b.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task', 60_000);
  assert.match(waiting.waitingText ?? '', /worktree is gone/);
  assert.deepEqual(waiting.workspace, workspace);
  assert.equal(fx.repo.listRuns(b.id).length, 1, 'no new run');
});

test('a queued carry-on whose session vanished while the office was down waits interrupted, no fresh session', async (t) => {
  const { fx, b } = await queuedThenSpoiled(t, (fx, _id, workerId) => {
    rmSync(fx.workers.transcripts(workerId)!.claude!, { force: true });
    mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'x'), { recursive: true });
  });
  const waiting = await fx.waitTask(b.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task', 60_000);
  assert.match(waiting.waitingText ?? '', /session is gone/);
  assert.equal(fx.repo.listRuns(b.id).length, 1, 'no new run');
});

test('a plan question cut off by a restart: the answer goes on in the plan phase, on the implementer', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'Which database?', ask: 'question' }, { when: 'The user replied about the plan', reply: 'Plan again.\n\nPLAN READY', exitPlan: 'The plan' }]);
  const task = fx.newTask({ usePlan: true, planApproval: 'manual', useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  const worker = fx.task(task.id).workerId;
  await fx.restartOffice();
  await sleep(500);
  assert.deepEqual([fx.task(task.id).status, fx.task(task.id).waitingReason], ['waiting', 'agent_asking']);
  assert.equal(await fx.engine.continue(task.id, ADA, 'Postgres'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan waiting for approval', 60_000);
  const runs = fx.repo.listRuns(task.id);
  assert.deepEqual(runs.map((r) => `${r.phase}/${r.role}`), ['plan/implementer', 'plan/implementer']);
  assert.equal(runs[1].workerId, worker, 'the same worker');
});

test('a reviewer question cut off by a restart: the answer goes on in the review, on the reviewer', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { review: { tool: 'claude', rounds: 1 } });
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'You are reviewing the work', reply: 'Which standard?', ask: 'question' },
    { when: 'commented on task', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the reviewer asking', 60_000);
  const reviewer = fx.task(task.id).reviewerWorkerId;
  assert.ok(reviewer);
  await fx.restartOffice();
  await sleep(500);
  assert.deepEqual([fx.task(task.id).status, fx.task(task.id).waitingReason], ['waiting', 'agent_asking']);
  assert.equal(await fx.engine.continue(task.id, ADA, 'The house style'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 60_000);
  const reviews = fx.repo.listRuns(task.id).filter((r) => r.phase === 'review');
  assert.deepEqual(reviews.map((r) => `${r.role}/${r.verdict ?? r.status}`), ['reviewer/interrupted', 'reviewer/approved']);
  assert.equal(reviews[1].workerId, reviewer, 'the same reviewer');
});

test('a plan that finished (ExitPlanMode) when the office stopped reaches plan approval, not a question', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'Plan text.\n\nPLAN READY', exitPlan: 'The plan', delayMs: 1200 }]);
  const task = fx.newTask({ usePlan: true, planApproval: 'manual', useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'plan' && x.runState === 'running', 'the plan run');
  const run = fx.repo.activeRun(task.id)!;
  fx.engine.dispose();
  const end = Date.now() + 15_000;
  while (fx.workers.get(run.workerId!)?.status !== 'needs_input' && Date.now() < end) await sleep(30);
  await fx.restartOffice();
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan waiting for approval', 30_000);
});

test('a pull-request review question cut off by a restart: the answer goes on in pr-review, on the same reviewer', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Review these pull requests', reply: 'Which standard?', ask: 'question' }, { when: 'commented on task', reply: 'They fit together.\n\nREVIEW: APPROVED' }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 3 }, { repo: 'acme/proj', number: 4 }] as never, tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  const taskId = (got as { taskId: number }).taskId;
  await fx.waitTask(taskId, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the reviewer asking');
  const first = fx.repo.listRuns(taskId)[0];
  await fx.restartOffice();
  await sleep(500);
  assert.deepEqual([fx.task(taskId).status, fx.task(taskId).waitingReason], ['waiting', 'agent_asking']);
  assert.equal(await fx.engine.continue(taskId, ADA, 'The house style'), undefined);
  await fx.waitTask(taskId, (x) => x.runState === 'idle' && x.status !== 'waiting' && x.status !== 'in_progress', 'the review done', 60_000);
  const runs = fx.repo.listRuns(taskId);
  assert.deepEqual(runs.map((r) => `${r.phase}/${r.role}`), ['pr-review/reviewer', 'pr-review/reviewer']);
  assert.equal(runs[1].workerId, first.workerId, 'the same reviewer');
  assert.equal(prompts(fx, /Review these pull requests/).length, 1, 'nobody was hired fresh');
  assert.ok(prompts(fx, /The house style/).length >= 1, 'the answer was delivered');
});
