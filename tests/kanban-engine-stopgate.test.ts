import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gateDirty, gateUnconfirmed } from '../src/shared/kanban/prompts.js';
import type { TurnResult } from '../src/server/kanban/engine/adapters/types.js';
import { StopGate, type GateRun, type StopGateDeps } from '../src/server/kanban/engine/signals.js';
import { TurnEnd, type EndLive, type TurnEndDeps } from '../src/server/kanban/engine/turnend.js';
import { worktreeDir } from '../src/server/worktree-home.js';
import { ADA, engineFixture, midTurn, type EngineFixture } from './kanban-engine-fixture.js';

// The Stop hook gate (Claude only): a Stop that is no end of the work, or leaves uncommitted changes, is answered with feedback and the agent goes on.

const DONE = 'Changed it.\nWORK DONE';
const live = (extra: Partial<GateRun> = {}): GateRun => ({ taskId: 1, runId: 7, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', role: 'implementer', ...extra });
const turn = (extra: Partial<TurnResult> = {}): TurnResult => ({ text: '', complete: true, ...extra });

/** A gate over fake deps: what the log says, what is uncommitted and the notes made are the test's. */
function gateOf(o: { log?: TurnResult | undefined | (() => TurnResult | undefined); dirty?: string[]; max?: number; type?: 'implement' | 'investigate'; deadlineMs?: number; throws?: boolean } = {}) {
  const notes: string[] = [];
  const calls = { read: 0, uncommitted: 0 };
  const deps: StopGateDeps<GateRun> = {
    task: () => ({ id: 1, project: 'p', type: o.type ?? 'implement' }),
    note: (_t, text) => void notes.push(text),
    read: async () => {
      calls.read++;
      if (o.throws) throw new Error('boom');
      return typeof o.log === 'function' ? o.log() : o.log;
    },
    uncommitted: async () => (calls.uncommitted++, o.dirty ?? []),
    maxBlocks: () => o.max ?? 2,
    readPauseMs: () => 1,
    ...(o.deadlineMs ? { deadlineMs: o.deadlineMs } : {}),
  };
  return { gate: new StopGate(deps), notes, calls };
}
const stop = (text: string, extra: Record<string, unknown> = {}) => ({ last_assistant_message: text, ...extra });

test('a Stop without the end of the work is blocked: the feedback, the count, the gated mark; the announcement is cleared', async () => {
  const { gate } = gateOf({ log: turn({ text: 'Still looking.' }) });
  const l = live({ lastHookAt: 0 });
  const r = await gate.decide(l, stop('Still looking.'));
  assert.deepEqual(r, { block: gateUnconfirmed() });
  assert.equal(l.gateBlocks, 1);
  assert.equal(l.gated, true);
  assert.ok((l.lastHookAt ?? 0) > 0);
  assert.match(r.block!, /did not take this as the end of your work/);
  assert.match(r.block!, /IN FULL/);
  assert.match(r.block!, /WORK DONE/);
  assert.match(r.block!, /office-tasks done/);
  assert.match(r.block!, /office-tasks ask/);
});

test('a Stop after an announced done or a WORK DONE line with a clean worktree is let through; with changes uncommitted it is blocked, naming the folders', async () => {
  const clean = gateOf({ log: turn({ text: DONE }) });
  assert.deepEqual(await clean.gate.decide(live(), stop(DONE)), {});
  assert.equal(clean.calls.uncommitted, 1);
  const announced = live({ signal: { kind: 'done' } });
  assert.deepEqual(await gateOf({ log: turn({ text: 'Done, I think.' }) }).gate.decide(announced, stop('Done, I think.')), {}, 'done confirms without a marker');
  const dirty = gateOf({ log: turn({ text: DONE }), dirty: ['wt/a', 'wt/b'] });
  const l = live({ signal: { kind: 'done' } });
  const r = await dirty.gate.decide(l, stop(DONE));
  assert.deepEqual(r, { block: gateDirty(['wt/a', 'wt/b']) });
  assert.match(r.block!, /wt\/a, wt\/b/);
  assert.match(r.block!, /don't delete or add files that aren't yours/);
  assert.match(r.block!, /office-tasks ask/);
  assert.equal(l.signal, undefined, 'the agent announces again');
  assert.equal(l.gateBlocks, 1);
});

test('the cap: a run gets two blocks, the third Stop goes through with one note per run', async () => {
  const { gate, notes } = gateOf({ log: turn({ text: 'Still looking.' }) });
  const l = live();
  assert.ok((await gate.decide(l, stop('Still looking.'))).block);
  assert.ok((await gate.decide(l, stop('Still looking.', { stop_hook_active: true }))).block);
  assert.deepEqual(await gate.decide(l, stop('Still looking.', { stop_hook_active: true })), {});
  assert.deepEqual(await gate.decide(l, stop('Still looking.')), {});
  assert.deepEqual(notes, ['Its agent ended its turn without saying it was done, even when the office asked twice: went on as before']);
  const d = gateOf({ log: turn({ text: DONE }), dirty: ['wt/a'] });
  const m = live({ gateBlocks: 2 });
  assert.deepEqual(await d.gate.decide(m, stop(DONE)), {});
  assert.deepEqual(d.notes, ['Its agent ended its turn with uncommitted changes in wt/a, even when the office asked twice: went on as before']);
  assert.equal(m.gateNoted, true);
});

test('stop_hook_active with no counter of the run (a restart, a hook of another office) counts as one block', async () => {
  const { gate, notes } = gateOf({ log: turn({ text: 'Still looking.' }), max: 2 });
  const l = live();
  const first = await gate.decide(l, stop('Still looking.', { stop_hook_active: true }));
  assert.ok(first.block, 'one more block is left');
  assert.equal(l.gateBlocks, 2);
  assert.deepEqual(await gate.decide(l, stop('Still looking.', { stop_hook_active: true })), {});
  assert.equal(notes.length, 1);
  const one = gateOf({ log: turn({ text: 'Still looking.' }), max: 1 });
  assert.deepEqual(await one.gate.decide(live(), stop('Still looking.', { stop_hook_active: true })), {}, 'the cap of one is used up by it');
});

test('the gate does not fire: it lets the Stop through whenever the Stop is not the end of a turn of the implementer or the picture is unclear', async () => {
  const allowed = async (what: string, l: GateRun | undefined, payload: unknown, o: Parameters<typeof gateOf>[0] = { log: turn({ text: 'Still looking.' }) }) => {
    assert.deepEqual(await gateOf(o).gate.decide(l, payload), {}, what);
  };
  const p = stop('Still looking.');
  await allowed('no run followed', undefined, p);
  await allowed('ended', live({ ended: true }), p);
  await allowed('codex', live({ tool: 'codex' }), p);
  await allowed('a reviewer', live({ role: 'reviewer', phase: 'fix' }), p);
  await allowed('a subagent or teammate', live(), stop('Still looking.', { agent_id: 'helper@1' }));
  for (const phase of ['plan', 'review', 'pr-review', 'compact'] as const) await allowed(phase, live({ phase }), p);
  await allowed('stopping', live({ stopping: {} }), p);
  await allowed('restating', live({ restating: true }), p);
  await allowed('an announced question', live({ signal: { kind: 'ask' } }), p);
  await allowed('the gate off', live(), p, { log: turn({ text: 'Still looking.' }), max: 0 });
  await allowed('background tasks running', live(), stop('Waiting.', { background_tasks: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'running' }] }));
  for (const [what, extra] of [['background work', { background: 1 }], ['teammates resuming', { resuming: true }], ['an unheard prompt', { unheard: true as const }], ['a typed prompt', { typed: true as const }], ['a tool that still runs', { toolRunning: true }]] as const) {
    await allowed(what, live(), p, { log: turn({ text: 'Still looking.', ...extra }) });
  }
  await allowed('a usage limit', live(), stop("You've hit your limit · resets 3pm"));
  await allowed('an api error', live(), p, { log: turn({ text: 'x', apiError: 'API Error: 529 overloaded' }) });
  await allowed('no answer to judge', live(), {}, { log: undefined });
  await allowed('a log that fails', live(), p, { throws: true });
  // Finished background tasks do not keep it out.
  assert.ok((await gateOf({ log: turn({ text: 'Still looking.' }) }).gate.decide(live(), stop('Still looking.', { background_tasks: [{ id: 'a', status: 'completed' }] }))).block);
});

test('an investigation is never asked for a commit', async () => {
  const g = gateOf({ log: turn({ text: DONE }), dirty: ['wt'], type: 'investigate' });
  assert.deepEqual(await g.gate.decide(live(), stop(DONE)), {});
  assert.equal(g.calls.uncommitted, 0);
});

test('the log is read again a moment when it lags the Stop, and a log that shows work out then lets it through', async () => {
  let n = 0;
  const g = gateOf({ log: () => (++n < 3 ? turn({ text: '', complete: false }) : turn({ text: 'Waiting.', background: 1 })) });
  assert.deepEqual(await g.gate.decide(live(), stop('Waiting.')), {});
  assert.equal(g.calls.read, 3);
});

test('a decision that takes too long lets the Stop through', async () => {
  const slow = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: () => new Promise(() => {}), uncommitted: async () => [], maxBlocks: () => 2, readPauseMs: () => 1, deadlineMs: 30 });
  assert.deepEqual(await slow.decide(live(), stop('Still looking.')), {});
});

// --- A blocked Stop is no turn end ----------------------------------------------------------------------

test('TurnEnd: the worker\'s done after a blocked Stop holds the run instead of ending it; the hold\'s timeout still ends it', async () => {
  const held: string[] = [];
  const deps = {
    holds: { hold: (l: EndLive) => void held.push(`hold ${l.workerId}`) },
    following: () => true,
    serial: (_id: number, fn: () => Promise<unknown>) => fn(),
    task: () => undefined,
    floor: () => undefined,
    note() {},
    read: async () => undefined,
    turnEnded: async () => {},
    nudgeIdleMs: () => 60_000,
    maxNudges: () => 4,
  } as unknown as TurnEndDeps<EndLive>;
  const end = new TurnEnd<EndLive>(deps);
  const l: EndLive = { taskId: 1, runId: 1, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', gated: true };
  const said = turn({ text: DONE });
  const a = await end.decide(l, said, { planExit: false, force: false });
  assert.deepEqual(a, { end: false });
  assert.deepEqual(held, ['hold w']);
  clearTimeout(l.nudgeTimer);
  const b = await end.decide(l, said, { planExit: false, force: true });
  assert.equal(b.end, true, 'the hold\'s timeout ends it on what the log says');
  // A usage limit that cut the turn the agent went on with fires no Stop: it still ends the run, to be retried.
  const cut = await end.decide(l, turn({ text: "You've hit your limit · resets 3pm" }), { planExit: false, force: false });
  assert.equal(cut.end, true, 'an interrupted turn is not held behind the gate');
  l.gated = false;
  assert.equal((await end.decide(l, said, { planExit: false, force: false })).end, true, 'once a Stop is heard again the marker ends it as before');
  // An announcement made after the block is for the new turn: it ends the run.
  l.gated = true;
  l.signal = { kind: 'done' };
  assert.equal((await end.decide(l, turn({ text: 'Changed it.' }), { planExit: false, force: false })).end, true);
});

// --- Through the engine ----------------------------------------------------------------------------------

async function working(fx: EngineFixture, patch: Parameters<EngineFixture['newTask']>[0] = {}, rule: { reply?: string } = {}) {
  fx.setRules([{ when: '(?:Implement|Investigate) kanban task', reply: rule.reply ?? 'Changed it.', noMarker: true, delayMs: 20_000 }, { when: 'You are planning kanban task', reply: 'A plan.', noMarker: true, delayMs: 20_000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  await fx.engine.start(task.id, ADA);
  const t = await fx.waitTask(task.id, (x) => !!x.workerId && x.runState === 'running', 'the agent at work');
  await midTurn(fx, t.workerId!);
  return { task, w: t.workerId! };
}
const notes = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'status').map((c) => c.text);
const tree = (fx: EngineFixture, w: string) => worktreeDir(fx.dir, fx.workers.get(w)!.worktree!.path);

test('the engine gate: a Stop without confirmation is blocked twice, the third goes through with one note', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task, w } = await working(fx);
  assert.deepEqual(await fx.engine.stopGate(w, { last_assistant_message: 'Waiting', agent_id: 'helper@1' }), {}, 'a teammate\'s Stop');
  assert.deepEqual(await fx.engine.stopGate(w, { last_assistant_message: 'Waiting', background_tasks: [{ id: 'x', status: 'running' }] }), {}, 'work out');
  assert.equal((await fx.engine.stopGate(w, { last_assistant_message: 'Looked at it, more to do.' })).block, gateUnconfirmed());
  assert.equal((await fx.engine.stopGate(w, { last_assistant_message: 'Looked at it, more to do.', stop_hook_active: true })).block, gateUnconfirmed());
  assert.deepEqual(await fx.engine.stopGate(w, { last_assistant_message: 'Looked at it, more to do.', stop_hook_active: true }), {});
  assert.deepEqual(await fx.engine.stopGate(w, { last_assistant_message: 'Looked at it, more to do.' }), {});
  assert.equal(notes(fx, task.id).filter((n) => /without saying it was done, even when the office asked twice/.test(n)).length, 1);
  assert.equal(fx.task(task.id).status, 'in_progress', 'a blocked Stop moved nothing');
  assert.equal(fx.engine.signal(w, { kind: 'done' }), undefined);
});

test('the engine gate: a done turn with uncommitted work is blocked until it is committed', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { w } = await working(fx);
  writeFileSync(path.join(tree(fx, w), 'new.txt'), 'work\n');
  const blocked = await fx.engine.stopGate(w, { last_assistant_message: DONE });
  assert.ok(blocked.block?.includes(fx.workers.get(w)!.worktree!.path), blocked.block);
  assert.equal(blocked.block, gateDirty([fx.workers.get(w)!.worktree!.path]));
  execFileSync('git', ['add', '-A'], { cwd: tree(fx, w) });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'Work'], { cwd: tree(fx, w) });
  assert.deepEqual(await fx.engine.stopGate(w, { last_assistant_message: DONE }), {});
});

test('the engine gate: an investigation, a plan and a Codex agent are never gated', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const inv = await working(fx, { type: 'investigate' });
  writeFileSync(path.join(tree(fx, inv.w), 'notes.txt'), 'x\n');
  assert.deepEqual(await fx.engine.stopGate(inv.w, { last_assistant_message: DONE }), {}, 'no git check');
  assert.equal((await fx.engine.stopGate(inv.w, { last_assistant_message: 'More to do.' })).block, gateUnconfirmed(), 'but its unfinished turn is still asked about');

  const fx2 = await engineFixture();
  t.after(() => fx2.close());
  const plan = await working(fx2, { usePlan: true });
  assert.deepEqual(await fx2.engine.stopGate(plan.w, { last_assistant_message: 'More to do.' }), {}, 'a plan');

  const fx3 = await engineFixture();
  t.after(() => fx3.close());
  const codex = await working(fx3, { tool: 'codex' });
  assert.deepEqual(await fx3.engine.stopGate(codex.w, { last_assistant_message: 'More to do.' }), {}, 'codex');
  assert.deepEqual(await fx3.engine.stopGate('nobody', { last_assistant_message: 'More to do.' }), {}, 'no run');
});

test('the engine gate: off with maxGateBlocks 0', async (t) => {
  const fx = await engineFixture({ engine: { maxGateBlocks: 0 } });
  t.after(() => fx.close());
  const { w } = await working(fx);
  assert.deepEqual(await fx.engine.stopGate(w, { last_assistant_message: 'More to do.' }), {});
});
