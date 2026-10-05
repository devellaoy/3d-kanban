import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prune } from '../src/server/prune.js';
import { ensureHome, officeOfWorktree, worktreeHomes, worktreesHome } from '../src/server/worktree-home.js';
import { Worktrees } from '../src/server/worktrees.js';

// New worktrees live beside the project, in <project>.worktrees/, linked to the project's node_modules;
// the ones older offices made in <project>/.agent-office/worktrees keep working.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(dir: string, gitignore = 'node_modules/\n'): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, '.gitignore'), gitignore);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** A temp folder with the repository in a subfolder of it, so the sibling .worktrees goes with the folder. */
function fixture(t: { after(fn: () => void): void }, name = 'proj') {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = repo(path.join(root, name));
  mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x\n');
  return { root, dir };
}

test('worktreesHome is beside the folder as given, and officeOfWorktree reads both homes back', () => {
  assert.equal(worktreesHome('/a/b/proj'), '/a/b/proj.worktrees');
  assert.deepEqual(worktreeHomes('/a/b/proj'), ['/a/b/proj.worktrees', '/a/b/proj/.agent-office/worktrees']);
  assert.equal(officeOfWorktree('/a/b/proj.worktrees/slug'), '/a/b/proj');
  assert.equal(officeOfWorktree('/a/b/proj.worktrees/slug/api'), '/a/b/proj');
  assert.equal(officeOfWorktree('/a/b/proj/.agent-office/worktrees/slug/api'), '/a/b/proj');
  assert.equal(officeOfWorktree('/a/b/proj.worktrees'), undefined);
  assert.equal(officeOfWorktree('/a/b/proj'), undefined);
  // A floor that is a worktree itself: the innermost home counts.
  assert.equal(officeOfWorktree('/a/proj.worktrees/x/x.worktrees/y'), '/a/proj.worktrees/x/x');
});

test('create puts the worktree in the sibling folder and links node_modules, which git ignores', async (t) => {
  const { root, dir } = fixture(t);
  const trees = new Worktrees(dir);
  const made = trees.create('pip-1');
  assert.equal(typeof made, 'object', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.path, path.join('..', 'proj.worktrees', 'pip-1'));
  const wt = path.join(dir, made.path);
  assert.ok(existsSync(path.join(root, 'proj.worktrees', 'pip-1', 'a.txt')));
  assert.ok(lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  assert.equal(realpathSync(path.join(wt, 'node_modules')), realpathSync(path.join(dir, 'node_modules')));
  assert.ok(existsSync(path.join(wt, 'node_modules', 'dep', 'index.js')));
  // `node_modules/` in the .gitignore doesn't match a symlink: the office ignores the link itself.
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('create and list give the same path, even when the folder is reached through a symlink', async (t) => {
  const { root, dir } = fixture(t);
  const link = path.join(root, 'link');
  symlinkSync(dir, link);
  const trees = new Worktrees(link);
  const made = trees.create('pip-2');
  assert.equal(typeof made, 'object', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.path, path.join('..', 'link.worktrees', 'pip-2'));
  const listed = await trees.list();
  assert.deepEqual(listed.worktrees.map((w) => w.path), [made.path]);
  assert.deepEqual(listed.strays, []);
  assert.equal(existsSync(path.join(link, made.path, 'a.txt')), true);
  assert.equal(trees.owns(path.join(link, made.path)), true);
});

test('list and owns see worktrees in both homes, and strays in either', async (t) => {
  const { root, dir } = fixture(t);
  const trees = new Worktrees(dir);
  assert.equal(typeof trees.create('new-1'), 'object');
  // One of an older office: inside the project.
  const old = path.join(dir, '.agent-office', 'worktrees', 'old-1');
  git(dir, 'worktree', 'add', '-q', '-b', 'office/old-1', old);
  mkdirSync(path.join(root, 'proj.worktrees', 'stray-new'));
  mkdirSync(path.join(dir, '.agent-office', 'worktrees', 'stray-old'));
  const listed = await trees.list();
  assert.deepEqual(listed.worktrees.map((w) => [w.path, w.branch]).sort(), [
    [path.join('..', 'proj.worktrees', 'new-1'), 'office/new-1'],
    [path.join('.agent-office', 'worktrees', 'old-1'), 'office/old-1'],
  ].sort());
  assert.deepEqual(listed.strays.sort(), [path.join('..', 'proj.worktrees', 'stray-new'), path.join('.agent-office', 'worktrees', 'stray-old')].sort());
  assert.equal(trees.owns(path.join(root, 'proj.worktrees', 'new-1')), true);
  assert.equal(trees.owns(old), true);
  assert.equal(trees.owns(dir), false);
  assert.equal(trees.owns(path.join(root, 'proj.worktrees')), false);
  // The old one is taken out as before.
  assert.equal(await trees.remove({ path: path.join('.agent-office', 'worktrees', 'old-1'), branch: 'office/old-1' }, 'all'), undefined);
  assert.equal(existsSync(old), false);
});

test('remove never follows the node_modules link into the project', async (t) => {
  const { dir } = fixture(t);
  const trees = new Worktrees(dir);
  const made = trees.create('pip-3');
  assert.equal(typeof made, 'object', String(made));
  if (typeof made === 'string') return;
  assert.equal(await trees.remove(made, 'all'), undefined);
  assert.equal(existsSync(path.join(dir, made.path)), false);
  assert.equal(readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x\n');
});

test('restore puts the worktree back with its node_modules link', async (t) => {
  const { dir } = fixture(t);
  const trees = new Worktrees(dir);
  const made = trees.create('pip-4');
  if (typeof made === 'string') return assert.fail(made);
  const abs = path.join(dir, made.path);
  rmSync(abs, { recursive: true, force: true });
  assert.deepEqual(await trees.restore(made), { from: 'here' });
  assert.equal(readlinkSync(path.join(abs, 'node_modules')), path.join(dir, 'node_modules'));
});

test('a repository without node_modules gets no link', (t) => {
  const { dir } = fixture(t);
  rmSync(path.join(dir, 'node_modules'), { recursive: true });
  const made = new Worktrees(dir).create('pip-5');
  if (typeof made === 'string') return assert.fail(made);
  assert.equal(existsSync(path.join(dir, made.path, 'node_modules')), false);
});

test('prune does not take a worktree straight in the new home for an emptied workspace', async (t) => {
  const { root, dir } = fixture(t);
  assert.equal(typeof new Worktrees(dir).create('pip-6'), 'object');
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    assert.equal(await prune([dir]), 0);
  } finally {
    console.log = log;
  }
  const out = lines.join('\n');
  assert.match(out, /removed\s+office\/pip-6/);
  assert.doesNotMatch(out, /empty workspace/);
  assert.ok(existsSync(path.join(root, 'proj.worktrees')), 'the home itself stays');
  assert.equal(existsSync(path.join(root, 'proj.worktrees', 'pip-6')), false);
});

test('ensureHome makes the folder, and a floor nested in another repository has it ignored there', (t) => {
  const { root } = fixture(t, 'mono');
  const mono = path.join(root, 'mono');
  const floor = path.join(mono, 'packages', 'app');
  mkdirSync(floor, { recursive: true });
  const home = ensureHome(floor);
  assert.equal(home, path.join(mono, 'packages', 'app.worktrees'));
  assert.ok(existsSync(home));
  const exclude = () => readFileSync(path.join(mono, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude(), /^\/packages\/app\.worktrees\/$/m);
  ensureHome(floor);
  assert.equal(exclude().split('\n').filter((l) => l === '/packages/app.worktrees/').length, 1);
  writeFileSync(path.join(home, 'x.txt'), 'x\n');
  assert.equal(git(mono, 'status', '--porcelain', '-uall'), '');
});

test('create says so when the folder beside the project can not be made', (t) => {
  const { root, dir } = fixture(t);
  // Something in the way: a file where the folder should be.
  writeFileSync(path.join(root, 'proj.worktrees'), 'not a folder\n');
  const made = new Worktrees(dir).create('pip-7');
  assert.equal(typeof made, 'string');
  assert.match(String(made), /proj\.worktrees/);
});
