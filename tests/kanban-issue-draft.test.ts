import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIssueOpsMsg } from '../src/shared/kanban/issueops.js';
import { KANBAN_LIMITS } from '../src/shared/kanban/validate.js';
import { cachedClaudeBin, oneShotCommand, runOneShot, spawnPlan, type OneShotRun } from '../src/server/kanban/oneshot.js';
import { cleanDraft, draftHandlers, type DraftDeps } from '../src/server/kanban/integrations/issues/draft.js';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { NormalizedIssue } from '../src/shared/kanban/types.js';
import { client, def, makeCtx, type TestCtx } from './kanban-integrations-ctx.js';

const ISSUE = { key: 'gh:o/r#5', title: 'Login loops', body: 'It loops.', url: 'https://github.com/o/r/issues/5', source: 'github-repo', sourceId: 'r' } as unknown as NormalizedIssue;
const MSG = { t: 'kanban.issues.draft', project: 'app', issueKey: 'gh:o/r#5', rid: 'r1' } as const;

interface Call { opts: Parameters<NonNullable<DraftDeps['run']>>[0] }

/** A handler with the agent stubbed: `answer` is what each run gives (resolved by hand when it is a promise). */
function setup(over: { answer?: (o: Call['opts']) => Promise<{ text: string } | { error: string }>; bin?: () => string | null; load?: DraftDeps['load']; setCtx?: (c: TestCtx) => void } = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })]);
  ctx.claudeBin = over.bin ?? (() => '/bin/claude');
  over.setCtx?.(ctx);
  const calls: Call[] = [];
  const killed: number[] = [];
  const run: NonNullable<DraftDeps['run']> = (o) => {
    calls.push({ opts: o });
    const n = calls.length;
    let stop: (v: { error: string }) => void = () => {};
    const cancel = new Promise<{ error: string }>((r) => (stop = r));
    return { done: Promise.race([(over.answer ?? (async () => ({ text: 'Fix the login loop.' })))(o), cancel]), kill: () => (killed.push(n), stop({ error: 'cancelled' })) } satisfies OneShotRun;
  };
  const d = draftHandlers(ctx, { find: (_p, k) => (k === ISSUE.key ? ISSUE : undefined), load: over.load ?? (async () => undefined), remember: () => {}, run });
  return { ctx, calls, killed, d, go: d.ws['kanban.issues.draft']! };
}
const last = (c: { got: KanbanServerMsg[] }) => c.got.at(-1) as any;

test('kanban.issues.draft parses like issue.get minus fresh', () => {
  assert.deepEqual(parseIssueOpsMsg('kanban.issues.draft', { project: 'app', issueKey: ' UYT-1 ', source: 'jira', fresh: true } as never), { t: 'kanban.issues.draft', project: 'app', issueKey: 'UYT-1', source: 'jira' });
  assert.deepEqual(parseIssueOpsMsg('kanban.issues.draft', { project: 'app', issueKey: 'UYT-1' } as never), { t: 'kanban.issues.draft', project: 'app', issueKey: 'UYT-1' });
  assert.throws(() => parseIssueOpsMsg('kanban.issues.draft', { project: 'app', issueKey: 'x'.repeat(KANBAN_LIMITS.issueKey + 1) } as never));
  assert.throws(() => parseIssueOpsMsg('kanban.issues.draft', { project: 'app', issueKey: 'UYT-1', source: 'bad source!' } as never), /issue source id/);
  assert.throws(() => parseIssueOpsMsg('kanban.issues.draft', { project: 'app' } as never));
});

test('oneShotCommand: Claude without tools or settings, the system text from a file, the model only when set', () => {
  const c = oneShotCommand(undefined, '/t/system.txt');
  assert.deepEqual(c.args, ['-p', '--output-format', 'json', '--system-prompt-file', '/t/system.txt', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']);
  assert.deepEqual(oneShotCommand('haiku', '/t/system.txt').args.slice(0, 3), ['-p', '--model', 'haiku']);
  assert.ok(!oneShotCommand('haiku', '/t/s.txt').args.includes('--system-prompt'));
});

test('spawnPlan: a .cmd or .bat on Windows goes through cmd.exe with every token quoted; anything else is unchanged', () => {
  const args = ['-p', '--model', 'haiku', '--system-prompt-file', 'C:\\Temp\\a b\\system.txt', '--tools', ''];
  const plan = spawnPlan('C:\\npm\\claude.cmd', args, true, 'cmd.exe');
  assert.deepEqual(plan, { file: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "-p" "--model" "haiku" "--system-prompt-file" "C:\\Temp\\a b\\system.txt" "--tools" """'], windowsVerbatimArguments: true });
  assert.equal((spawnPlan('X.BAT', [], true, 'cmd.exe') as { file: string }).file, 'cmd.exe');
  assert.deepEqual((spawnPlan('c.CMD', ['a\\'], true, 'cmd.exe') as { args: string[] }).args[3], '""c.CMD" "a\\\\""');
  assert.deepEqual(spawnPlan('C:\\bin\\claude.exe', args, true), { file: 'C:\\bin\\claude.exe', args });
  assert.deepEqual(spawnPlan('/bin/claude.cmd', args, false), { file: '/bin/claude.cmd', args });
  for (const bad of ['say "hi"', '100%', 'a\nb', 'a\rb']) assert.ok('error' in spawnPlan('claude.cmd', ['-p', bad], true, 'cmd.exe'), bad);
  assert.ok('error' in spawnPlan('C:\\a"b\\claude.cmd', [], true, 'cmd.exe'));
  // A refusal of an .exe's argument does not apply: nothing is interpreted there.
  assert.deepEqual(spawnPlan('claude.exe', ['say "hi"'], true), { file: 'claude.exe', args: ['say "hi"'] });
});

test('cachedClaudeBin looks once, and a miss again only after a minute', () => {
  let t = 0;
  let looked = 0;
  let found: string | null = null;
  const bin = cachedClaudeBin(() => (looked++, found), () => t);
  assert.equal(bin(), null);
  assert.equal(bin(), null);
  assert.equal(looked, 1);
  t = 61_000;
  found = '/x/claude';
  assert.equal(bin(), '/x/claude');
  assert.equal(bin(), '/x/claude');
  assert.equal(looked, 2);
});

test('runOneShot with an unusable binary resolves an error rather than throwing', async () => {
  const res = await runOneShot({ cmd: 'invalid\0command', system: 's', input: 'i', env: {} }).done;
  assert.ok('error' in res && res.error.length > 0 && res.error.length <= 201);
  const missing = await runOneShot({ cmd: '/nonexistent/agent-bin', system: 's', input: 'i', env: {} }).done;
  assert.ok('error' in missing);
});

test('runOneShot reads Claude’s JSON result, passes the system text in a file and the input on stdin, and times out and cancels', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oneshot-test-'));
  const script = (name: string, body: string) => {
    const f = path.join(dir, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const claude = script('claude', 'cat >/dev/null; echo "{\\"result\\":\\"Hello $MAX_THINKING_TOKENS\\"}"');
  assert.deepEqual(await runOneShot({ cmd: claude, system: 's', input: 'i', env: {} }).done, { text: 'Hello 0' });
  const failing = script('claude-bad', 'cat >/dev/null; echo "first" >&2; echo "boom" >&2; exit 3');
  assert.deepEqual(await runOneShot({ cmd: failing, system: 's', input: 'i', env: {} }).done, { error: 'boom' });
  const isError = script('claude-err', 'cat >/dev/null; echo "{\\"is_error\\":true,\\"result\\":\\"Not logged in\\"}"');
  assert.deepEqual(await runOneShot({ cmd: isError, system: 's', input: 'i', env: {} }).done, { error: 'Not logged in' });
  // A failed run still says why in its JSON (a limit reached, an unknown model): that, not stderr.
  const exitError = script('claude-exit', 'cat >/dev/null; echo "{\\"is_error\\":true,\\"result\\":\\"Claude usage limit reached\\"}"; echo "noise" >&2; exit 1');
  assert.deepEqual(await runOneShot({ cmd: exitError, system: 's', input: 'i', env: {} }).done, { error: 'Claude usage limit reached' });
  // The system text is in the file named after --system-prompt-file (gone afterwards), the input is on stdin, and no argument carries either.
  const echo = script('claude-echo', 'f=""; for a in "$@"; do [ "$p" = "--system-prompt-file" ] && f="$a"; p="$a"; case "$a" in *SYS*|*INPUT*) echo "leak" >&2; exit 9;; esac; done; in=$(cat); sys=$(cat "$f"); printf \'{"result":"%s|%s|%s"}\' "$sys" "$in" "$f"');
  const echoed = await runOneShot({ cmd: echo, system: 'SYS', input: 'INPUT', env: {} }).done;
  assert.ok('text' in echoed && echoed.text.startsWith('SYS|INPUT|'), JSON.stringify(echoed));
  assert.equal(existsSync((echoed as { text: string }).text.split('|')[2]), false);
  const slow = script('slow', 'sleep 5');
  assert.deepEqual(await runOneShot({ cmd: slow, system: 's', input: 'i', env: {}, timeoutMs: 100 }).done, { error: 'took too long' });
  // Something the agent started and left holding its pipes doesn't keep the run past its time.
  const forks = script('forks', 'sleep 5 & wait');
  const at = Date.now();
  assert.deepEqual(await runOneShot({ cmd: forks, system: 's', input: 'i', env: {}, timeoutMs: 100 }).done, { error: 'took too long' });
  assert.ok(Date.now() - at < 2000);
  const run = runOneShot({ cmd: slow, system: 's', input: 'i', env: {} });
  setTimeout(() => run.kill(), 50);
  assert.deepEqual(await run.done, { error: 'cancelled' });
});

test('cleanDraft strips one code fence and quotes, and clips', () => {
  assert.equal(cleanDraft('  Plain.  '), 'Plain.');
  assert.equal(cleanDraft('```\nFenced text.\n```'), 'Fenced text.');
  assert.equal(cleanDraft('```markdown\nFenced text.\n```'), 'Fenced text.');
  assert.equal(cleanDraft('"Quoted."'), 'Quoted.');
  assert.equal(cleanDraft('“Curly.”'), 'Curly.');
  assert.equal(cleanDraft('Say "hi" now'), 'Say "hi" now');
  assert.equal(cleanDraft('"Retry" must replace the old "Again"'), '"Retry" must replace the old "Again"');
  assert.equal(cleanDraft('a'.repeat(3000)).length, 1500);
});

test('draft: Claude with the settings’ model, the server-side issue text, the prompt with the language rule', async () => {
  const { go, calls } = setup({ setCtx: (c) => { const s = c.settings.get(); c.settings.get = () => ({ ...s, defaults: { ...s.defaults, tool: 'claude', model: 'haiku' } }); } });
  const c = client();
  await go(c, { ...MSG });
  assert.equal(calls.length, 1);
  const o = calls[0].opts;
  assert.equal(o.model, 'haiku');
  assert.equal(o.cmd, '/bin/claude');
  assert.equal(o.input, 'Issue gh:o/r#5: Login loops\n\nIt loops.');
  assert.match(o.system, /^You write a short task prompt/);
  assert.deepEqual(last(c), { t: 'kanban.issueDraft', rid: 'r1', text: 'Fix the login loop.' });
});

test('draft: with Codex as the default agent nothing is drafted, and no issue is even loaded', async () => {
  let loaded = 0;
  const s = setup({ load: async () => (loaded++, undefined), setCtx: (c) => { const st = c.settings.get(); c.settings.get = () => ({ ...st, defaults: { ...st.defaults, tool: 'codex', model: 'gpt-x' } }); } });
  const c = client();
  await s.go(c, { ...MSG, issueKey: 'gh:o/r#99' });
  assert.deepEqual(last(c), { t: 'kanban.issueDraft', rid: 'r1', text: '' });
  assert.equal(s.calls.length + loaded, 0);
});

test('draft: Claude without a model passes none, and an account’s sign-in is checked and applied', async () => {
  const applied: string[] = [];
  const { go, calls } = setup({ setCtx: (c) => { c.runAs = { claudeReady: (id) => id === 'ok', apply: (id, env) => void (applied.push(id), (env.CLAUDE_CONFIG_DIR = '/home/x')), why: () => 'Sign in to Claude first' }; const s = c.settings.get(); c.settings.get = () => ({ ...s, defaults: { ...s.defaults, model: undefined } }); } });
  const no = client(true, 'nope');
  await go(no, { ...MSG });
  assert.deepEqual(last(no), { t: 'kanban.error', rid: 'r1', message: 'Sign in to Claude first' });
  assert.equal(calls.length, 0);
  const yes = client(true, 'ok');
  await go(yes, { ...MSG });
  assert.equal(calls[0].opts.model, undefined);
  assert.equal(calls[0].opts.env.CLAUDE_CONFIG_DIR, '/home/x');
  assert.deepEqual(applied, ['ok']);
});

test('draft: an emptied prompt and a paused office answer an empty text without a run', async () => {
  const off = setup({ setCtx: (c) => void (c.officePrompts = () => ({ 'kanban.issueDraft': { text: '' } })) });
  const c = client();
  await off.go(c, { ...MSG });
  assert.deepEqual(last(c), { t: 'kanban.issueDraft', rid: 'r1', text: '' });
  const project = setup({ setCtx: (x) => { const s = x.settings.get(); x.settings.project = (id) => ({ ...(s.projects[id] ?? ({} as never)), prompts: { 'kanban.issueDraft': '  ' }, issueSources: [] }) as never; } });
  const c2 = client();
  await project.go(c2, { ...MSG });
  assert.equal(last(c2).text, '');
  const paused = setup({ setCtx: (x) => void (x.hiringPaused = () => 'budget') });
  const c3 = client();
  await paused.go(c3, { ...MSG });
  assert.deepEqual(last(c3), { t: 'kanban.issueDraft', rid: 'r1', text: '' });
  assert.equal(off.calls.length + project.calls.length + paused.calls.length, 0);
});

test('draft: errors answer kanban.error', async () => {
  const err = async (s: ReturnType<typeof setup>, m: Record<string, unknown> = {}) => {
    const c = client();
    await s.go(c, { ...MSG, ...m } as never);
    return last(c);
  };
  assert.match((await err(setup(), { project: 'nope' })).message, /no project nope/);
  assert.match((await err(setup(), { issueKey: 'gh:o/r#99' })).message, /isn't among the project's issues/);
  assert.match((await err(setup({ bin: () => null }))).message, /Claude isn't available on the office's machine/);
  assert.equal((await err(setup({ answer: async () => ({ error: 'took too long' }) }))).message, 'took too long');
  const empty = await err(setup({ answer: async () => ({ text: '  "" ' }) }));
  assert.deepEqual([empty.t, empty.message], ['kanban.error', 'The agent wrote nothing']);
});

test('draft: fences and quotes are stripped and the text is clipped', async () => {
  const s = setup({ answer: async () => ({ text: `\`\`\`\n${'x'.repeat(2000)}\n\`\`\`` }) });
  const c = client();
  await s.go(c, { ...MSG });
  assert.equal(last(c).text.length, 1500);
});

test('draft: a second request from the same browser cancels the first; at most four run at once', async () => {
  const pending: ((v: { text: string }) => void)[] = [];
  const s = setup({ answer: () => new Promise((r) => pending.push(r)) });
  const a = client();
  const first = s.go(a, { ...MSG, rid: 'one' });
  await new Promise((r) => setImmediate(r));
  const second = s.go(a, { ...MSG, rid: 'two' });
  await first;
  assert.deepEqual(last(a), { t: 'kanban.error', rid: 'one', message: 'cancelled' });
  assert.deepEqual(s.killed, [1]);
  await new Promise((r) => setImmediate(r));
  const b = { ...client(), clientId: 'c2' };
  const third = s.go(b, { ...MSG, rid: 'three' });
  await new Promise((r) => setImmediate(r));
  // Two more browsers fill the office's four runs.
  for (const id of ['c4', 'c5']) void s.go({ ...client(), clientId: id }, { ...MSG });
  await new Promise((r) => setImmediate(r));
  const d = { ...client(), clientId: 'c3' };
  await s.go(d, { ...MSG, rid: 'four' });
  assert.match(last(d).message, /busy drafting/);
  pending[1]({ text: 'Second.' });
  pending[2]({ text: 'Third.' });
  await Promise.all([second, third]);
  assert.equal(last(a).text, 'Second.');
  assert.equal(last(b).text, 'Third.');
  // stop() kills what is running.
  const more = s.go(client(), { ...MSG, rid: 'five' });
  await new Promise((r) => setImmediate(r));
  s.d.stop();
  await more;
  assert.ok(s.killed.length >= 2);
});

test('the issues plugin serves kanban.issues.draft and takes an agent stub', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })]);
  ctx.claudeBin = () => '/bin/claude';
  const issues = createIssues(ctx, { oneShot: () => ({ done: Promise.resolve({ text: 'Drafted.' }), kill() {} }) });
  assert.equal(typeof issues.plugin.ws!['kanban.issues.draft'], 'function');
  const c = client();
  await issues.plugin.ws!['kanban.issues.draft']!(c, { t: 'kanban.issues.draft', project: 'nope', issueKey: 'K-1' });
  assert.match(last(c).message, /no project nope/);
  issues.plugin.stop?.();
});

test('draft: a slow lookup of an older request does not cancel the browser’s newer run', async () => {
  const lookups: ((v: NormalizedIssue | undefined) => void)[] = [];
  const s = setup({ load: () => new Promise((r) => lookups.push(r)) });
  const a = client();
  const older = s.go(a, { ...MSG, issueKey: 'gh:o/r#7', rid: 'old' });
  // B finds its issue at once and runs.
  const newer = s.go(a, { ...MSG, rid: 'new' });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 1);
  lookups[0](ISSUE);
  await Promise.all([older, newer]);
  const of = (rid: string) => (a.got as any[]).find((g) => g.rid === rid);
  assert.deepEqual(of('old'), { t: 'kanban.error', rid: 'old', message: 'cancelled' });
  assert.deepEqual(s.killed, []);
  assert.deepEqual(of('new'), { t: 'kanban.issueDraft', rid: 'new', text: 'Fix the login loop.' });
  assert.equal(s.calls.length, 1);
});

test('draft: a lookup that finishes after stop() starts no run', async () => {
  let finish: (v: NormalizedIssue | undefined) => void = () => {};
  const s = setup({ load: () => new Promise((r) => (finish = r)) });
  const c = client();
  const p = s.go(c, { ...MSG, issueKey: 'gh:o/r#7' });
  await new Promise((r) => setImmediate(r));
  s.d.stop();
  finish(ISSUE);
  await p;
  assert.deepEqual(last(c), { t: 'kanban.error', rid: 'r1', message: 'cancelled' });
  assert.equal(s.calls.length, 0);
});

test('runOneShot starts a real .cmd on Windows', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oneshot-cmd-'));
  const f = path.join(dir, 'claude.cmd');
  writeFileSync(f, '@echo off\r\nmore >nul\r\necho {"result":"From cmd"}\r\n');
  assert.deepEqual(await runOneShot({ cmd: f, system: 's', input: 'i', env: { ...process.env } as Record<string, string> }).done, { text: 'From cmd' });
});
