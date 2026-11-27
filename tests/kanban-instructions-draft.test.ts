import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';
import { parseInstructionsDraftMsg } from '../src/shared/kanban/instructionsdraft.js';
import { KANBAN_LIMITS } from '../src/shared/kanban/validate.js';
import { oneShotCommand, runOneShot, type OneShotRun } from '../src/server/kanban/oneshot.js';
import { createInstructionsDraftPlugin, INSTRUCTIONS_DRAFT_DENY, INSTRUCTIONS_DRAFT_MAX, type InstructionsDraftDeps } from '../src/server/kanban/integrations/instructions-draft/index.js';
import { envExampleKeys, envKeys } from '../src/server/kanban/integrations/instructions-draft/envexamples.js';
import { draftInput, draftSystem } from '../src/server/kanban/integrations/instructions-draft/prompt.js';
import { findSecrets } from '../src/server/kanban/integrations/instructions-draft/secrets.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

const MSG = { t: 'kanban.instructions.draft', project: 'app', field: 'testing', text: 'Run npm test.', rid: 'r1' } as const;
type Opts = Parameters<NonNullable<InstructionsDraftDeps['run']>>[0];

function setup(over: { answer?: (o: Opts) => Promise<{ text: string } | { error: string }>; dir?: string | null } = {}) {
  const dir = over.dir === undefined ? mkdtempSync(path.join(os.tmpdir(), 'instr-repo-')) : (over.dir ?? '/nonexistent/repo-dir');
  const ctx = makeCtx([def('app', dir, { repo: 'o/r' })]);
  ctx.claudeBin = () => '/bin/claude';
  const calls: Opts[] = [];
  const killed: number[] = [];
  const run: NonNullable<InstructionsDraftDeps['run']> = (o) => {
    calls.push(o);
    const n = calls.length;
    let stop: (v: { error: string }) => void = () => {};
    const cancel = new Promise<{ error: string }>((r) => (stop = r));
    return { done: Promise.race([(over.answer ?? (async () => ({ text: 'Instructions.' })))(o), cancel]), kill: () => (killed.push(n), stop({ error: 'cancelled' })) } satisfies OneShotRun;
  };
  const p = createInstructionsDraftPlugin(ctx, { run });
  return { ctx, calls, killed, p, dir, go: p.ws!['kanban.instructions.draft']!, cancel: p.ws!['kanban.instructions.draft.cancel']! };
}
const last = (c: { got: unknown[] }) => c.got.at(-1) as any;
/** Waits until the stand-in agent has been started `n` times (the handler looks through the repositories first). */
async function started(s: { calls: unknown[] }, n: number) {
  for (let i = 0; i < 500 && s.calls.length < n; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(s.calls.length >= n, `run ${n} never started`);
}

test('oneShotCommand: tools, extra directories and the settings file only on request', () => {
  const plain = oneShotCommand(undefined, '/t/system.txt').args;
  assert.deepEqual(plain, ['-p', '--output-format', 'json', '--system-prompt-file', '/t/system.txt', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']);
  assert.deepEqual(oneShotCommand(undefined, '/t/system.txt', { tools: [] }).args, plain);
  const rich = oneShotCommand('opus', '/t/system.txt', { tools: ['Read', 'Glob', 'Grep'], addDirs: ['/a', '/b'], settingsFile: '/t/settings.json' }).args;
  assert.equal(rich[rich.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.deepEqual(rich.filter((_, i) => rich[i - 1] === '--add-dir'), ['/a', '/b']);
  assert.equal(rich[rich.indexOf('--settings') + 1], '/t/settings.json');
});

test('runOneShot writes the deny rules to a settings file and passes it with the tools and directories', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oneshot-test-'));
  const f = path.join(dir, 'claude');
  writeFileSync(f, '#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do [ "$p" = "--settings" ] && s="$a"; p="$a"; done\nprintf \'{"result":"%s|%s"}\' "$*" "$(tr -d "\\n \\"" < "$s")"\n');
  chmodSync(f, 0o755);
  const res = await runOneShot({ cmd: f, system: 's', input: 'i', env: {}, tools: ['Read', 'Grep'], addDirs: ['/x'], deny: ['Read(**/.env)'] }).done;
  assert.ok('text' in res, JSON.stringify(res));
  assert.match(res.text, /--tools Read,Grep /);
  assert.match(res.text, /--add-dir \/x /);
  assert.match(res.text, /--settings \S+settings\.json/);
  assert.ok(res.text.endsWith('|{permissions:{deny:[Read(**/.env)]}}'), res.text);
});

test('the messages parse: the field and the length limit', () => {
  assert.deepEqual(parseInstructionsDraftMsg('kanban.instructions.draft', { project: 'app', field: 'prReview', text: '' }), { t: 'kanban.instructions.draft', project: 'app', field: 'prReview', text: '' });
  assert.deepEqual(parseKanbanClientMsg({ t: 'kanban.instructions.draft.cancel', project: 'app', rid: 'x' }), { t: 'kanban.instructions.draft.cancel', project: 'app', rid: 'x' });
  assert.throws(() => parseInstructionsDraftMsg('kanban.instructions.draft', { project: 'app', field: 'other', text: '' }), /field/);
  assert.throws(() => parseInstructionsDraftMsg('kanban.instructions.draft', { project: 'app', field: 'testing', text: 'x'.repeat(KANBAN_LIMITS.promptText + 1) }), /too long/);
  assert.doesNotThrow(() => parseInstructionsDraftMsg('kanban.instructions.draft', { project: 'app', field: 'testing', text: 'x'.repeat(KANBAN_LIMITS.promptText) }));
});

test('the handler is for admins, and refuses what it cannot do', async () => {
  const s = setup();
  const visitor = client(false);
  await s.go(visitor, MSG);
  assert.match(last(visitor).message, /Only an admin/);
  const a = client();
  await s.go(a, { ...MSG, project: 'nope' });
  assert.match(last(a).message, /no project/);
  s.ctx.claudeBin = () => null;
  await s.go(a, MSG);
  assert.match(last(a).message, /Claude isn't available/);
  s.ctx.claudeBin = () => '/bin/claude';
  s.ctx.hiringPaused = () => 'budget';
  await s.go(a, MSG);
  assert.match(last(a).message, /budget/);
  assert.equal(s.calls.length, 0);
  const gone = setup({ dir: null });
  const b = client();
  await gone.go(b, MSG);
  assert.match(last(b).message, /None of the project's repository folders/);
});

test('the run gets the repositories, the current text, read-only tools and the deny list', async () => {
  const s = setup();
  s.ctx.settings.setProject('app', { generalInstructions: 'GENERAL', prReviewInstructions: 'OTHERFIELD' } as never);
  const a = client();
  await s.go(a, MSG);
  assert.deepEqual(last(a), { t: 'kanban.instructionsDraft', rid: 'r1', text: 'Instructions.' });
  const o = s.calls[0];
  assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(o.addDirs, [s.dir]);
  assert.ok(o.deny?.includes('Read(**/.env)') && o.deny.includes('Read(**/.env.*)'));
  assert.ok(o.input.includes(s.dir) && o.input.includes('Run npm test.') && o.input.includes('GENERAL') && o.input.includes('OTHERFIELD'));
  assert.match(o.input, /Keep every fact and rule/);
  await s.go(a, { ...MSG, text: '' });
  assert.match(s.calls[1].input, /The field is empty: write it from scratch/);
  assert.match(draftSystem('prReview', 'Finnish'), /Write in Finnish/);
  assert.match(draftSystem('testing', undefined), /language of the existing text/);
  assert.match(draftSystem('prReview', undefined), /Per-review database copies/);
  assert.match(draftInput({ projectName: 'P', repos: [], general: '', other: '', current: '', field: 'testing' }), /Project: P/);
});

test('the answer loses one fence, is clipped, and an empty one is an error; secrets are warned of, not removed', async () => {
  const run = (text: string) => setup({ answer: async () => ({ text }) });
  let s = run('```markdown\n# Setup\nPassword=hunter2x\n```');
  let a = client();
  await s.go(a, MSG);
  assert.deepEqual(last(a), { t: 'kanban.instructionsDraft', rid: 'r1', text: '# Setup\nPassword=hunter2x', warnings: ['Line 2 may hold a secret (a password or key)'] });
  s = run('x'.repeat(INSTRUCTIONS_DRAFT_MAX + 500) + ' ');
  a = client();
  await s.go(a, MSG);
  assert.equal(last(a).text.length, INSTRUCTIONS_DRAFT_MAX);
  s = run('  ```\n```  ');
  a = client();
  await s.go(a, MSG);
  assert.equal(last(a).message, 'The agent wrote nothing');
});

test('a cancel that lands while the settings file is being written starts no agent', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oneshot-test-'));
  const f = path.join(dir, 'claude');
  const started = path.join(dir, 'started');
  writeFileSync(f, `#!/bin/sh\ntouch "${started}"\ncat >/dev/null\nprintf '{"result":"x"}'\n`);
  chmodSync(f, 0o755);
  let run: OneShotRun | undefined;
  const real = fs.promises.writeFile;
  // The write of settings.json finishes, and the cancel arrives before runOneShot goes on from it.
  mock.method(fs.promises, 'writeFile', async (...a: Parameters<typeof real>) => {
    await real(...a);
    if (String(a[0]).endsWith('settings.json')) run?.kill();
  });
  syncBuiltinESMExports();
  try {
    run = runOneShot({ cmd: f, system: 's', input: 'i', env: {}, tools: ['Read'], deny: ['Read(**/.env)'] });
    assert.deepEqual(await run.done, { error: 'cancelled' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(existsSync(started), false, 'the agent was started after the cancel');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('every env file is denied, and the example ones reach the agent as key names only', async () => {
  assert.ok(INSTRUCTIONS_DRAFT_DENY.includes('Read(**/.env)') && INSTRUCTIONS_DRAFT_DENY.includes('Read(**/.env.*)'));
  assert.deepEqual(envKeys('# c\nAPI_URL=http://x\nexport DB_PASSWORD="s3cret"\n  TOKEN = abc\nAPI_URL=again\nnot a key'), ['API_URL', 'DB_PASSWORD', 'TOKEN']);
  const repo = mkdtempSync(path.join(os.tmpdir(), 'instr-env-'));
  mkdirSync(path.join(repo, 'api'));
  mkdirSync(path.join(repo, 'node_modules'));
  writeFileSync(path.join(repo, '.env.example'), 'PORT=3000\nDB_PASSWORD=exampleValue1\n');
  writeFileSync(path.join(repo, 'api', '.env.local.sample'), 'REDIS_URL=redis://x\n');
  writeFileSync(path.join(repo, '.env.ci'), 'CI_TOKEN=realValue99\n');
  writeFileSync(path.join(repo, '.env'), 'REAL=realValue98\n');
  writeFileSync(path.join(repo, 'node_modules', '.env.example'), 'SKIPPED=1\n');
  const out = await envExampleKeys([repo]);
  assert.equal(out, `- ${path.join(repo, 'api', '.env.local.sample')}: REDIS_URL\n- ${path.join(repo, '.env.example')}: PORT, DB_PASSWORD`.split('\n').sort().join('\n'));
  assert.ok(!/exampleValue1|realValue|CI_TOKEN|REAL|SKIPPED/.test(out));
  const input = draftInput({ projectName: 'p', repos: [], general: '', other: '', current: '', field: 'testing', envExamples: out });
  assert.ok(input.includes('key names only') && input.includes('PORT, DB_PASSWORD'));
  assert.ok(!draftInput({ projectName: 'p', repos: [], general: '', other: '', current: '', field: 'testing' }).includes('key names only'));
});

test('nothing inside a quoted, multi-line value is taken for a key name', () => {
  const pem = 'PRIVATE_KEY="-----BEGIN KEY-----\nabc123==\nline=two\n say \\" quote=inside\n-----END KEY-----"\nAFTER=1\n';
  assert.deepEqual(envKeys(pem), ['PRIVATE_KEY', 'AFTER']);
  assert.deepEqual(envKeys("CERT='first\nsecretPart=xyz\nlast'\nNEXT=2\nTICK=`a\nhidden=1\nb`\nEND=3"), ['CERT', 'NEXT', 'TICK', 'END']);
  // A quote never closed: the value is the rest of its line, as dotenv reads it, and the following lines are lines again.
  assert.deepEqual(envKeys('OPEN="no end\nREAL_KEY=1\n'), ['OPEN', 'REAL_KEY']);
  assert.deepEqual(envKeys('A=plain # KEY2=x\n=nokey\n1BAD=x\nB=\n'), ['A', 'B']);
  // A byte order mark before the first name, and a backslash before the quote in each kind of quote.
  assert.deepEqual(envKeys('\uFEFFPRIVATE_KEY="first\nabc123==\nlast"\nAFTER=1\n'), ['PRIVATE_KEY', 'AFTER']);
  assert.deepEqual(envKeys("TOKEN='first \\' quote\nabc123==\nlast'\nAFTER=1\n"), ['TOKEN', 'AFTER']);
  assert.deepEqual(envKeys('TOKEN=`first \\` tick\nabc123==\nlast`\nAFTER=1\n'), ['TOKEN', 'AFTER']);
  // The value starts on the line after its `=`, and the `KEY: value` form.
  assert.deepEqual(envKeys('KEY=\n"a\nabc123==\n"\nYAMLISH: "x\nhidden=1\n"\nEND=1'), ['KEY', 'YAMLISH', 'END']);
});

test('the search for example env files follows no link, stops at its caps and when its request has ended', { skip: process.platform === 'win32' }, async () => {
  const other = mkdtempSync(path.join(os.tmpdir(), 'instr-other-'));
  mkdirSync(path.join(other, 'conf'));
  writeFileSync(path.join(other, '.env.example'), 'OTHER_PROJECT_KEY=1\n');
  writeFileSync(path.join(other, 'conf', '.env.sample'), 'OTHER_FOLDER_KEY=1\n');
  const repo = mkdtempSync(path.join(os.tmpdir(), 'instr-env-'));
  mkdirSync(path.join(repo, 'sub'));
  writeFileSync(path.join(repo, 'sub', '.env.example'), 'OWN_KEY=1\n');
  // A file link and a folder link out of the repository.
  symlinkSync(path.join(other, '.env.example'), path.join(repo, '.env.example'));
  symlinkSync(path.join(other, 'conf'), path.join(repo, 'linked'));
  const out = await envExampleKeys([repo]);
  assert.equal(out, `- ${path.join(repo, 'sub', '.env.example')}: OWN_KEY`);
  assert.ok(!out.includes('OTHER_'));
  // The caps: the file lies behind more entries than may be looked at; a request that has ended; no time left.
  for (let i = 0; i < 30; i++) writeFileSync(path.join(repo, `a${i}.txt`), '');
  assert.equal(await envExampleKeys([repo], { entriesMax: 10 }), '');
  assert.equal(await envExampleKeys([repo], { stopped: () => true }), '');
  // A disk call that never comes back: the search still answers in its time, with nothing.
  const t0 = Date.now();
  assert.equal(await envExampleKeys([repo], { timeMs: 30, opendir: (() => new Promise(() => {})) as never }), '');
  assert.ok(Date.now() - t0 < 1000);
  // A folder is read entry by entry: with the cap reached, no more of it is read.
  let reads = 0;
  const big = { read: async () => (reads++, { name: `f${reads}`, isDirectory: () => false, isFile: () => true }), close: async () => {} };
  assert.equal(await envExampleKeys(['/big'], { entriesMax: 50, opendir: (async () => big) as never }), '');
  assert.equal(reads, 50);
  assert.equal(await envExampleKeys(['/nonexistent/repo-dir']), '');
});

test('findSecrets', () => {
  assert.deepEqual(findSecrets('a\nToken eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 x'), ['Line 2 may hold a secret (a token)']);
  assert.deepEqual(findSecrets('Password=<your password>\nPwd=\nPassword=${DB_PASS}'), []);
  assert.equal(findSecrets('Server=x;Pwd=s3cr3t;').length, 1);
  assert.equal(findSecrets('ghp_' + 'a'.repeat(30)).length, 1);
  assert.equal(findSecrets('key sk-' + 'b'.repeat(24)).length, 1);
  assert.equal(findSecrets('AKIAABCDEFGHIJKLMNOP').length, 1);
  assert.equal(findSecrets('c'.repeat(8) + '0123456789abcdef'.repeat(3)).length, 1);
  assert.deepEqual(findSecrets('Read the README and run npm test in /Users/me/repo/src/server/kanban/integrations'), []);
  assert.ok(!findSecrets('ghp_' + 'a'.repeat(30)).join().includes('ghp_'));
  assert.deepEqual(findSecrets('PASSWORD=<fill> API_KEY=realSecret123'), ['Line 1 may hold a secret (a password or key)']);
  assert.deepEqual(findSecrets('PASSWORD=<fill> API_KEY=${KEY}'), []);
  for (const line of ['PGPASSWORD=Hunter2Dev pg_dump app', 'POSTGRES_PASSWORD: Hunter2Dev', '"Password": "Hunter2Dev"', 'postgres://app:Hunter2Dev@localhost/app', 'mysql -u root -pHunter2Dev app', 'sqlcmd -S . -U sa -P Hunter2Dev', 'API_SECRET=abc123def'])
    assert.equal(findSecrets(line).length, 1, line);
  assert.deepEqual(findSecrets('DB_PASSWORD=<the password>\nThe password is in appsettings.Development.json (key ConnectionStrings:Default)\nhttps://example.com/docs\nmysql -u root -p app'), []);
});

test('a cancel or a newer request during the search of the repositories starts no agent', async () => {
  const s = setup();
  const a = client();
  // Cancelled before the search (asynchronous) has come back.
  const first = s.go(a, MSG);
  await s.cancel(client(), { t: 'kanban.instructions.draft.cancel', project: 'app', rid: 'c1' });
  await first;
  assert.deepEqual(last(a), { t: 'kanban.error', rid: 'r1', message: 'cancelled' });
  assert.equal(s.calls.length, 0);
  // Replaced by a newer one at the same point: only the newer one runs.
  const old = s.go(a, { ...MSG, rid: 'r2' });
  const newer = s.go(a, { ...MSG, rid: 'r3' });
  await Promise.all([old, newer]);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(a.got.filter((g: any) => g.rid === 'r2'), [{ t: 'kanban.error', rid: 'r2', message: 'cancelled' }]);
  assert.equal((a.got.find((g: any) => g.rid === 'r3') as any).t, 'kanban.instructionsDraft');
});

test('a newer request or the cancel message ends the older run; at most two run at once', async () => {
  const hold = () => new Promise<{ text: string }>(() => {});
  const s = setup({ answer: hold });
  const a = client();
  const first = s.go(a, MSG);
  await started(s, 1);
  const second = s.go(a, { ...MSG, rid: 'r2' });
  await first;
  assert.deepEqual(s.killed, [1]);
  assert.deepEqual(last(a), { t: 'kanban.error', rid: 'r1', message: 'cancelled' });
  await started(s, 2);
  const cancelAck = client();
  await s.cancel(cancelAck, { t: 'kanban.instructions.draft.cancel', project: 'app', rid: 'c1' });
  assert.deepEqual(last(cancelAck), { t: 'kanban.ok', rid: 'c1' });
  await second;
  assert.deepEqual(s.killed, [1, 2]);
  assert.equal(last(a).message, 'cancelled');
  // The cap: two other browsers hold runs, a third is turned away.
  const b = { ...client(), clientId: 'b' };
  const c = { ...client(), clientId: 'c' };
  const d = { ...client(), clientId: 'd' };
  void s.go(b, MSG);
  void s.go(c, MSG);
  await started(s, 4);
  await s.go(d, MSG);
  assert.match(last(d).message, /busy writing instructions/);
  s.p.stop?.();
});
