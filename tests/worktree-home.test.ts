import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prune } from '../src/server/prune.js';
import { ensureHome, linkNodeModules, linkNodeModulesAsync, officeOfWorktree, worktreeHomes, worktreesHome } from '../src/server/worktree-home.js';
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-home-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = repo(path.join(root, name));
  mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x\n');
  return { root, dir };
}

test('worktreesHome is beside the real folder; officeOfWorktree names a floor only when it is one', (t) => {
  const { root, dir } = fixture(t);
  assert.equal(worktreesHome(dir), path.join(root, 'proj.worktrees'));
  assert.deepEqual(worktreeHomes(dir), [path.join(root, 'proj.worktrees'), path.join(dir, '.agent-office', 'worktrees')]);
  mkdirSync(path.join(dir, '.agent-office'));
  assert.equal(officeOfWorktree(path.join(root, 'proj.worktrees', 'slug')), dir);
  assert.equal(officeOfWorktree(path.join(root, 'proj.worktrees', 'slug', 'api')), dir);
  assert.equal(officeOfWorktree(path.join(dir, '.agent-office', 'worktrees', 'slug', 'api')), dir);
  assert.equal(officeOfWorktree(path.join(root, 'proj.worktrees')), undefined);
  assert.equal(officeOfWorktree(dir), undefined);
  // Someone's own `<name>.worktrees` isn't an office's: nothing named code has an .agent-office.
  assert.equal(officeOfWorktree(path.join(root, 'code.worktrees', 'review')), undefined);
  // A floor that is a worktree itself: the innermost home counts.
  const inner = path.join(root, 'proj.worktrees', 'x');
  mkdirSync(path.join(inner, '.agent-office'), { recursive: true });
  assert.equal(officeOfWorktree(path.join(root, 'proj.worktrees', 'x.worktrees', 'y')), inner);
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
  // The same whichever way the floor is spelled: its real name, not the link's.
  assert.equal(made.path, path.join('..', 'proj.worktrees', 'pip-2'));
  assert.equal(worktreesHome(link), worktreesHome(dir));
  const listed = await trees.list();
  assert.deepEqual(listed.worktrees.map((w) => w.path), [made.path]);
  assert.deepEqual(listed.strays, []);
  assert.equal(existsSync(path.join(link, made.path, 'a.txt')), true);
  // Asked the other way: inspect, list, owns and restore through the real path agree.
  const direct = new Worktrees(dir);
  assert.equal((await direct.inspect(made)).exists, true);
  assert.deepEqual((await direct.list()).worktrees.map((w) => w.path), [made.path]);
  assert.equal(direct.owns(path.join(link, made.path), made), true);
  rmSync(path.join(dir, made.path), { recursive: true });
  assert.deepEqual(await direct.restore(made), { from: 'here' });
  assert.equal(existsSync(path.join(link, made.path, 'a.txt')), true);
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
  const mine = { path: path.join('..', 'proj.worktrees', 'new-1'), branch: 'office/new-1' };
  const oldRef = { path: path.join('.agent-office', 'worktrees', 'old-1'), branch: 'office/old-1' };
  assert.equal(trees.owns(path.join(root, 'proj.worktrees', 'new-1'), mine), true);
  assert.equal(trees.owns(old, oldRef), true);
  assert.equal(trees.owns(dir, mine), false);
  assert.equal(trees.owns(path.join(root, 'proj.worktrees'), mine), false);
  // In the new home only the folder of the office's slug is the office's.
  assert.equal(trees.owns(path.join(root, 'proj.worktrees', 'notes'), mine), false);
  assert.equal(trees.owns(path.join(root, 'proj.worktrees', 'new-1', 'api'), mine), true);
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
  assert.equal(home, path.join(realpathSync(mono), 'packages', 'app.worktrees'));
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

test('remove does not rm a folder of the user\'s in the new home, whatever the ref says', async (t) => {
  const { root, dir } = fixture(t);
  const home = path.join(root, 'proj.worktrees');
  mkdirSync(path.join(home, 'notes'), { recursive: true });
  writeFileSync(path.join(home, 'notes', 'todo.md'), 'keep\n');
  const err = await new Worktrees(dir).remove({ path: path.join('..', 'proj.worktrees', 'notes'), branch: 'office/other' }, 'worktree');
  assert.equal(typeof err, 'string');
  assert.equal(readFileSync(path.join(home, 'notes', 'todo.md'), 'utf8'), 'keep\n');
});

test('prune keeps an office/* branch checked out in a folder that is not an office\'s', async (t) => {
  const { root, dir } = fixture(t);
  const theirs = path.join(root, 'code.worktrees', 'review');
  git(dir, 'worktree', 'add', '-q', '-b', 'office/hand-made', theirs);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    assert.equal(await prune([dir, '--force']), 0);
  } finally {
    console.log = log;
  }
  assert.ok(existsSync(path.join(theirs, 'a.txt')));
  assert.match(git(dir, 'branch', '--list', 'office/hand-made'), /office\/hand-made/);
  assert.match(lines.join('\n'), /kept\s+office\/hand-made\s+checked out at/);
});

test('a detached office worktree in the new home is listed, and prune does not delete its branch from under it', async (t) => {
  const { dir } = fixture(t);
  const made = new Worktrees(dir).create('pip-10');
  if (typeof made === 'string') return assert.fail(made);
  const abs = path.join(dir, made.path);
  git(abs, 'checkout', '-q', '--detach');
  writeFileSync(path.join(abs, 'wip.txt'), 'uncommitted\n');
  const listed = await new Worktrees(dir).list();
  assert.deepEqual(listed.worktrees.map((w) => [w.path, w.branch, w.office]), [[made.path, undefined, 'office/pip-10']]);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    assert.equal(await prune([dir]), 0);
  } finally {
    console.log = log;
  }
  assert.match(lines.join('\n'), /kept\s+\S+ \(detached\)/);
  assert.ok(existsSync(path.join(abs, 'wip.txt')), 'the folder stays');
  assert.match(git(dir, 'branch', '--list', 'office/pip-10'), /office\/pip-10/, 'and so does its branch');
});

test('restore makes the home again, and says why when it can not', async (t) => {
  const { dir: web } = fixture(t, 'mono');
  const floor = path.join(web, 'packages', 'app');
  mkdirSync(floor, { recursive: true });
  git(web, 'branch', 'office/r1');
  const trees = new Worktrees(floor);
  assert.deepEqual(await trees.restore({ path: path.join('..', 'app.worktrees', 'r1'), branch: 'office/r1' }), { from: 'here' });
  assert.match(readFileSync(path.join(web, '.git', 'info', 'exclude'), 'utf8'), /^\/packages\/app\.worktrees\/$/m);
  rmSync(path.join(web, 'packages', 'app.worktrees'), { recursive: true, force: true });
  writeFileSync(path.join(web, 'packages', 'app.worktrees'), 'in the way\n');
  git(web, 'worktree', 'prune');
  const r = await trees.restore({ path: path.join('..', 'app.worktrees', 'r1'), branch: 'office/r1' });
  assert.match(JSON.stringify(r), /can't make .*app\.worktrees for the worktrees/);
});

test('ensureHome escapes the folder name for gitignore, and writes nothing for one with control characters', (t) => {
  const { root } = fixture(t, 'mono');
  const mono = path.join(root, 'mono');
  const floor = path.join(mono, 'we*ird [1] !x ', 'app');
  mkdirSync(floor, { recursive: true });
  const home = ensureHome(floor);
  const exclude = () => readFileSync(path.join(mono, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude().split('\n').includes('/we\\*ird \\[1] \\!x\\ /app.worktrees/'), exclude());
  writeFileSync(path.join(home, 'x.txt'), 'x\n');
  mkdirSync(path.join(mono, 'we-also', 'app.worktrees'), { recursive: true });
  writeFileSync(path.join(mono, 'we-also', 'app.worktrees', 'y.txt'), 'y\n');
  assert.equal(git(mono, 'status', '--porcelain', '-uall').includes('ird'), false, 'ignored');
  assert.match(git(mono, 'status', '--porcelain', '-uall'), /we-also/, 'the pattern does not reach beyond its folder');
  const before = exclude();
  const odd = path.join(mono, 'a\nb', 'app');
  mkdirSync(odd, { recursive: true });
  assert.ok(existsSync(ensureHome(odd)));
  assert.equal(exclude(), before);
});

test('the async node_modules walk makes what the sync one does', async (t) => {
  const { root, dir } = fixture(t);
  pkg(dir, '@types/node');
  mkdirSync(path.join(dir, 'node_modules', '.bin'));
  symlinkSync('../dep/index.js', path.join(dir, 'node_modules', '.bin', 'dep'));
  const tree = (d: string) => readdirSync(path.join(d, 'node_modules'), { recursive: true }).map(String).sort();
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  linkNodeModules(dir, a);
  await linkNodeModulesAsync(dir, b);
  assert.deepEqual(tree(b), tree(a));
  assert.ok(tree(a).includes(path.join('@types', 'node')));
});

test('the async walk maps workspace, pnpm and dangling links as the sync one does', async (t) => {
  const { root, dir } = workspace(t);
  const nm = path.join(dir, 'node_modules');
  mkdirSync(path.join(nm, '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'), { recursive: true });
  symlinkSync('.pnpm/foo@1.0.0/node_modules/foo', path.join(nm, 'foo'));
  symlinkSync('../nowhere', path.join(nm, 'dangling'));
  symlinkSync('../../nowhere', path.join(nm, '@acme', 'dangling'));
  git(dir, 'worktree', 'add', '-q', '-b', 'sync', path.join(root, 'a'));
  git(dir, 'worktree', 'add', '-q', '-b', 'async', path.join(root, 'b'));
  linkNodeModules(dir, path.join(root, 'a'));
  await linkNodeModulesAsync(dir, path.join(root, 'b'));
  // Link targets, with the worktree's own root taken out.
  const links = (wt: string) => {
    const base = path.join(wt, 'node_modules');
    return (readdirSync(base, { recursive: true }) as string[])
      .filter((f) => lstatSync(path.join(base, f)).isSymbolicLink())
      .sort()
      .map((f) => [f, readlinkSync(path.join(base, f)).replace(wt, '<wt>')]);
  };
  assert.deepEqual(links(path.join(root, 'b')), links(path.join(root, 'a')));
  const got = Object.fromEntries(links(path.join(root, 'a')));
  assert.equal(got[path.join('@acme', 'ui')], path.join('<wt>', 'packages', 'ui'));
  assert.equal(got.foo, path.join(nm, 'foo'));
  assert.equal(got.dangling, path.join(nm, 'dangling'));
});

/** A repository with workspace packages (committed) and the links an install makes to them in its node_modules (ignored). */
function workspace(t: { after(fn: () => void): void }, gitignore = 'node_modules/\n') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-home-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = repo(path.join(root, 'proj'), gitignore);
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  put('packages/ui/index.js', "module.exports = 'main';\n");
  put('packages/ui/cli.js', 'cli\n');
  put('packages/ui/package.json', JSON.stringify({ name: '@acme/ui', main: 'index.js' }));
  put('packages/plain/index.js', "module.exports = 'plain';\n");
  put('packages/plain/package.json', JSON.stringify({ name: 'ui-plain', main: 'index.js' }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'packages');
  mkdirSync(path.join(dir, 'node_modules', '@acme'), { recursive: true });
  symlinkSync('../../packages/ui', path.join(dir, 'node_modules', '@acme', 'ui'));
  symlinkSync('../packages/plain', path.join(dir, 'node_modules', 'ui-plain'));
  return { root, dir, put };
}

const made = (dir: string, slug: string): string => {
  const m = new Worktrees(dir).create(slug);
  assert.equal(typeof m, 'object', String(m));
  return path.join(dir, (m as { path: string }).path);
};
const real = (...p: string[]) => realpathSync(path.join(...p));
const requireIn = (cwd: string, name: string) => execFileSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(name)})))`], { cwd, encoding: 'utf8' });

test('a workspace package linked in node_modules is the worktree\'s own copy, scoped or not', (t) => {
  const { dir } = workspace(t);
  const wt = made(dir, 'ws-1');
  assert.equal(real(wt, 'node_modules', '@acme', 'ui'), real(wt, 'packages', 'ui'));
  assert.equal(real(wt, 'node_modules', 'ui-plain'), real(wt, 'packages', 'plain'));
  writeFileSync(path.join(wt, 'packages', 'ui', 'index.js'), "module.exports = 'worktree';\n");
  assert.equal(requireIn(wt, '@acme/ui'), 'worktree');
  assert.equal(requireIn(dir, '@acme/ui'), 'main');
});

test('a .bin link into a workspace package points into the worktree', (t) => {
  const { dir } = workspace(t);
  mkdirSync(path.join(dir, 'node_modules', '.bin'));
  symlinkSync('../@acme/ui/cli.js', path.join(dir, 'node_modules', '.bin', 'ui-cli'));
  const wt = made(dir, 'ws-bin');
  assert.equal(real(wt, 'node_modules', '.bin', 'ui-cli'), real(wt, 'packages', 'ui', 'cli.js'));
});

test('a .bin link into build output the worktree has not made yet runs the worktree\'s build once it is made', (t) => {
  const { dir, put } = workspace(t, 'node_modules/\ndist/\n');
  put('packages/ui/dist/cli.js', "process.stdout.write('main');\n");
  mkdirSync(path.join(dir, 'node_modules', '.bin'));
  symlinkSync('../@acme/ui/dist/cli.js', path.join(dir, 'node_modules', '.bin', 'ui-cli'));
  const wt = made(dir, 'ws-dist');
  const cli = path.join(wt, 'node_modules', '.bin', 'ui-cli');
  assert.equal(readlinkSync(cli), path.join(wt, 'packages', 'ui', 'dist', 'cli.js'));
  // Built in the worktree after the links were made.
  mkdirSync(path.join(wt, 'packages', 'ui', 'dist'));
  writeFileSync(path.join(wt, 'packages', 'ui', 'dist', 'cli.js'), "process.stdout.write('worktree');\n");
  assert.equal(execFileSync(process.execPath, [cli], { encoding: 'utf8' }), 'worktree');
  assert.equal(execFileSync(process.execPath, [path.join(dir, 'node_modules', '.bin', 'ui-cli')], { encoding: 'utf8' }), 'main');
});

test('a link to a package the worktree does not have falls back to the project\'s', (t) => {
  const { dir, put } = workspace(t);
  put('packages/local/index.js', 'local\n');
  put('packages/local/package.json', JSON.stringify({ name: 'local' }));
  symlinkSync('../packages/local', path.join(dir, 'node_modules', 'local'));
  const wt = made(dir, 'ws-local');
  assert.equal(existsSync(path.join(wt, 'packages', 'local')), false);
  assert.equal(real(wt, 'node_modules', 'local'), real(dir, 'packages', 'local'));
});

test('a pnpm store link and a link out of the repository stay what they were', (t) => {
  const { root, dir } = workspace(t);
  const nm = path.join(dir, 'node_modules');
  mkdirSync(path.join(nm, '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'), { recursive: true });
  writeFileSync(path.join(nm, '.pnpm', 'foo@1.0.0', 'node_modules', 'foo', 'index.js'), 'foo\n');
  symlinkSync('.pnpm/foo@1.0.0/node_modules/foo', path.join(nm, 'foo'));
  mkdirSync(path.join(root, 'ext'));
  symlinkSync(path.join(root, 'ext'), path.join(nm, 'ext'));
  const wt = made(dir, 'ws-ext');
  assert.equal(real(wt, 'node_modules', 'foo'), real(nm, 'foo'));
  assert.equal(real(wt, 'node_modules', 'ext'), path.join(root, 'ext'));
});

for (const [name, ignore] of [['ignored', 'node_modules/\n'], ['not mentioned in .gitignore', '']] as const) {
  test(`a workspace package's own node_modules is linked in the worktree too (node_modules ${name}), and git stays clean`, (t) => {
    const { dir } = workspace(t, ignore);
    // Needs to be in the project before the worktree is made, as an install would.
    mkdirSync(path.join(dir, 'packages', 'ui', 'node_modules', 'ui-dep'), { recursive: true });
    writeFileSync(path.join(dir, 'packages', 'ui', 'node_modules', 'ui-dep', 'index.js'), "module.exports = 'dep';\n");
    writeFileSync(path.join(dir, 'packages', 'ui', 'index.js'), "module.exports = require('ui-dep');\n");
    git(dir, 'commit', '-q', '-am', 'ui uses ui-dep');
    const wt = made(dir, 'ws-nested');
    assert.equal(requireIn(wt, '@acme/ui'), 'dep');
    assert.ok(lstatSync(path.join(wt, 'packages', 'ui', 'node_modules')).isDirectory());
    assert.equal(git(wt, 'status', '--porcelain'), '');
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });
}

test('a floor in a subfolder of a monorepo: the links go to the worktree\'s packages', (t) => {
  const { dir } = workspace(t);
  const floor = path.join(dir, 'apps', 'web');
  mkdirSync(path.join(floor, 'node_modules', '@acme'), { recursive: true });
  symlinkSync(path.relative(path.join(floor, 'node_modules', '@acme'), path.join(dir, 'packages', 'ui')), path.join(floor, 'node_modules', '@acme', 'ui'));
  const m = new Worktrees(floor).create('ws-floor');
  assert.equal(typeof m, 'object', String(m));
  if (typeof m === 'string') return;
  const wt = path.resolve(floor, m.path);
  assert.equal(real(wt, 'node_modules', '@acme', 'ui'), real(wt, 'packages', 'ui'));
});

test('restore links the workspace packages to the worktree again', async (t) => {
  const { root, dir } = workspace(t);
  const trees = new Worktrees(dir);
  const m = trees.create('ws-restore');
  if (typeof m === 'string') return assert.fail(m);
  rmSync(path.join(root, 'proj.worktrees'), { recursive: true, force: true });
  assert.deepEqual(await trees.restore(m), { from: 'here' });
  const wt = path.join(dir, m.path);
  assert.equal(real(wt, 'node_modules', '@acme', 'ui'), real(wt, 'packages', 'ui'));
});
