import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';
import { parseInstructionsDraftMsg } from '../src/shared/kanban/instructionsdraft.js';
import { KANBAN_LIMITS } from '../src/shared/kanban/validate.js';
import { oneShotCommand, runOneShot, type OneShotRun } from '../src/server/kanban/oneshot.js';
import { createInstructionsDraftPlugin, INSTRUCTIONS_DRAFT_MAX, type InstructionsDraftDeps } from '../src/server/kanban/integrations/instructions-draft/index.js';
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
  assert.ok(o.deny?.includes('Read(**/.env.local)') && !o.deny.includes('Read(**/.env.*)'));
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
  for (const line of ['PGPASSWORD=Hunter2Dev pg_dump app', 'POSTGRES_PASSWORD: Hunter2Dev', '"Password": "Hunter2Dev"', 'postgres://app:Hunter2Dev@localhost/app', 'mysql -u root -pHunter2Dev app', 'sqlcmd -S . -U sa -P Hunter2Dev', 'API_SECRET=abc123def'])
    assert.equal(findSecrets(line).length, 1, line);
  assert.deepEqual(findSecrets('DB_PASSWORD=<the password>\nThe password is in appsettings.Development.json (key ConnectionStrings:Default)\nhttps://example.com/docs\nmysql -u root -p app'), []);
});

test('a newer request or the cancel message ends the older run; at most two run at once', async () => {
  const hold = () => new Promise<{ text: string }>(() => {});
  const s = setup({ answer: hold });
  const a = client();
  const first = s.go(a, MSG);
  await new Promise((r) => setImmediate(r));
  const second = s.go(a, { ...MSG, rid: 'r2' });
  await first;
  assert.deepEqual(s.killed, [1]);
  assert.deepEqual(last(a), { t: 'kanban.error', rid: 'r1', message: 'cancelled' });
  await new Promise((r) => setImmediate(r));
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
  await new Promise((r) => setImmediate(r));
  await s.go(d, MSG);
  assert.match(last(d).message, /busy writing instructions/);
  s.p.stop?.();
});
