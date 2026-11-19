import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gateDirty, gatePlanDirty, gateUnconfirmed } from '../src/shared/kanban/prompts.js';
import type { TurnResult } from '../src/server/kanban/engine/adapters/types.js';
import { prLines, workDone } from '../src/server/kanban/engine/markers.js';
import { acceptSignal, newTurn, StopGate, type GateRun, type StopGateDeps } from '../src/server/kanban/engine/signals.js';
import { TurnEnd, type EndLive, type TurnEndDeps } from '../src/server/kanban/engine/turnend.js';
import { worktreeDir } from '../src/server/worktree-home.js';
import { ADA, engineFixture, hookToken, midTurn, type EngineFixture } from './kanban-engine-fixture.js';
import { createSignals } from '../src/server/kanban/signals.js';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// The Stop hook gate (Claude only): a Stop that is no end of the work, or leaves uncommitted changes, is answered with feedback and the agent goes on.

const DONE = 'Changed it.\nWORK DONE';
const live = (extra: Partial<GateRun> = {}): GateRun => ({ taskId: 1, runId: 7, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', role: 'implementer', ...extra });
const turn = (extra: Partial<TurnResult> = {}): TurnResult => ({ text: '', complete: true, ...extra });

/** A gate over fake deps: what the log says, what is uncommitted and the notes made are the test's. */
function gateOf(o: { log?: TurnResult | undefined | (() => TurnResult | undefined); dirty?: string[]; max?: number; type?: 'implement' | 'investigate'; deadlineMs?: number; throws?: boolean; args?: string[] } = {}) {
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
    launchArgs: () => o.args,
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
  await allowed('a plan in plan mode, even with changes', live({ phase: 'plan' }), p, { log: turn({ text: 'A plan.' }), dirty: ['wt'], args: ['--permission-mode', 'plan'] });
  for (const phase of ['review', 'pr-review', 'compact'] as const) await allowed(`${phase} in auto mode`, live({ phase }), p, { log: turn({ text: 'x' }), dirty: ['wt'], args: ['--permission-mode', 'auto'] });
  await allowed('stopping', live({ stopping: {} }), p);
  await allowed('restating', live({ restating: true }), p);
  await allowed('an announced question', live({ signal: { kind: 'ask' } }), p);
  await allowed('the gate off', live(), p, { log: turn({ text: 'Still looking.' }), max: 0 });
  await allowed('background tasks running', live(), stop('Waiting.', { background_tasks: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'running' }] }));
  for (const [what, extra] of [['background work', { background: 1 }], ['teammates resuming', { resuming: true }], ['an unheard prompt', { unheard: true as const }], ['a typed turn still going', { typed: true as const, typedOpen: true }], ['a typed turn that took the work\'s end', { typed: true as const, interim: true }], ['a tool that still runs', { toolRunning: true }]] as const) {
    await allowed(what, live(), p, { log: turn({ text: 'Still looking.', ...extra }) });
  }
  await allowed('a usage limit', live(), stop("You've hit your limit · resets 3pm"));
  await allowed('an api error', live(), p, { log: turn({ text: 'x', apiError: 'API Error: 529 overloaded' }) });
  await allowed('no answer to judge', live(), {}, { log: undefined });
  await allowed('a log that fails', live(), p, { throws: true });
  // Finished background tasks do not keep it out.
  assert.ok((await gateOf({ log: turn({ text: 'Still looking.' }) }).gate.decide(live(), stop('Still looking.', { background_tasks: [{ id: 'a', status: 'completed' }] }))).block);
});

test('a plan in auto mode is gated on uncommitted changes alone: no WORK DONE is asked for, and the cap and the note are the same', async () => {
  const auto = ['--permission-mode', 'auto', '--disallowedTools', 'Edit'];
  const reply = 'The plan.\n\nPLAN READY';
  const clean = gateOf({ log: turn({ text: reply }), args: auto });
  assert.deepEqual(await clean.gate.decide(live({ phase: 'plan' }), stop(reply)), {}, 'no done signal is required');
  assert.deepEqual(await gateOf({ log: turn({ text: 'Thinking.' }), args: auto }).gate.decide(live({ phase: 'plan' }), stop('Thinking.')), {}, 'an unmarked reply with a clean tree goes through');
  const { gate, notes } = gateOf({ log: turn({ text: reply }), dirty: ['wt/a'], args: auto });
  const l = live({ phase: 'plan' });
  const r = await gate.decide(l, stop(reply));
  assert.deepEqual(r, { block: gatePlanDirty(['wt/a']) });
  assert.match(r.block!, /must not change files/);
  assert.match(r.block!, /PLAN READY or QUESTIONS:/);
  assert.ok((await gate.decide(l, stop(reply, { stop_hook_active: true }))).block);
  assert.deepEqual(await gate.decide(l, stop(reply, { stop_hook_active: true })), {}, 'after the cap the turn ends as before');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /uncommitted changes in wt\/a/);
  const inv = gateOf({ log: turn({ text: reply }), dirty: ['wt'], args: auto, type: 'investigate' });
  assert.deepEqual(await inv.gate.decide(live({ phase: 'plan' }), stop(reply)), {}, 'an investigation writes its report elsewhere');
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
  assert.deepEqual(await fx2.engine.stopGate(plan.w, { last_assistant_message: 'More to do.' }), {}, 'a plan with nothing changed is not asked for WORK DONE');
  // A plan in auto mode (the default) is read-only by the gate: changes in its worktree block the Stop.
  writeFileSync(path.join(tree(fx2, plan.w), 'plan-notes.txt'), 'x\n');
  const blocked = await fx2.engine.stopGate(plan.w, { last_assistant_message: 'The plan.\n\nPLAN READY' });
  assert.match(blocked.block ?? '', /The plan phase must not change files/);

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

// --- The review's findings (#449, round 1) --------------------------------------------------------------

/** A TurnEnd over fake deps that only records its holds. */
function endOf() {
  const held: string[] = [];
  const deps = {
    holds: { hold: (l: EndLive) => void held.push(`hold ${l.workerId}`), restate: () => false },
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
  return { end: new TurnEnd<EndLive>(deps), held };
}

test('the run\'s end waits for a gate decision under way: a done that comes while git is asked does not end the run the gate then blocks', async () => {
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  let answer!: (folders: string[]) => void;
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => (asked(), new Promise<string[]>((r) => (answer = r))), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live();
  const { end, held } = endOf();
  const gating = gate.decide(l, stop(DONE));
  await asking;
  // The worker shows `done` (the terminal's progress signal) while the gate still waits for git: the marker is there, but the decision is not.
  let ended: Awaited<ReturnType<typeof end.decide>> | undefined;
  const deciding = end.decide(l as EndLive, turn({ text: DONE }), { planExit: false, force: false }).then((e) => (ended = e));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ended, undefined, 'the end waits for the gate');
  answer(['wt']);
  assert.deepEqual(await gating, { block: gateDirty(['wt']) });
  await deciding;
  assert.deepEqual(ended, { end: false }, 'the blocked Stop is no end');
  assert.deepEqual(held, ['hold w']);
  assert.equal(l.gating, undefined);
  clearTimeout((l as EndLive).nudgeTimer);
});

test('a gate decision that comes back after the run ended or was stopped blocks nothing', async () => {
  for (const patch of [{ ended: true }, { stopping: { by: 'Ada' } }]) {
    let answer!: (folders: string[]) => void;
    let asked!: () => void;
    const asking = new Promise<void>((r) => (asked = r));
    const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => (asked(), new Promise<string[]>((r) => (answer = r))), maxBlocks: () => 2, readPauseMs: () => 1 });
    const l = live();
    const gating = gate.decide(l, stop(DONE));
    await asking;
    Object.assign(l, patch);
    answer(['wt']);
    assert.deepEqual(await gating, {});
    assert.equal(l.gated, undefined);
    assert.equal(l.gateBlocks, undefined);
  }
});

test('an announcement never makes an unfinished turn the answer: a tool still running, a log not caught up, a typed turn', async () => {
  for (const r of [turn({ text: 'Running the tests now.', toolRunning: true, complete: false }), turn({ text: 'Running the tests now.', complete: false }), turn({ text: 'Changed it.', typed: true, typedOpen: true })]) {
    const { end } = endOf();
    const l: EndLive = { taskId: 1, runId: 1, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'codex', signal: { kind: 'done' } };
    const e = await end.decide(l, r, { planExit: false, force: false });
    assert.deepEqual(e, { end: false }, JSON.stringify(r));
    clearTimeout(l.nudgeTimer);
  }
  // The finished turn's own answer is taken as it was read, never marked complete by the announcement.
  const { end } = endOf();
  const l: EndLive = { taskId: 1, runId: 1, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', signal: { kind: 'done' } };
  const e = await end.decide(l, turn({ text: 'Changed it.' }), { planExit: false, force: false });
  assert.equal(e.end, true);
  assert.equal(e.end && e.result?.text, 'Changed it.\nWORK DONE');
});

test('an announcement a Stop was held on is gone: the turn after the background work needs its own', async () => {
  const { end, held } = endOf();
  const l: EndLive = { taskId: 1, runId: 1, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', signal: { kind: 'done' }, signalPrs: ['https://github.com/o/r/pull/1'] };
  // Announced, then the turn ends to wait for a background agent: the run is held, on the text.
  assert.deepEqual(await end.decide(l, turn({ text: 'Waiting for the tests.', background: 1 }), { planExit: false, force: false }), { end: false });
  assert.equal(l.signal, undefined);
  assert.equal(l.signalPrs, undefined);
  // The notification's turn answers without an announcement or a marker: an interim update, as without any.
  assert.deepEqual(await end.decide(l, turn({ text: 'The tests passed.' }), { planExit: false, force: false }), { end: false });
  assert.deepEqual(held, ['hold w', 'hold w']);
  clearTimeout(l.nudgeTimer);
});

test('a subagent\'s Stop while the lead\'s is judged leaves the lead\'s decision alone: the done that follows still waits for it', async () => {
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  let answer!: (folders: string[]) => void;
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => (asked(), new Promise<string[]>((r) => (answer = r))), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live();
  const { end, held } = endOf();
  const gating = gate.decide(l, stop(DONE));
  await asking;
  const waited = l.gating;
  assert.ok(waited);
  // A subagent's Stop (it has the lead's token) comes back at once and touches nothing.
  assert.deepEqual(await gate.decide(l, stop('A helper is done.', { agent_id: 'a1' })), {});
  assert.equal(l.gating, waited, 'the lead\'s decision is still the one waited for');
  let ended: Awaited<ReturnType<typeof end.decide>> | undefined;
  const deciding = end.decide(l as EndLive, turn({ text: DONE }), { planExit: false, force: false }).then((e) => (ended = e));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ended, undefined, 'the end still waits for the gate');
  answer(['wt']);
  assert.deepEqual(await gating, { block: gateDirty(['wt']) });
  await deciding;
  assert.deepEqual(ended, { end: false });
  assert.deepEqual(held, ['hold w']);
  assert.equal(l.gating, undefined);
  clearTimeout((l as EndLive).nudgeTimer);
});

test('a second Stop of the lead\'s while one is judged neither replaces nor ends its wait: it is judged after it', async () => {
  const answers: ((folders: string[]) => void)[] = [];
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => new Promise<string[]>((r) => answers.push(r)), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live();
  const first = gate.decide(l, stop(DONE));
  await new Promise((r) => setTimeout(r, 20));
  const second = gate.decide(l, stop(DONE));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(answers.length, 1, 'the second is not judged while the first is');
  answers[0](['wt']);
  assert.deepEqual(await first, { block: gateDirty(['wt']) });
  assert.ok(l.gating, 'the wait goes on for the second');
  await new Promise((r) => setTimeout(r, 20));
  answers[1]([]);
  assert.deepEqual(await second, {});
  assert.equal(l.gating, undefined);
  assert.equal(l.gateBlocks, 1);
});

test('the run\'s end waits until no gate decision is under way: a second Stop that joins the wait is waited for too', async () => {
  const answers: ((folders: string[]) => void)[] = [];
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => new Promise<string[]>((r) => answers.push(r)), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live();
  const { end, held } = endOf();
  const tick = () => new Promise((r) => setTimeout(r, 20));
  // The first Stop is judged, and the run's end stands waiting for it.
  const first = gate.decide(l, stop(DONE));
  await tick();
  let ended: Awaited<ReturnType<typeof end.decide>> | undefined;
  const deciding = end.decide(l as EndLive, turn({ text: DONE }), { planExit: false, force: false }).then((e) => (ended = e));
  await tick();
  // A second Stop joins the wait; then the first is let through.
  const second = gate.decide(l, stop(DONE));
  await tick();
  answers[0]([]);
  assert.deepEqual(await first, {});
  await tick();
  assert.equal(ended, undefined, 'the end still waits: the second Stop is not judged yet');
  assert.equal(answers.length, 2);
  // The second is blocked: the run does not end on the answer the first let through.
  answers[1](['wt']);
  assert.deepEqual(await second, { block: gateDirty(['wt']) });
  await deciding;
  assert.deepEqual(ended, { end: false });
  assert.deepEqual(held, ['hold w']);
  assert.equal(l.gating, undefined);
  clearTimeout((l as EndLive).nudgeTimer);
});

// --- The review's findings (#449, the last round) --------------------------------------------------------

test('a prompt that comes while the gate decides: the answer read before it does not end the run, which is held for the new turn', async () => {
  let answer!: (folders: string[]) => void;
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => (asked(), new Promise<string[]>((r) => (answer = r))), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live({ signalPrs: ['https://github.com/o/r/pull/1'] });
  const { end, held } = endOf();
  const gating = gate.decide(l, stop(DONE));
  await asking;
  let ended: Awaited<ReturnType<typeof end.decide>> | undefined;
  const deciding = end.decide(l as EndLive, turn({ text: DONE }), { planExit: false, force: false }).then((e) => (ended = e));
  await new Promise((r) => setTimeout(r, 20));
  // Someone types a prompt into the terminal while git is asked: a new turn.
  newTurn(l);
  answer([]);
  assert.deepEqual(await gating, { stale: true }, 'nothing is blocked, and the Stop is a past turn\'s');
  await deciding;
  assert.deepEqual(ended, { end: false }, 'the old turn\'s WORK DONE ends nothing');
  assert.deepEqual(held, ['hold w']);
  assert.equal(l.signalPrs, undefined);
  clearTimeout((l as EndLive).nudgeTimer);
});

test('after the wait for the gate the turn is read again: the run is judged on what the log says now', async () => {
  let answer!: (folders: string[]) => void;
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: 'Still at it.' }), uncommitted: () => (asked(), new Promise<string[]>((r) => (answer = r))), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live({ signal: { kind: 'done' } });
  const held: string[] = [];
  let reads = 0;
  const deps = { holds: { hold: (x: EndLive) => void held.push(`hold ${x.workerId}`), restate: () => false }, following: () => true, serial: (_id: number, fn: () => Promise<unknown>) => fn(), task: () => undefined, floor: () => undefined, note() {}, read: async () => (reads++, turn({ text: 'The final answer, as the log has it now.\nWORK DONE' })), turnEnded: async () => {}, nudgeIdleMs: () => 60_000, maxNudges: () => 4 } as unknown as TurnEndDeps<EndLive>;
  const end = new TurnEnd<EndLive>(deps);
  const gating = gate.decide(l, stop('Still at it.'));
  await asking;
  const deciding = end.decide(l as EndLive, turn({ text: 'An answer the log had before the wait.', complete: false }), { planExit: false, force: false });
  answer([]);
  assert.deepEqual(await gating, {});
  const e = await deciding;
  assert.equal(reads, 1);
  assert.equal(e.end && e.result?.text, 'The final answer, as the log has it now.\nWORK DONE');
  assert.deepEqual(held, []);
});

test('a pull request reported with the command counts when the turn ends on the text\'s own WORK DONE, without a done announcement', async () => {
  const { end } = endOf();
  const url = 'https://github.com/o/r/pull/7';
  const l: EndLive = { taskId: 1, runId: 1, phase: 'pr', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', signalPrs: [url] };
  const e = await end.decide(l, turn({ text: 'Opened the pull request.\nWORK DONE' }), { planExit: false, force: false });
  assert.equal(e.end, true);
  const text = (e.end && e.result?.text) || '';
  assert.deepEqual(prLines(text).map((p) => p.url), [url]);
  assert.equal(workDone(text), true, 'the marker still reads as one');
  // One the text already names is not written twice.
  const l2: EndLive = { ...l, signalPrs: [url] };
  const e2 = await end.decide(l2, turn({ text: `Opened it.\nPR: ${url}\nWORK DONE` }), { planExit: false, force: false });
  assert.equal(e2.end && e2.result?.text, `Opened it.\nPR: ${url}\nWORK DONE`);
});

for (const dirty of [[], ['wt']]) test(`what the new turn announces while an old Stop's gate decision is still out is kept (git says ${dirty.length ? 'uncommitted changes' : 'clean'}): the old Stop's handling expires nothing of it`, async () => {
  let answer!: (folders: string[]) => void;
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => (asked(), new Promise<string[]>((r) => (answer = r))), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live({ phase: 'pr' });
  const { end, held } = endOf();
  const url = 'https://github.com/o/r/pull/9';
  // The old Stop's decision waits for git, and the run's end waits for it.
  const gating = gate.decide(l, stop(DONE));
  await asking;
  const deciding = end.decide(l as EndLive, turn({ text: DONE }), { planExit: false, force: false });
  await new Promise((r) => setTimeout(r, 20));
  // A new prompt, and the new turn reports its pull request and that it is done.
  newTurn(l);
  assert.equal(acceptSignal(l, { kind: 'pr', url }), undefined);
  assert.equal(acceptSignal(l, { kind: 'done' }), undefined);
  // The old decision comes back.
  answer(dirty);
  assert.deepEqual(await gating, { stale: true }, 'a decision about a past turn blocks nothing');
  assert.equal(l.gated, undefined);
  assert.equal(l.gateBlocks, undefined);
  assert.deepEqual(await deciding, { end: false }, 'the old turn\'s answer ends nothing');
  assert.deepEqual(held, ['hold w']);
  assert.deepEqual(l.signal, { kind: 'done' }, 'the new turn\'s announcement is still there');
  assert.deepEqual(l.signalPrs, [url]);
  clearTimeout((l as EndLive).nudgeTimer);
  // The new turn's own Stop then ends the run on it, the pull request with it.
  const e = await end.decide(l as EndLive, turn({ text: 'Opened the pull request.' }), { planExit: false, force: false });
  assert.equal(e.end && e.result?.text, `Opened the pull request.\nPR: ${url}\nWORK DONE`);
});

// --- Through the route and the engine: a Stop a new prompt overtook -----------------------------------------

/** Posts a Stop hook payload to the kanban's own route as the hook's wrapper does, with the worker's token. */
async function postStop(fx: EngineFixture, w: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const handler = createSignals(fx.ctx).hook!['/office/tasks/stop'];
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST', headers: { authorization: `Bearer ${hookToken(fx, w)}` } }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = { writeHead: (s: number) => void (status = s), end: (t: string) => void (text = t) } as unknown as ServerResponse;
  assert.equal(await handler(req, res, new URL('/office/tasks/stop', 'http://127.0.0.1'), { workerId: w, floorId: fx.ctx.projects()[0].id }), true);
  return { status, body: JSON.parse(text) };
}

test('route and engine: a Stop a new prompt overtook while the gate judged it is dropped, and its WORK DONE does not end the turn that goes now', async (t) => {
  // The gate reads the log again after a pause when it has no finished answer yet: long enough here for a prompt to come in between.
  const fx = await engineFixture({ engine: { readPauseMs: 300, nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  const { task, w } = await working(fx);
  const posting = postStop(fx, w, { last_assistant_message: DONE });
  await new Promise((r) => setTimeout(r, 120));
  // Someone types into the terminal while the gate still looks: the agent has a new turn.
  fx.workers.handleHook(w, hookToken(fx, w), 'UserPromptSubmit', { prompt: 'One more thing' });
  assert.deepEqual(await posting, { status: 200, body: {} }, 'nothing is blocked');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fx.workers.get(w)?.status, 'working', 'the Stop was not passed on: the worker still works on its new turn');
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running', 'the old answer ended nothing');
  assert.equal(fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result').length, 0);
});

test('route and engine: a Stop no prompt overtook is passed on as ever: the worker rests', async (t) => {
  const fx = await engineFixture({ engine: { readPauseMs: 50, nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  const { w } = await working(fx);
  assert.deepEqual(await postStop(fx, w, { last_assistant_message: 'Looked at it.', stop_hook_active: true, background_tasks: [{ id: 'b1', status: 'running' }] }), { status: 200, body: {} });
  assert.equal(fx.workers.get(w)?.status, 'done', 'upstream heard the Stop');
});

test('a turn typed into the terminal that is over is gated like any: an instruction typed in, a finished answer, a dirty worktree, and the Stop is blocked', async () => {
  // The office's turn ended earlier; someone typed one more instruction, and the agent answered it (the log's last turn, over).
  const typed = turn({ text: 'Changed it.', typed: true, lastText: 'Did the extra thing too.\nWORK DONE' });
  const dirty = gateOf({ log: typed, dirty: ['wt'] });
  const l = live();
  assert.deepEqual(await dirty.gate.decide(l, stop('Did the extra thing too.\nWORK DONE')), { block: gateDirty(['wt']) });
  assert.equal(dirty.calls.uncommitted, 1);
  assert.equal(l.gated, true);
  // Announced done instead of written: the same.
  assert.deepEqual(await gateOf({ log: turn({ text: 'Changed it.', typed: true, lastText: 'Did the extra thing too.' }), dirty: ['wt'] }).gate.decide(live({ signal: { kind: 'done' } }), stop('Did the extra thing too.')), { block: gateDirty(['wt']) });
  // Without the Stop's own answer the typed turn's is the one judged, not the office's before it.
  assert.deepEqual(await gateOf({ log: typed, dirty: ['wt'] }).gate.decide(live(), {}), { block: gateDirty(['wt']) });
  assert.deepEqual(await gateOf({ log: turn({ text: 'Changed it.\nWORK DONE', typed: true, lastText: 'Looked at the extra thing, more to do.' }) }).gate.decide(live(), {}), { block: gateUnconfirmed() });
  // A clean worktree lets it through, as for any turn.
  assert.deepEqual(await gateOf({ log: typed }).gate.decide(live(), stop('Did the extra thing too.\nWORK DONE')), {});
  // The log still shows the typed turn open when the Stop comes (it lags): read again, then judged.
  let reads = 0;
  const lag = gateOf({ log: () => (reads++ === 0 ? turn({ text: 'Changed it.', typed: true, typedOpen: true }) : typed), dirty: ['wt'] });
  assert.deepEqual(await lag.gate.decide(live(), stop('Did the extra thing too.\nWORK DONE')), { block: gateDirty(['wt']) });
  assert.equal(lag.calls.read, 2);
});

test('a Stop whose gate decision begins while the turn is read again after a wait is waited for too: its uncommitted changes block, and the run does not end', async () => {
  const answers: ((folders: string[]) => void)[] = [];
  const gate = new StopGate<GateRun>({ task: () => ({ id: 1, project: 'p', type: 'implement' }), note() {}, read: async () => turn({ text: DONE }), uncommitted: () => new Promise<string[]>((r) => answers.push(r)), maxBlocks: () => 2, readPauseMs: () => 1 });
  const l = live();
  const held: string[] = [];
  // The turn end's own read of the log, which the test lets go when it wants.
  let reading!: () => void;
  const readBegan = new Promise<void>((r) => (reading = r));
  let finishRead!: (r: TurnResult) => void;
  let reads = 0;
  const deps = { holds: { hold: (x: EndLive) => void held.push(`hold ${x.workerId}`), restate: () => false }, following: () => true, serial: (_id: number, fn: () => Promise<unknown>) => fn(), task: () => undefined, floor: () => undefined, note() {}, read: () => (reads++, reading(), new Promise<TurnResult>((r) => (finishRead = r))), turnEnded: async () => {}, nudgeIdleMs: () => 60_000, maxNudges: () => 4 } as unknown as TurnEndDeps<EndLive>;
  const end = new TurnEnd<EndLive>(deps);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  // The first Stop is judged (clean), the run's end waits for it and then reads the turn again.
  const first = gate.decide(l, stop(DONE));
  await tick();
  let ended: Awaited<ReturnType<typeof end.decide>> | undefined;
  const deciding = end.decide(l as EndLive, turn({ text: DONE }), { planExit: false, force: false }).then((e) => (ended = e));
  answers[0]([]);
  assert.deepEqual(await first, {});
  await readBegan;
  // A second Stop comes while that read is still out, and git finds uncommitted changes for it.
  const second = gate.decide(l, stop(DONE));
  await tick();
  finishRead(turn({ text: DONE }));
  await tick();
  assert.equal(ended, undefined, 'the end waits for the decision that began during the read');
  answers[1](['wt']);
  assert.deepEqual(await second, { block: gateDirty(['wt']) }, 'the run had not ended under it');
  await tick();
  // The turn is read once more after that wait, then the blocked Stop holds the run.
  assert.equal(reads, 2);
  finishRead(turn({ text: DONE }));
  await deciding;
  assert.deepEqual(ended, { end: false });
  assert.deepEqual(held, ['hold w']);
  assert.equal(l.ended, false);
  clearTimeout((l as EndLive).nudgeTimer);
});
