import test from 'node:test';
import assert from 'node:assert/strict';
import type { Floor } from '../src/server/floor.js';
import { validExtra } from '../src/server/kanban/launch.js';
import { STOP_TIMED_OUT, stopAndRestart } from '../src/server/kanban/engine/stopping.js';

/** A floor with one worker whose relaunch says `err`, at `status`; what it was asked is logged. */
function floorWith(err: string | undefined, status: string) {
  const calls: string[] = [];
  const floor = {
    workers: {
      relaunch: async (id: string) => (calls.push(`relaunch ${id}`), err),
      get: () => ({ status }),
    },
    sendHome: async (id: string, cleanup: string) => (calls.push(`home ${id} ${cleanup}`), {}),
  } as unknown as Floor;
  return { floor, calls };
}

test('stopAndRestart: the run is stopped before the restart, and the worker stays at its desk', async () => {
  const { floor, calls } = floorWith(undefined, 'starting');
  const notes: string[] = [];
  await stopAndRestart(floor, 'w1', async () => void calls.push('stop'), (t) => notes.push(t), STOP_TIMED_OUT);
  assert.deepEqual(calls, ['stop', 'relaunch w1']);
  assert.deepEqual(notes, [STOP_TIMED_OUT]);
});

test("stopAndRestart: a restart that fails leaves the worker where it is, resting or at work, and never sends it home", async () => {
  const resting = floorWith('Ada has no session to carry on yet', 'done');
  const notes: string[] = [];
  await stopAndRestart(resting.floor, 'w1', async () => {}, (t) => notes.push(t), STOP_TIMED_OUT);
  assert.deepEqual(resting.calls, ['relaunch w1']);
  assert.match(notes[0], /couldn't restart it \(Ada has no session to carry on yet\), so it stays as it is/);

  const working = floorWith('Ada has no session to carry on yet', 'working');
  await stopAndRestart(working.floor, 'w1', async () => {}, (t) => notes.push(t), STOP_TIMED_OUT);
  assert.deepEqual(working.calls, ['relaunch w1']);
  assert.match(notes[1], /couldn't restart it \(Ada has no session to carry on yet\), so it stays as it is/);
});

test('validExtra keeps when the office last restarted the agent (a finite number) across workers.json, and drops anything else', () => {
  assert.equal(validExtra({ restartedAt: 123 })?.restartedAt, 123);
  assert.equal(validExtra({ restartedAt: '123' })?.restartedAt, undefined);
  assert.equal(validExtra({ restartedAt: Infinity })?.restartedAt, undefined);
});
