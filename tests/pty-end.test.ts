// Ending a worker's terminal (endPty in src/server/ptys.ts, and the host's stop in ptyhost.ts):
// SIGHUP first, and SIGKILL when the process is still there after the grace period. A shell can
// miss a SIGHUP it gets while starting up, and a terminal left open keeps its Node process from
// ever exiting (a test file that never ends, a release run that hangs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import { PtyHost, endPty, type Pty, type PtyExit } from '../src/server/ptys.js';

const unix = process.platform !== 'win32';
/** A shell that ignores SIGHUP, as one that missed it while starting up behaves. */
const DEAF = "trap '' HUP; echo ready; exec sleep 60";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `pred` for up to `ms`. */
async function until(pred: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !pred() && Date.now() < end; ) await sleep(25);
  return pred();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // A zombie still answers signal 0 on Linux: look at its state.
    return process.platform !== 'linux' || !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
  } catch {
    return false;
  }
};

/** A terminal running `script` under sh, once it has printed "ready", and its exit when that comes. */
async function terminal(spawn: (file: string, args: string[]) => Pty, script: string) {
  const proc = spawn('/bin/sh', ['-c', script]);
  let out = '';
  proc.onData((d) => (out += d));
  const exit: Partial<PtyExit> & { at?: number } = {};
  proc.onExit((e) => Object.assign(exit, e, { at: Date.now() }));
  assert.ok(await until(() => out.includes('ready'), 5000), 'the terminal started');
  return { proc, exit, exited: (ms: number) => until(() => exit.at !== undefined, ms) };
}

const local = (file: string, args: string[]): Pty => pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });

test('endPty kills a terminal that ignores SIGHUP once the grace period is over', { skip: !unix }, async (t) => {
  const { proc, exit, exited } = await terminal(local, DEAF);
  t.after(() => {
    if (exit.at === undefined) proc.kill('SIGKILL');
  });
  const start = Date.now();
  endPty(proc, 300);
  assert.equal(await exited(150), false, 'SIGHUP alone leaves it running');
  assert.ok(await exited(5000), 'SIGKILL ended it');
  assert.equal((exit as { signal?: number }).signal, 9);
  assert.ok(exit.at! - start >= 250, 'not before the grace period');
});

test('endPty leaves it at SIGHUP for a terminal that goes on it: no SIGKILL after the grace period', async () => {
  // A terminal stood in for, so the test sees every signal sent and controls when it exits.
  const kills: (string | undefined)[] = [];
  let onExit: ((e: PtyExit) => void) | undefined;
  const fake: Pty = { pid: 1, write() {}, resize() {}, kill: (signal) => void kills.push(signal), onData() {}, onExit: (cb) => (onExit = cb) };
  endPty(fake, 100);
  assert.deepEqual(kills, [undefined], 'the default signal first');
  onExit!({ exitCode: 0 });
  await sleep(300);
  assert.deepEqual(kills, [undefined], 'nothing more for a terminal that went on SIGHUP');
});

test("the host's stop ends a terminal that ignores SIGHUP, after the grace period, before the host exits", { skip: !unix }, async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pty-host-'));
  const host = new PtyHost(dataDir, () => {});
  assert.ok(await host.connect(), 'a host started');
  const { proc } = await terminal((file, args) => host.spawn({ file, args, cwd: process.cwd(), env: process.env as Record<string, string>, cols: 80, rows: 24 }), DEAF);
  assert.ok(await until(() => proc.pid > 0, 2000), 'the host said which process it is');
  // The host's own process: the parent of the terminal it spawned.
  const hostPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(proc.pid)], { encoding: 'utf8' }).trim());
  t.after(() => {
    for (const pid of [proc.pid, hostPid]) if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  });
  const start = Date.now();
  host.stop();
  assert.ok(await until(() => !alive(proc.pid), 9000), 'the terminal was killed');
  assert.ok(Date.now() - start >= 4000, 'only after the grace period: SIGHUP had its chance first');
  assert.ok(await until(() => !alive(hostPid), 3000), 'and the host exited once it was gone');
});
