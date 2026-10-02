// A task on hold (#61, docs/kanban-architecture.md §3): the migration, the machine, the engine's hold
// and unhold with the fake agents, the lounge figures and what other parts say about a held task.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate } from '../src/server/kanban/db/migrations.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { next, type MachineEvent, type MachineState, type MachineTask } from '../src/server/kanban/engine/machine.js';
import { LoungeSender, loungeFigures, LOUNGE_NEUTRAL_COLOR } from '../src/server/kanban/lounge.js';
import { createRefsPlugin } from '../src/server/kanban/integrations/refs/index.js';
import { canFixPrs } from '../src/shared/kanban/prs.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { TaskHold } from '../src/shared/kanban/hold.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const UNHOLD: Rule = { when: 'has been on hold since', reply: 'Carried on.', commit: 'After the hold' };
const BOB = { name: 'Bob', admin: false };

async function inReview(fx: EngineFixture, patch: Parameters<EngineFixture['newTask']>[0] = {}) {
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
}

// --- Database ----------------------------------------------------------------------------------------

test('migration 4 adds tasks.hold, a build that knows 3 refuses the database, and the hold round-trips onto the card', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrate(db, MIGRATIONS.slice(0, 3)), [1, 2, 3]);
  assert.deepEqual(migrate(db), [4]);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.throws(() => migrate(db, MIGRATIONS.slice(0, 3)), /newer than this build/);
  const repo = new KanbanRepository(db);
  const t = repo.createTask({ project: 'web', title: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  assert.equal(repo.getTask(t.id)?.hold, undefined);
  const hold: TaskHold = { at: 5, by: 'Ada', from: 'review', note: 'wait for keys', worker: { name: 'Ada2', color: '#fff' } };
  repo.updateTask(t.id, { status: 'on_hold', hold });
  assert.deepEqual(repo.getTask(t.id)?.hold, hold);
  assert.deepEqual(repo.card(t.id)?.hold, hold);
  db.prepare('UPDATE tasks SET hold = ? WHERE id = ?').run('{broken', t.id);
  assert.equal(repo.getTask(t.id)?.hold, undefined, 'a hand-edited row does not take the board down');
  repo.updateTask(t.id, { hold });
  repo.updateTask(t.id, { hold: null });
  assert.equal(repo.getTask(t.id)?.hold, undefined);
});

// --- Machine -----------------------------------------------------------------------------------------

const TASK: MachineTask = { type: 'implement', usePlan: true, useReview: true, planApproval: 'manual' };
const HELD: MachineState = { status: 'on_hold', phase: 'resume', runState: 'idle', reviewRound: 1, retryAttempts: 0 };
const RUN = { type: 'run', phase: 'implement', role: 'implementer', prompt: 'implement' } as const;
const EVERY_EVENT: { [K in MachineEvent['type']]: Extract<MachineEvent, { type: K }> } = {
  start: { type: 'start', slot: true },
  noRoom: { type: 'noRoom', text: 'full' },
  dequeue: { type: 'dequeue', run: RUN },
  planned: { type: 'planned', outcome: 'ready' },
  implemented: { type: 'implemented', changes: true },
  reviewed: { type: 'reviewed', round: 1, approved: true },
  fixed: { type: 'fixed', round: 1, changes: true },
  resumed: { type: 'resumed', changes: true },
  prDone: { type: 'prDone' },
  prReview: { type: 'prReview' },
  prReviewed: { type: 'prReviewed' },
  asking: { type: 'asking' },
  working: { type: 'working' },
  stop: { type: 'stop' },
  stopped: { type: 'stopped', by: 'Ada' },
  reviewAbandoned: { type: 'reviewAbandoned' },
  failed: { type: 'failed', error: 'x' },
  limited: { type: 'limited', retryAt: 1, attempts: 1 },
  gaveUp: { type: 'gaveUp', text: 'x' },
  interrupted: { type: 'interrupted' },
  retry: { type: 'retry' },
  continue: { type: 'continue', answer: 'go' },
  approvePlan: { type: 'approvePlan' },
  requestPlanChanges: { type: 'requestPlanChanges', text: 'x' },
  unhold: { type: 'unhold' },
  comment: { type: 'comment', text: 'hello', busy: false },
  review: { type: 'review' },
  pr: { type: 'pr', mode: 'fix' },
};
const CFG = { rounds: 2, reReviewLastFix: false };

test('every machine event on an idle task on hold either resumes it or leaves it on hold with nothing to run', () => {
  for (const [type, e] of Object.entries(EVERY_EVENT)) {
    const tr = next(HELD, e, TASK, CFG);
    if (type === 'unhold') {
      assert.ok(!('error' in tr));
      assert.equal(tr.state.status, 'in_progress');
      assert.deepEqual(tr.effects, [{ type: 'run', phase: 'resume', role: 'implementer', prompt: 'unhold' }]);
    } else if ('error' in tr) assert.ok(tr.error, type);
    else {
      assert.equal(tr.state.status, 'on_hold', type);
      assert.equal(tr.state.runState, 'idle', type);
      assert.deepEqual(tr.effects.filter((x) => x.type === 'run'), [], type);
    }
  }
  assert.deepEqual(next(HELD, EVERY_EVENT.comment, TASK, CFG), { state: HELD, effects: [] }, 'a comment is only stored');
  assert.match(String((next(HELD, EVERY_EVENT.pr, TASK, CFG) as { error: string }).error), /on hold: resume it first/);
  assert.match(String((next(HELD, EVERY_EVENT.prReview, TASK, CFG) as { error: string }).error), /on hold: resume it first/);
  // Only a task on hold is resumed.
  assert.ok('error' in next({ ...HELD, status: 'review' }, EVERY_EVENT.unhold, TASK, CFG));
});

test('a held task is not fixable and its PR review is refused', () => {
  const held = { status: 'on_hold' as const, runState: 'idle' as const, prs: [{ state: 'OPEN' as const }] };
  assert.deepEqual(canFixPrs(held), { ok: false, reason: 'It is on hold: resume it first' });
});

// --- Engine ------------------------------------------------------------------------------------------

test('hold: the creator or an admin only; the worker goes home with the hold line, the worktree, session and desk stay, the queue and retry are cleared', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  const worker = fx.workers.get(r.workerId!)!;
  assert.match(String(await fx.engine.hold!(r.id, BOB, { note: 'x' })), /Only whoever made it, or an admin/);
  assert.equal(fx.task(r.id).status, 'review');
  fx.repo.updateTask(r.id, { retryAttempts: 2 });
  const until = Date.now() + 5 * 86_400_000;
  assert.equal(await fx.engine.hold!(r.id, ADA, { note: 'waiting for the API keys', until }), undefined);
  const h = await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  assert.equal(h.status, 'on_hold');
  assert.equal(h.runState, 'idle');
  assert.equal(h.retryAttempts, 0);
  assert.equal(h.queuedRun, undefined);
  assert.equal(h.sessionId, r.sessionId);
  assert.deepEqual(h.workspace, r.workspace);
  assert.equal(h.branch, r.branch);
  assert.equal(h.deskId, r.deskId);
  assert.equal(h.hold?.from, 'review');
  assert.equal(h.hold?.by, 'Ada');
  assert.equal(h.hold?.until, until);
  assert.deepEqual(h.hold?.worker, { name: worker.name, color: worker.color });
  assert.equal(h.hold?.deskId, r.deskId);
  assert.equal(fx.workers.get(r.workerId!), undefined, 'it went home');
  assert.ok(existsSync(path.join(fx.dir, r.workspace!.worktree.path)), 'its worktree stayed');
  const lines = fx.repo.listComments(r.id).comments.filter((c) => c.kind === 'status').map((c) => c.text);
  assert.ok(lines.some((l) => l === `${worker.name} went to sit in the lounge: the task is on hold.`), lines.join(' | '));
  const said = lines.find((l) => l.startsWith('⏸️ Put on hold by Ada: waiting for the API keys (until '));
  assert.ok(said?.includes(r.workspace!.worktree.path) && said.includes('▶️ Resume'), said);
  assert.equal(fx.task(r.id).status, 'on_hold', 'the departure did not move it');
  // Nothing starts for it: a comment is only stored, Retry and Continue refuse.
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'ping' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  assert.equal(fx.task(r.id).status, 'on_hold');
  assert.equal(fx.task(r.id).runState, 'idle');
  assert.ok(String(await fx.engine.retry(r.id, ADA)));
  assert.ok(String(await fx.engine.pr(r.id, ADA, 'fix')));
});

test('a task on hold takes no maxConcurrent slot: the next task starts at once', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { maxConcurrent: 1 });
  fx.setRules([IMPLEMENT]);
  const a = await inReview(fx);
  assert.equal(await fx.engine.hold!(a.id, ADA, {}), undefined);
  const b = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(b.id, ADA), undefined);
  assert.notEqual(fx.task(b.id).runState, 'queued');
  await fx.waitTask(b.id, (x) => x.status === 'review' && x.runState === 'idle', 'the second task done', 30_000);
});

test('unhold: the implementer is hired again in the same worktree and session, with the same name and colour and the unhold prompt', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  const before = fx.workers.get(r.workerId!)!;
  assert.equal(await fx.engine.hold!(r.id, ADA, { note: 'waiting for the API keys' }), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  fx.setRules([UNHOLD]);
  const mark = fx.invocations().length;
  assert.equal(await fx.engine.unhold!(r.id, ADA, 'The keys are in.'), undefined);
  const back = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'back in review', 30_000);
  assert.equal(back.hold, undefined, 'the hold is cleared');
  const hired = fx.workers.get(back.workerId!)!;
  assert.equal(hired.name, before.name);
  assert.equal(hired.color, before.color);
  assert.equal(back.deskId, r.deskId);
  assert.equal(back.sessionId, r.sessionId, 'the same session carries on');
  const launch = fx.invocations().slice(mark).find((i) => !i.prompt && i.kind === 'claude');
  assert.ok(launch, 'a new agent was launched');
  assert.equal(launch.args[launch.args.indexOf('--resume') + 1], r.sessionId);
  assert.equal(realpathSync(launch.cwd), realpathSync(path.join(fx.dir, r.workspace!.worktree.path)));
  const prompt = launch.args[launch.args.length - 1];
  assert.match(prompt, /^Task #\d+ has been on hold since .+, because: waiting for the API keys\./);
  assert.match(prompt, /- Ada: The keys are in\./, 'the note it came back with is quoted');
  assert.ok(!prompt.includes('You are taking over'), 'no handoff: it has its session');
  const runs = fx.repo.listRuns(r.id);
  assert.equal(runs[runs.length - 1].phase, 'resume');
  assert.ok(String(await fx.engine.unhold!(r.id, ADA)), 'only a task on hold is resumed');
});

test('unhold without a session gets the handoff first', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  fx.repo.updateTask(r.id, { sessionId: null });
  fx.setRules([UNHOLD]);
  const mark = fx.invocations().length;
  assert.equal(await fx.engine.unhold!(r.id, ADA), undefined);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'back in review', 30_000);
  const launch = fx.invocations().slice(mark).find((i) => !i.prompt && i.kind === 'claude')!;
  assert.ok(!launch.args.includes('--resume'));
  const prompt = launch.args[launch.args.length - 1];
  assert.match(prompt, /^You are taking over kanban task #\d+/);
  assert.match(prompt, /has been on hold since/);
});

// --- Lounge, v1 ----------------------------------------------------------------------------------------

test('lounge figures: a floor\'s held tasks, oldest first; the floor is told when they change and not otherwise', () => {
  const db = new Database(':memory:');
  migrate(db);
  const repo = new KanbanRepository(db);
  const mk = (project: string, title: string) => repo.createTask({ project, title, tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const a = mk('web', 'A');
  const b = mk('web', 'B');
  const c = mk('api', 'C');
  mk('web', 'not held');
  const sent: { floor: string; msg: KanbanServerMsg }[] = [];
  const lounge = new LoungeSender(repo, (floor, msg) => void sent.push({ floor, msg }));
  lounge.changed('web');
  assert.equal(sent.length, 1, 'the first look at a floor says what is there, even nothing');
  sent.length = 0;
  repo.updateTask(b.id, { status: 'on_hold', hold: { at: 20, by: 'Ada', from: 'waiting', note: 'keys', until: 99, worker: { name: 'Fia', color: '#abc' } } });
  repo.updateTask(a.id, { status: 'on_hold', hold: { at: 10, by: 'Ada', from: 'review' } });
  repo.updateTask(c.id, { status: 'on_hold', hold: { at: 1, by: 'Ada', from: 'review' } });
  lounge.changed('web');
  lounge.changed('web');
  assert.equal(sent.length, 1, 'the same set is sent once');
  assert.equal(sent[0].floor, 'web');
  assert.deepEqual(sent[0].msg, {
    t: 'kanban.lounge',
    floor: 'web',
    figures: [
      { taskId: a.id, title: 'A', name: 'Worker', color: LOUNGE_NEUTRAL_COLOR, at: 10 },
      { taskId: b.id, title: 'B', name: 'Fia', color: '#abc', note: 'keys', until: 99, at: 20 },
    ],
  });
  assert.deepEqual(loungeFigures(repo, 'api').map((f) => f.taskId), [c.id]);
  repo.updateTask(a.id, { status: 'review', hold: null });
  lounge.changed('web');
  assert.equal(sent.length, 2);
  assert.deepEqual((sent[1].msg as { figures: { taskId: number }[] }).figures.map((f) => f.taskId), [b.id]);
});

test('/api/v1: a task on hold is not active and not in the active scope', async (t) => {
  const ctx = makeCtx([def('app', '/tmp/app-hold', { name: 'App', repo: 'o/app' })]);
  const held = ctx.repo.createTask({ project: 'app', title: 'Held', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'u' });
  ctx.repo.createTask({ project: 'app', title: 'Open', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'u' });
  ctx.repo.updateTask(held.id, { status: 'on_hold', hold: { at: 1000, by: 'u', from: 'review', note: 'waiting for keys', until: 2000 } });
  const plugin = createRefsPlugin(ctx);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const [prefix, h] of Object.entries({ ...plugin.loopback })) if (url.pathname.startsWith(prefix) && (await h(req, res, url))) return;
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await (await fetch(base + p)).json()) as any;
  assert.deepEqual((await get('/api/v1/tasks')).tasks.map((x: { title: string }) => x.title), ['Open']);
  const all = (await get('/api/v1/tasks?scope=all')).tasks as { title: string; active: boolean; statusTitle: string }[];
  const h = all.find((x) => x.title === 'Held')!;
  assert.equal(h.active, false);
  assert.equal(h.statusTitle, 'On hold');
  assert.deepEqual((await get('/api/v1/tasks?status=on_hold')).tasks.map((x: { title: string }) => x.title), ['Held']);
});

// --- Review fixes -------------------------------------------------------------------------------------------

test('machine: unhold with a plan to answer puts the task back to Waiting and runs nothing', () => {
  const tr = next(HELD, { type: 'unhold', back: { reason: 'plan_approval', text: 'Ready', phase: 'plan' } }, TASK, CFG);
  assert.ok(!('error' in tr));
  assert.equal(tr.state.status, 'waiting');
  assert.equal(tr.state.waitingReason, 'plan_approval');
  assert.equal(tr.state.phase, 'plan');
  assert.equal(tr.state.runState, 'idle');
  assert.deepEqual(tr.effects.map((x) => x.type), ['note']);
});

test('held from plan approval: unhold gives the approval back, hires nobody, and approving carries on as usual', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { planApproval: 'manual' });
  fx.setRules([{ when: 'You are planning kanban task', reply: 'PLAN READY', exitPlan: '1. Do it' }, IMPLEMENT]);
  const task = fx.newTask({ usePlan: true, useReview: false, planApproval: 'manual' });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const w = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval' && x.runState === 'idle', 'plan approval', 30_000);
  assert.equal(await fx.engine.hold!(task.id, ADA, { note: 'later' }), undefined);
  const h = await fx.waitTask(task.id, (x) => x.status === 'on_hold' && !x.workerId, 'held');
  assert.equal(h.hold?.reason, 'plan_approval');
  const hired = fx.workers.list().length;
  assert.equal(await fx.engine.unhold!(task.id, ADA, 'ok, later'), undefined);
  const back = fx.task(task.id);
  assert.equal(back.status, 'waiting');
  assert.equal(back.waitingReason, 'plan_approval');
  assert.equal(back.waitingText, w.waitingText);
  assert.equal(back.hold, undefined);
  assert.equal(fx.workers.list().length, hired, 'no worker was hired');
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => c.text.startsWith('▶️ Back from hold: approve the plan')));
  assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'implemented after approval', 30_000);
});

test('a queued unhold that is stopped leaves no hold behind', async (t) => {
  let full: string | undefined;
  const fx = await engineFixture({ capacity: { full: () => full, room: () => (full ? 0 : 5) } });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, { note: 'n' }), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  full = 'The office is at its limit';
  assert.equal(await fx.engine.unhold!(r.id, ADA), undefined);
  const q = fx.task(r.id);
  assert.equal(q.runState, 'queued');
  assert.equal(q.hold?.note, 'n', 'a queued unhold keeps what its prompt needs');
  assert.equal(await fx.engine.stop(r.id, ADA), undefined);
  const s = fx.task(r.id);
  assert.equal(s.status, 'waiting');
  assert.equal(s.hold, undefined);
});

test('v1: ?status=waiting also lists tasks on hold, as their legacy status says', async (t) => {
  const ctx = makeCtx([def('app', '/tmp/app-hold2', { name: 'App', repo: 'o/app' })]);
  const mk = (title: string) => ctx.repo.createTask({ project: 'app', title, tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'u' });
  ctx.repo.updateTask(mk('Held').id, { status: 'on_hold', hold: { at: 1, by: 'u', from: 'review' } });
  ctx.repo.updateTask(mk('Waits').id, { status: 'waiting' });
  const plugin = createRefsPlugin(ctx);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const [prefix, h] of Object.entries({ ...plugin.loopback })) if (url.pathname.startsWith(prefix) && (await h(req, res, url))) return;
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const body = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tasks?status=waiting`)).json()) as { tasks: { title: string }[] };
  assert.deepEqual(body.tasks.map((x) => x.title).sort(), ['Held', 'Waits']);
});

// --- Held messages, the lounge after a restart, many comments ---------------------------------------------------

const promptsOf = (fx: EngineFixture) => fx.invocations().map((i) => i.prompt ?? i.args[i.args.length - 1] ?? '');

for (const reason of ['plan_approval', 'plan_questions'] as const) {
  test(`held in ${reason}: the messages left meanwhile and the resume note reach the run the approval or answer starts`, async (t) => {
    const fx = await engineFixture();
    t.after(() => fx.close());
    const asks = reason === 'plan_questions';
    fx.setRules([asks ? { when: 'You are planning kanban task', reply: 'QUESTIONS:\n1. Which look?' } : { when: 'You are planning kanban task', reply: 'PLAN READY', exitPlan: '1. Do it' }, { when: 'The user replied about the plan', reply: 'Plan.\n\nPLAN READY', exitPlan: 'The plan' }, IMPLEMENT]);
    const task = fx.newTask({ usePlan: true, useReview: false, planApproval: 'manual' });
    assert.equal(await fx.engine.start(task.id, ADA), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === reason && x.runState === 'idle', reason, 30_000);
    assert.equal(await fx.engine.hold!(task.id, ADA, {}), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'on_hold' && !x.workerId, 'held');
    const said = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Bob', text: 'Keys arrived on Monday.' }).comment;
    await fx.engine.commented(task.id, said.id, BOB);
    assert.equal(fx.task(task.id).status, 'on_hold', 'only stored');
    assert.equal(await fx.engine.unhold!(task.id, ADA, 'Carry on with the new keys.'), undefined);
    const back = fx.task(task.id);
    assert.equal(back.waitingReason, reason);
    assert.equal(back.pendingMessages.length, 2, 'kept for the next run');
    assert.equal(fx.repo.getComment(said.id)?.pending, true);
    if (asks) assert.equal(await fx.engine.continue(task.id, ADA, 'Like this'), undefined);
    else assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
    await fx.waitTask(task.id, (x) => (asks ? x.waitingReason === 'plan_approval' : x.status === 'review') && x.runState === 'idle' && x.pendingMessages.length === 0, 'the run after the approval or answer', 30_000);
    const run = promptsOf(fx).find((p) => (asks ? /The user replied about the plan/ : /^Implement kanban task/).test(p))!;
    assert.ok(run, 'the run was prompted');
    assert.match(run, /Messages left on the task while it was on hold:/);
    assert.ok(run.includes('Keys arrived on Monday.') && run.includes('Carry on with the new keys.'), run);
    assert.equal(fx.repo.getComment(said.id)?.pending, false);
  });
}

test('the lounge after a restart: the last figure leaves before anything was sent: the floor is told it is empty', () => {
  const db = new Database(':memory:');
  migrate(db);
  const repo = new KanbanRepository(db);
  const t = repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  repo.updateTask(t.id, { status: 'on_hold', hold: { at: 1, by: 'Ada', from: 'review' } });
  const sent: KanbanServerMsg[] = [];
  const lounge = new LoungeSender(repo, (_f, msg) => void sent.push(msg));
  repo.updateTask(t.id, { status: 'review', hold: null });
  lounge.changed('web');
  assert.deepEqual(sent, [{ t: 'kanban.lounge', floor: 'web', figures: [] }]);
});

test('a browser arriving in the middle of a hold move does not hide the update from the rest of the floor', () => {
  const db = new Database(':memory:');
  migrate(db);
  const repo = new KanbanRepository(db);
  const t = repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const sent: KanbanServerMsg[] = [];
  const lounge = new LoungeSender(repo, (_f, msg) => void sent.push(msg));
  lounge.changed('web'); // the floor was told: nobody is held
  sent.length = 0;
  repo.updateTask(t.id, { status: 'on_hold', hold: { at: 1, by: 'Ada', from: 'review' } }); // the hold is saved ...
  assert.equal(loungeFigures(repo, 'web').length, 1); // ... a browser arrives and is shown it ...
  lounge.changed('web'); // ... and then the change is pushed
  assert.equal(sent.length, 1);
});

for (const reason of ['plan_approval', 'plan_questions'] as const) {
  test(`held messages stay on the task while the approval's or answer's run waits for room, and reach its prompt once it launches (${reason})`, async (t) => {
    let full: string | undefined;
    const fx = await engineFixture({ capacity: { full: () => full, room: () => (full ? 0 : 5) }, engine: { sweepMs: 100 } });
    t.after(() => fx.close());
    const asks = reason === 'plan_questions';
    fx.setRules([asks ? { when: 'You are planning kanban task', reply: 'QUESTIONS:\n1. Which look?' } : { when: 'You are planning kanban task', reply: 'PLAN READY', exitPlan: '1. Do it' }, { when: 'The user replied about the plan', reply: 'Plan.\n\nPLAN READY', exitPlan: 'The plan' }, IMPLEMENT]);
    const task = fx.newTask({ usePlan: true, useReview: false, planApproval: 'manual' });
    assert.equal(await fx.engine.start(task.id, ADA), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === reason && x.runState === 'idle', reason, 30_000);
    assert.equal(await fx.engine.hold!(task.id, ADA, {}), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'on_hold' && !x.workerId, 'held');
    fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Bob', text: 'Keys arrived on Monday.' });
    assert.equal(await fx.engine.unhold!(task.id, ADA), undefined);
    full = 'The office is at its limit';
    if (asks) assert.equal(await fx.engine.continue(task.id, ADA, 'Like this'), undefined);
    else assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
    const q = await fx.waitTask(task.id, (x) => x.runState === 'queued', 'queued for room');
    assert.equal(q.pendingMessages.length, 1, 'still the task\'s: no agent has them');
    full = undefined;
    await fx.waitTask(task.id, (x) => (asks ? x.waitingReason === 'plan_approval' : x.status === 'review') && x.runState === 'idle' && x.pendingMessages.length === 0, 'the queued run launched', 30_000);
    const run = promptsOf(fx).find((p) => (asks ? /The user replied about the plan/ : /^Implement kanban task/).test(p))!;
    assert.ok(run.includes('Keys arrived on Monday.'), run);
  });
}

test('the unhold prompt quotes every comment left while on hold, past fifty', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  for (let i = 0; i < 60; i++) fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: `held-${i}.` });
  fx.setRules([UNHOLD]);
  assert.equal(await fx.engine.unhold!(r.id, ADA), undefined);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'back in review', 30_000);
  const prompt = promptsOf(fx).find((p) => /has been on hold since/.test(p))!;
  for (let i = 0; i < 60; i++) assert.ok(prompt.includes(`held-${i}.`), `held-${i}`);
});
