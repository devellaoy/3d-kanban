import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TaskWorkspace } from '../src/shared/kanban/types.js';
import { workspaceFingerprint } from '../src/server/kanban/engine/workspace.js';

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
