import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEX_HOOK_EVENTS,
  codexHookArgs,
  normalizeCodexHook,
  validateCodexHook,
  writeCodexHook,
} from '../src/server/codex.js';

test('normalizes bounded root Codex hook payloads and passes only the metric reader path', () => {
  assert.deepEqual(normalizeCodexHook('SessionStart', {
    session_id: 'thread-1', source: 'startup', transcript_path: '/private/transcript.jsonl', turn_id: 'turn-1',
  }), { sessionId: 'thread-1', event: 'SessionStart', source: 'startup', turnId: 'turn-1', transcriptPath: '/private/transcript.jsonl' });
  assert.deepEqual(normalizeCodexHook('UserPromptSubmit', {
    session_id: 'thread-1', prompt: '  fix the login  ', turn_id: 'turn-2', model: 'secret-model',
  }), { sessionId: 'thread-1', event: 'UserPromptSubmit', prompt: 'fix the login', turnId: 'turn-2' });
  assert.deepEqual(normalizeCodexHook('PermissionRequest', {
    session_id: 'thread-1', tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'secret' },
  }), { sessionId: 'thread-1', event: 'PermissionRequest', tool: 'Bash', toolUseId: 'tool-1' });
});

test('rejects unknown, malformed, empty, oversized, and child-scoped events', () => {
  assert.equal(validateCodexHook('Unknown', { session_id: 'x' }), false);
  assert.equal(validateCodexHook('Stop', null), false);
  assert.equal(validateCodexHook('Stop', { session_id: '' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x'.repeat(161) }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_id: 'child-1' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_type: 'explorer' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_id: 'c'.repeat(161) }), false);
});

test('generates one stable CLI hook override per supported event', () => {
  const args = codexHookArgs('/tmp/office data/agent-office-codex-hook.cjs');
  assert.equal(args.length, CODEX_HOOK_EVENTS.length * 2);
  for (let i = 0; i < CODEX_HOOK_EVENTS.length; i++) {
    assert.equal(args[i * 2], '-c');
    assert.match(args[i * 2 + 1], new RegExp(`^hooks\\.${CODEX_HOOK_EVENTS[i]}=\\[\\{hooks=`));
    assert.match(args[i * 2 + 1], /type="command"/);
    assert.match(args[i * 2 + 1], /timeout=3/);
    assert.match(args[i * 2 + 1], /agent-office-codex-hook\.cjs/);
  }
});

test('writes a mode-restricted helper that forwards paths without reading transcripts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  try {
    const file = writeCodexHook(dir);
    assert.equal(file, path.join(dir, 'agent-office-codex-hook.cjs'));
    const source = readFileSync(file, 'utf8');
    assert.match(source, /MAX = 64 \* 1024/);
    assert.match(source, /AGENT_OFFICE_HOOK_TOKEN/);
    assert.doesNotMatch(source, /readFile|readSync|createReadStream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('helper forwards only the bounded root event fields to the authenticated bridge', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  const received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.url = req.url;
      received.authorization = req.headers.authorization;
      received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end();
    });
  });
  try {
    const file = writeCodexHook(dir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, [file, 'UserPromptSubmit'], {
      env: {
        PATH: process.env.PATH,
        AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`,
        AGENT_OFFICE_HOOK_TOKEN: 'hook-token',
        AGENT_OFFICE_WORKER_ID: 'worker-1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify({
        session_id: 'thread-1', prompt: 'fix it', turn_id: 'turn-1',
        transcript_path: '/private/transcript.jsonl', model: 'private-model',
        tool_input: { command: 'private' }, hook_event_name: 'forged',
      }));
    });
    assert.equal(stdout, '{}');
    assert.equal(received.authorization, 'Bearer hook-token');
    assert.equal(received.url, '/hooks/codex?worker=worker-1&event=UserPromptSubmit');
    assert.deepEqual(received.body, {
      session_id: 'thread-1', hook_event_name: 'UserPromptSubmit', prompt: 'fix it', turn_id: 'turn-1',
      transcript_path: '/private/transcript.jsonl',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the real helper on a hook's stdin against a local server standing in for the office; the body it POSTed. */
async function bridged(event: string, stdin: unknown): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end();
    });
  });
  try {
    const file = writeCodexHook(dir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, [file, event], {
      env: { PATH: process.env.PATH, AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`, AGENT_OFFICE_HOOK_TOKEN: 't', AGENT_OFFICE_WORKER_ID: 'w' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve());
      child.stdin.end(JSON.stringify(stdin));
    });
    return body;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('helper forwards a question tool\'s question, bounded and only its fields, on PreToolUse; no other tool\'s input', async () => {
  const input = {
    questions: [
      { id: 'q1', question: '  Which one?  ', header: 'Pick', secret: 'x', options: [{ label: 'A', description: 'first', extra: 1 }, 'plain', { description: 'no label' }, 7] },
      { question: 'z'.repeat(5000) },
      { header: 'no question' },
      ...Array.from({ length: 20 }, (_, i) => ({ question: `q${i}` })),
    ],
    command: 'private', env: { A: 'b' },
  };
  const got = await bridged('PreToolUse', { session_id: 's', tool_name: 'request_user_input', tool_use_id: 'u1', tool_input: input, model: 'private' });
  const asked = got.tool_input as { questions: { question: string; header?: string; options?: unknown[] }[]; command?: unknown; env?: unknown };
  assert.equal(asked.command, undefined);
  assert.equal(asked.env, undefined);
  assert.equal(asked.questions.length, 7, 'the cap counts what was sent; one of the first eight had no question');
  assert.deepEqual(asked.questions[0], { question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, 'plain'] });
  assert.equal(asked.questions[1].question.length, 2000);
  assert.deepEqual(Object.keys(got).sort(), ['hook_event_name', 'session_id', 'tool_input', 'tool_name', 'tool_use_id']);
  // The input as a JSON string, and plain fields.
  const text = await bridged('PreToolUse', { session_id: 's', tool_name: 'mcp.AskUserQuestion', tool_input: JSON.stringify({ question: 'Plain?', other: 1 }) });
  assert.deepEqual(text.tool_input, { question: 'Plain?' });
  // Not a question tool, not a PreToolUse, or nothing to forward: no tool_input.
  assert.equal('tool_input' in (await bridged('PreToolUse', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'private', question: 'sneaky' } })), false);
  assert.equal('tool_input' in (await bridged('PermissionRequest', { session_id: 's', tool_name: 'request_user_input', tool_input: input })), false);
  assert.equal('tool_input' in (await bridged('PreToolUse', { session_id: 's', tool_name: 'request_user_input', tool_input: { x: 1 } })), false);
});

test("the hook helper knows the same question tools as the kanban's QUESTION_TOOL", async () => {
  const { QUESTION_TOOL } = await import('../src/server/kanban/engine/signals.js');
  const { CODEX_HOOK_SOURCE } = await import('../src/server/codex.js');
  assert.ok(CODEX_HOOK_SOURCE.includes(`/${QUESTION_TOOL.source}/`), 'the helper carries its own copy of the pattern: keep the two the same');
});
