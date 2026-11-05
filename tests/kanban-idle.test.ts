// Idle agents close (kanban #401, docs/kanban.md "Idle agents close"): the pure rule, the plugin's sweep
// with the fake agents, and what wakes (and does not wake) a closed worker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { idleVictims, createIdle, quietSince, type IdleTask } from '../src/server/kanban/idle.js';
import { restoreWorkers, saveWorkers } from '../src/server/workers/persist.js';
import { handlers } from '../src/server/ws/handlers/index.js';
import type { Worker } from '../src/server/workers/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import type { ClientMsg } from '../src/shared/protocol.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';

const H = 3_600_000;
const NOW = 100 * H;
const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const COMMENT: Rule = { when: 'commented on task', reply: 'Renamed.', commit: 'Rename' };

const info = (over: Partial<WorkerInfo> = {}) =>
  ({ id: 'w1', kind: 'agent', provider: 'claude', status: 'idle', sessionId: 's1', kanban: { taskId: 1, role: 'implementer' }, viewers: [], viewerIds: [], waitingSince: NOW - 3 * H, ...over }) as WorkerInfo;
const quiet = (over: Partial<IdleTask> = {}): IdleTask => ({ runState: 'idle', updatedAt: NOW - 3 * H, ...over });

// --- The rule ------------------------------------------------------------------------------------------

test('idleVictims: a resting, unwatched worker of a quiet task is closed once the quiet is long enough, and not before', () => {
  const seen = new Map<string, number>([['w1', NOW - 3 * H]]);
  assert.deepEqual(idleVictims(NOW, 2, [info()], () => quiet(), seen), ['w1']);
  for (const status of ['done', 'idle', 'needs_input'] as const) assert.deepEqual(idleVictims(NOW, 2, [info({ status })], () => quiet(), seen), ['w1'], status);
  assert.deepEqual(idleVictims(NOW, 4, [info()], () => quiet(), seen), [], 'not yet');
  // Any of the clocks being recent keeps it: its waiting mark, someone's last input, the task's last change, the last time it was seen.
  assert.deepEqual(idleVictims(NOW, 2, [info({ waitingSince: NOW - H })], () => quiet(), seen), []);
  assert.deepEqual(idleVictims(NOW, 2, [info({ lastInput: { by: 'Ada', at: NOW - H } })], () => quiet(), seen), []);
  assert.deepEqual(idleVictims(NOW, 2, [info()], () => quiet({ updatedAt: NOW - H }), seen), []);
  assert.deepEqual(idleVictims(NOW, 2, [info()], () => quiet(), new Map([['w1', NOW - H]])), []);
});

test('idleVictims: not a worker someone is looking at, one at work, a task with a run, a queued run, no session, a non-task worker, the setting at 0', () => {
  const none = (w: WorkerInfo, task: IdleTask | null = quiet(), hours = 2) => idleVictims(NOW, hours, [w], () => task ?? undefined, new Map([[w.id, NOW - 3 * H]]));
  assert.deepEqual(none(info({ viewerIds: ['c1'], viewers: ['Ada'] })), []);
  for (const status of ['working', 'starting', 'exited', 'offline'] as const) assert.deepEqual(none(info({ status })), [], status);
  assert.deepEqual(none(info(), quiet({ runState: 'running' })), []);
  assert.deepEqual(none(info(), quiet({ runState: 'asking' })), []);
  assert.deepEqual(none(info(), quiet({ queuedRun: { phase: 'implement' } as IdleTask['queuedRun'] })), []);
  assert.deepEqual(none(info(), null), [], 'a task that is gone');
  assert.deepEqual(none(info({ sessionId: undefined })), []);
  assert.deepEqual(none(info({ kanban: undefined })), []);
  assert.deepEqual(none(info({ kind: 'shell' })), []);
  assert.deepEqual(none(info({ dozing: NOW - H, status: 'idle' })), [], 'already closed');
  assert.deepEqual(none(info(), quiet(), 0), [], 'the setting is off');
});

test('idleVictims: sightings restart the clock; a worker not seen before is seen now', () => {
  const seen = new Map<string, number>();
  const w = info();
  assert.deepEqual(idleVictims(NOW, 2, [w], () => quiet(), seen), [], 'after a restart the clock starts at the first look');
  assert.equal(seen.get('w1'), NOW);
  assert.deepEqual(idleVictims(NOW + 2 * H + 1, 2, [w], () => quiet(), seen), ['w1']);
  // Looked at at +1 h: its quiet counts from the look.
  idleVictims(NOW + H, 2, [info({ viewerIds: ['c'], viewers: ['Ada'] })], () => quiet(), seen);
  assert.equal(seen.get('w1'), NOW + H);
  assert.deepEqual(idleVictims(NOW + 2 * H + 1, 2, [w], () => quiet(), seen), []);
  // At work counts as seen too.
  idleVictims(NOW + 5 * H, 2, [info({ status: 'working' })], () => quiet({ runState: 'running' }), seen);
  assert.equal(seen.get('w1'), NOW + 5 * H);
});

// --- The sweep and the wake-up ------------------------------------------------------------------------

async function inReview(fx: EngineFixture) {
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
}

async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(ok(), `timed out waiting for ${what}`);
}

/** The attach handler as a person's browser (or a visitor's) reaches it. */
function attacher(fx: EngineFixture) {
  const warnings: string[] = [];
  const ctx = { workerFloor: () => ({ workers: fx.workers }), sendTo() {}, warn: (_c: unknown, t: string) => void warnings.push(t) } as never;
  const attach = (id: string, clientId: string, visitor = false) => {
    const c = { id: clientId, peer: { name: clientId }, visitor, attached: new Set<string>() } as never;
    (handlers['worker.attach'] as (ctx: never, c: never, m: ClientMsg) => void)(ctx, c, { t: 'worker.attach', workerId: id });
  };
  return { attach, warnings };
}

test('a quiet task in Review: its agent is closed in place, the task is untouched, and nothing wakes it but a person opening it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, COMMENT]);
  const r = await inReview(fx);
  const id = r.workerId!;
  await until('the worker at rest', () => fx.workers.get(id)?.status === 'done' || fx.workers.get(id)?.status === 'idle');
  const idle = createIdle(fx.ctx);
  const t0 = Date.now();

  // The first look only starts the clock, and a short quiet closes nothing.
  assert.deepEqual(await idle.sweep(t0), []);
  assert.deepEqual(await idle.sweep(t0 + H), []);
  fx.settings.set({ idleCloseHours: 0 });
  assert.deepEqual(await idle.sweep(t0 + 50 * H), [], 'off');
  fx.settings.set({ idleCloseHours: 2 });

  assert.deepEqual(await idle.sweep(t0 + 3 * H), [id]);
  const closed = fx.workers.get(id)!;
  assert.equal(closed.status, 'exited');
  assert.equal(typeof closed.dozing, 'number');
  assert.equal(fx.task(r.id).status, 'review');
  assert.equal(fx.task(r.id).runState, 'idle');
  assert.equal(fx.task(r.id).workerId, id, 'it keeps its desk');
  const note = fx.repo.listComments(r.id).comments.find((c) => c.text.startsWith('Closed '));
  assert.equal(note?.text, `Closed ${closed.name}'s idle agent after 2 h; opening the task resumes it.`);
  assert.deepEqual(await idle.sweep(t0 + 9 * H), [], 'not closed twice');

  // Coming to the office, or another floor, does not wake it.
  const launches = () => fx.invocations().length;
  const mark = launches();
  fx.workers.wakeAll();
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(fx.workers.get(id)!.status, 'exited');
  assert.equal(launches(), mark);

  // A visitor looking does not wake it either; a person in the office does, on its session.
  const { attach, warnings } = attacher(fx);
  attach(id, 'guest', true);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(launches(), mark);
  assert.equal(fx.workers.get(id)!.status, 'exited');
  attach(id, 'ada');
  await until('the agent running again', () => fx.workers.get(id)!.status === 'idle');
  assert.deepEqual(warnings, []);
  assert.equal(fx.workers.get(id)!.dozing, undefined);
  const launch = fx.invocations().slice(mark).find((i) => i.kind === 'claude' && !i.prompt);
  assert.equal(launch?.args[launch.args.indexOf('--resume') + 1], r.sessionId);
  assert.equal(fx.task(r.id).status, 'review');

  // Watched, it is not closed; after the window is shut it has a full quiet again, not the minutes since its old mark.
  const later = t0 + 10 * H;
  assert.deepEqual(await idle.sweep(later), []);
  fx.workers.detach(id, 'ada');
  fx.workers.detach(id, 'guest');
  assert.deepEqual(await idle.sweep(later + 5 * 60_000), []);
  assert.deepEqual(await idle.sweep(later + H), []);
  assert.deepEqual(await idle.sweep(later + 2 * H + 10 * 60_000), [id]);
});

test('a comment on a closed worker carries on its session as usual', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT, COMMENT]);
  const r = await inReview(fx);
  const id = r.workerId!;
  await until('the worker at rest', () => ['done', 'idle'].includes(fx.workers.get(id)?.status ?? ''));
  const idle = createIdle(fx.ctx);
  const t0 = Date.now();
  await idle.sweep(t0);
  assert.deepEqual(await idle.sweep(t0 + 3 * H), [id]);
  const mark = fx.invocations().length;
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename it.' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && x.pendingMessages.length === 0, 'back in review', 30_000);
  const launch = fx.invocations().slice(mark).find((i) => i.kind === 'claude');
  assert.equal(launch?.args[launch.args.indexOf('--resume') + 1], r.sessionId);
  assert.equal(fx.workers.get(id)!.dozing, undefined, 'any resume clears the mark');
  assert.ok(fx.invocations().slice(mark).some((i) => i.prompt?.includes('Also rename it.')));
});

test('a worker with a live run, or a run waiting for its turn, is not closed', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 2000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const running = await fx.waitTask(task.id, (x) => x.runState === 'running' && !!x.workerId, 'running');
  const idle = createIdle(fx.ctx);
  const t0 = Date.now();
  await idle.sweep(t0);
  assert.deepEqual(await idle.sweep(t0 + 9 * H), []);
  assert.equal(fx.workers.get(running.workerId!)?.dozing, undefined);
});

// --- Saved workers ------------------------------------------------------------------------------------

test('a closed worker stays closed through a save and a restore, and the wake-up of a start leaves it alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'idle-persist-'));
  try {
    const file = path.join(dir, 'workers.json');
    const mk = (id: string, deskId: string, over: Partial<WorkerInfo>) =>
      ({ info: { id, kind: 'agent', provider: 'claude', deskId, name: 'Ada', color: '#fff', status: 'exited', createdBy: 'Bob', createdAt: 1, kanban: { taskId: 4, role: 'implementer' }, sessionId: 's', ...over }, tracker: {} }) as unknown as Worker;
    saveWorkers(file, [mk('w1', 'desk-1', { dozing: 1234 }), mk('w2', 'desk-2', {})], true);
    const restored = new Map<string, Worker>();
    restoreWorkers(file, restored, 'claude', () => false);
    assert.equal(restored.get('w1')?.info.dozing, 1234);
    assert.equal(restored.get('w2')?.info.dozing, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex: a closed worker resumes on its session with no prompt', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Changed.', commit: 'Fix' }]);
  const task = fx.newTask({ usePlan: false, useReview: false, tool: 'codex' });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'review', 30_000);
  const id = r.workerId!;
  await until('the worker at rest', () => ['done', 'idle'].includes(fx.workers.get(id)?.status ?? ''));
  const idle = createIdle(fx.ctx);
  const t0 = Date.now();
  await idle.sweep(t0);
  assert.deepEqual(await idle.sweep(t0 + 3 * H), [id]);
  const mark = fx.invocations().length;
  attacher(fx).attach(id, 'ada');
  await until('the agent running again', () => fx.workers.get(id)!.status === 'idle');
  const launch = fx.invocations().slice(mark).find((i) => i.kind === 'codex');
  assert.ok(launch, 'codex was launched');
  const at = launch.args.indexOf('resume');
  assert.equal(launch.args[at + 1], r.sessionId);
  assert.ok(!launch.args.includes('--'), 'with no prompt');
});

test('someone opens the window while the close is under way: the agent comes back by itself, with no warning', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  const id = r.workerId!;
  await until('the worker at rest', () => ['done', 'idle'].includes(fx.workers.get(id)?.status ?? ''));
  const idle = createIdle(fx.ctx);
  const t0 = Date.now();
  await idle.sweep(t0);
  const sweeping = idle.sweep(t0 + 3 * H);
  // Polled tightly: the fake agent leaves within a few milliseconds of the signal.
  while (fx.workers.get(id)!.dozing === undefined) await new Promise((res) => setImmediate(res));
  const { attach, warnings } = attacher(fx);
  attach(id, 'ada');
  assert.deepEqual(await sweeping, [], 'not closed after all');
  await until('the agent running again', () => fx.workers.get(id)!.status === 'idle' && fx.workers.get(id)!.dozing === undefined);
  assert.deepEqual(warnings, []);
  assert.equal(fx.repo.listComments(r.id).comments.some((c) => c.text.startsWith('Closed ')), false);
});

// --- Several floors, the clock, and the visitor (stand-in office) ---------------------------------------

/** A kanban context over stand-in floors, one worker each: what the plugin reads and calls, with the calls recorded. */
function standIn(floors: string[], hooks: { beforeRun?: (taskId: number) => void } = {}) {
  const calls: string[] = [];
  const tasks = new Map<number, IdleTask & { project: string }>();
  const touched = new Map<string, number>();
  const wakes = new Set<string>();
  const infos = new Map<string, WorkerInfo>();
  const floorOf = (project: string, n: number) => {
    const w = info({ id: `w-${project}`, kanban: { taskId: n, role: 'implementer' } as WorkerInfo['kanban'], name: project, waitingSince: NOW - 9 * H });
    infos.set(w.id, w);
    tasks.set(n, { runState: 'idle', updatedAt: NOW - 9 * H, project });
    return {
      workers: {
        list: () => [w],
        get: (id: string) => (id === w.id ? w : undefined),
        touchedAt: (id: string) => touched.get(id),
        takeWake: (id: string) => wakes.delete(id),
        doze: async (id: string, at: number) => (calls.push(`doze ${id}`), (w.dozing = at), undefined),
        resume: (id: string) => (calls.push(`resume ${id}`), (w.dozing = undefined), undefined),
      },
    };
  };
  const byProject = new Map(floors.map((f, i) => [f, floorOf(f, i + 1)]));
  const ctx = {
    projects: () => floors.map((id) => ({ id })),
    floor: (id: string) => byProject.get(id),
    repo: { getTask: (id: number) => tasks.get(id), addComment: () => ({ comment: {}, deduped: false }) },
    settings: { get: () => ({ idleCloseHours: 2 }) },
    broadcast() {},
    engine: { serialized: async (id: number, fn: (t: unknown) => Promise<unknown>) => (hooks.beforeRun?.(id), fn(tasks.get(id))) },
  };
  return { ctx: ctx as never, calls, tasks, touched, wakes, infos };
}

test('with several floors every floor\'s clocks survive each other\'s sweep, and every floor\'s idle agent is closed', async () => {
  const fx = standIn(['a', 'b']);
  const idle = createIdle(fx.ctx);
  assert.deepEqual(await idle.sweep(NOW - 9 * H + 1), [], 'the first look on each floor only starts its clock');
  assert.deepEqual(await idle.sweep(NOW), ['w-a', 'w-b']);
});

test('a window opened and shut between two sweeps starts the quiet over', async () => {
  const fx = standIn(['a']);
  const idle = createIdle(fx.ctx);
  await idle.sweep(NOW - 9 * H + 1);
  fx.touched.set('w-a', NOW - 1);
  assert.deepEqual(await idle.sweep(NOW), [], 'touched a moment ago');
  assert.deepEqual(await idle.sweep(NOW + 2 * H - 2), []);
  assert.deepEqual(await idle.sweep(NOW + 2 * H), ['w-a'], 'N hours after the touch');
  assert.equal(quietSince(info({ waitingSince: 5 }), quiet({ updatedAt: 7 }), 3, 9), 9);
});

test('the time is checked again inside the close: a task changed meanwhile is not closed', async () => {
  const fx = standIn(['a'], { beforeRun: (id) => (fx.tasks.get(id)!.updatedAt = NOW - 1) });
  const idle = createIdle(fx.ctx);
  await idle.sweep(NOW - 9 * H + 1);
  assert.deepEqual(await idle.sweep(NOW), []);
  assert.deepEqual(fx.calls, []);
});

test('a visitor opening the window during the close does not wake it; a member does', async () => {
  const wake = async (member: boolean) => {
    const fx = standIn(['a']);
    const idle = createIdle(fx.ctx);
    await idle.sweep(NOW - 9 * H + 1);
    // The member\'s attach found the process still running and asked for it (the handler); a visitor's asks for nothing.
    const doze = (fx.ctx as never as { floor(id: string): { workers: { doze(id: string, at: number): Promise<undefined> } } }).floor('a').workers;
    const real = doze.doze;
    doze.doze = async (id, at) => (member && fx.wakes.add(id), real(id, at));
    const closed = await idle.sweep(NOW);
    return { closed, calls: fx.calls };
  };
  assert.deepEqual(await wake(false), { closed: ['w-a'], calls: ['doze w-a'] });
  assert.deepEqual(await wake(true), { closed: [], calls: ['doze w-a', 'resume w-a'] });
});

test('opening and shutting a window as a member touches the worker; a visitor does not', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  const id = r.workerId!;
  const { attach } = attacher(fx);
  attach(id, 'guest', true);
  assert.equal(fx.workers.touchedAt(id), undefined);
  const before = Date.now();
  attach(id, 'ada');
  const opened = fx.workers.touchedAt(id)!;
  assert.ok(opened >= before && opened <= Date.now());
  fx.workers.touch(id, 0);
  const ctx = { workerFloor: () => ({ workers: fx.workers }) } as never;
  const c = (visitor: boolean) => ({ id: 'ada', peer: { name: 'ada' }, visitor, attached: new Set<string>(), typingAt: new Map() }) as never;
  (handlers['worker.detach'] as (ctx: never, c: never, m: ClientMsg) => void)(ctx, c(true), { t: 'worker.detach', workerId: id });
  assert.equal(fx.workers.touchedAt(id), 0);
  (handlers['worker.detach'] as (ctx: never, c: never, m: ClientMsg) => void)(ctx, c(false), { t: 'worker.detach', workerId: id });
  assert.ok(fx.workers.touchedAt(id)! >= before);
});
