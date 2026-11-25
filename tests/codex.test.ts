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
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { taskConversation } from '../src/server/kanban/conversation.js';
import { askedQuestion, heardQuestion } from '../src/server/kanban/engine/signals.js';

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
  assert.equal('moreOptions' in asked.questions[0], false, 'nothing cut there, nothing said');
  assert.equal(asked.questions[1].question, 'z'.repeat(2000) + ' (cut here: 3000 more characters)');
  assert.equal((asked as { moreQuestions?: number }).moreQuestions, 15, 'the 23 entries sent, 8 kept');
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

test('helper: every cut is said: a marker on a clipped text, the counts of dropped questions and options', async () => {
  const got = await bridged('PreToolUse', {
    session_id: 's', tool_name: 'request_user_input',
    tool_input: {
      questions: [
        { question: 'Q'.repeat(2005), options: Array.from({ length: 15 }, (_, i) => ({ label: `o${i}`, description: i === 0 ? 'd'.repeat(2100) : undefined })) },
        ...Array.from({ length: 19 }, (_, i) => ({ question: `q${i}` })),
      ],
    },
  });
  const asked = got.tool_input as { questions: { question: string; options: { label: string; description?: string }[]; moreOptions?: number }[]; moreQuestions?: number };
  assert.equal(asked.questions.length, 8);
  assert.equal(asked.moreQuestions, 12);
  assert.equal(asked.questions[0].question, 'Q'.repeat(2000) + ' (cut here: 5 more characters)');
  assert.equal(asked.questions[0].options.length, 12);
  assert.equal(asked.questions[0].moreOptions, 3);
  assert.equal(asked.questions[0].options[0].description, 'd'.repeat(2000) + ' (cut here: 100 more characters)');
  assert.equal('moreOptions' in asked.questions[1], false);
  const whole = (await bridged('PreToolUse', { session_id: 's', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Q'.repeat(2000), options: [{ label: 'a' }] }] } })).tool_input as object;
  assert.deepEqual(whole, { questions: [{ question: 'Q'.repeat(2000), options: [{ label: 'a' }] }] });
});

test('the history of a cut: what the helper sends is kept as the agent\'s question and the conversation file says what was left out', async () => {
  const body = await bridged('PreToolUse', {
    session_id: 's', tool_name: 'request_user_input',
    tool_input: { questions: [{ question: 'Pick a colour ' + 'x'.repeat(2100), options: Array.from({ length: 14 }, (_, i) => ({ label: `c${i}` })) }, ...Array.from({ length: 9 }, (_, i) => ({ question: `extra ${i}` }))] },
  });
  const live = {};
  assert.equal(heardQuestion(live, { tool: 'request_user_input', hookEvent: 'PreToolUse', payload: body }), true);
  const text = askedQuestion(live)!;
  const db = openKanbanDb(':memory:');
  try {
    const repo = new KanbanRepository(db);
    const task = repo.createTask({ project: 'web', title: 'T', tool: 'codex', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
    const run = repo.createRun({ taskId: task.id, phase: 'implement', tool: 'codex' });
    repo.addComment({ taskId: task.id, authorKind: 'agent', authorName: 'Bot', tool: 'codex', kind: 'questions', text, runId: run.id, createdAt: 1000 });
    repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'the red one', runId: run.id, createdAt: 2000 });
    const md = taskConversation({ repo }, task.id, (c) => c.text)!.markdown();
    const at = md.indexOf('What the agent had said or asked');
    const answer = md.indexOf('the red one');
    assert.ok(at > 0 && answer > at);
    const entry = md.slice(at, answer);
    assert.match(entry, /\(cut here: 114 more characters\)/);
    assert.match(entry, /\(2 more options were left out\)/);
    assert.match(entry, /\(2 more questions were left out\)/);
    assert.doesNotMatch(md, /question was not recorded/);
  } finally {
    db.close();
  }
});
