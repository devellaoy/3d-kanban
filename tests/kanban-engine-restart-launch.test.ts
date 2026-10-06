// A run's launch that a full restart cut off before an agent had its prompt keeps that prompt and its text (engine/restart.ts, runs.launch),
// for Claude and Codex alike; the Codex session check; the stagger of several projects (docs/kanban-architecture.md §4, "After a full restart").

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('a comment whose relaunched agent started but had not submitted it when the office stops is delivered once after the restart', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', commit: 'Work' }, { when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename', submitDelayMs: 3000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  fx.repo.updateTask(task.id, { model: 'sonnet' }); // another model than the worker's own: the comment's run relaunches it
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename foo to bar.' }).comment;
  const before = fx.invocations().length;
  void fx.engine.commented(task.id, c.id, ADA);
  const end = Date.now() + 15_000;
  while (fx.invocations().length === before && Date.now() < end) await sleep(10);
  await sleep(600); // its SessionStart is heard; its prompt is still to be submitted
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.phase, 'resume');
  fx.setRules([{ when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename' }]);
  await fx.restartOffice();
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'resume' && r.status === 'succeeded'), 'the comment handled', 40_000);
  assert.equal(prompts(fx, /rename foo to bar/).length, 2, 'once before the stop (never submitted) and once after');
  assert.equal(prompts(fx, RESTARTED).length, 0);
});

test('a finished background agent whose lead never answered is carried on, not waited for, even before the hold was stored', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', backgroundMs: 300, lateLogMs: 60_000, reply: 'Never logged.' }, { when: 'office was restarted', reply: 'Finished after the restart.', commit: 'Work' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const run = fx.repo.activeRun(task.id)!;
  fx.engine.dispose(); // before the first Stop is heard: no hold is stored
  fx.repo.clearRunLaunch(run.id); // the prompt was submitted
  const end = Date.now() + 15_000;
  const log = () => fx.workers.transcripts(run.workerId!)?.claude;
  const has = async (s: string) => !!log() && (await import('node:fs')).existsSync(log()!) && (await import('node:fs')).readFileSync(log()!, 'utf8').includes(s);
  while (!(await has('task-notification')) && Date.now() < end) await sleep(20);
  await sleep(300);
  assert.equal(fx.repo.runHeldAt(run.id), undefined);
  await fx.restartOffice();
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.equal(done.summary, 'Finished after the restart.');
  assert.equal(prompts(fx, RESTARTED).length, 1);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => r.status), ['interrupted', 'succeeded']);
});

test('a re-attached run whose prompt arrives later is acknowledged: a full stop then carries on instead of sending it again', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', commit: 'Work' }, { when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename', delayMs: 60_000 }, { when: 'office was restarted', reply: 'Finished after the restart.', commit: 'More' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  const office = fx.workers as unknown as Office;
  const typeIn = office.prompt;
  // The comment's prompt is typed in, the engine goes away (the terminal stays) before the agent submits it.
  office.prompt = () => undefined;
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename foo to bar.' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  const run = fx.repo.activeRun(task.id)!;
  assert.ok(fx.repo.runLaunch(run.id), 'its prompt is still to arrive');
  fx.restartEngine();
  await sleep(300);
  assert.equal(fx.repo.getRun(run.id)?.status, 'running', 'the run waits for its prompt, its result is not read yet');
  (typeIn as (id: string, text: string) => unknown).call(fx.workers, done.workerId!, 'You commented on task #1: Also rename foo to bar.');
  const end = Date.now() + 15_000;
  while (fx.repo.runLaunch(run.id) && Date.now() < end) await sleep(20);
  assert.equal(fx.repo.runLaunch(run.id), undefined, 'the prompt arrived and was acknowledged');
  await fx.restartOffice();
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.status === 'succeeded' && r.phase === 'resume'), 'the carried-on run', 40_000);
  assert.equal(prompts(fx, /rename foo to bar/).length, 1, 'the comment was not sent again');
  assert.equal(prompts(fx, RESTARTED).length, 1);
});

test('a re-attached run whose agent received its prompt and finished the turn while the engine was down is handled, not waited for', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', commit: 'Work' }, { when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  const office = fx.workers as unknown as Office;
  const typeIn = office.prompt;
  office.prompt = () => undefined;
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename foo to bar.' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  const run = fx.repo.activeRun(task.id)!;
  assert.ok(fx.repo.runLaunch(run.id), 'its prompt is still to arrive');
  // The engine is gone while the terminal stays: the agent submits the prompt and finishes its turn.
  fx.engine.dispose();
  (typeIn as (id: string, text: string) => unknown).call(fx.workers, done.workerId!, 'You commented on task #1: Also rename foo to bar.');
  const end = Date.now() + 15_000;
  while (fx.invocations().filter((i) => i.prompt && /rename foo to bar/.test(i.prompt)).length < 1 && Date.now() < end) await sleep(20);
  await sleep(1500);
  assert.equal(fx.workers.get(done.workerId!)?.status, 'done');
  fx.restartEngine();
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.getRun(run.id)?.status === 'succeeded', 'the comment run handled', 20_000);
  assert.equal(fx.repo.getRun(run.id)?.summary, 'Handled the comment.');
  assert.equal(fx.repo.runLaunch(run.id), undefined, 'its launch was acknowledged');
  assert.equal(prompts(fx, /rename foo to bar/).length, 1, 'the comment was not sent again');
});

test('a pull-request review whose prompt had not been submitted when the office stopped is delivered once after the restart', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Review these pull requests', reply: 'unused', submitDelayMs: 3000 }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 3 }] as never, tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  const taskId = (got as { taskId: number }).taskId;
  const end = Date.now() + 15_000;
  while (!fx.invocations().some((i) => i.prompt) && Date.now() < end) await sleep(30);
  await sleep(600); // started, prompt not submitted yet
  fx.setRules([{ when: 'Review these pull requests', reply: 'They fit together.\n\nREVIEW: APPROVED' }]);
  await fx.restartOffice();
  await fx.waitTask(taskId, (x) => x.runState === 'idle' && x.status !== 'in_progress', 'the review done', 60_000);
  assert.deepEqual(fx.repo.listRuns(taskId).map((r) => `${r.phase}/${r.status}`), ['pr-review/interrupted', 'pr-review/succeeded']);
  assert.equal(prompts(fx, /Review these pull requests/).length, 2, 'the stopped attempt and the one after the restart');
  assert.equal(prompts(fx, RESTARTED).length, 0, 'not a continue');
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

/** Restarts.delivered on a codex run whose rollout holds the given lines: whether its turn is handled now, and whether the launch was acknowledged. */
function codexDelivered(lines: object[], launchText?: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'rollout-')), 'rollout.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const restarts = new Restarts({ ctx: { repo: { runLaunch: () => ({ phase: 'resume', role: 'implementer', prompt: 'comment', ...(launchText ? { text: launchText } : {}) }) } } as never } as never);
  const live = { ack: () => void (acked = true) } as never;
  let acked = false;
  const floor = { workers: { transcripts: () => ({ codex: file }) } } as never;
  const got = restarts.delivered({ id: 1, tool: 'codex', promptedAt: Date.parse('2026-01-01T00:00:10Z'), startedAt: 0 } as never, floor, { id: 'w' } as never, live);
  return { got, acked };
}
const stamp = (s: string) => `2026-01-01T00:00:${s}Z`;
const turn = (at: string, text: string, old = false) => [
  old ? { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } } : { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: text } },
  { type: 'event_msg', timestamp: at, payload: { type: 'task_complete', last_agent_message: 'Done.' } },
];

test('codex: a prompt received while the engine was down is acknowledged, in either rollout format', () => {
  for (const old of [false, true]) assert.deepEqual(codexDelivered(turn(stamp('11'), 'You commented on task #1: Also rename foo to bar.', old), 'Also rename foo to bar.'), { got: true, acked: true }, old ? 'older format' : 'event format');
});

test("codex: the previous turn's user message just before the prompt was typed is not its receipt", () => {
  for (const old of [false, true]) assert.deepEqual(codexDelivered(turn(stamp('09.500'), 'Implement kanban task #1', old), 'Also rename foo to bar.'), { got: false, acked: false }, old ? 'older format' : 'event format');
});

test('codex: a user message after the prompt was typed that is not its text is not its receipt', () => {
  assert.deepEqual(codexDelivered(turn(stamp('12'), 'Something somebody else typed', true), 'Also rename foo to bar.'), { got: false, acked: false });
});
