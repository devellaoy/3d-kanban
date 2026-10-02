import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Floor } from '../src/server/floor.js';
import { validExtra } from '../src/server/kanban/launch.js';
import { endStop, type StopRun } from '../src/server/kanban/engine/stopping.js';
import { KanbanWorkers } from '../src/server/kanban/workers.js';
import { restoreWorkers, saveWorkers } from '../src/server/workers/persist.js';
import type { Worker } from '../src/server/workers/types.js';

/** A floor with one worker at `status` whose relaunch says `err`, whose halt says `left`, and whose transcript is `file`; what it was asked is logged. */
function floorWith(err: string | undefined, status: string, opts: { left?: string; file?: string } = {}) {
  const calls: string[] = [];
  const floor = {
    workers: {
      relaunch: async (id: string) => (calls.push(`relaunch ${id}`), err),
      halt: async (id: string) => (calls.push(`halt ${id}`), opts.left),
      rested: (id: string) => void calls.push(`rested ${id}`),
      transcripts: () => ({ claude: opts.file }),
      get: () => ({ status }),
    },
  } as unknown as Floor;
  return { floor, calls };
}

/** What the engine gives a Stop: `ended` is what ending the run answers (false: it had ended already); the run's stop and notes are logged with the floor's calls. */
function runOf(f: ReturnType<typeof floorWith>, ended: boolean, interrupted = false) {
  const notes: string[] = [];
  const run: StopRun = {
    workerId: 'w1',
    floor: () => f.floor,
    serial: (fn) => fn(),
    stop: async () => (f.calls.push('stop'), ended),
    note: (t) => void notes.push(t),
    interrupted: () => interrupted,
  };
  return { run, notes };
}

test('endStop: the run is stopped before the restart, and the worker stays at its desk', async () => {
  const f = floorWith(undefined, 'starting');
  const { run, notes } = runOf(f, true);
  await endStop(run, 'timeout');
  assert.deepEqual(f.calls, ['stop', 'relaunch w1']);
  assert.deepEqual(notes, ["It didn't stop in a few seconds after Esc: restarted on its session at its desk."]);
});

test("endStop: a restart that fails ends a working agent's process in place (halt), and leaves a resting one as it is", async () => {
  const err = 'Ada has no session to carry on yet';
  const working = floorWith(err, 'working');
  const w = runOf(working, true);
  await endStop(w.run, 'timeout');
  assert.deepEqual(working.calls, ['stop', 'relaunch w1', 'halt w1']);
  assert.match(w.notes[0], /couldn't restart it \(Ada has no session to carry on yet\), so its agent was ended; it stays at its desk/);

  const resting = floorWith(err, 'done');
  const r = runOf(resting, true);
  await endStop(r.run, 'background');
  assert.deepEqual(resting.calls, ['stop', 'relaunch w1'], 'a resting worker is not halted');
  assert.match(r.notes[0], /^Stopped while its background agents worked: couldn't restart it \(Ada has no session to carry on yet\); it stays as it is\.$/);

  const stuck = floorWith("Ada's old process didn't exit", 'working', { left: "Ada's old process didn't exit" });
  const s = runOf(stuck, true);
  await endStop(s.run, 'timeout');
  assert.match(s.notes[0], /so its agent was ended \(Ada's old process didn't exit\)/);
});

test('endStop: a stop that had already finished (the Stop hook or a rest got there first) neither restarts nor notes', async () => {
  const f = floorWith(undefined, 'working');
  const { run, notes } = runOf(f, false);
  await endStop(run, 'timeout');
  await endStop(run, 'background');
  assert.deepEqual(f.calls, ['stop', 'stop']);
  assert.deepEqual(notes, []);
});

test('endStop: an Esc the transcript confirms rests the worker and ends the run with no restart', async () => {
  const f = floorWith(undefined, 'working', { file: '/log.jsonl' });
  const { run, notes } = runOf(f, true, true);
  await endStop(run, 'timeout');
  assert.deepEqual(f.calls, ['rested w1', 'stop']);
  assert.deepEqual(notes, []);
});

test('validExtra keeps when the office last restarted the agent (a finite number) across workers.json, and drops anything else', () => {
  assert.equal(validExtra({ restartedAt: 123 })?.restartedAt, 123);
  assert.equal(validExtra({ restartedAt: '123' })?.restartedAt, undefined);
  assert.equal(validExtra({ restartedAt: Infinity })?.restartedAt, undefined);
});

test('extra.restartedAt survives a save and a restore of workers.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'restarted-'));
  try {
    const file = path.join(dir, 'workers.json');
    const info = { id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-1', name: 'Ada', color: '#fff', status: 'done', createdBy: 'test', createdAt: 1 };
    const worker = { info, tracker: {}, extra: { launchArgs: ['--x'], restartedAt: 1234 } } as unknown as Worker;
    saveWorkers(file, [worker], true);
    const restored = new Map<string, Worker>();
    restoreWorkers(file, restored, 'claude', () => false);
    assert.equal(restored.get('w1')?.extra?.restartedAt, 1234);
    assert.deepEqual(restored.get('w1')?.extra?.launchArgs, ['--x']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A worker manager of its own, with a process that exits on the signal `exitsOn` (SIGTERM is the default one), and what was resumed. */
function managerWith(exitsOn: 'SIGTERM' | 'SIGKILL' | 'never') {
  const signals: (string | undefined)[] = [];
  const exits: (() => void)[] = [];
  const pty = { kill: (signal?: string) => { signals.push(signal); if ((signal ?? 'SIGTERM') === exitsOn) exits.forEach((cb) => cb()); }, onExit: (cb: () => void) => void exits.push(cb) };
  const resumed: string[] = [];
  class Workers extends KanbanWorkers {
    readonly workers = new Map<string, Worker>();
    protected emitUpdate() {}
    protected setStatus() {}
    resume(id: string) {
      resumed.push(id);
      return undefined;
    }
  }
  const mgr = new Workers();
  mgr.workers.set('w1', { info: { id: 'w1', kind: 'agent', provider: 'claude', name: 'Ada', sessionId: 's1' }, pty } as unknown as Worker);
  return { mgr, signals, resumed, w: () => mgr.workers.get('w1')! };
}

test('relaunch and halt: SIGTERM first, SIGKILL when it is ignored; a process that still stays is not resumed over', { timeout: 30_000 }, async () => {
  const polite = managerWith('SIGTERM');
  assert.equal(await polite.mgr.relaunch('w1'), undefined);
  assert.deepEqual(polite.signals, [undefined]);
  assert.deepEqual(polite.resumed, ['w1']);

  const stubborn = managerWith('SIGKILL');
  const never = managerWith('never');
  const [halted, stuck] = await Promise.all([stubborn.mgr.halt('w1'), never.mgr.relaunch('w1')]);
  assert.equal(halted, undefined);
  assert.deepEqual(stubborn.signals, [undefined, 'SIGKILL']);
  assert.ok(stubborn.w().pty, 'halt leaves the process to the exit handler (it is not cleared first)');
  assert.equal(stuck, "Ada's old process didn't exit");
  assert.deepEqual(never.signals, [undefined, 'SIGKILL']);
  assert.deepEqual(never.resumed, [], 'no second agent on the session');
  assert.ok(never.w().pty, 'the old process is still its process');
});
