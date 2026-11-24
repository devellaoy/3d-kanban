import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROMPTS } from '../src/shared/prompts.js';
import type { FloorDef } from '../src/server/building.js';
import { installKanban } from '../src/server/kanban/index.js';
import type { KanbanEngine } from '../src/server/kanban/engine/index.js';
import { instructionsDir, projectInstructionTexts, pruneInstructionDirs, syncInstructionFiles } from '../src/server/kanban/instructions.js';

function files(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-instructions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the folder and the parts are written with the trimmed text and a newline, read-only', (t) => {
  const root = files(t);
  const got = syncInstructionFiles(root, 'web', { general: '  Be kind.\n\n', testing: 'Run it.', repos: [{ id: 'api', instructions: 'Use X' }, { id: 'docs' }] });
  const dir = instructionsDir(root, 'web');
  assert.equal(got.dir, dir);
  assert.equal(got.general, path.join(dir, 'general.md'));
  assert.equal(readFileSync(got.general!, 'utf8'), 'Be kind.\n');
  assert.equal(readFileSync(got.testing!, 'utf8'), 'Run it.\n');
  assert.deepEqual(got.repos, { api: path.join(dir, 'repo-api.md') });
  assert.equal(readFileSync(got.repos.api, 'utf8'), 'Use X\n');
  if (process.platform !== 'win32') assert.equal(statSync(got.general!).mode & 0o777, 0o444);
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('with no instructions the folder still exists and no path is returned', (t) => {
  const root = files(t);
  const got = syncInstructionFiles(root, 'web', {});
  assert.ok(existsSync(got.dir));
  assert.deepEqual(got, { dir: got.dir, repos: {} });
});

test('the same text is not written again, a changed one is (although the file is read-only), a blank one removes the file', (t) => {
  const root = files(t);
  const file = syncInstructionFiles(root, 'web', { general: 'one' }).general!;
  const ino = statSync(file).ino, at = statSync(file).mtimeMs;
  assert.equal(syncInstructionFiles(root, 'web', { general: ' one ' }).general, file);
  assert.equal(statSync(file).ino, ino);
  assert.equal(statSync(file).mtimeMs, at);
  assert.equal(syncInstructionFiles(root, 'web', { general: 'two' }).general, file);
  assert.equal(readFileSync(file, 'utf8'), 'two\n');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o444);
  assert.equal(syncInstructionFiles(root, 'web', { general: ' \n\t' }).general, undefined);
  assert.ok(!existsSync(file));
});

test("a repository's file goes when the repository does or its text is blanked", (t) => {
  const root = files(t);
  const dir = instructionsDir(root, 'web');
  syncInstructionFiles(root, 'web', { repos: [{ id: 'api', instructions: 'a' }, { id: 'ui', instructions: 'u' }] });
  assert.ok(existsSync(path.join(dir, 'repo-api.md')) && existsSync(path.join(dir, 'repo-ui.md')));
  syncInstructionFiles(root, 'web', { repos: [{ id: 'api', instructions: 'a' }] });
  assert.ok(!existsSync(path.join(dir, 'repo-ui.md')));
  syncInstructionFiles(root, 'web', { repos: [{ id: 'api', instructions: '  ' }] });
  assert.ok(!existsSync(path.join(dir, 'repo-api.md')));
});

test('pruneInstructionDirs removes the folders of projects that are gone, and only those', (t) => {
  const root = files(t);
  for (const id of ['a', 'b', 'c']) syncInstructionFiles(root, id, { general: id });
  pruneInstructionDirs(root, ['c']);
  assert.ok(!existsSync(instructionsDir(root, 'a')));
  assert.ok(!existsSync(instructionsDir(root, 'b')));
  assert.ok(existsSync(instructionsDir(root, 'c')));
  pruneInstructionDirs(path.join(root, 'no-such'), ['c']);
});

test("a part that can't be written is left out and the others still are; nothing throws", (t) => {
  const root = files(t);
  const dir = instructionsDir(root, 'web');
  mkdirSync(path.join(dir, 'general.md'), { recursive: true });
  writeFileSync(path.join(dir, 'general.md', 'x'), 'in the way');
  const got = syncInstructionFiles(root, 'web', { general: 'blocked', testing: 'fine', repos: [{ id: 'api', instructions: 'ok' }] });
  assert.equal(got.general, undefined);
  assert.equal(readFileSync(got.testing!, 'utf8'), 'fine\n');
  assert.ok(got.repos.api);
  // The folder itself can't be made: no paths at all.
  writeFileSync(path.join(root, 'instructions-file'), '');
  const none = syncInstructionFiles(path.join(root, 'instructions-file'), 'web', { general: 'x' });
  assert.deepEqual(none.repos, {});
  assert.equal(none.general, undefined);
});

test('ids that could leave the folder are refused', (t) => {
  const root = files(t);
  const bad = syncInstructionFiles(root, '../escape', { general: 'x' });
  assert.equal(bad.general, undefined);
  assert.ok(!existsSync(path.join(root, 'escape')));
  const got = syncInstructionFiles(root, 'web', { repos: [{ id: '../x', instructions: 'a' }, { id: 'A', instructions: 'a' }, { id: 'ok-1', instructions: 'a' }] });
  assert.deepEqual(Object.keys(got.repos), ['ok-1']);
});

test("projectInstructionTexts reads the project's settings and every repository", () => {
  const ctx = {
    settings: { project: (id: string) => ({ generalInstructions: `g-${id}`, testingInstructions: 't' }) },
    repos: () => [{ id: 'web', instructions: 'p' }, { id: 'api' }],
  } as never;
  assert.deepEqual(projectInstructionTexts(ctx, 'web'), { general: 'g-web', testing: 't', repos: [{ id: 'web', instructions: 'p' }, { id: 'api', instructions: undefined }] });
});

test('an installed kanban keeps the files in step with the settings, the repositories and the floors', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-instructions-office-'));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const defs: FloorDef[] = [{ id: 'web', name: 'web', dir: root, palette: 0, addedBy: 'Sam', addedAt: 1 }];
  const no = async () => undefined;
  const engine = { start: no, stop: no, continue: no, retry: no, review: no, approvePlan: no, requestPlanChanges: no, pr: no, sendWorkersHome: no, prForWorker: no, commented: async () => {}, begin() {}, dispose() {} } as KanbanEngine;
  // A stale folder of a project that is gone is pruned when the kanban opens.
  const stale = instructionsDir(path.join(dataDir, 'kanban'), 'gone');
  mkdirSync(stale, { recursive: true });
  const kanban = installKanban({
    dataDir,
    floors: () => defs,
    floor: () => undefined,
    saveRepos: (id, repos) => {
      defs[0] = { ...defs[0], repos };
      return defs[0];
    },
    officePrompts: () => ({}),
    officeText: (id: keyof typeof PROMPTS) => PROMPTS[id].text,
    languages: () => ({}),
    hookUrl: 'http://127.0.0.1:9',
    toast: () => {},
    createEngine: () => engine,
    plugins: [],
  });
  t.after(() => {
    kanban.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const dir = instructionsDir(kanban.ctx.filesDir, 'web');
  assert.ok(existsSync(dir), 'every project has its folder from the start');
  assert.ok(!existsSync(stale), 'and a removed project does not');
  assert.equal(typeof kanban.ctx.settings.setProject('web', { generalInstructions: 'Be kind.', testingInstructions: 'Run it.' }), 'object');
  assert.equal(readFileSync(path.join(dir, 'general.md'), 'utf8'), 'Be kind.\n');
  assert.equal(readFileSync(path.join(dir, 'testing.md'), 'utf8'), 'Run it.\n');
  const sub = path.join(root, 'api');
  mkdirSync(sub);
  const primary = { id: 'web', name: 'web', kind: 'folder' as const, dir: root, primary: true, instructions: 'Primary rules' };
  assert.equal(kanban.ctx.setRepos('web', [primary, { id: 'api', name: 'api', kind: 'folder', dir: sub, primary: false, instructions: 'Api rules' }]), undefined);
  assert.equal(readFileSync(path.join(dir, 'repo-api.md'), 'utf8'), 'Api rules\n');
  assert.equal(readFileSync(path.join(dir, 'repo-web.md'), 'utf8'), 'Primary rules\n');
  assert.equal(kanban.ctx.setRepos('web', [primary]), undefined);
  assert.ok(!existsSync(path.join(dir, 'repo-api.md')), 'a removed repository takes its file');
  kanban.ctx.settings.setProject('web', { generalInstructions: '' });
  assert.ok(!existsSync(path.join(dir, 'general.md')));
  defs.push({ id: 'new', name: 'new', dir: root, palette: 1, addedBy: 'Sam', addedAt: 2 });
  kanban.projectsChanged();
  assert.ok(existsSync(instructionsDir(kanban.ctx.filesDir, 'new')), 'a new floor gets its folder');
  defs.pop();
  kanban.projectsChanged();
  assert.ok(!existsSync(instructionsDir(kanban.ctx.filesDir, 'new')), 'and loses it with the floor');
});

test("a primary repository's id is its project's, which may be longer than another repository's", (t) => {
  const root = files(t);
  const id = 'a-project-with-quite-a-long-name-0123456'; // 40 characters
  assert.equal(id.length, 40);
  const got = syncInstructionFiles(root, id, { repos: [{ id, instructions: 'Run make check.' }] });
  assert.equal(got.repos[id], path.join(instructionsDir(root, id), `repo-${id}.md`));
  assert.equal(readFileSync(got.repos[id], 'utf8'), 'Run make check.\n');
});

test("a link where a file belongs is replaced, and what it points at keeps its text and its mode", { skip: process.platform === 'win32' }, (t) => {
  const root = files(t);
  const dir = instructionsDir(root, 'web');
  mkdirSync(dir, { recursive: true });
  const secret = path.join(root, 'secret.txt');
  writeFileSync(secret, 'private', { mode: 0o600 });
  symlinkSync(secret, path.join(dir, 'general.md'));
  const got = syncInstructionFiles(root, 'web', { general: 'Be kind.' });
  assert.ok(lstatSync(got.general!).isFile(), 'a file of its own now');
  assert.equal(readFileSync(got.general!, 'utf8'), 'Be kind.\n');
  assert.equal(readFileSync(secret, 'utf8'), 'private');
  assert.equal(statSync(secret).mode & 0o777, 0o600);
});
