// How a kanban hire's agent is launched (workers/manager.ts launch()): the
// phase's own flags (SpawnExtra.launchArgs) come before the resume and the prompt arguments, Claude
// runs on the kanban settings file when asked, and a task worker's environment names its task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { antigravityAdapter } from '../src/server/kanban/engine/adapters/antigravity.js';
import { registerOfficeFiles, splitOfficeDirs } from '../src/server/kanban/launch.js';

const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({
  kind: path.basename(process.argv[1]),
  args: process.argv.slice(2),
  env: { taskId: process.env.AIKANBAN_TASK_ID, apiBase: process.env.AIKANBAN_API_BASE, own: process.env.KANBAN_TEST_VAR, workerId: process.env.AGENT_OFFICE_WORKER_ID },
}) + '\\n');
process.stdin.resume();
setTimeout(() => process.exit(0), 3000).unref();
`;

type Invocation = { kind: string; args: string[]; env: { taskId?: string; apiBase?: string; own?: string; workerId?: string } };

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-launch-'));
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'invocations.jsonl');
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex', 'agy']) {
    writeFileSync(path.join(bin, name), fakeAgent, { mode: 0o700 });
    chmodSync(path.join(bin, name), 0o700);
  }
  writeFileSync(log, '');
  // Run from a task's own worker, these are set already: a worker that isn't a task's must not have them.
  const saved = { PATH: process.env.PATH, FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG, AIKANBAN_TASK_ID: process.env.AIKANBAN_TASK_ID, AIKANBAN_API_BASE: process.env.AIKANBAN_API_BASE };
  delete process.env.AIKANBAN_TASK_ID;
  delete process.env.AIKANBAN_API_BASE;
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_AGENT_LOG = log;
  const updates: WorkerInfo[] = [];
  const events: WorkerEvents = { update: (info) => updates.push(info), remove() {}, data() {}, screen() {}, toast() {} };
  const workers = new WorkerManager(root, data, 'claude', ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => {
    workers.shutdown();
    process.env.PATH = saved.PATH;
    if (saved.FAKE_AGENT_LOG === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = saved.FAKE_AGENT_LOG;
    for (const k of ['AIKANBAN_TASK_ID', 'AIKANBAN_API_BASE'] as const) if (saved[k] !== undefined) process.env[k] = saved[k];
    rmSync(root, { recursive: true, force: true });
  });
  const read = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Invocation) : []);
  const launched = async (kind: string) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const hit = read().find((i) => i.kind === kind && !i.args.includes('--output-format')); // not the task namer's
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${kind} never started`);
  };
  return { data, workers, launched };
}

test('a Claude task worker: the phase flags come before --resume and the prompt, on the kanban settings', async (t) => {
  const { data, workers, launched } = setup(t);
  const w = workers.spawn('desk-1', 'Ada', 'do the task', false, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, {
    launchArgs: ['--permission-mode', 'plan', '--allowedTools', 'Read'],
    resumeSessionId: 'sess-1',
    kanban: { taskId: 7, role: 'implementer' } as never,
    env: { KANBAN_TEST_VAR: 'yes', AGENT_OFFICE_WORKER_ID: 'not-this' },
    settingsFile: 'kanban',
  });
  assert.equal(typeof w, 'object');
  if (typeof w === 'string') return;
  const run = await launched('claude');
  const at = (a: string) => run.args.indexOf(a);
  assert.equal(run.args[at('--settings') + 1], path.join(data, 'claude-hooks-kanban.json'));
  assert.ok(at('--from-test') >= 0);
  assert.ok(at('--permission-mode') > at('--from-test'));
  assert.deepEqual(run.args.slice(at('--permission-mode'), at('--permission-mode') + 4), ['--permission-mode', 'plan', '--allowedTools', 'Read']);
  assert.ok(at('--resume') > at('Read'), '--resume follows the phase flags');
  assert.equal(run.args[at('--resume') + 1], 'sess-1');
  assert.deepEqual(run.args.slice(-2), ['--', 'do the task']);
  assert.deepEqual(run.env, { taskId: '7', apiBase: 'http://127.0.0.1:1', own: 'yes', workerId: w.id }, "the office's own variables can't be replaced");
  const kanbanSettings = JSON.parse(readFileSync(path.join(data, 'claude-hooks-kanban.json'), 'utf8'));
  const plain = JSON.parse(readFileSync(path.join(data, 'claude-hooks.json'), 'utf8'));
  assert.equal(kanbanSettings.skipDangerousModePermissionPrompt, true);
  assert.equal(plain.skipDangerousModePermissionPrompt, undefined);
  // The same hooks and permissions, but for the Stop hook: a kanban worker's goes through the Stop gate (kanbanStopCommand, #449).
  const plainStop = plain.hooks.Stop[0].hooks[0];
  const kanbanStop = kanbanSettings.hooks.Stop[0].hooks[0];
  assert.equal(kanbanStop.timeout, 40);
  assert.ok(kanbanStop.command.includes('/office/tasks/stop?worker=') && kanbanStop.command.includes(plainStop.command), 'the gate first, the original command as its fallback');
  Object.assign(kanbanStop, { command: plainStop.command, timeout: plainStop.timeout });
  if (plainStop.timeout === undefined) delete kanbanStop.timeout;
  assert.deepEqual({ ...kanbanSettings, skipDangerousModePermissionPrompt: undefined }, { ...plain, skipDangerousModePermissionPrompt: undefined });
});

test('a Codex task worker: the phase flags come after the office hooks and before resume and the prompt', async (t) => {
  const { workers, launched } = setup(t);
  const w = workers.spawn('desk-1', 'Ada', 'do the task', false, 'agent', 'codex', undefined, undefined, undefined, undefined, [], undefined, {
    launchArgs: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    resumeSessionId: 'sess-2',
    kanban: { taskId: 8, role: 'reviewer' } as never,
  });
  assert.equal(typeof w, 'object');
  if (typeof w === 'string') return;
  const run = await launched('codex');
  const at = (a: string) => run.args.indexOf(a);
  assert.ok(at('--no-alt-screen') >= 0 && at('--sandbox') > at('--no-alt-screen'));
  assert.deepEqual(run.args.slice(at('--sandbox'), at('--sandbox') + 4), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.equal(run.args[at('--sandbox') + 4], 'resume');
  assert.equal(run.args[at('--sandbox') + 5], 'sess-2');
  assert.deepEqual(run.args.slice(-2), ['--', 'do the task']);
  assert.equal(run.env.taskId, '8');
});

test('an Antigravity task worker: trust, then the phase flags, then resume and the prompt (-i), with no --add-dir', async (t) => {
  const { workers, launched } = setup(t);
  const w = workers.spawn('desk-1', 'Ada', 'do the task', false, 'agent', 'antigravity', undefined, undefined, undefined, undefined, [], undefined, {
    launchArgs: antigravityAdapter.launchArgs('plan', { permission: 'bypass', planPermission: 'plan', sandbox: false, model: 'gemini-4-hydrogen', effort: 'max', addDirs: ['/refs'], readDirs: ['/instr'] }),
    resumeSessionId: 'conv-2',
    readDir: '/instr',
    kanban: { taskId: 8, role: 'implementer' } as never,
  });
  assert.equal(typeof w, 'object');
  if (typeof w === 'string') return;
  const run = await launched('agy');
  const at = (a: string) => run.args.indexOf(a);
  assert.equal(run.args[0], '--settings');
  assert.ok(Array.isArray(JSON.parse(run.args[1]).trustedWorkspaces));
  assert.deepEqual(run.args.slice(2), ['--dangerously-skip-permissions', '--mode', 'plan', '--model', 'gemini-4-hydrogen', '--effort', 'xhigh', '--resume', 'conv-2', '-i', 'do the task']);
  assert.ok(at('--add-dir') < 0, "a hire's instructions folder is never --add-dir for Antigravity");
  assert.equal(run.env.taskId, '8');
});

test('an ordinary worker launches with none of it', async (t) => {
  const { data, workers, launched } = setup(t);
  const w = workers.spawn('desk-1', 'Ada', 'hello', false, 'agent', 'claude');
  assert.equal(typeof w, 'object');
  const run = await launched('claude');
  assert.equal(run.args[run.args.indexOf('--settings') + 1], path.join(data, 'claude-hooks.json'));
  assert.equal(run.env.taskId, undefined);
  assert.ok(!run.args.includes('--permission-mode'));
});

test('splitOfficeDirs: the office folders leave the flags, other folders stay', () => {
  const files = '/data/kanban';
  const args = ['--permission-mode', 'auto', '--add-dir', '/data/kanban/grants/task-7', '--add-dir', '/repos/other', '--add-dir', '/data/kanban/refs/task-7', '--add-dir', '/data/kanbanx/refs', '--model', 'x', '--add-dir'];
  assert.deepEqual(splitOfficeDirs(args, files), { args: ['--permission-mode', 'auto', '--add-dir', '/repos/other', '--add-dir', '/data/kanbanx/refs', '--model', 'x', '--add-dir'], dirs: ['/data/kanban/grants/task-7', '/data/kanban/refs/task-7'] });
  assert.deepEqual(splitOfficeDirs(['--permission-mode', 'auto'], files), { args: ['--permission-mode', 'auto'], dirs: [] });
  // No root named yet (a worker woken at the office's start, before the kanban opens): the folders are known by their shape.
  assert.deepEqual(splitOfficeDirs(['--add-dir', '/home/o/.agent-office/kanban/grants/task-7', '--add-dir', '/home/o/.agent-office/kanban/uploads', '--add-dir', '/repos/kanban/grants/task-7']), {
    args: ['--add-dir', '/home/o/.agent-office/kanban/uploads', '--add-dir', '/repos/kanban/grants/task-7'],
    dirs: ['/home/o/.agent-office/kanban/grants/task-7'],
  });
  // The project's instructions folder has the shape too; a deeper path, a bad id or another folder under kanban/ doesn't.
  assert.deepEqual(splitOfficeDirs(['--add-dir', '/home/o/.agent-office/kanban/instructions/web-2', '--add-dir', '/home/o/.agent-office/kanban/instructions/Web', '--add-dir', '/home/o/.agent-office/kanban/instructions/web/x', '--add-dir', '/home/o/.agent-office/kanban/other/web']), {
    args: ['--add-dir', '/home/o/.agent-office/kanban/instructions/Web', '--add-dir', '/home/o/.agent-office/kanban/instructions/web/x', '--add-dir', '/home/o/.agent-office/kanban/other/web'],
    dirs: ['/home/o/.agent-office/kanban/instructions/web-2'],
  });
});

test('a Claude task worker with office folders: they are in its own settings file, not on the command line, and the file goes with the worker', async (t) => {
  const { data, workers, launched } = setup(t);
  // The kanban names its task folders' root when it opens (in an office it is not the floor's data folder, but any folder does here).
  registerOfficeFiles(path.join(data, 'kanban'));
  const stored = ['--permission-mode', 'auto', '--add-dir', path.join(data, 'kanban', 'grants', 'task-9'), '--add-dir', '/repos/other', '--add-dir', path.join(data, 'kanban', 'reports', 'task-9')];
  const w = workers.spawn('desk-1', 'Ada', 'do the task', false, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, {
    launchArgs: stored,
    kanban: { taskId: 9, role: 'implementer' } as never,
    settingsFile: 'kanban',
  });
  assert.equal(typeof w, 'object');
  if (typeof w === 'string') return;
  const run = await launched('claude');
  const at = (a: string) => run.args.indexOf(a);
  const own = path.join(data, `claude-hooks-kanban-${w.id}.json`);
  assert.equal(run.args[at('--settings') + 1], own);
  assert.deepEqual(run.args.slice(at('--permission-mode'), at('--permission-mode') + 4), ['--permission-mode', 'auto', '--add-dir', '/repos/other']);
  assert.ok(!run.args.some((a) => a.includes(path.join(data, 'kanban'))), 'none of the office folders is a flag');
  assert.equal(workers.launchArgsOf(w.id)?.length, stored.length, 'the stored flags are untouched');
  const settings = JSON.parse(readFileSync(own, 'utf8'));
  const kanban = JSON.parse(readFileSync(path.join(data, 'claude-hooks-kanban.json'), 'utf8'));
  assert.deepEqual(settings.permissions.additionalDirectories, [path.join(data, 'kanban', 'grants', 'task-9'), path.join(data, 'kanban', 'reports', 'task-9')]);
  assert.deepEqual(settings.permissions.allow, kanban.permissions.allow, 'its allowed tools are kept');
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.deepEqual(settings.hooks, kanban.hooks, 'the Stop wrapper and the other hooks are the kanban settings');
  assert.equal(kanban.permissions.additionalDirectories, undefined);
  assert.equal(statSync(own).mode & 0o777, 0o600);
  await workers.kill(w.id);
  assert.equal(existsSync(own), false, 'the file goes when the worker leaves');
});
