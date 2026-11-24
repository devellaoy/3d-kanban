// A task on hold (#61, docs/kanban-architecture.md §3): the migration, the machine, the engine's hold
// and unhold with the fake agents, the lounge figures and what other parts say about a held task.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate } from '../src/server/kanban/db/migrations.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { next, type HoldBack, type MachineEvent, type MachineState, type MachineTask } from '../src/server/kanban/engine/machine.js';
import { LoungeSender, loungeFigures, LOUNGE_NEUTRAL_COLOR } from '../src/server/kanban/lounge.js';
import { createRefsPlugin } from '../src/server/kanban/integrations/refs/index.js';
import { canFixPrs } from '../src/shared/kanban/prs.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { TaskHold } from '../src/shared/kanban/hold.js';
import type { WaitingReason } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const COMMENTED: Rule = { when: 'commented on task', reply: 'Done.', commit: 'After the hold' };
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
  assert.deepEqual(migrate(db, MIGRATIONS.slice(0, 4)), [4]);
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
  unhold: { type: 'unhold', back: { from: 'review' } },
  comment: { type: 'comment', text: 'hello', busy: false },
  review: { type: 'review' },
  pr: { type: 'pr', mode: 'fix' },
};
const CFG = { rounds: 2, reReviewLastFix: false };

test('every machine event on an idle task on hold either puts it back where it came from or leaves it on hold with nothing to run', () => {
  for (const [type, e] of Object.entries(EVERY_EVENT)) {
    const tr = next(HELD, e, TASK, CFG);
    if (type === 'unhold') {
      assert.ok(!('error' in tr));
      assert.equal(tr.state.status, 'review');
      assert.deepEqual(tr.effects.filter((x) => x.type === 'run'), [], 'Resume starts nothing');
    } else if ('error' in tr) assert.ok(tr.error, type);
    else {
      assert.equal(tr.state.status, 'on_hold', type);
      assert.equal(tr.state.runState, 'idle', type);
      assert.deepEqual(tr.effects.filter((x) => x.type === 'run'), [], type);
    }
  }
  assert.deepEqual(next(HELD, EVERY_EVENT.comment, TASK, CFG), { state: HELD, effects: [] }, 'a comment that comes without what the task was held from is only stored');
  assert.match(String((next(HELD, EVERY_EVENT.pr, TASK, CFG) as { error: string }).error), /on hold: resume it first/);
  assert.match(String((next(HELD, EVERY_EVENT.prReview, TASK, CFG) as { error: string }).error), /on hold: resume it first/);
  // Only a task on hold is resumed.
  assert.ok('error' in next({ ...HELD, status: 'review' }, EVERY_EVENT.unhold, TASK, CFG));
});

const REASONS: WaitingReason[] = ['plan_questions', 'plan_approval', 'agent_asking', 'stopped', 'failed', 'interrupted', 'usage_limit'];

for (const reason of REASONS) {
  test(`machine: held from Waiting for ${reason}: Resume starts nothing and shows a true wait, a comment starts exactly one run`, () => {
    const back: HoldBack = { from: 'waiting', reason, text: 'what it said', phase: reason.startsWith('plan') ? 'plan' : 'implement' };
    const off = next({ ...HELD, retryAt: 123 }, { type: 'unhold', back }, TASK, CFG);
    assert.ok(!('error' in off));
    assert.deepEqual(off.effects.filter((x) => x.type === 'run'), [], 'Resume starts nothing');
    assert.equal(off.state.status, 'waiting');
    assert.equal(off.state.runState, 'idle');
    assert.equal(off.state.retryAt, undefined, 'nothing retries by itself');
    assert.equal(off.state.phase, back.phase);
    const plain = reason === 'agent_asking' || reason === 'usage_limit';
    assert.equal(off.state.waitingReason, plain ? 'stopped' : reason, 'only the waits that cannot go on by themselves are told as a stop');
    if (plain) assert.ok(off.state.waitingText && off.state.waitingText !== back.text);
    else assert.equal(off.state.waitingText, 'what it said');
    // A comment on the restored state, and one straight from the hold, each start exactly one run.
    const restored = next(off.state, { type: 'comment', text: 'go', busy: false }, TASK, CFG);
    assert.ok(!('error' in restored));
    assert.equal(restored.effects.filter((x) => x.type === 'run').length, 1);
    const direct = next({ ...HELD, retryAt: 123 }, { type: 'comment', text: 'go', busy: false, back }, TASK, CFG);
    assert.ok(!('error' in direct));
    assert.equal(direct.effects.filter((x) => x.type === 'run').length, 1);
    assert.equal(direct.state.status, 'in_progress');
    assert.equal(direct.state.retryAt, undefined);
    const run = direct.effects.find((x) => x.type === 'run');
    assert.equal(run?.type === 'run' && run.prompt, reason.startsWith('plan') ? 'replan' : 'resume');
  });
}

test('machine: held from Review, Resume goes back to Review; a comment straight from the hold resumes the work', () => {
  const off = next(HELD, { type: 'unhold', back: { from: 'review' } }, TASK, CFG);
  assert.ok(!('error' in off));
  assert.equal(off.state.status, 'review');
  assert.equal(off.state.waitingReason, undefined);
  assert.deepEqual(off.effects.map((x) => x.type), ['note']);
  const direct = next(HELD, { type: 'comment', text: 'go', busy: false, back: { from: 'review' } }, TASK, CFG);
  assert.ok(!('error' in direct));
  assert.deepEqual(direct.effects, [{ type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', text: 'go' }]);
});

test('machine: a comment from the hold on an agent that was asking goes on in the phase it asked in', () => {
  const direct = next({ ...HELD, reviewRound: 1 }, { type: 'comment', text: 'yes', busy: false, back: { from: 'waiting', reason: 'agent_asking', phase: 'review' }, last: { phase: 'review', round: 1, role: 'reviewer' } }, TASK, CFG);
  assert.ok(!('error' in direct));
  assert.deepEqual(direct.effects, [{ type: 'run', phase: 'review', role: 'reviewer', prompt: 'resume', text: 'yes', round: 1 }]);
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
  assert.ok(said?.includes(r.workspace!.worktree.path) && said.includes('A comment puts it back to work') && said.includes('Resume only moves it back to Review'), said);
  assert.equal(fx.task(r.id).status, 'on_hold', 'the departure did not move it');
  // Nothing starts for it on its own: Retry and Continue refuse.
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

/** Puts a task in Waiting for `reason` as the engine leaves it (no worker, no run), ready to be held. */
async function waitingFor(fx: EngineFixture, reason: WaitingReason, patch: Parameters<EngineFixture['repo']['updateTask']>[1] = {}) {
  const r = await inReview(fx);
  fx.repo.updateTask(r.id, { status: 'waiting', waitingReason: reason, waitingText: `the ${reason} text`, phase: 'implement', ...patch });
  return fx.task(r.id);
}

test('Resume: back in the column it was held from, nobody is hired, nothing runs, anyone may do it, and the history shows it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, { note: 'waiting for the API keys' }), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  const mark = fx.invocations().length;
  const hired = fx.workers.list().length;
  assert.equal(await fx.engine.unhold!(r.id, BOB), undefined, 'not its maker, not an admin');
  await new Promise((res) => setTimeout(res, 300));
  const back = fx.task(r.id);
  assert.equal(back.status, 'review');
  assert.equal(back.runState, 'idle');
  assert.equal(back.hold, undefined, 'the hold is cleared');
  assert.equal(back.workerId, undefined);
  assert.equal(back.sessionId, r.sessionId, 'the session is kept for the next comment');
  assert.deepEqual(back.workspace, r.workspace);
  assert.equal(fx.workers.list().length, hired, 'nobody was hired');
  assert.equal(fx.invocations().length, mark, 'no agent was launched');
  assert.ok(fx.repo.listComments(r.id).comments.some((c) => c.text.startsWith('▶️ Off hold: back in Review')));
  assert.ok(String(await fx.engine.unhold!(r.id, ADA)), 'only a task on hold is resumed');
});

test('a comment on a held task starts a run at once: the resume prompt, the same worktree and session, the comment once, and the history shows the task leaving hold', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, { note: 'waiting for the API keys' }), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  fx.setRules([COMMENTED]);
  const mark = fx.invocations().length;
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'The keys are in.' }).comment;
  await fx.engine.commented(r.id, c.id, BOB);
  const back = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'back in review', 30_000);
  assert.equal(back.hold, undefined, 'the hold is cleared');
  assert.equal(back.sessionId, r.sessionId, 'the same session carries on');
  assert.equal(back.deskId, r.deskId);
  const launch = fx.invocations().slice(mark).find((i) => !i.prompt && i.kind === 'claude');
  assert.ok(launch, 'a new agent was launched');
  assert.equal(launch.args[launch.args.indexOf('--resume') + 1], r.sessionId);
  assert.equal(realpathSync(launch.cwd), realpathSync(path.join(fx.dir, r.workspace!.worktree.path)));
  const prompt = launch.args[launch.args.length - 1];
  assert.match(prompt, /^Bob commented on task #\d+:\s+The keys are in\./);
  assert.ok(!prompt.includes('You are taking over'), 'no handoff: it has its session');
  assert.equal(promptsOf(fx).slice(mark).filter((p) => p.includes('The keys are in.')).length, 2, 'the launch argument and the turn: once');
  assert.equal(fx.task(r.id).pendingMessages.length, 0);
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
  const runs = fx.repo.listRuns(r.id);
  assert.equal(runs[runs.length - 1].phase, 'resume');
  assert.ok(fx.repo.listEvents(r.id).some((e) => e.kind === 'moved' && (e.data as { from?: string; to?: string; by?: string }).from === 'on_hold' && (e.data as { to?: string }).to === 'in_progress' && (e.data as { by?: string }).by === 'Bob'));
});

test('a comment on a held task without a session gets the handoff first', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  fx.repo.updateTask(r.id, { sessionId: null });
  fx.setRules([COMMENTED]);
  const mark = fx.invocations().length;
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'Go on.' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'back in review', 30_000);
  const launch = fx.invocations().slice(mark).find((i) => !i.prompt && i.kind === 'claude')!;
  assert.ok(!launch.args.includes('--resume'));
  const prompt = launch.args[launch.args.length - 1];
  assert.match(prompt, /^You are taking over kanban task #\d+/);
  assert.ok(prompt.includes('Go on.'));
});

test('the worker hired by a comment on a held task is an ordinary hire: a name and colour of its own choosing, not the held figure\'s', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  const held = await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  assert.ok(held.hold?.worker, 'the lounge figure keeps the look');
  fx.setRules([COMMENTED]);
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'Go on.' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  const back = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'back in review', 30_000);
  assert.ok(fx.workers.get(back.workerId!), 'a worker sits at the desk');
  assert.equal(back.hold, undefined);
});

for (const reason of ['agent_asking', 'usage_limit', 'stopped'] as const) {
  test(`held from Waiting for ${reason}: Resume tells the truth, and nothing starts by itself, retry sweep included`, async (t) => {
    const fx = await engineFixture({ engine: { sweepMs: 50 } });
    t.after(() => fx.close());
    fx.setRules([IMPLEMENT]);
    const w = await waitingFor(fx, reason, { retryAt: Date.now() + 300, retryAttempts: 1 });
    assert.equal(await fx.engine.hold!(w.id, ADA, {}), undefined);
    const held = await fx.waitTask(w.id, (x) => x.status === 'on_hold' && !x.workerId, 'held');
    assert.equal(held.hold?.from, 'waiting');
    assert.equal(held.hold?.reason, reason);
    assert.equal(held.hold?.text, `the ${reason} text`);
    assert.equal(held.retryAt, undefined);
    const mark = fx.invocations().length;
    assert.equal(await fx.engine.unhold!(w.id, ADA), undefined);
    await new Promise((res) => setTimeout(res, 800)); // well past the sweep and the old retry time
    const back = fx.task(w.id);
    assert.equal(back.status, 'waiting');
    assert.equal(back.runState, 'idle');
    assert.equal(back.retryAt, undefined);
    assert.equal(back.hold, undefined);
    assert.equal(back.phase, 'implement');
    const plain = reason !== 'stopped';
    assert.equal(back.waitingReason, 'stopped');
    if (plain) assert.ok(back.waitingText && back.waitingText !== `the ${reason} text` && /comment|Retry/.test(back.waitingText), back.waitingText);
    else assert.equal(back.waitingText, `the ${reason} text`);
    assert.equal(fx.invocations().length, mark, 'no agent was launched');
    // And a comment then puts it to work like on any waiting task.
    fx.setRules([COMMENTED]);
    const c = fx.repo.addComment({ taskId: w.id, authorKind: 'user', authorName: 'Ada', text: 'Carry on.' }).comment;
    await fx.engine.commented(w.id, c.id, ADA);
    await fx.waitTask(w.id, (x) => x.status === 'review' && x.runState === 'idle', 'worked on', 30_000);
  });
}

test('held from a plan wait, a comment on the held task is the answer: the plan run (replan) starts at once', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { planApproval: 'manual' });
  fx.setRules([{ when: 'You are planning kanban task', reply: 'PLAN READY', exitPlan: '1. Do it' }, { when: 'The user replied about the plan', reply: 'Plan.\n\nPLAN READY', exitPlan: 'The plan' }, IMPLEMENT]);
  const task = fx.newTask({ usePlan: true, useReview: false, planApproval: 'manual' });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval' && x.runState === 'idle', 'plan approval', 30_000);
  assert.equal(await fx.engine.hold!(task.id, ADA, { note: 'later' }), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'on_hold' && !x.workerId, 'held');
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Bob', text: 'Make it smaller.' }).comment;
  await fx.engine.commented(task.id, c.id, BOB);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval' && x.runState === 'idle' && x.hold === undefined, 'the plan again', 30_000);
  const run = promptsOf(fx).find((p) => /The user replied about the plan/.test(p))!;
  assert.ok(run?.includes('Make it smaller.'), 'the replan run got the comment');
  assert.equal(fx.repo.listRuns(task.id).filter((x) => x.phase === 'plan').length, 2);
});

test('a task on hold that an old hold knows no reason for (held from Waiting before the hold kept it) comes back as a stop, and a comment starts it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  fx.repo.updateTask(r.id, { status: 'on_hold', workerId: null, hold: { at: Date.now(), by: 'Ada', from: 'waiting' } });
  assert.equal(await fx.engine.unhold!(r.id, BOB), undefined);
  const back = fx.task(r.id);
  assert.equal(back.status, 'waiting');
  assert.equal(back.waitingReason, 'stopped');
  fx.repo.updateTask(r.id, { status: 'on_hold', hold: { at: Date.now(), by: 'Ada', from: 'waiting' }, waitingReason: null, waitingText: null });
  fx.setRules([COMMENTED]);
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Go on.' }).comment;
  await fx.engine.commented(r.id, c.id, BOB);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'worked on', 30_000);
});

test('a comment on a held task while the office has no room: it waits in the queue the ordinary way, off hold, and its run starts once with the comment', async (t) => {
  let full: string | undefined;
  const fx = await engineFixture({ capacity: { full: () => full, room: () => (full ? 0 : 5) }, engine: { sweepMs: 100 } });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  full = 'The office is at its limit';
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Also rename it.' }).comment;
  await fx.engine.commented(r.id, c.id, BOB);
  const q = await fx.waitTask(r.id, (x) => x.runState === 'queued', 'queued');
  assert.equal(q.status, 'in_progress');
  assert.equal(q.hold, undefined, 'it is no longer on hold');
  assert.equal(q.queuedRun?.prompt, 'resume');
  fx.setRules([COMMENTED]);
  full = undefined;
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.pendingMessages.length === 0, 'back in review', 30_000);
  assert.equal(new Set(promptsOf(fx).filter((p) => p.includes('Also rename it.'))).size, 1);
  assert.equal(promptsOf(fx).filter((p) => p.includes('Also rename it.')).length, 2, 'the launch argument and the turn, no other prompt');
  assert.equal(fx.repo.listRuns(r.id).filter((x) => x.phase === 'resume').length, 1);
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
  assert.equal(await fx.engine.unhold!(task.id, ADA), undefined);
  const back = fx.task(task.id);
  assert.equal(back.status, 'waiting');
  assert.equal(back.waitingReason, 'plan_approval');
  assert.equal(back.waitingText, w.waitingText);
  assert.equal(back.hold, undefined);
  assert.equal(fx.workers.list().length, hired, 'no worker was hired');
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => c.text.startsWith('▶️ Off hold: back in Waiting')));
  assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'implemented after approval', 30_000);
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
  test(`held in ${reason}: the messages left on the task before comments started a run (stored by an older build) reach the run the approval or answer starts`, async (t) => {
    const fx = await engineFixture();
    t.after(() => fx.close());
    const asks = reason === 'plan_questions';
    fx.setRules([asks ? { when: 'You are planning kanban task', reply: 'QUESTIONS:\n1. Which look?' } : { when: 'You are planning kanban task', reply: 'PLAN READY', exitPlan: '1. Do it' }, { when: 'The user replied about the plan', reply: 'Plan.\n\nPLAN READY', exitPlan: 'The plan' }, IMPLEMENT]);
    const task = fx.newTask({ usePlan: true, useReview: false, planApproval: 'manual' });
    assert.equal(await fx.engine.start(task.id, ADA), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === reason && x.runState === 'idle', reason, 30_000);
    assert.equal(await fx.engine.hold!(task.id, ADA, {}), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'on_hold' && !x.workerId, 'held');
    // A comment of an older build: stored while the task was held, no run started for it.
    const said = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Bob', text: 'Keys arrived on Monday.' }).comment;
    assert.equal(await fx.engine.unhold!(task.id, ADA), undefined);
    const back = fx.task(task.id);
    assert.equal(back.waitingReason, reason);
    assert.equal(back.pendingMessages.length, 1, 'kept for the next run');
    assert.equal(fx.repo.getComment(said.id)?.pending, true);
    if (asks) assert.equal(await fx.engine.continue(task.id, ADA, 'Like this'), undefined);
    else assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
    await fx.waitTask(task.id, (x) => (asks ? x.waitingReason === 'plan_approval' : x.status === 'review') && x.runState === 'idle' && x.pendingMessages.length === 0, 'the run after the approval or answer', 30_000);
    const run = promptsOf(fx).find((p) => (asks ? /The user replied about the plan/ : /^Implement kanban task/).test(p))!;
    assert.ok(run, 'the run was prompted');
    assert.match(run, /Messages left on the task that you have not seen yet:/);
    assert.ok(run.includes('Keys arrived on Monday.'), run);
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

test('a comment on a held task quotes every comment left while it was on hold, past fifty', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  for (let i = 0; i < 60; i++) fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: `held-${i}.` });
  fx.setRules([COMMENTED]);
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'The one that starts it.' }).comment;
  await fx.engine.commented(r.id, c.id, BOB);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.pendingMessages.length === 0, 'back in review', 30_000);
  const prompt = promptsOf(fx).find((p) => /The one that starts it\./.test(p))!;
  for (let i = 0; i < 60; i++) assert.ok(prompt.includes(`held-${i}.`), `held-${i}`);
  assert.equal(prompt.split('The one that starts it.').length - 1, 1, 'the triggering comment is in the prompt once');
  assert.equal(fx.repo.listComments(r.id).comments.some((x) => x.pending), false);
});

// --- Messages carried by id until an agent has them ---------------------------------------------------------------

test('a failed run started by a comment on a held task keeps what was said: the Retry delivers it, once', async (t) => {
  const state = { ok: true };
  const fx = await engineFixture({ runAs: { claudeReady: () => state.ok, why: () => 'Ada is not signed in to Claude', apply: (_o: unknown, env: unknown) => env } as never });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx, { createdByAccount: 'acc1' });
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Use the staging keys.' });
  state.ok = false;
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Go on, please.' }).comment;
  await fx.engine.commented(r.id, c.id, BOB);
  const failed = await fx.waitTask(r.id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'failed');
  assert.equal(failed.pendingMessages.length, 2, 'kept: no agent has them');
  state.ok = true;
  fx.setRules([{ when: 'Your last turn on task', reply: 'Carried on.', commit: 'After the hold' }]);
  assert.equal(await fx.engine.retry(r.id, ADA), undefined);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.pendingMessages.length === 0, 'back in review', 30_000);
  // A launch is logged twice by the fake agent (its argument, then the turn's prompt): one distinct prompt is one delivery.
  const said = new Set(promptsOf(fx).filter((p) => p.includes('Use the staging keys.') && p.includes('Go on, please.')));
  assert.equal(said.size, 1, 'delivered once');
  assert.equal(promptsOf(fx).filter((p) => p.includes('Use the staging keys.')).length, 2, 'and in no other prompt');
  assert.equal(fx.repo.listComments(r.id).comments.some((c) => c.pending), false);
});

test('more than fifty held comments, then a comment that starts the run and a new one while it waits for a desk: every message reaches the prompt once and none stays pending', async (t) => {
  let full: string | undefined;
  const fx = await engineFixture({ capacity: { full: () => full, room: () => (full ? 0 : 5) }, engine: { sweepMs: 100 } });
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  for (let i = 0; i < 60; i++) fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: `held-${i}.` });
  full = 'The office is at its limit';
  const first = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'first-one.' }).comment;
  await fx.engine.commented(r.id, first.id, BOB);
  await fx.waitTask(r.id, (x) => x.runState === 'queued', 'queued');
  assert.equal(fx.task(r.id).pendingMessages.length, 60, 'nothing was dropped, and the triggering comment is the run\'s own text');
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'late-one.' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  assert.equal(fx.task(r.id).pendingMessages.length, 61, 'nothing was dropped');
  fx.setRules([COMMENTED]);
  full = undefined;
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.pendingMessages.length === 0, 'back in review', 30_000);
  const prompts = promptsOf(fx);
  for (const text of [...Array.from({ length: 60 }, (_, i) => `held-${i}.`), 'first-one.', 'late-one.']) assert.equal(new Set(prompts.filter((p) => p.includes(text))).size, 1, text);
  assert.equal(fx.repo.listComments(r.id).comments.some((x) => x.pending), false);
});

// --- A session that is gone; held messages on the way to Review ---------------------------------------------------------

/** Claude's folder of transcripts, as a worker of the fixture's office sees it (its projects folder exists, so a missing transcript is known to be missing). */
const claudeProjects = (...file: string[]) => {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  for (const f of file) writeFileSync(path.join(dir, f), '{}\n');
};

test('a stored session that no longer exists: the comment on a held task starts afresh with the handoff and every message, and nothing is acknowledged before the agent has them', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, { note: 'waiting for the keys' }), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  claudeProjects();
  fx.repo.updateTask(r.id, { sessionId: 'stale-gone' });
  fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Keys arrived on Monday.' });
  fx.setRules([COMMENTED]);
  const mark = fx.invocations().length;
  const histMark = fx.history(r.id).length;
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'Carry on, please.' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  const back = await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.pendingMessages.length === 0, 'back in review', 30_000);
  const launches = fx.invocations().slice(mark).filter((i) => !i.prompt && i.kind === 'claude');
  assert.equal(launches.length, 2, 'the stale resume, then the fresh start');
  assert.equal(launches[0].args[launches[0].args.indexOf('--resume') + 1], 'stale-gone');
  assert.ok(!launches[1].args.includes('--resume'));
  const prompt = launches[1].args[launches[1].args.length - 1];
  assert.match(prompt, /^You are taking over kanban task #\d+/);
  assert.ok(prompt.includes('Keys arrived on Monday.') && prompt.includes('Carry on, please.'), prompt);
  assert.notEqual(back.sessionId, 'stale-gone');
  // Nothing was acknowledged by the hire whose resume failed: the held message was still the task's after the stale agent had been launched, and went with the fresh hire.
  const snaps = fx.history(r.id).slice(histMark);
  const emptyAt = snaps.findIndex((s) => s.task.pendingMessages.length === 0);
  assert.ok(emptyAt > 0 && snaps[emptyAt - 1].task.pendingMessages.length === 1, 'the held message until the fresh hire');
  assert.ok(snaps[emptyAt - 1].at >= launches[0].at!, 'still pending after the stale launch');
  const runs = fx.repo.listRuns(r.id);
  assert.deepEqual(runs.slice(-2).map((x) => x.status), ['interrupted', 'succeeded']);
  assert.ok(fx.repo.listComments(r.id).comments.some((c) => /session \(stale-gone\) couldn't be resumed/.test(c.text)), 'the note says which session was dropped');
  assert.equal(fx.repo.listComments(r.id).comments.some((c) => c.pending), false);
});

test('held then moved on to Review: the messages left meanwhile reach the next run (a comment)', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  const said = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Use the staging keys.' }).comment;
  // What ws.ts does for a move on to Review.
  await fx.engine.releaseHeld!(r.id);
  fx.repo.updateTask(r.id, { status: 'review', hold: null });
  assert.equal(fx.task(r.id).pendingMessages.length, 1);
  assert.equal(fx.repo.getComment(said.id)?.pending, true);
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'Rename it as well.' }).comment;
  fx.setRules([{ when: 'commented on task', reply: 'Done.', commit: 'Rename' }]);
  await fx.engine.commented(r.id, c.id, ADA);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId && x.pendingMessages.length === 0, 'resumed', 30_000);
  const run = promptsOf(fx).find((p) => p.includes('Rename it as well.'))!;
  assert.ok(run.includes('Use the staging keys.'), run);
  assert.equal(fx.repo.getComment(said.id)?.pending, false);
});

test('an agent that exits early on a session that does exist keeps it: the run is interrupted and Retry carries on', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  claudeProjects('stale-present.jsonl'); // the transcript is there: whatever stopped the agent, the session is not gone
  fx.repo.updateTask(r.id, { sessionId: 'stale-present' });
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Ada', text: 'Go on.' }).comment;
  await fx.engine.commented(r.id, c.id, ADA);
  const w = await fx.waitTask(r.id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'interrupted', 30_000);
  assert.equal(w.sessionId, 'stale-present', 'the session is kept');
  assert.equal(w.pendingMessages.length, 1, 'and what was said waits for the Retry');
  assert.ok(!fx.repo.listComments(r.id).comments.some((c) => /couldn't be resumed/.test(c.text)));
});

test('the engine follows a worker only while its run goes (upstream\'s fresh start on a lost session stays on for the rest)', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  const followed = () => (fx.workers as unknown as { followed: Set<string> }).followed;
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const running = await fx.waitTask(task.id, (x) => !!x.workerId, 'hired');
  assert.ok(followed().has(running.workerId!), 'followed while its run goes');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'review', 30_000);
  assert.ok(!followed().has(done.workerId!), 'not once the run is over');
});

test('a comment on a held task is anyone\'s, as on any task: Resume too, with no creator or admin needed', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([IMPLEMENT]);
  const r = await inReview(fx);
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => !x.workerId, 'the worker gone');
  assert.equal(await fx.engine.unhold!(r.id, BOB), undefined, 'not its maker, not an admin');
  assert.equal(fx.task(r.id).status, 'review');
  assert.equal(await fx.engine.hold!(r.id, ADA, {}), undefined);
  await fx.waitTask(r.id, (x) => x.status === 'on_hold', 'held again');
  fx.setRules([COMMENTED]);
  const c = fx.repo.addComment({ taskId: r.id, authorKind: 'user', authorName: 'Bob', text: 'Back to it.' }).comment;
  await fx.engine.commented(r.id, c.id, BOB);
  await fx.waitTask(r.id, (x) => x.status === 'review' && x.runState === 'idle' && !!x.workerId, 'worked on', 30_000);
});

test('an in-place relaunch on a resumed session acknowledges the held messages once the agent is heard from, and delivers them once', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'PLAN READY', exitPlan: '1. Do it' }, IMPLEMENT]);
  const task = fx.newTask({ usePlan: true, useReview: false, planApproval: 'manual' });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval' && x.runState === 'idle', 'plan approval', 30_000);
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Bob', text: 'Mind the staging keys.' }).comment;
  fx.repo.setCommentPending(c.id, true);
  fx.repo.updateTask(task.id, { pendingMessages: [{ commentId: c.id, text: c.text, by: 'Bob', at: c.createdAt, held: true }] });
  assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && x.pendingMessages.length === 0, 'implemented', 30_000);
  assert.equal(new Set(promptsOf(fx).filter((p) => p.includes('Mind the staging keys.'))).size, 1);
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
});
