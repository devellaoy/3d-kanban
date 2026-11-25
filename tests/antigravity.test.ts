import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ANTIGRAVITY_HOOK_EVENTS,
  antigravityTrustArgs,
  normalizeAntigravityHook,
  writeAntigravityHook,
  writeAntigravityPlugin,
} from '../src/server/antigravity.js';
import { antigravity, antigravityBlocked, HELD_STOP_MS, type AntigravityState } from '../src/server/providers/antigravity.js';
import { PROVIDERS } from '../src/server/providers/index.js';
import { ANTIGRAVITY_MODELS, PROVIDER_META } from '../src/shared/providers.js';
import type { WorkerHandle } from '../src/server/workers/types.js';

const temp = () => mkdtempSync(path.join(tmpdir(), 'agent-office-agy-'));

test('normalizes bounded hook bodies and drops what a provider does not use', () => {
  assert.deepEqual(normalizeAntigravityHook('SessionStart', { session_id: 'c1', transcript_path: '/t.jsonl', model: 'x' }), { sessionId: 'c1', event: 'SessionStart', transcriptPath: '/t.jsonl' });
  assert.deepEqual(normalizeAntigravityHook('PreInvocation', { session_id: 'c1', prompt: '  fix it ', invocation_num: 0 }), { sessionId: 'c1', event: 'PreInvocation', prompt: 'fix it', invocationNum: 0 });
  assert.deepEqual(normalizeAntigravityHook('PreToolUse', { session_id: 'c1', tool_name: 'ask_question', tool_use_id: 't1', prompt: 'no' }), { sessionId: 'c1', event: 'PreToolUse', tool: 'ask_question', toolUseId: 't1' });
  assert.deepEqual(normalizeAntigravityHook('Stop', { session_id: 'c1', fully_idle: false }), { sessionId: 'c1', event: 'Stop', fullyIdle: false });
  assert.deepEqual(normalizeAntigravityHook('Stop', { session_id: 'c1', fully_idle: 'yes' }), { sessionId: 'c1', event: 'Stop' });
  assert.equal(normalizeAntigravityHook('PreInvocation', { session_id: 'c1', invocation_num: -1 })?.invocationNum, undefined);
  assert.equal(normalizeAntigravityHook('PreInvocation', { session_id: 'c1', invocation_num: 1.5 })?.invocationNum, undefined);
});

test('rejects unknown events, malformed bodies and oversized ids', () => {
  assert.equal(normalizeAntigravityHook('Unknown', { session_id: 'x' }), undefined);
  assert.equal(normalizeAntigravityHook('Stop', null), undefined);
  assert.equal(normalizeAntigravityHook('Stop', []), undefined);
  assert.equal(normalizeAntigravityHook('Stop', { session_id: '' }), undefined);
  assert.equal(normalizeAntigravityHook('Stop', { session_id: 'x'.repeat(161) }), undefined);
  assert.equal(normalizeAntigravityHook('PreInvocation', { session_id: 'x', prompt: 'p'.repeat(20_001) })?.prompt, undefined);
  assert.equal(normalizeAntigravityHook('PreToolUse', { session_id: 'x', tool_name: 't'.repeat(161) })?.tool, undefined);
});

test('writes the office plugin with its hooks and MCP server, once, and keeps it out of git', () => {
  const dir = temp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const plugin = path.join(dir, '.agents', 'plugins', 'agent-office');
    writeAntigravityPlugin(dir, '/data/hook one.cjs', '/app/bin/office-workers.js');
    const read = (f: string) => JSON.parse(readFileSync(path.join(plugin, f), 'utf8'));
    assert.equal(read('plugin.json').name, 'agent-office');
    const hooks = read('hooks.json')['agent-office'];
    assert.equal(hooks.enabled, true);
    for (const event of ANTIGRAVITY_HOOK_EVENTS) assert.ok(hooks[event], event);
    const stop = hooks.Stop[0];
    assert.equal(stop.type, 'command');
    assert.equal(stop.timeout, 5);
    assert.equal(stop.command, `'${process.execPath}' '/data/hook one.cjs' 'Stop'`);
    assert.equal(hooks.PreToolUse[0].matcher, '.*');
    assert.equal(hooks.PreToolUse[0].hooks[0].type, 'command');
    assert.deepEqual(read('mcp_config.json'), { mcpServers: { 'agent-office': { command: process.execPath, args: [path.join('/data', 'agent-office-antigravity-mcp.cjs'), '/app/bin/office-workers.js', 'mcp'] } } });
    const before = readFileSync(path.join(plugin, 'hooks.json'), 'utf8');
    writeAntigravityPlugin(dir, '/data/hook one.cjs', '/app/bin/office-workers.js');
    assert.equal(readFileSync(path.join(plugin, 'hooks.json'), 'utf8'), before);
    const exclude = readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((l) => l === '.agents/plugins/agent-office/').length, 1);
    writeAntigravityPlugin(dir, '/data/hook.cjs');
    assert.deepEqual(read('mcp_config.json'), { mcpServers: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder that is no git repository still gets the plugin', () => {
  const dir = temp();
  try {
    assert.doesNotThrow(() => writeAntigravityPlugin(dir, '/data/hook.cjs'));
    assert.ok(readFileSync(path.join(dir, '.agents', 'plugins', 'agent-office', 'plugin.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workspace is trusted for the session only', () => {
  assert.deepEqual(antigravityTrustArgs('/work/tree'), ['--settings', '{"trustedWorkspaces":["/work/tree"]}']);
});

test('is registered, runs as agy and suggests its models', () => {
  assert.equal(PROVIDERS.antigravity, antigravity);
  assert.equal(PROVIDER_META.antigravity.bin, 'agy');
  assert.equal(PROVIDER_META.antigravity.label, 'Antigravity');
  assert.ok(ANTIGRAVITY_MODELS.includes('gemini-4-hydrogen'));
});

// --- launch ------------------------------------------------------------------------------------

function launch(cwd: string, input: { prompt?: string; resumeSessionId?: string; extraArgs?: string[]; args?: string[] }, h = handle().h) {
  const dataDir = path.join(cwd, 'data');
  const setup = antigravity.prepare!({ dataDir, dshProfile: 'acp' });
  return antigravity.launch({ h, args: input.args ?? [], cwd, setup, prompt: input.prompt, resumeSessionId: input.resumeSessionId, extraArgs: input.extraArgs });
}

test('launch puts the trust, the phase flags, the resume and the prompt on the command line in that order', () => {
  const dir = temp();
  try {
    const trust = ['--settings', JSON.stringify({ trustedWorkspaces: [dir] })];
    assert.deepEqual(launch(dir, {}).args, trust);
    assert.deepEqual(launch(dir, { prompt: '- fix it' }).args, [...trust, '-i', '- fix it']);
    assert.deepEqual(launch(dir, { resumeSessionId: 'abc' }).args, [...trust, '--resume', 'abc']);
    const plan = launch(dir, { args: ['--base'], extraArgs: ['--dangerously-skip-permissions', '--mode', 'plan'], resumeSessionId: 'abc', prompt: 'go' });
    assert.deepEqual(plan.args, ['--base', ...trust, '--dangerously-skip-permissions', '--mode', 'plan', '--resume', 'abc', '-i', 'go']);
    assert.equal(plan.rotateToken, true);
    plan.finishEnv!({});
    assert.equal(antigravity.bootHint, undefined);
    // The helper went to the data dir, the plugin to the workspace.
    assert.ok(readFileSync(path.join(dir, 'data', 'agent-office-antigravity-hook.cjs'), 'utf8').includes('/hooks/antigravity'));
    assert.ok(readFileSync(path.join(dir, '.agents', 'plugins', 'agent-office', 'hooks.json'), 'utf8').includes('agent-office-antigravity-hook.cjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('its trust, sign-in and first-run screens block it, the banner it prints at every start does not', () => {
  const blocked = antigravity.screen!.blocked!;
  assert.match(blocked('Do you trust the contents of this project?\n Yes, I trust this folder', true) ?? '', /trust/);
  for (const line of ['Select login method:', 'Select Google Cloud sign-in method:', 'Open this URL in your local browser to sign in:', 'Enter the authorization code:', 'Sign-in timed out. Try again.', 'No authentication methods available.']) {
    assert.equal(blocked(`welcome\n  │ ${line}\n  1. Google`, false), 'Open the terminal: sign in to Antigravity', line);
  }
  assert.equal(antigravityBlocked('Choose your color scheme:\n 1. Dark'), "Open the terminal: finish Antigravity's first-run setup");
  assert.equal(blocked('You are currently not signed in.\nSigning in...', true), undefined);
  assert.equal(blocked('I read the docs on how to sign in and select login method: it is in the guide', false), undefined);
  assert.equal(blocked('> fix it\nthinking about login...', false), undefined);
});

test('the helper posts the snake_case body to the authenticated bridge and prints nothing', async () => {
  const dir = temp();
  const received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.url = req.url;
      received.authorization = req.headers.authorization;
      received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end();
    });
  });
  try {
    const file = writeAntigravityHook(dir);
    assert.equal(file, path.join(dir, 'agent-office-antigravity-hook.cjs'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const run = (event: string, input: unknown, env: Record<string, string>) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [file, event], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify(input));
    });
    const env = { AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`, AGENT_OFFICE_HOOK_TOKEN: 'tok', AGENT_OFFICE_WORKER_ID: 'w1' };
    assert.equal(await run('PreInvocation', { conversationId: 'c1', lastUserInput: 'fix it', invocationNum: 0, transcriptPath: '/t.jsonl', modelName: 'secret' }, env), '');
    assert.equal(received.authorization, 'Bearer tok');
    assert.equal(received.url, '/hooks/antigravity?worker=w1&event=PreInvocation');
    assert.deepEqual(received.body, { session_id: 'c1', hook_event_name: 'PreInvocation', prompt: 'fix it', invocation_num: 0, transcript_path: '/t.jsonl' });
    await run('PreToolUse', { conversationId: 'c1', toolCall: { name: 'ask_question', id: 't1', args: { q: 'secret' } } }, env);
    assert.deepEqual(received.body, { session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'ask_question', tool_use_id: 't1' });
    await run('Stop', { conversationId: 'c1', fullyIdle: false, terminationReason: 'NO_TOOL_CALL', error: '' }, env);
    assert.deepEqual(received.body, { session_id: 'c1', hook_event_name: 'Stop', fully_idle: false, termination_reason: 'NO_TOOL_CALL' });
    received.url = undefined;
    await run('Stop', { conversationId: 'c1' }, {});
    assert.equal(received.url, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- hooks -------------------------------------------------------------------------------------

function handle(sessionId?: string, launched = true) {
  const observed: { event?: string; tool?: string; payload: unknown }[] = [];
  const statuses: string[] = [];
  const info = { kind: 'agent', status: 'starting', sessionId } as unknown as WorkerHandle<AntigravityState>['info'];
  const h = {
    info,
    state: { ...antigravity.createState!(), launched },
    running: true,
    bootBlocked: false,
    leftNeedsInputAt: 0,
    setStatus: (s: string) => { info.status = s as typeof info.status; statuses.push(s); },
    emit() {},
    persist() {},
    notePrompt: (p: string) => p,
    noteTool() {},
    clearTask() {},
    scheduleScan() {},
    prompt: () => undefined,
    observeHook: (event: string | undefined, tool: string | undefined, payload: unknown) => { observed.push({ event, tool, payload }); },
  } as unknown as WorkerHandle<AntigravityState>;
  return { h, info, observed, statuses };
}

const send = (h: WorkerHandle<AntigravityState>, event: string, body: Record<string, unknown>) => antigravity.hook!.handle(h, event, { hook_event_name: event, ...body });

test('a fresh conversation: SessionStart makes it idle, its first model call is the prompt', () => {
  const { h, info, observed } = handle();
  assert.equal(send(h, 'SessionStart', { session_id: 'root', transcript_path: '/t.jsonl' }), true);
  assert.equal(info.status, 'idle');
  assert.equal(info.sessionId, 'root');
  assert.equal((h.state as AntigravityState).transcript, '/t.jsonl');
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'fix it', invocation_num: 0 });
  assert.equal(info.status, 'working');
  assert.equal(info.activity, 'fix it');
  // The kanban reads the raw payload, under the event the office knows.
  assert.equal(observed.at(-1)?.event, 'UserPromptSubmit');
  assert.equal((observed.at(-1)?.payload as { prompt: string }).prompt, 'fix it');
  send(h, 'PreToolUse', { session_id: 'root', tool_name: 'run_command', tool_use_id: 't1' });
  assert.equal(info.status, 'working');
  send(h, 'Stop', { session_id: 'root', fully_idle: true });
  assert.equal(info.status, 'done');
});

test('a resumed conversation fires no SessionStart: its first model call starts the session and counts as a prompt', () => {
  const { h, info, observed } = handle('root');
  assert.equal(send(h, 'PreInvocation', { session_id: 'root', prompt: 'carry on', invocation_num: 0 }), true);
  assert.equal(info.status, 'working');
  assert.equal(info.sessionId, 'root');
  assert.deepEqual(observed.map((o) => o.event), ['UserPromptSubmit']);
});

test('model calls after the first of a prompt are ignored', () => {
  const { h, info } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  assert.equal(send(h, 'PreInvocation', { session_id: 'root', prompt: 'again', invocation_num: 1 }), false);
  assert.equal(send(h, 'PostInvocation', { session_id: 'root', invocation_num: 0 }), false);
  assert.equal(info.status, 'idle');
});

test('a subagent conversation never switches the worker session or ends its turn', () => {
  const { h, info } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
  assert.equal(send(h, 'SessionStart', { session_id: 'sub' }), false);
  send(h, 'PreInvocation', { session_id: 'sub', invocation_num: 0 });
  assert.equal(info.sessionId, 'root');
  assert.equal(info.status, 'working');
  assert.deepEqual([...(h.state as AntigravityState).subagents], ['sub']);
  send(h, 'Stop', { session_id: 'sub', fully_idle: false });
  assert.equal(info.status, 'working');
  assert.equal((h.state as AntigravityState).subagents.size, 0);
});

test('a root Stop while a subagent lives is held, and the last subagent Stop releases it once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { h, info, observed } = handle();
    const stops = () => observed.filter((o) => o.event === 'Stop' && !(o.payload as { agent_id?: string }).agent_id);
    send(h, 'SessionStart', { session_id: 'root' });
    send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
    send(h, 'SessionStart', { session_id: 'sub' });
    send(h, 'Stop', { session_id: 'root', fully_idle: true, transcript_path: '/interim' });
    assert.equal(info.status, 'working');
    // A subagent's tool call and 90 s of silence do not end the turn.
    send(h, 'PreToolUse', { session_id: 'sub', tool_name: 'run_command', tool_use_id: 's1' });
    mock.timers.tick(90_000);
    assert.equal(info.status, 'working');
    send(h, 'Stop', { session_id: 'sub', fully_idle: true });
    assert.equal(info.status, 'done');
    assert.equal(stops().length, 1);
    assert.equal((stops()[0].payload as { transcript_path: string }).transcript_path, '/interim');
    assert.equal((h.state as AntigravityState).held, undefined);
  } finally {
    mock.timers.reset();
  }
});

test('a root woken with the same prompt drops the held Stop; a long tool call does not end the turn; the last subagent Stop releases the next one', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { h, info, observed } = handle();
    send(h, 'SessionStart', { session_id: 'root' });
    send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
    send(h, 'SessionStart', { session_id: 'sub' });
    send(h, 'Stop', { session_id: 'root', fully_idle: false, transcript_path: '/interim' });
    send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
    assert.equal(observed.filter((o) => o.event === 'UserPromptSubmit').length, 1);
    assert.equal((h.state as AntigravityState).held, undefined);
    send(h, 'PreToolUse', { session_id: 'root', tool_name: 'run_command', tool_use_id: 'r1' });
    mock.timers.tick(30 * 60_000); // minutes of one tool call
    assert.equal(info.status, 'working');
    send(h, 'PostToolUse', { session_id: 'root', tool_name: 'run_command', tool_use_id: 'r1' });
    send(h, 'Stop', { session_id: 'root', fully_idle: false, transcript_path: '/final' });
    assert.equal(info.status, 'working');
    send(h, 'Stop', { session_id: 'sub', fully_idle: true });
    assert.equal(info.status, 'done');
    const stops = observed.filter((o) => o.event === 'Stop' && !(o.payload as { agent_id?: string }).agent_id);
    assert.equal(stops.length, 1);
    assert.equal((stops[0].payload as { transcript_path: string }).transcript_path, '/final');
  } finally {
    mock.timers.reset();
  }
});

test('a root Stop after the subagents have stopped is reported at once, whatever fully_idle says', () => {
  const { h, info } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
  send(h, 'SessionStart', { session_id: 'sub' });
  send(h, 'Stop', { session_id: 'sub', fully_idle: false });
  send(h, 'Stop', { session_id: 'root', fully_idle: false });
  assert.equal(info.status, 'done');
});

test('a held Stop with no hook event of the tree for 10 minutes ends the turn; any event starts the wait over', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { h, info } = handle();
    assert.equal(HELD_STOP_MS, 10 * 60_000);
    send(h, 'SessionStart', { session_id: 'root' });
    send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
    send(h, 'SessionStart', { session_id: 'sub' });
    send(h, 'Stop', { session_id: 'root', fully_idle: false });
    mock.timers.tick(HELD_STOP_MS - 1000);
    send(h, 'PreToolUse', { session_id: 'sub', tool_name: 'run_command', tool_use_id: 's1' });
    mock.timers.tick(HELD_STOP_MS - 1000);
    assert.equal(info.status, 'working');
    mock.timers.tick(1000);
    assert.equal(info.status, 'done');
    assert.equal((h.state as AntigravityState).timer, undefined);
  } finally {
    mock.timers.reset();
  }
});

test('a different prompt while a Stop is held is a new prompt of the person', () => {
  const { h, info, observed } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
  send(h, 'SessionStart', { session_id: 'sub' });
  send(h, 'Stop', { session_id: 'root', fully_idle: false });
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'something else', invocation_num: 0 });
  assert.equal(observed.filter((o) => o.event === 'UserPromptSubmit').length, 2);
  assert.equal(info.activity, 'something else');
  assert.equal((h.state as AntigravityState).held, undefined);
});

test('a conversation the person starts becomes the root; a restored state waits for a root-looking event', () => {
  const { h, info } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  send(h, 'SessionStart', { session_id: 'sub' });
  assert.equal(info.sessionId, 'root');
  send(h, 'SessionStart', { session_id: 'mine', prompt: 'a new chat' });
  assert.equal(info.sessionId, 'mine');
  assert.equal((h.state as AntigravityState).root, 'mine');
  assert.equal((h.state as AntigravityState).subagents.size, 0);
  // After a restart without a saved root.
  const restored = handle('root', false);
  assert.equal(send(restored.h, 'SessionStart', { session_id: 'sub' }), false);
  assert.equal((restored.h.state as AntigravityState).root, undefined);
  assert.equal(send(restored.h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 }), true);
  assert.equal((restored.h.state as AntigravityState).root, 'root');
  // A saved root is kept.
  const kept = handle('root', false);
  antigravity.usage!.restore!(kept.h.state, { antigravityRoot: 'root' });
  send(kept.h, 'SessionStart', { session_id: 'sub' });
  assert.equal(kept.info.sessionId, 'root');
  assert.deepEqual([...(kept.h.state as AntigravityState).subagents], ['sub']);
});

test('subagent events reach the observers marked with their agent_id and change nothing of the worker', () => {
  const { h, info, observed } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
  const before = observed.length;
  send(h, 'SessionStart', { session_id: 'sub' });
  send(h, 'PreToolUse', { session_id: 'sub', tool_name: 'ask_question', tool_use_id: 'q' });
  send(h, 'Stop', { session_id: 'sub' });
  const sub = observed.slice(before);
  assert.deepEqual(sub.map((o) => o.event), ['SessionStart', 'PreToolUse', 'Stop']);
  for (const o of sub) assert.equal((o.payload as { agent_id: string }).agent_id, 'sub');
  assert.equal(sub[1].tool, 'ask_question');
  assert.equal(info.status, 'working');
  assert.equal(info.sessionId, 'root');
});

test('the MCP launcher exits 0 outside a worker, and runs the server inside one', async () => {
  const dir = temp();
  try {
    writeAntigravityHook(dir);
    const helper = path.join(dir, 'agent-office-antigravity-mcp.cjs');
    const server = path.join(dir, 'server.js');
    writeFileSync(server, 'process.stdout.write(process.argv.slice(2).join(" "));process.exit(3)');
    const run = (env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [helper, server, 'mcp'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.deepEqual(await run({}), { code: 0, out: '' });
    assert.deepEqual(await run({ AGENT_OFFICE_WORKER_ID: 'w1' }), { code: 0, out: '' });
    assert.deepEqual(await run({ AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:1' }), { code: 3, out: 'mcp' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new launch drops a held Stop and its timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const dir = temp();
  try {
    const { h, info } = handle();
    send(h, 'SessionStart', { session_id: 'root' });
    send(h, 'SessionStart', { session_id: 'sub' });
    send(h, 'Stop', { session_id: 'root', fully_idle: false });
    assert.ok((h.state as AntigravityState).timer);
    launch(dir, {}, h);
    assert.equal((h.state as AntigravityState).timer, undefined);
    assert.equal((h.state as AntigravityState).held, undefined);
    assert.equal((h.state as AntigravityState).root, undefined);
    mock.timers.tick(HELD_STOP_MS * 2);
    assert.equal(info.status, 'idle');
  } finally {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask_question needs input until it is answered', () => {
  const { h, info } = handle();
  send(h, 'SessionStart', { session_id: 'root' });
  send(h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
  send(h, 'PreToolUse', { session_id: 'root', tool_name: 'ask_question', tool_use_id: 'q1' });
  assert.equal(info.status, 'needs_input');
  send(h, 'PostToolUse', { session_id: 'root', tool_name: 'ask_question', tool_use_id: 'q1' });
  assert.equal(info.status, 'working');
});

test('a replacement conversation (a resume of a lost id) takes over the session', () => {
  const { h, info } = handle('old');
  send(h, 'SessionStart', { session_id: 'new' });
  assert.equal(info.sessionId, 'new');
  assert.equal((h.state as AntigravityState).root, 'new');
});

test('keeps only the transcript and root across a restart', () => {
  const { h } = handle();
  send(h, 'SessionStart', { session_id: 'root', transcript_path: '/t.jsonl' });
  const saved = antigravity.usage!.save!(h.state);
  assert.deepEqual(saved, { antigravityTranscript: '/t.jsonl', antigravityRoot: 'root' });
  const fresh = antigravity.createState!();
  antigravity.usage!.restore!(fresh, saved);
  assert.equal(fresh.transcript, '/t.jsonl');
  assert.equal(fresh.root, 'root');
});

test('a huge prompt loses no event: the helper cuts it and every hook gets through, so the worker finishes', async () => {
  const dir = temp();
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(200).end(); });
  });
  try {
    const file = writeAntigravityHook(dir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const env = { PATH: process.env.PATH ?? '', AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`, AGENT_OFFICE_HOOK_TOKEN: 'tok', AGENT_OFFICE_WORKER_ID: 'w1' };
    const run = (event: string, input: unknown) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [file, event], { env, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('close', () => resolve());
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
    const big = 'x'.repeat(300_000);
    const base = { conversationId: 'c1', lastUserInput: big, transcriptPath: '/t.jsonl' };
    await run('SessionStart', base);
    await run('PreInvocation', { ...base, invocationNum: 0 });
    await run('PreToolUse', { ...base, toolCall: { name: 'write_file', id: 't1', args: { content: 'y'.repeat(200 * 1024) } } });
    await run('PostToolUse', { ...base, toolCall: { name: 'write_file', id: 't1' } });
    // A question tool's question is the one tool input that goes on (bounded), as Antigravity shapes it: options are plain strings.
    await run('PreToolUse', { ...base, toolCall: { name: 'ask_question', id: 't2', args: { questions: [{ question: 'Which colour?', options: ['red', 'blue'], is_multi_select: false }] } } });
    await run('PostToolUse', { ...base, toolCall: { name: 'ask_question', id: 't2' } });
    await run('Stop', { ...base, fullyIdle: true });
    assert.deepEqual(bodies.map((b) => b.hook_event_name), ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'Stop']);
    assert.equal((bodies[1].prompt as string).length, 20_000);
    assert.equal(bodies[2].prompt, undefined);
    assert.equal(bodies[2].tool_input, undefined);
    assert.deepEqual(bodies[4].tool_input, { questions: [{ question: 'Which colour?', options: ['red', 'blue'] }] });
    const { heardQuestion, askedQuestion } = await import('../src/server/kanban/engine/signals.js');
    const live = {};
    assert.equal(heardQuestion(live, { tool: 'ask_question', hookEvent: 'PreToolUse', payload: bodies[4] }), true);
    assert.equal(askedQuestion(live), 'Which colour?\n- red\n- blue');
    const { h, info } = handle();
    const seen: string[] = [];
    for (const b of bodies) {
      assert.equal(antigravity.hook!.handle(h, b.hook_event_name as string, b), true);
      seen.push(info.status);
    }
    assert.deepEqual(seen, ['idle', 'working', 'working', 'working', 'needs_input', 'working', 'done']);
    // The same cut prompt again is still "the same prompt" for the woken-root rule.
    assert.equal((h.state as AntigravityState).lastPrompt?.length, 20_000);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the plugin folder is the office's own ------------------------------------------------------

const PLUGIN_REL = path.join('.agents', 'plugins', 'agent-office');

test('a plugin folder tracked by git is left byte for byte as it is, and the launch fails with why', () => {
  const dir = temp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const folder = path.join(dir, PLUGIN_REL);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'plugin.json'), '{"name":"theirs"}');
    execFileSync('git', ['add', '-f', '.'], { cwd: dir });
    assert.throws(() => writeAntigravityPlugin(dir, '/data/hook.cjs'), /Antigravity can't start here: .*not the office's own \(it is tracked by git\)\. Move or remove it, then press R/);
    assert.equal(readFileSync(path.join(folder, 'plugin.json'), 'utf8'), '{"name":"theirs"}');
    assert.deepEqual(readdirSyncOf(folder), ['plugin.json']);
    const plan = launch(dir, {});
    assert.throws(() => plan.finishEnv!({}), /press R/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readdirSyncOf(dir: string): string[] {
  return execFileSync('ls', ['-A', dir], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
}

test('a foreign folder without the office marker is left alone; its own, an empty one and a fresh one are written', () => {
  const dir = temp();
  try {
    const folder = path.join(dir, PLUGIN_REL);
    mkdirSync(folder, { recursive: true });
    writeAntigravityPlugin(dir, '/data/hook.cjs'); // empty folder: ours to fill
    assert.ok(existsSync(path.join(folder, '.agent-office-plugin')));
    writeFileSync(path.join(folder, 'hooks.json'), 'stale');
    writeAntigravityPlugin(dir, '/data/hook.cjs'); // marked: rewritten
    assert.notEqual(readFileSync(path.join(folder, 'hooks.json'), 'utf8'), 'stale');
    const foreign = path.join(temp(), PLUGIN_REL);
    mkdirSync(foreign, { recursive: true });
    writeFileSync(path.join(foreign, 'plugin.json'), '{"name":"theirs"}');
    const root = path.resolve(foreign, '..', '..', '..');
    try {
      assert.throws(() => writeAntigravityPlugin(root, '/data/hook.cjs'), /has no office marker/);
      assert.deepEqual(readdirSyncOf(foreign), ['plugin.json']);
      assert.equal(readFileSync(path.join(foreign, 'plugin.json'), 'utf8'), '{"name":"theirs"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- subagents' questions ------------------------------------------------------------------------

function working() {
  const x = handle();
  send(x.h, 'SessionStart', { session_id: 'root' });
  send(x.h, 'PreInvocation', { session_id: 'root', prompt: 'go', invocation_num: 0 });
  send(x.h, 'SessionStart', { session_id: 'sub' });
  return x;
}
const ask = (h: WorkerHandle<AntigravityState>, id: string, call: string, tool = 'ask_question') => send(h, 'PreToolUse', { session_id: id, tool_name: tool, tool_use_id: call });
const answer = (h: WorkerHandle<AntigravityState>, id: string, call: string, tool = 'ask_question') => send(h, 'PostToolUse', { session_id: id, tool_name: tool, tool_use_id: call });

test("a subagent's question needs the person, until it is answered or the subagent stops", () => {
  const { h, info } = working();
  ask(h, 'sub', 'q1');
  assert.equal(info.status, 'needs_input');
  assert.equal(info.sessionId, 'root');
  answer(h, 'sub', 'q1');
  assert.equal(info.status, 'working');
  ask(h, 'sub', 'p1', 'ask_permission');
  assert.equal(info.status, 'needs_input');
  send(h, 'Stop', { session_id: 'sub' });
  assert.equal(info.status, 'working');
});

test('a question of the root and one of a subagent both have to be closed', () => {
  const { h, info } = working();
  ask(h, 'root', 'r1');
  ask(h, 'sub', 'q1');
  answer(h, 'root', 'r1');
  assert.equal(info.status, 'needs_input');
  answer(h, 'sub', 'q1');
  assert.equal(info.status, 'working');
  ask(h, 'sub', 'q2');
  ask(h, 'root', 'r2');
  answer(h, 'sub', 'q2');
  assert.equal(info.status, 'needs_input');
  answer(h, 'root', 'r2');
  assert.equal(info.status, 'working');
});

test("a held root Stop stays held while a subagent's question is open, and a finished turn is not resurrected", () => {
  const { h, info } = working();
  send(h, 'Stop', { session_id: 'root', fully_idle: false });
  ask(h, 'sub', 'q1');
  assert.equal(info.status, 'needs_input');
  assert.ok((h.state as AntigravityState).held);
  answer(h, 'sub', 'q1');
  assert.equal(info.status, 'working');
  send(h, 'Stop', { session_id: 'sub' });
  assert.equal(info.status, 'done');
  // A late answer of a gone subagent does not wake the finished turn.
  answer(h, 'sub', 'q1');
  assert.equal(info.status, 'done');
});
