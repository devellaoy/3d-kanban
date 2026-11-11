// Ending a worker's terminal (endPty in src/server/ptys.ts): SIGHUP first, and SIGKILL when the
// process is still there after the grace period. A shell can miss a SIGHUP it gets while starting
// up, and a terminal left open keeps its Node process from ever exiting (a test file that never
// ends, a release run that hangs).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as pty from '@lydell/node-pty';
import { endPty } from '../src/server/ptys.js';

const unix = process.platform !== 'win32';

/** A terminal running `script` under sh, once it has printed "ready", and its exit when that comes. */
async function terminal(script: string) {
  const proc = pty.spawn('/bin/sh', ['-c', script], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
  let out = '';
  proc.onData((d) => (out += d));
  const exit: { signal?: number; at?: number } = {};
  proc.onExit((e) => Object.assign(exit, { signal: e.signal, at: Date.now() }));
  for (let i = 0; i < 200 && !out.includes('ready'); i++) await new Promise((r) => setTimeout(r, 25));
  assert.match(out, /ready/, 'the terminal started');
  const exited = async (ms: number) => {
    for (const end = Date.now() + ms; exit.at === undefined && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
    return exit.at !== undefined;
  };
  return { proc, exit, exited };
}

test('endPty kills a terminal that ignores SIGHUP once the grace period is over', { skip: !unix }, async (t) => {
  const { proc, exit, exited } = await terminal("trap '' HUP; echo ready; exec sleep 60");
  t.after(() => {
    if (exit.at === undefined) proc.kill('SIGKILL');
  });
  const start = Date.now();
  endPty(proc, 300);
  assert.equal(await exited(150), false, 'SIGHUP alone leaves it running');
  assert.ok(await exited(5000), 'SIGKILL ended it');
  assert.equal(exit.signal, 9);
  assert.ok(exit.at! - start >= 250, 'not before the grace period');
});

test('endPty leaves it at SIGHUP for a terminal that goes on it', { skip: !unix }, async (t) => {
  const { proc, exit, exited } = await terminal('echo ready; exec sleep 60');
  t.after(() => {
    if (exit.at === undefined) proc.kill('SIGKILL');
  });
  endPty(proc, 60_000);
  assert.ok(await exited(5000), 'SIGHUP ended it, long before the grace period');
  assert.equal(exit.signal, 1);
});
