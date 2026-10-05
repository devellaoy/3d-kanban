import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** A package folder in a repository's node_modules, with `scope` for @scope/name. */
function pkg(dir: string, name: string, body = 'x\n') {
  mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', name, 'index.js'), body);
}

test('create puts the worktree in the sibling folder, with node_modules made of links to the project\'s packages', async (t) => {
  const { root, dir } = fixture(t);
  pkg(dir, '@types/node', 'types\n');
  mkdirSync(path.join(dir, 'node_modules', '.bin'));
  symlinkSync('../dep/index.js', path.join(dir, 'node_modules', '.bin', 'dep'));
  writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}\n');
  const trees = new Worktrees(dir);
  const made = trees.create('pip-1');
  assert.equal(typeof made, 'object', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.path, path.join('..', 'proj.worktrees', 'pip-1'));
  const wt = path.join(dir, made.path);
  assert.ok(existsSync(path.join(root, 'proj.worktrees', 'pip-1', 'a.txt')));
  assert.equal(existsSync(path.join(root, 'proj.worktrees', 'node_modules')), false, 'no link in the home');
  const nm = path.join(wt, 'node_modules');
  assert.ok(lstatSync(nm).isDirectory() && !lstatSync(nm).isSymbolicLink(), 'a real folder');
  assert.ok(lstatSync(path.join(nm, 'dep')).isSymbolicLink());
  assert.equal(readFileSync(path.join(nm, 'dep', 'index.js'), 'utf8'), 'x\n');
  // A scope is a real folder with a link per package: npm writes through a linked one.
  assert.ok(lstatSync(path.join(nm, '@types')).isDirectory() && !lstatSync(path.join(nm, '@types')).isSymbolicLink());
  assert.ok(lstatSync(path.join(nm, '@types', 'node')).isSymbolicLink());
  assert.equal(readFileSync(path.join(nm, '@types', 'node', 'index.js'), 'utf8'), 'types\n');
  assert.ok(!lstatSync(path.join(nm, '.bin')).isSymbolicLink());
  assert.ok(lstatSync(path.join(nm, '.bin', 'dep')).isSymbolicLink());
  assert.equal(existsSync(path.join(nm, '.package-lock.json')), false);
  // Ignored by the project's `node_modules/` line.
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a worktree of a repository whose .gitignore does not mention node_modules has it excluded', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = repo(path.join(root, 'bare'), '');
  pkg(dir, 'dep');
  const made = new Worktrees(dir).create('pip-9');
  if (typeof made === 'string') return assert.fail(made);
  assert.equal(git(path.join(dir, made.path), 'status', '--porcelain'), '');
});

test('each repository of a workspace gives its worktree its own node_modules', (t) => {
  const { root, dir: web } = fixture(t, 'web');
  const api = repo(path.join(root, 'api'));
  pkg(web, 'only-web', 'web\n');
  pkg(api, 'only-api', 'api\n');
  const a = new Worktrees(web).create('ws-1', 'web');
  const b = new Worktrees(api).create('ws-1', 'api', web);
  if (typeof a === 'string' || typeof b === 'string') return assert.fail(String(typeof a === 'string' ? a : b));
  const nm = (name: string) => path.join(root, 'web.worktrees', 'ws-1', name, 'node_modules');
  assert.deepEqual(readdirSync(nm('web')).filter((n) => n !== 'dep'), ['only-web']);
  assert.deepEqual(readdirSync(nm('api')), ['only-api']);
  assert.equal(readFileSync(path.join(nm('api'), 'only-api', 'index.js'), 'utf8'), 'api\n');
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
  // Folders and worktrees people keep in the new home themselves aren't the office's.
  mkdirSync(path.join(root, 'proj.worktrees', 'notes'));
  git(dir, 'worktree', 'add', '-q', '-b', 'feature', path.join(root, 'proj.worktrees', 'mine'));
  mkdirSync(path.join(dir, '.agent-office', 'worktrees', 'stray-old'));
  const listed = await trees.list();
  assert.deepEqual(listed.worktrees.map((w) => [w.path, w.branch]).sort(), [
    [path.join('..', 'proj.worktrees', 'new-1'), 'office/new-1'],
    [path.join('.agent-office', 'worktrees', 'old-1'), 'office/old-1'],
  ].sort());
  assert.deepEqual(listed.strays, [path.join('.agent-office', 'worktrees', 'stray-old')]);
  assert.equal(trees.owns(path.join(root, 'proj.worktrees', 'new-1')), true);
  assert.equal(trees.owns(old), true);
  assert.equal(trees.owns(dir), false);
  assert.equal(trees.owns(path.join(root, 'proj.worktrees')), false);
  // The old one is taken out as before.
  assert.equal(await trees.remove({ path: path.join('.agent-office', 'worktrees', 'old-1'), branch: 'office/old-1' }, 'all'), undefined);
  assert.equal(existsSync(old), false);
});

test('remove leaves the project node_modules alone, through git and through the rm fallback', async (t) => {
  const { dir } = fixture(t);
  const trees = new Worktrees(dir);
  const check = () => assert.equal(readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x\n');
  const made = trees.create('pip-3');
  if (typeof made === 'string') return assert.fail(made);
  assert.equal(await trees.remove(made, 'all'), undefined);
  assert.equal(existsSync(path.join(dir, made.path)), false);
  check();
  // Git refuses (a lock): the office takes the folder out itself, which never follows links either.
  const locked = trees.create('pip-3b');
  if (typeof locked === 'string') return assert.fail(locked);
  git(dir, 'worktree', 'lock', path.join(dir, locked.path));
  assert.equal(await trees.remove(locked, 'worktree'), undefined);
  assert.equal(existsSync(path.join(dir, locked.path)), false);
  check();
});

test('restore puts the worktree back, with its node_modules, even when the whole home was deleted', async (t) => {
  const { root, dir } = fixture(t);
  const trees = new Worktrees(dir);
  const made = trees.create('pip-4');
  if (typeof made === 'string') return assert.fail(made);
  rmSync(path.join(root, 'proj.worktrees'), { recursive: true, force: true });
  assert.deepEqual(await trees.restore(made), { from: 'here' });
  const abs = path.join(dir, made.path);
  assert.ok(existsSync(path.join(abs, 'a.txt')));
  assert.equal(readFileSync(path.join(abs, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x\n');
});

test('a project whose node_modules is itself a link gives its worktree the packages it links to', (t) => {
  const { root, dir } = fixture(t);
  // The real install lives elsewhere (a shared or cached one), the project only links to it.
  const store = path.join(root, 'store');
  mkdirSync(path.join(store, 'linked-dep'), { recursive: true });
  writeFileSync(path.join(store, 'linked-dep', 'index.js'), 'linked\n');
  rmSync(path.join(dir, 'node_modules'), { recursive: true });
  symlinkSync(store, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const made = new Worktrees(dir).create('pip-6');
  if (typeof made === 'string') return assert.fail(made);
  const nm = path.join(dir, made.path, 'node_modules');
  assert.ok(!lstatSync(nm).isSymbolicLink(), 'a real folder');
  assert.equal(readFileSync(path.join(nm, 'linked-dep', 'index.js'), 'utf8'), 'linked\n');
});

test('a linked package is the project\'s: npm rebuild in the worktree runs its scripts in the project\'s copy', (t) => {
  const { dir } = fixture(t);
  // A package with an install script that writes into its own folder, as a native build does.
  pkg(dir, 'native-dep');
  writeFileSync(
    path.join(dir, 'node_modules', 'native-dep', 'package.json'),
    JSON.stringify({ name: 'native-dep', version: '1.0.0', scripts: { install: 'node -e "require(\'fs\').writeFileSync(\'built.txt\', \'built\')"' } }),
  );
  const made = new Worktrees(dir).create('pip-7');
  if (typeof made === 'string') return assert.fail(made);
  const wt = path.join(dir, made.path);
  writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'wt', version: '1.0.0', dependencies: { 'native-dep': '1.0.0' } }));
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['rebuild', '--foreground-scripts', '--no-audit', '--no-fund'], { cwd: wt, stdio: 'ignore', shell: process.platform === 'win32' });
  // Shared, not copied (see linkNodeModules): the script's output lands in the project's package...
  assert.equal(readFileSync(path.join(dir, 'node_modules', 'native-dep', 'built.txt'), 'utf8'), 'built');
  // ...while the worktree keeps its own folder of links, and the project's other packages are untouched.
  assert.ok(!lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  assert.ok(lstatSync(path.join(wt, 'node_modules', 'native-dep')).isSymbolicLink());
  assert.equal(readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x\n');
});

test('a repository without node_modules gives its worktree none', (t) => {
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

test('prune leaves the user\'s own worktrees and folders there alone, even with --force', async (t) => {
  const { root, dir } = fixture(t);
  const home = path.join(root, 'proj.worktrees');
  assert.equal(typeof new Worktrees(dir).create('pip-8'), 'object');
  mkdirSync(path.join(home, 'notes'));
  writeFileSync(path.join(home, 'notes', 'todo.md'), 'keep\n');
  git(dir, 'worktree', 'add', '-q', '-b', 'feature', path.join(home, 'mine'));
  git(dir, 'worktree', 'add', '-q', '--detach', path.join(home, 'loose'));
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await prune([dir, '--force']), 0);
  } finally {
    console.log = log;
  }
  assert.equal(existsSync(path.join(home, 'pip-8')), false, "the office's own goes");
  assert.ok(existsSync(path.join(home, 'mine', 'a.txt')));
  assert.ok(existsSync(path.join(home, 'loose', 'a.txt')));
  assert.equal(readFileSync(path.join(home, 'notes', 'todo.md'), 'utf8'), 'keep\n');
  assert.match(git(dir, 'branch', '--list', 'feature'), /feature/);
  assert.ok(existsSync(path.join(dir, 'node_modules', 'dep', 'index.js')));
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

test('create says so, naming the folder, when the one beside the project can not be made', (t) => {
  const { root, dir } = fixture(t);
  // Something in the way: a file where the folder should be.
  writeFileSync(path.join(root, 'proj.worktrees'), 'not a folder\n');
  const made = new Worktrees(dir).create('pip-7');
  assert.match(String(made), /^Could not create a git worktree: can't make .*proj\.worktrees for the worktrees/);
  assert.equal(git(dir, 'branch', '--list', 'office/*'), '');
});
