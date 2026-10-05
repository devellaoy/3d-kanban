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
  await midTurn(fx, task.id);
  // A projects folder that knows no such session, and a task whose session is another one.
  mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'x'), { recursive: true });
  fx.repo.updateTask(task.id, { sessionId: 'gone-session' });
  await fx.restartOffice();
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /session is gone/);
  assert.equal(prompts(fx, RESTARTED).length, 0);
});
