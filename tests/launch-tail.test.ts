import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager } from '../src/server/workers.js';
import type { SpawnExtra, Worker } from '../src/server/workers/types.js';
import type { AgentProvider } from '../src/shared/providers.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const TAIL = 'Files attached to this prompt (read them as needed):\n- notes.txt: /repo/.agent-office/drops/ab12/notes.txt';

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-tail-'));
  const data = path.join(root, 'data');
  mkdirSync(data, { recursive: true });
  const agent = path.join(root, 'claude');
  writeFileSync(agent, '#!/bin/sh\nsleep 3\n', { mode: 0o700 });
  chmodSync(agent, 0o700);
  const events = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };
  const led = new Ledger(data, { pauseHiring: false }, () => {}, () => {});
  const workers = new WorkerManager(root, data, agent, [], { url: 'http://127.0.0.1:1', token: '' }, events, led);
  t.after(() => {
    workers.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const internal = workers as unknown as { workers: Map<string, Worker> };
  const hire = (prompt: string | undefined) => {
    const info = workers.spawn('desk-1', 'test', prompt, false, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, { promptTail: TAIL }) as WorkerInfo;
    assert.equal(typeof info, 'object');
    const w = internal.workers.get(info.id)!;
    const hook = (prompt: string) => workers.handleHook(info.id, w.hookToken, 'UserPromptSubmit', { prompt });
    return { w, info, hook };
  };
  let desk = 1;
  const spawn = (extra: SpawnExtra, provider: AgentProvider) => {
    const info = workers.spawn(`desk-${++desk}`, 'test', 'hi', false, 'agent', provider, undefined, undefined, undefined, undefined, [], undefined, extra) as WorkerInfo;
    assert.equal(typeof info, 'object');
    return internal.workers.get(info.id)!;
  };
  return { hire, workers, spawn };
}

test('a hire with text and files: the first prompt hook shows and names the text only', (t) => {
  const { hire } = setup(t);
  const { w, info, hook } = hire('fix the login page');
  assert.equal(w.launchTail, TAIL);
  assert.deepEqual(w.prompts, ['fix the login page']);
  assert.equal(hook(`fix the login page\n\n${TAIL}`), true);
  assert.equal(info.activity, 'fix the login page');
  assert.equal(w.launchTail, undefined);
  assert.ok(w.prompts.every((p) => !p.includes('/drops/')));
  assert.ok(!JSON.stringify(info.task ?? '').includes('/drops/'));
  // A later prompt is noted as it is.
  hook('now add a logout button');
  assert.equal(info.activity, 'now add a logout button');
  assert.equal(w.prompts.at(-1), 'now add a logout button');
});

test('a files-only hire: the first prompt hook leaves the activity and the prompts alone', (t) => {
  const { hire } = setup(t);
  const { w, info, hook } = hire(undefined);
  const before = info.activity;
  assert.deepEqual(w.prompts, []);
  assert.equal(hook(TAIL), true);
  assert.equal(info.activity, before);
  assert.deepEqual(w.prompts, []);
  assert.equal(info.task, undefined);
  assert.equal(w.launchTail, undefined);
  hook('look at the notes');
  assert.equal(info.activity, 'look at the notes');
  assert.deepEqual(w.prompts, ['look at the notes']);
});

test('the hire\'s own prompt noted at spawn does not use up the tail', (t) => {
  const { hire } = setup(t);
  const { w } = hire('first');
  assert.equal(w.launchTail, TAIL);
});

test('a report with other whitespace (CRLF, wrapped lines) still loses the tail', (t) => {
  const { hire } = setup(t);
  const { w, info, hook } = hire('fix the login page');
  assert.equal(hook(`fix the login page\r\n\r\n${TAIL.replace(/\n/g, '\r\n')}\r\n`), true);
  assert.equal(info.activity, 'fix the login page');
  assert.ok(w.prompts.every((p) => !p.includes('/drops/')));
  assert.equal(w.launchTail, undefined);
});

test('a report cut short inside the tail loses the rest of it', (t) => {
  const { hire } = setup(t);
  const { w, info, hook } = hire('fix the login page');
  hook(`fix the login page\n\n${TAIL.slice(0, 70)}`);
  assert.equal(info.activity, 'fix the login page');
  assert.ok(w.prompts.every((p) => !p.includes('Files attached')));
  assert.equal(w.launchTail, undefined);
});

test('the first report is the only one looked at, whether or not it matched', (t) => {
  const { hire } = setup(t);
  const { w, info, hook } = hire('first');
  hook('something typed meanwhile');
  assert.equal(info.activity, 'something typed meanwhile');
  assert.equal(w.launchTail, undefined);
  // So a later prompt that happens to end the same way is left as it is.
  hook(`later\n\n${TAIL}`);
  assert.ok(w.prompts.at(-1)?.includes('/drops/'));
});

test('a read folder is added to a Claude hire\'s launch flags and kept for its resume', (t) => {
  const { workers, spawn } = setup(t);
  const claude = spawn({ readDir: '/repo/.agent-office/drops/ab12' }, 'claude');
  assert.deepEqual(claude.extra?.launchArgs, ['--add-dir', '/repo/.agent-office/drops/ab12']);
  assert.equal('readDir' in (claude.extra ?? {}), false);
  assert.equal(workers.launchArgsOf(claude.info.id)?.at(-1), '/repo/.agent-office/drops/ab12');
  assert.equal(spawn({ readDir: '/x' }, 'opencode').extra?.launchArgs, undefined);
});
