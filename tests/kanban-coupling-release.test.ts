// The kanban and the 3D office as one world (docs/kanban-coupling.md): leave-on-merge and kanban
// tasks, done/archived tasks releasing their workers, WorkerInfo.kanban following the card, and a
// task started at a chosen desk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { landedWorkers, notLeaving } from '../src/server/leave-on-merge.js';
import { archiveOldTasks, createCorePlugin } from '../src/server/kanban/ws.js';
import type { KanbanClient, KanbanContext } from '../src/server/kanban/registry.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { GhPull, WorkerInfo } from '../src/shared/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };

const homeNotes = (fx: EngineFixture, id: number) =>
  fx.repo
    .listComments(id)
    .comments.filter((c) => c.kind === 'status' && / home/.test(c.text))
    .map((c) => c.text);

async function inReview(fx: EngineFixture) {
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
}

/** The core plugin (ws.ts) over the fixture's context, and a browser that keeps what it's sent. */
function core(fx: EngineFixture) {
  const ctx = { ...fx.ctx, taskChanged: () => {}, card: (id: number) => fx.repo.card(id) } as KanbanContext;
  const plugin = createCorePlugin(ctx, { subscribe() {}, unsubscribe() {} });
  const got: KanbanServerMsg[] = [];
  const client: KanbanClient = { clientId: 'c1', name: 'Ada', admin: true, send: (m) => void got.push(m) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (msg: any) => (plugin.ws as any)[msg.t](client, msg) as Promise<void>;
  return { ctx, send, got };
}

const pull = (branch: string, state: string): GhPull => ({ number: 42, url: 'https://github.com/acme/proj/pull/42', state, isDraft: false, headRefName: branch, closes: [], createdAt: new Date().toISOString(), title: 'x' }) as unknown as GhPull;

test('leave-on-merge never picks a worker of a task in progress or with a run under way', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 3000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.runState === 'running' && !!x.workerId && !!x.workspace, 'running', 15_000);
  const busy = fx.workers.get(r.workerId!)!;
  assert.equal(busy.kanban?.status, 'in_progress');
  assert.match(notLeaving(busy) ?? '', /kanban task/);
  // Even at rest (its status says so), a worker of a task in progress stays.
  assert.match(notLeaving({ ...busy, status: 'done' }) ?? '', /kanban task/);
  assert.match(notLeaving({ ...busy, status: 'done', kanban: { ...busy.kanban!, status: 'review', runState: 'running' } }) ?? '', /kanban task/);
  assert.deepEqual(landedWorkers([{ ...busy, status: 'done' }], [pull(busy.worktree!.branch, 'MERGED')], []), []);

  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  await sleep(50);
  const idle = fx.workers.get(done.workerId!)!;
  assert.equal(idle.kanban?.status, 'review');
  assert.equal(notLeaving(idle), undefined, 'in Review with nothing running, it may go');
  assert.equal(landedWorkers([idle], [pull(idle.worktree!.branch, 'MERGED')], []).length, 1);
});

test('leave-on-merge sending a task worker home: done only when every linked PR has merged', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const link = (id: number, number: number, state: 'OPEN' | 'MERGED') => fx.repo.upsertPrLink(id, { repoId: 'proj', repo: 'acme/proj', number, url: `https://github.com/acme/proj/pull/${number}`, state });

  const all = await inReview(fx);
  link(all.id, 1, 'MERGED');
  link(all.id, 2, 'MERGED');
  await fx.workers.kill(all.workerId!, undefined, undefined, undefined, { by: 'Leave-on-merge', reason: 'merged' });
  const a = await fx.waitTask(all.id, (x) => x.status === 'done', 'done');
  assert.ok(a.doneAt);
  const merged = homeNotes(fx, all.id);
  assert.equal(merged.length, 1);
  assert.match(merged[0], /^Leave-on-merge sent .+ home as its pull requests merged, and the task is done\.$/);

  const some = await inReview(fx);
  link(some.id, 3, 'MERGED');
  link(some.id, 4, 'OPEN');
  await fx.workers.kill(some.workerId!, undefined, undefined, undefined, { by: 'Leave-on-merge', reason: 'merged' });
  const b = await fx.waitTask(some.id, (x) => !x.workerId, 'the worker gone');
  await sleep(50);
  assert.equal(b.status, 'review');
  const notes = homeNotes(fx, some.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not every pull request of the task has merged, so it stays in Review\.$/);

  // No linked PRs at all: nothing says it's delivered.
  const none = await inReview(fx);
  await fx.workers.kill(none.workerId!, undefined, undefined, undefined, { by: 'Leave-on-merge', reason: 'merged' });
  await fx.waitTask(none.id, (x) => !x.workerId, 'the worker gone');
  await sleep(50);
  assert.equal(fx.task(none.id).status, 'review');
});

test('moving a card to done sends its idle workers home, worktree kept', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  const wt = path.join(fx.dir, r.workspace!.worktree.path);
  const { send, got } = core(fx);
  await send({ t: 'kanban.task.move', id: r.id, to: 'done', rid: 'm1' });
  assert.deepEqual(got.find((m) => m.t === 'kanban.ok' || m.t === 'kanban.error'), { t: 'kanban.ok', rid: 'm1', taskId: r.id });
  const a = await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  assert.equal(fx.workers.get(r.workerId!), undefined);
  assert.equal(a.status, 'done');
  assert.ok(a.workspace && existsSync(wt), 'kept');
  const notes = homeNotes(fx, r.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Ada sent .+ home\.$/);
});

test('the auto-archive sends an archived task’s idle workers home too', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  fx.repo.updateTask(r.id, { status: 'done', doneAt: 1 });
  fx.settings.set({ archiveAfterDays: 1 });
  const { ctx } = core(fx);
  assert.deepEqual(archiveOldTasks(ctx, Date.now()), [r.id]);
  const a = await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  assert.equal(a.status, 'archived');
  assert.ok(existsSync(path.join(fx.dir, a.workspace!.worktree.path)));
  assert.match(homeNotes(fx, r.id)[0] ?? '', /^Kanban sent .+ home\.$/);
});

test('a task done by sending its implementer home releases its idle reviewer too, one line each', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  // A reviewer still at its desk in the task's worktree (a manual round's, say).
  const hired = fx.workers.spawn('desk-9', 'Ada (kanban)', undefined, false, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, { reuse: { worktree: r.workspace!.worktree }, kanban: { taskId: r.id, role: 'reviewer' }, settingsFile: 'kanban' });
  assert.notEqual(typeof hired, 'string');
  const rev = hired as WorkerInfo;
  fx.repo.updateTask(r.id, { reviewerWorkerId: rev.id });
  await fx.waitTask(r.id, () => fx.workers.get(rev.id)?.status !== 'starting', 'the reviewer up', 10_000).catch(() => undefined);
  await fx.workers.kill(r.workerId!, 'all', undefined, undefined, { by: 'Ada', reason: 'sent-home', done: true });
  assert.ok(existsSync(path.join(fx.dir, r.workspace!.worktree.path)), 'the reviewer sits in it: kept');
  const a = await fx.waitTask(r.id, (x) => x.status === 'done' && !x.workerId && !x.reviewerWorkerId, 'done, both gone');
  assert.ok(a.doneAt);
  assert.equal(fx.workers.get(rev.id), undefined);
  const notes = homeNotes(fx, r.id);
  assert.equal(notes.length, 2, notes.join(' | '));
  assert.match(notes[0], /and the task is done\.$/);
  assert.match(notes[1], /^Ada sent .+ home\.$/);
});

test("the worker's card: WorkerInfo.kanban follows the task, with the ordinary worker update", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const updates: WorkerInfo[] = [];
  (fx.workers as unknown as { events: { update(i: WorkerInfo): void } }).events.update = (i) => void updates.push(i);
  fx.setRules([{ ...IMPLEMENT, delayMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: true, title: 'Fix the login redirect' });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.runState === 'running' && !!x.workerId, 'running', 15_000);
  const running = fx.workers.get(r.workerId!)!.kanban!;
  assert.equal(running.taskId, task.id);
  assert.equal(running.role, 'implementer');
  assert.equal(running.title, 'Fix the login redirect');
  assert.equal(running.status, 'in_progress');
  assert.equal(running.phase, 'implement');
  assert.equal(running.runState, 'running');
  assert.equal(typeof running.rounds, 'number');
  assert.ok(updates.some((u) => u.id === r.workerId && u.kanban?.runState === 'running'), 'sent as a worker update');

  fx.setRules([IMPLEMENT, { when: 'review round 1 of', reply: 'Fine.\n\nREVIEW: APPROVED' }]);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  await sleep(50);
  const after = fx.workers.get(done.workerId!)!.kanban!;
  assert.equal(after.status, 'review');
  assert.equal(after.runState, 'idle');
  assert.equal(after.round, 1);

  // A change made outside the engine (ctx.taskChanged → cardChanged) reaches the worker too.
  const n = updates.length;
  fx.repo.updateTask(task.id, { title: 'Fix the login redirect for good' });
  fx.engine.cardChanged?.(task.id);
  assert.equal(fx.workers.get(done.workerId!)!.kanban!.title, 'Fix the login redirect for good');
  assert.equal(updates.length, n + 1);
  fx.engine.cardChanged?.(task.id);
  assert.equal(updates.length, n + 1, 'an unchanged card sends nothing');
});

test('a task started at a desk is hired there; a taken, unbuilt or unknown desk is refused', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 3000 }]);
  const a = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(a.id, ADA, { deskId: 'desk-5' }), undefined);
  const ra = await fx.waitTask(a.id, (x) => !!x.workerId, 'hired');
  assert.equal(fx.workers.get(ra.workerId!)!.deskId, 'desk-5');

  const b = fx.newTask({ usePlan: false, useReview: false });
  assert.match((await fx.engine.start(b.id, ADA, { deskId: 'desk-5' })) ?? '', /Desk 5 is taken/);
  assert.match((await fx.engine.start(b.id, ADA, { deskId: 'desk-17' })) ?? '', /isn't built/);
  assert.match((await fx.engine.start(b.id, ADA, { deskId: 'station-issues' })) ?? '', /isn't a desk/);
  assert.equal(fx.task(b.id).status, 'todo', 'nothing started');
  assert.equal(fx.task(b.id).startedAt, undefined);

  // kanban.task.create with start and a desk, through the WS plugin.
  const { send, got } = core(fx);
  await send({ t: 'kanban.task.create', rid: 'c1', start: true, deskId: 'desk-7', task: { project: 'proj', title: 'Another', usePlan: false, useReview: false, tool: 'claude' } });
  const ok = got.find((m) => m.t === 'kanban.ok') as { taskId: number; startError?: string } | undefined;
  assert.ok(ok && !ok.startError, JSON.stringify(got));
  const rc = await fx.waitTask(ok.taskId, (x) => !!x.workerId, 'hired');
  assert.equal(fx.workers.get(rc.workerId!)!.deskId, 'desk-7');
  await send({ t: 'kanban.task.create', rid: 'c2', start: true, deskId: 'desk-7', task: { project: 'proj', title: 'Third', tool: 'claude' } });
  const taken = got.filter((m) => m.t === 'kanban.ok').pop() as { taskId: number; startError?: string };
  assert.match(taken.startError ?? '', /Desk 7 is taken/);
  assert.equal(fx.task(taken.taskId).status, 'todo');
});
