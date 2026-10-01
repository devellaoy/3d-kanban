import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectRepo, TaskWorkspace } from '../src/shared/kanban/types.js';
import { allOn, checkoutLines, workspaceFingerprint } from '../src/server/kanban/engine/workspace.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });

function fixture() {
  const floor = mkdtempSync(path.join(tmpdir(), 'kanban-ws-'));
  const dir = path.join(floor, 'tree');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const ws = { worktree: { path: 'tree', base: 'main' } } as unknown as TaskWorkspace;
  return { floor, dir, ws, print: () => workspaceFingerprint(floor, ws), done: () => rmSync(floor, { recursive: true, force: true }) };
}

test('the fingerprint holds still without changes and moves with each kind of change', async (t) => {
  const f = fixture();
  t.after(f.done);
  const clean = await f.print();
  assert.ok(clean);
  assert.equal(await f.print(), clean);
  const seen = new Set([clean]);
  const step = async (what: string, act: () => void) => {
    act();
    const now = await f.print();
    assert.ok(now && !seen.has(now), `${what} changed it`);
    seen.add(now);
  };
  await step('a commit', () => git(f.dir, 'commit', '-q', '--allow-empty', '-m', 'empty'));
  await step('an edit of a tracked file', () => writeFileSync(path.join(f.dir, 'a.txt'), 'two\n'));
  await step('a second edit of the same file', () => writeFileSync(path.join(f.dir, 'a.txt'), 'three\n'));
  await step('a new untracked file', () => writeFileSync(path.join(f.dir, 'new.txt'), 'x\n'));
  await step('an edit of that untracked file', () => writeFileSync(path.join(f.dir, 'new.txt'), 'y\n'));
  const before = await f.print();
  writeFileSync(path.join(f.dir, 'ignored.log'), 'noise\n');
  assert.equal(await f.print(), before, 'an ignored file does not count');
});

test('the fingerprint reads the workspace without touching its index or objects', async (t) => {
  const f = fixture();
  t.after(f.done);
  writeFileSync(path.join(f.dir, 'a.txt'), 'edited\n');
  writeFileSync(path.join(f.dir, 'new.txt'), 'x\n');
  const state = () => [git(f.dir, 'status', '--porcelain'), git(f.dir, 'diff', '--cached'), git(f.dir, 'count-objects', '-v')].join('|');
  const before = state();
  assert.ok(await f.print());
  assert.equal(state(), before);
});

test('the fingerprint is undefined when git cannot say', async (t) => {
  const f = fixture();
  t.after(f.done);
  const plain = mkdtempSync(path.join(tmpdir(), 'kanban-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(await workspaceFingerprint(plain, { worktree: { path: '.', base: 'main' } } as unknown as TaskWorkspace), undefined);
  assert.equal(await workspaceFingerprint(f.floor, undefined), undefined);
});

test('untracked symlinks and nested repositories are fingerprinted, and a link target counts', async (t) => {
  const f = fixture();
  t.after(f.done);
  const clean = await f.print();
  symlinkSync('nowhere', path.join(f.dir, 'dangling'));
  const withLink = await f.print();
  assert.ok(withLink && withLink !== clean, 'a dangling link');
  unlinkSync(path.join(f.dir, 'dangling'));
  symlinkSync('.', path.join(f.dir, 'dangling'));
  const retargeted = await f.print();
  assert.ok(retargeted && retargeted !== withLink, 'a changed link target (here a folder)');
  const nested = path.join(f.dir, 'nested');
  mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  git(nested, 'commit', '-q', '--allow-empty', '-m', 'inner');
  const withNested = await f.print();
  assert.ok(withNested && withNested !== retargeted, 'a nested repository');
  git(nested, 'commit', '-q', '--allow-empty', '-m', 'inner two');
  assert.notEqual(await f.print(), withNested);
});

test('edits inside an untracked nested repository change the fingerprint', async (t) => {
  const f = fixture();
  t.after(f.done);
  const nested = path.join(f.dir, 'nested');
  mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(nested, 'n.txt'), 'one\n');
  git(nested, 'add', '.');
  git(nested, 'commit', '-q', '-m', 'inner');
  const clean = await f.print();
  assert.ok(clean);
  writeFileSync(path.join(nested, 'n.txt'), 'two\n');
  const edited = await f.print();
  assert.ok(edited && edited !== clean, 'an uncommitted edit of a tracked file');
  writeFileSync(path.join(nested, 'extra.txt'), 'x\n');
  const added = await f.print();
  assert.ok(added && added !== edited, 'an untracked file');
});

test('an unreadable untracked file leaves the fingerprint undefined', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const f = fixture();
  t.after(f.done);
  const file = path.join(f.dir, 'secret.txt');
  writeFileSync(file, 'x\n');
  chmodSync(file, 0);
  try {
    assert.equal(await f.print(), undefined);
  } finally {
    chmodSync(file, 0o644);
  }
});

test('a fingerprint that takes too long is undefined', async (t) => {
  const f = fixture();
  t.after(f.done);
  writeFileSync(path.join(f.dir, 'big.bin'), Buffer.alloc(32 * 1024 * 1024, 1));
  assert.equal(await workspaceFingerprint(f.floor, f.ws, 1), undefined);
  assert.ok(await f.print());
});

test('a checked-out submodule is fingerprinted: its edits and untracked files count', async (t) => {
  const f = fixture();
  t.after(f.done);
  const other = mkdtempSync(path.join(tmpdir(), 'kanban-sub-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(other, 's.txt'), 'one\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'sub');
  git(f.dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', other, 'sub');
  git(f.dir, 'commit', '-q', '-m', 'add the submodule');
  const clean = await f.print();
  writeFileSync(path.join(f.dir, 'sub', 's.txt'), 'two\n');
  const dirty = await f.print();
  assert.ok(clean && dirty && dirty !== clean, 'a dirty submodule');
  writeFileSync(path.join(f.dir, 'sub', 's.txt'), 'three\n');
  const more = await f.print();
  assert.ok(more && more !== dirty, 'a further edit');
  writeFileSync(path.join(f.dir, 'sub', 'new.txt'), 'x\n');
  const added = await f.print();
  assert.ok(added && added !== more, 'an untracked file in it');
});

function checkout(root: string, rel: string, branch: string) {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });
}

const repo = (id: string, primary = false): ProjectRepo => ({ id, name: id, kind: 'git', dir: `/${id}`, primary });

test('allOn: a repository with no worktree in the workspace is left out, not false forever', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-allon-'));
  checkout(root, 'wt/web', 'feature/x');
  const ws = { worktree: { path: 'wt/web', branch: 'feature/x' } } as TaskWorkspace;
  assert.equal(await allOn(root, ws, [{ r: repo('web', true), b: 'feature/x' }, { r: repo('api'), b: 'feature/x' }]), true, 'api was added after the workspace was made');
  assert.equal(await allOn(root, ws, [{ r: repo('web', true), b: 'other' }, { r: repo('api'), b: 'feature/x' }]), false);
  checkout(root, 'wt/api', 'main');
  const both = { ...ws, repos: [{ name: 'api', path: 'wt/api' }] } as TaskWorkspace;
  assert.equal(await allOn(root, both, [{ r: repo('web', true), b: 'feature/x' }, { r: repo('api'), b: 'feature/x' }]), false, 'one that has a worktree is still asked');
});

test('checkoutLines: fixing, only the repositories with a PR branch or a branch of their own are listed; the task branch is the fallback, never another repository\'s PR branch', async () => {
  const repos = [repo('web', true), repo('api')];
  const task = { branch: undefined, workspace: undefined };
  assert.equal(await checkoutLines('/x', task, repos, { api: 'fix/it' }, true, true, true), '- api: `fix/it`');
  assert.equal(await checkoutLines('/x', task, repos, {}, true, false, true), undefined, 'nothing to check out');
  assert.equal(await checkoutLines('/x', { ...task, branch: 'own' }, repos, {}, true, false, true), '- web: `own`\n- api: `own`');
  assert.equal(await checkoutLines('/x', { ...task, branch: 'own' }, repos, { api: 'fix/it' }, false, false, true), '- web: `own`\n- api: `fix/it`', 'not fixing: every repository');
});
