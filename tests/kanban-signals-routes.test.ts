// POST /office/tasks/signal and /office/tasks/stop (kanban/signals.ts), the Stop hook's wrapper (kanban/launch.ts) run for real, and the settings file it goes into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSignals } from '../src/server/kanban/signals.js';
import { kanbanStopCommand, writeKanbanSettings } from '../src/server/kanban/launch.js';
import type { KanbanContext, KanbanHookCaller } from '../src/server/kanban/registry.js';
import type { TurnSignal } from '../src/shared/kanban/signals.js';

type Json = Record<string, any>;

function setup(opts: { refuse?: string; block?: string; gateThrows?: boolean } = {}) {
  const signals: [string, TurnSignal][] = [];
  const gates: [string, unknown][] = [];
  const forwarded: unknown[][] = [];
  const ctx = {
    engine: {
      signal: (id: string, sig: TurnSignal) => (signals.push([id, sig]), opts.refuse),
      stopGate: async (id: string, payload: unknown) => {
        gates.push([id, payload]);
        if (opts.gateThrows) throw new Error('boom');
        return opts.block ? { block: opts.block } : {};
      },
    },
    floor: (id: string) => (id === 'app' ? { workers: { handleProviderHook: (...a: unknown[]) => (forwarded.push(a), true) } } : undefined),
  } as unknown as KanbanContext;
  const hook = createSignals(ctx).hook!;
  const who: KanbanHookCaller = { workerId: 'w1', floorId: 'app' };
  const call = async (pathname: string, body: unknown, method = 'POST'): Promise<{ status: number; body: Json }> => {
    // The route table picks by prefix; the handler checks the exact path itself.
    const handler = Object.entries(hook).find(([prefix]) => pathname.startsWith(prefix))![1];
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method, headers: { authorization: 'Bearer tok' } }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead: (s: number) => void (status = s), end: (t: string) => void (text = t) } as unknown as ServerResponse;
    assert.equal(await handler(req, res, new URL(pathname, 'http://127.0.0.1'), who), true);
    return { status, body: JSON.parse(text) };
  };
  return { call, signals, gates, forwarded };
}

test('/office/tasks/signal: a signal goes to the engine for the asking worker; a refusal is a 409', async () => {
  const s = setup();
  assert.deepEqual(await s.call('/office/tasks/signal', { kind: 'done' }), { status: 200, body: { ok: true } });
  assert.deepEqual((await s.call('/office/tasks/signal', { kind: 'review', verdict: 'changes' })).body, { ok: true });
  assert.deepEqual((await s.call('/office/tasks/signal', { kind: 'pr', url: 'https://github.com/o/app/pull/5' })).status, 200);
  assert.deepEqual(s.signals, [
    ['w1', { kind: 'done' }],
    ['w1', { kind: 'review', verdict: 'changes' }],
    ['w1', { kind: 'pr', url: 'https://github.com/o/app/pull/5' }],
  ]);
  for (const body of [undefined, 'not json', { kind: 'bogus' }, { kind: 'review' }, { kind: 'pr' }, [1]]) {
    const r = await s.call('/office/tasks/signal', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, /Send \{"kind": "plan-ready" \| "ask" \| "done"\}/);
  }
  assert.equal(s.signals.length, 3, 'a bad body never reaches the engine');
  assert.deepEqual(await s.call('/office/tasks/signalX', { kind: 'done' }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await s.call('/office/tasks/signal', { kind: 'done' }, 'GET'), { status: 405, body: { error: 'POST only' } });
  const refused = setup({ refuse: 'The run is not in a phase that ends with done' });
  assert.deepEqual(await refused.call('/office/tasks/signal', { kind: 'done' }), { status: 409, body: { error: 'The run is not in a phase that ends with done' } });
});

test('/office/tasks/stop: a block answers the hook and goes nowhere else; no block passes the Stop on once', async () => {
  const blocked = setup({ block: 'Say WORK DONE when you are done' });
  const payload = { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'hi' };
  assert.deepEqual(await blocked.call('/office/tasks/stop', payload), { status: 200, body: { decision: 'block', reason: 'Say WORK DONE when you are done' } });
  assert.deepEqual(blocked.gates, [['w1', payload]]);
  assert.deepEqual(blocked.forwarded, [], 'upstream never hears a blocked Stop');

  const open = setup();
  assert.deepEqual(await open.call('/office/tasks/stop', payload), { status: 200, body: {} });
  assert.deepEqual(open.forwarded, [['claude', 'w1', 'tok', 'Stop', payload]]);

  // A body that isn't JSON (or none) is still a Stop.
  for (const body of ['nope', undefined]) {
    const s = setup();
    assert.equal((await s.call('/office/tasks/stop', body)).status, 200);
    assert.deepEqual(s.gates, [['w1', {}]]);
    assert.deepEqual(s.forwarded, [['claude', 'w1', 'tok', 'Stop', {}]]);
  }

  // The gate failing is no block.
  const broken = setup({ gateThrows: true });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await broken.call('/office/tasks/stop', payload), { status: 200, body: {} });
  } finally {
    console.error = quiet;
  }
  assert.equal(broken.forwarded.length, 1);

  assert.deepEqual(await open.call('/office/tasks/stopped', payload), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await open.call('/office/tasks/stop', payload, 'GET'), { status: 405, body: { error: 'POST only' } });
  assert.equal(open.forwarded.length, 1, '404 and 405 forward nothing');
});

/** The wrapper run with sh against a server that answers `answer`; `original` is what it falls back to. */
async function runWrapper(answer: (req: http.IncomingMessage, body: string) => { status: number; text: string }, original: string, env: Record<string, string> = {}, input = '{"hook_event_name":"Stop"}') {
  const seen: { url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const a = answer(req, body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await runSh(kanbanStopCommand(original), { ...process.env, AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_URL: url, AGENT_OFFICE_HOOK_TOKEN: 'tok', ...env }, input);
    return { ...r, seen };
  } finally {
    server.close();
  }
}

/** sh -c `command` with `input` on stdin; asynchronous, so the test's own server keeps answering. */
function runSh(command: string, env: NodeJS.ProcessEnv, input: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('/bin/sh', ['-c', command], { env });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(input);
  });
}

test('the Stop wrapper prints the office\'s block answer and posts the payload with the worker\'s token', async () => {
  const marker = mkdtempSync(path.join(tmpdir(), 'stop-wrap-'));
  try {
    const original = `cat > ${path.join(marker, 'original.txt')}`;
    const block = JSON.stringify({ decision: 'block', reason: 'Finish first' });
    const r = await runWrapper(() => ({ status: 200, text: block }), original);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { decision: 'block', reason: 'Finish first' });
    assert.deepEqual(r.seen.map((s) => [s.url?.replace(/^.*\/office/, '/office'), s.auth, s.body]), [['/office/tasks/stop?worker=w1', 'Bearer tok', '{"hook_event_name":"Stop"}']]);
    assert.throws(() => readFileSync(path.join(marker, 'original.txt')), 'the original command is not run when the office answered');
  } finally {
    rmSync(marker, { recursive: true, force: true });
  }
});

test('the Stop wrapper hands the payload to the original command when the office fails, and does nothing without a worker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stop-wrap-'));
  try {
    const file = path.join(dir, 'original.txt');
    const original = `cat > ${file}; echo noise`;
    const r = await runWrapper(() => ({ status: 500, text: '{"error":"x"}' }), original);
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'the original command\'s output is discarded');
    assert.equal(readFileSync(file, 'utf8'), '{"hook_event_name":"Stop"}');

    rmSync(file);
    // The office down: nothing listens.
    const down = await runSh(kanbanStopCommand(original), { ...process.env, AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:1', AGENT_OFFICE_HOOK_TOKEN: 'tok' }, 'payload');
    assert.deepEqual([down.code, down.out], [0, '']);
    assert.equal(readFileSync(file, 'utf8'), 'payload');

    rmSync(file);
    const none = await runWrapper(() => ({ status: 200, text: '{}' }), original, { AGENT_OFFICE_WORKER_ID: '' });
    assert.deepEqual([none.code, none.out, none.seen.length], [0, '', 0]);
    assert.throws(() => readFileSync(file, 'utf8'));

    // No curl on the PATH: the original command, which the office's own node would then run.
    const bin = path.join(dir, 'bin');
    execFileSync('mkdir', [bin]);
    for (const tool of ['cat', 'printf']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found.startsWith('/')) execFileSync('ln', ['-s', found, path.join(bin, tool)]);
    }
    const noCurl = await runSh(kanbanStopCommand(original), { ...process.env, PATH: bin, AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:1', AGENT_OFFICE_HOOK_TOKEN: 'tok' }, 'no curl');
    assert.deepEqual([noCurl.code, noCurl.out], [0, '']);
    assert.equal(readFileSync(file, 'utf8'), 'no curl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeKanbanSettings wraps the Stop command, keeps the rest, and leaves it alone when the gate is off', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-settings-'));
  const prev = process.env.AGENT_OFFICE_KANBAN_STOP_GATE;
  try {
    const file = path.join(dir, 'claude-hooks.json');
    const base = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo note' }] }],
      },
      permissions: { allow: ['mcp__x'] },
    };
    writeFileSync(file, JSON.stringify(base));
    delete process.env.AGENT_OFFICE_KANBAN_STOP_GATE;
    const out = JSON.parse(readFileSync(writeKanbanSettings(file), 'utf8'));
    assert.equal(out.skipDangerousModePermissionPrompt, true);
    assert.deepEqual(out.permissions, base.permissions);
    assert.deepEqual(out.hooks.Notification, base.hooks.Notification);
    assert.equal(out.hooks.Stop[0].hooks[0].command, kanbanStopCommand('echo stop'));
    assert.equal(out.hooks.Stop[0].hooks[0].timeout, 40);
    assert.equal(out.hooks.Stop[0].hooks[0].type, 'command');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), base, 'the office\'s own file is untouched');

    process.env.AGENT_OFFICE_KANBAN_STOP_GATE = 'off';
    assert.deepEqual(JSON.parse(readFileSync(writeKanbanSettings(file), 'utf8')).hooks, base.hooks);

    delete process.env.AGENT_OFFICE_KANBAN_STOP_GATE;
    writeFileSync(file, JSON.stringify({ hooks: { Notification: base.hooks.Notification } }));
    assert.deepEqual(JSON.parse(readFileSync(writeKanbanSettings(file), 'utf8')).hooks, { Notification: base.hooks.Notification }, 'no Stop command: nothing to wrap');
  } finally {
    if (prev === undefined) delete process.env.AGENT_OFFICE_KANBAN_STOP_GATE;
    else process.env.AGENT_OFFICE_KANBAN_STOP_GATE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
