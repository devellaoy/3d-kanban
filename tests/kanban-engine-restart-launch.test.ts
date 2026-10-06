// A run's launch that a full restart cut off before an agent had its prompt keeps that prompt and its text (engine/restart.ts, runs.launch),
// for Claude and Codex alike; the Codex session check; the stagger of several projects (docs/kanban-architecture.md §4, "After a full restart").

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';
import { Restarts } from '../src/server/kanban/engine/restart.js';

const RESTARTED = /The office was restarted while you were working on this task, and your turn was cut off/;
const fixture = () => engineFixture({ engine: { restartStaggerMs: 50 } });
const prompts = (fx: EngineFixture, re: RegExp) => fx.invocations().filter((i) => i.prompt && re.test(i.prompt));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Office = { prompt: () => undefined; relaunch: () => Promise<undefined> };

/** The office goes down before an agent has the prompt of the run it is starting: whatever the engine types or relaunches goes nowhere. */
function swallow(fx: EngineFixture) {
  const office = fx.workers as unknown as Office;
  office.prompt = () => undefined;
  office.relaunch = async () => undefined;
}

/** A plan approved and its worker slow to leave: the office is stopped while the implement relaunch waits for it. */
async function stopDuringRelaunch(fx: EngineFixture, taskId: number) {
  await fx.engine.start(taskId, ADA);
  const end = Date.now() + 15_000;
  let worker: { pty?: { kill(signal?: string): void }; relaunching?: boolean } | undefined;
  while (!worker?.pty && Date.now() < end) {
    await sleep(20);
    const id = fx.repo.activeRun(taskId)?.workerId;
    worker = id ? (fx.workers as unknown as { workers: Map<string, typeof worker> }).workers.get(id) : undefined;
  }
  const pty = worker!.pty!;
  const kill = pty.kill.bind(pty);
  pty.kill = (signal) => void setTimeout(() => kill(signal), 1500);
  while (!worker!.relaunching && Date.now() < end) await sleep(5);
  await fx.restartOffice();
}

/** The implement prompt is not delivered through two stops, and goes in after the third start. */
async function twoStops(fx: EngineFixture, tool: 'claude' | 'codex', reply: string) {
  fx.settings.setProject('proj', { implementPermission: 'workspace-write' });
  fx.setRules([{ when: tool === 'codex' ? 'You are planning kanban task' : 'Plan kanban task', reply: 'Plan ready.\n\nPLAN READY', exitPlan: 'The plan.' }, { when: 'Implement kanban task', reply, commit: 'Work' }]);
  const task = fx.newTask({ tool, usePlan: true, planApproval: 'auto', useReview: false });
  await stopDuringRelaunch(fx, task.id);
  swallow(fx);
  const end = Date.now() + 15_000;
  while (fx.repo.listRuns(task.id).filter((r) => r.phase === 'implement').length < 2 && Date.now() < end) await sleep(10);
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, reply);
  assert.equal(prompts(fx, RESTARTED).length, 0, 'never a continue: the session only had the plan');
  assert.equal(prompts(fx, /Implement kanban task/).length, 1, 'the implement prompt went in once');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => r.phase), ['plan', 'implement', 'implement', 'implement']);
}

test('claude: the implement prompt survives a second stop before it was delivered', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  await twoStops(fx, 'claude', 'Implemented after two stops.');
});

test('codex: the implement prompt survives a second stop before it was delivered', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  await twoStops(fx, 'codex', 'Implemented after two stops.');
});

test("a comment's resume run cut off before its prompt was delivered carries the comment on, once", async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', commit: 'Work' }, { when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  // Another model than the worker's own: the comment's run relaunches it, and the old process is slow to leave.
  fx.repo.updateTask(task.id, { model: 'sonnet' });
  const worker = (fx.workers as unknown as { workers: Map<string, { pty: { kill(signal?: string): void }; relaunching?: boolean }> }).workers.get(done.workerId!)!;
  const kill = worker.pty.kill.bind(worker.pty);
  worker.pty.kill = (signal) => void setTimeout(() => kill(signal), 1500);
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename foo to bar.' }).comment;
  void fx.engine.commented(task.id, c.id, ADA);
  const end = Date.now() + 15_000;
  while (!worker.relaunching && Date.now() < end) await sleep(5);
  assert.ok(worker.relaunching, 'the relaunch waits for the old process');
  assert.equal(prompts(fx, /rename foo to bar/).length, 0, 'the prompt never went in');
  await fx.restartOffice();
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'resume' && r.status === 'succeeded'), 'the comment handled', 40_000);
  assert.equal(prompts(fx, /rename foo to bar/).length, 1, 'the comment reached the agent once');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a comment typed in but never submitted when the office stops is typed in again, once', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', commit: 'Work' }, { when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  // The prompt is typed into the resting agent, and the office is gone before Enter reaches it.
  swallow(fx);
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename foo to bar.' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.phase, 'resume');
  assert.equal(prompts(fx, /rename foo to bar/).length, 0, 'the prompt never went in');
  await fx.restartOffice();
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'resume' && r.status === 'succeeded'), 'the comment handled', 40_000);
  assert.equal(prompts(fx, /rename foo to bar/).length, 1, 'the comment reached the agent once');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a run held for background work whose final answer was logged before the office stopped is handled, not run again', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', backgroundMs: 600, reply: 'Finished after the helper.', commit: 'Work' }, { when: 'office was restarted', reply: 'Should not be asked.' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const end = Date.now() + 15_000;
  let run = fx.repo.activeRun(task.id);
  while ((!run || fx.repo.runHeldAt(run.id) === undefined) && Date.now() < end) {
    await sleep(20);
    run = fx.repo.activeRun(task.id);
  }
  // The office is gone once the answer to the completion notice is in the log, before its result is handled.
  fx.engine.dispose();
  const log = fx.workers.transcripts(run!.workerId!)!.claude!;
  while (!(await import('node:fs')).readFileSync(log, 'utf8').includes('Finished after the helper.') && Date.now() < end) await sleep(20);
  await sleep(200);
  assert.ok(fx.repo.runHeldAt(run!.id), 'the hold is still on the run');
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished after the helper.');
  assert.equal(fx.repo.getRun(run!.id)?.status, 'succeeded');
  assert.equal(fx.repo.listRuns(task.id).length, 1, 'no run was started again');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test("codex: a session whose rollout is gone interrupts the run with the reason, and Retry starts a fresh session", async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Finished before the restart.', commit: 'Work', delayMs: 60_000 }]);
  const task = fx.newTask({ tool: 'codex', usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement run');
  const end = Date.now() + 15_000;
  while (!prompts(fx, /Implement kanban task/).length && Date.now() < end) await sleep(30);
  const run = fx.repo.activeRun(task.id)!;
  while (fx.workers.get(run.workerId!)?.status !== 'working' && Date.now() < end) await sleep(30);
  mkdirSync(path.join(process.env.CODEX_HOME!, 'sessions', '2026', '01', '01'), { recursive: true });
  fx.workers.get(run.workerId!)!.sessionId = 'stale-1';
  await fx.restartOffice({ exitedFirst: true });
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interrupted task');
  assert.match(waiting.waitingText ?? '', /session is gone/);
  fx.setRules([{ when: 'Implement kanban task|taking over kanban task', reply: 'Finished in a fresh session.', commit: 'Work2' }]);
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 60_000);
  assert.equal(done.summary, 'Finished in a fresh session.');
});

test('with two projects waiting, each gets its own wake-up when the stagger has passed', async (t) => {
  const drained: string[] = [];
  const restarts = new Restarts({
    ctx: { repo: { listRuns: () => [] } } as never,
    serial: (_id, fn) => fn(),
    folder: () => true,
    finishRun() {},
    note() {},
    update() {},
    apply: async () => undefined,
    drain: (project) => void drained.push(project),
    attach: () => undefined as never,
    turnEnded: async () => {},
    hiringPaused: () => undefined,
    staggerMs: 60,
  });
  t.after(() => restarts.dispose());
  const floor = { dir: '/x', workers: { get: () => ({ id: 'w' }), carriesOnAfterRestart: () => true, transcripts: () => undefined } } as never;
  const queued = (id: number, project: string) => ({ id, project, tool: 'claude', queuedRun: { phase: 'implement', role: 'implementer', prompt: 'restarted' }, workerId: 'w' }) as never;
  assert.equal(await restarts.admit(queued(1, 'a'), floor), true);
  assert.equal(await restarts.admit(queued(2, 'b'), floor), false);
  assert.equal(await restarts.admit(queued(3, 'a'), floor), false);
  await sleep(250);
  assert.deepEqual([...new Set(drained)].sort(), ['a', 'b']);
});
