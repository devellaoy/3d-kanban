import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { excludeFromGit } from './config.js';

const execFileP = promisify(execFile);

/** Where the office kept its worktrees before they moved beside the project: inside it, relative to the project. */
export const LEGACY_WORKTREES_DIR = path.join('.agent-office', 'worktrees');
/** What a floor's worktrees folder is called next to the floor: `<name>.worktrees`. */
const HOME_SUFFIX = '.worktrees';

/**
 * Where the office makes new worktrees for the floor `dir`: a folder beside it, `<dir>.worktrees`,
 * rather than inside it, where the project's own tools (lint, tsc, jest, the IDE) would find the
 * copies. Absolute, and made from the folder's real path, so it is the same however the floor is
 * spelled (through a symlink or not).
 */
export function worktreesHome(dir: string): string {
  const abs = realish(dir);
  return path.join(path.dirname(abs), path.basename(abs) + HOME_SUFFIX);
}

/** Where older offices kept the floor's worktrees: inside it. Absolute. */
export function legacyHome(dir: string): string {
  return path.join(realish(dir), LEGACY_WORKTREES_DIR);
}

/** Every folder a floor's worktrees can be in, absolute: the one new ones go to, then the one older ones are in. */
export function worktreeHomes(dir: string): string[] {
  return [worktreesHome(dir), legacyHome(dir)];
}

/** The folder a stored worktree path (relative to the floor `dir`, see storedPath) is. Use it wherever one is turned into a folder. */
export function worktreeDir(dir: string, rel: string): string {
  return path.resolve(realish(dir), rel);
}

/**
 * The floor dir a worktree path belongs to (`…/<x>.worktrees/<slug>/…` is `…/<x>`, `…/.agent-office/worktrees/<slug>/…`
 * too), when that really is an office's floor: it has an `.agent-office` folder, and the folder
 * matched is the floor's own worktrees folder. Undefined for any other path, such as someone's
 * `code.worktrees/review`.
 */
export function officeOfWorktree(abs: string): string | undefined {
  const parts = path.resolve(abs).split(path.sep);
  // The innermost home wins: a floor can itself be a worktree.
  for (let i = parts.length - 2; i >= 1; i--) {
    const legacy = parts[i] === '.agent-office' && parts[i + 1] === 'worktrees';
    const fresh = parts[i].length > HOME_SUFFIX.length && parts[i].endsWith(HOME_SUFFIX);
    // A slug has to follow the home.
    const office = legacy && i + 2 < parts.length ? parts.slice(0, i) : fresh && i + 1 < parts.length ? parts.slice(0, i).concat(parts[i].slice(0, -HOME_SUFFIX.length)) : undefined;
    if (!office) continue;
    const dir = office.join(path.sep) || path.sep;
    const home = legacy ? parts.slice(0, i + 2) : parts.slice(0, i + 1);
    if (existsSync(path.join(dir, '.agent-office')) && realish(home.join(path.sep) || path.sep) === realish(legacy ? legacyHome(dir) : worktreesHome(dir))) return dir;
  }
  return undefined;
}

/** realpath of the nearest folder that exists, with the rest of the path put back: comparable to what git prints for a folder not made yet. */
export function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** Whether `p` is inside `root` (not `root` itself). */
export function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A worktree's path as the office stores it: relative to the floor `dir`, such as `../app.worktrees/x`
 * or `.agent-office/worktrees/x`, relative to its real path, so it doesn't depend on how the floor is
 * spelled. `abs` may be real (as `git worktree list` prints it) or not: create() and list() give the
 * same string for the same worktree.
 * Undefined when it isn't in one of the floor's homes.
 */
export function storedPath(dir: string, abs: string): string | undefined {
  const real = realish(abs);
  const base = realish(dir);
  for (const home of worktreeHomes(dir)) {
    const realHome = realish(home);
    if (within(realHome, real)) return path.join(path.relative(base, home), path.relative(realHome, real));
  }
  return undefined;
}

/** A name as a gitignore pattern that matches only it: wildcards, a leading `!` or `#` and trailing spaces escaped. */
export function gitignoreEscape(name: string): string {
  return name.replace(/[\\*?[!#]/g, '\\$&').replace(/ +$/, (sp) => sp.replace(/ /g, '\\ '));
}

/** Homes already told to the repository around them (see ensureHome), so a hire doesn't ask git again. */
const told = new Set<string>();

/**
 * Makes the floor's worktrees folder. When it lands inside a git work tree (the floor is in a monorepo,
 * or its parent folder is a repository of its own) that work tree is told to ignore it, so the
 * copies don't show up there as untracked; once per home. Throws when the folder can't be made,
 * naming it; the ignore is a courtesy and never throws (nor is written for a name with control
 * characters in it).
 */
export function ensureHome(dir: string): string {
  const home = worktreesHome(dir);
  try {
    mkdirSync(home, { recursive: true });
  } catch (err) {
    throw new Error(`can't make ${home} for the worktrees: ${(err as Error).message}`);
  }
  if (told.has(home)) return home;
  told.add(home);
  try {
    const top = realish(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const rel = path.relative(top, realish(home));
    if (within(top, realish(home)) && !/[\x00-\x1f\x7f]/.test(rel)) excludeFromGit(path.dirname(home), `/${rel.split(path.sep).map(gitignoreEscape).join('/')}/`);
  } catch {
    // not in a work tree: nothing to ignore
  }
  return home;
}

type Entry = { src: string; dest: string; dir: boolean };
/** What the node_modules walk asks of the file system, so the one walk serves a sync and an async caller. */
type Ask = { op: 'exists' | 'isDir' | 'list' | 'mkdir'; path: string } | ({ op: 'link' } & Entry) | { op: 'ignored'; path: string };

/**
 * The walk that makes a worktree's node_modules (see linkNodeModules), asking for each file system step
 * it needs by yielding it: scopes and `.bin` become real folders with a link per child, anything
 * else a link, and the dot entries other than `.bin` are left out.
 */
function* walkModules(repo: string, worktree: string): Generator<Ask, void, unknown> {
  const from = path.join(path.resolve(repo), 'node_modules');
  const to = path.join(worktree, 'node_modules');
  if (yield { op: 'exists', path: to }) return;
  // Followed: a project's node_modules may itself be a link (to a shared or cached install).
  if (!(yield { op: 'isDir', path: from })) return;
  yield { op: 'mkdir', path: to };
  const fill = function* (src: string, dest: string, nested: boolean): Generator<Ask, void, unknown> {
    for (const name of (yield { op: 'list', path: src }) as string[]) {
      if (!nested && name.startsWith('.') && name !== '.bin') continue;
      const at = path.join(src, name);
      const dir = (yield { op: 'isDir', path: at }) as boolean;
      if (!nested && dir && (name === '.bin' || name.startsWith('@'))) {
        yield { op: 'mkdir', path: path.join(dest, name) };
        yield* fill(at, path.join(dest, name), true);
      } else yield { op: 'link', src: at, dest: path.join(dest, name), dir };
    }
  };
  yield* fill(from, to, false);
  // `node_modules/` in a .gitignore matches the folder. When it doesn't, the project's shared
  // info/exclude (git has none per worktree) is told to ignore a node_modules at any worktree's top.
  if (!(yield { op: 'ignored', path: worktree })) excludeFromGit(worktree, '/node_modules/');
}

const link = ({ src, dest, dir }: Entry): void => {
  if (process.platform !== 'win32') symlinkSync(src, dest, dir ? 'dir' : 'file');
  else if (dir) symlinkSync(src, dest, 'junction');
  else copyFileSync(src, dest);
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false; // a dangling link: linked anyway
  }
};
const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Gives a new worktree a node_modules of its own, made of links to the packages of the repository it
 * is of (`repo`), which a worktree beside the project can no longer find through its parent folders.
 * Only when `repo` has one and the worktree doesn't; never throws. The packages stay shared (see
 * docs/how-it-works.md for why it isn't one link), and the `/node_modules/` line it may add to the
 * repository's info/exclude applies to every checkout of it. Sync, for create(); see linkNodeModulesAsync.
 */
export function linkNodeModules(repo: string, worktree: string): void {
  try {
    const walk = walkModules(repo, worktree);
    let r = walk.next();
    while (!r.done) {
      const a = r.value;
      let got: unknown;
      if (a.op === 'exists') got = exists(a.path);
      else if (a.op === 'isDir') got = isDir(a.path);
      else if (a.op === 'list') got = readdirSync(a.path);
      else if (a.op === 'mkdir') mkdirSync(a.path);
      else if (a.op === 'link') link(a);
      else got = checkIgnored(a.path, false);
      r = walk.next(got);
    }
  } catch {
    // no node_modules to give, or no way to: the worktree works without
  }
}

/** linkNodeModules for an async caller: the same walk, without blocking the office while it reads a big node_modules. */
export async function linkNodeModulesAsync(repo: string, worktree: string): Promise<void> {
  try {
    const walk = walkModules(repo, worktree);
    let r = walk.next();
    while (!r.done) {
      const a = r.value;
      let got: unknown;
      if (a.op === 'exists') got = await lstat(a.path).then(() => true, () => false);
      else if (a.op === 'isDir') got = await stat(a.path).then((st) => st.isDirectory(), () => false);
      else if (a.op === 'list') got = await readdir(a.path);
      else if (a.op === 'mkdir') await mkdir(a.path);
      else if (a.op === 'link') {
        if (process.platform !== 'win32') await symlink(a.src, a.dest, a.dir ? 'dir' : 'file');
        else if (a.dir) await symlink(a.src, a.dest, 'junction');
        else await copyFile(a.src, a.dest);
      } else got = await checkIgnored(a.path, true);
      r = walk.next(got);
    }
  } catch {
    // as linkNodeModules
  }
}

function checkIgnored(cwd: string, async: false): boolean;
function checkIgnored(cwd: string, async: true): Promise<boolean>;
function checkIgnored(cwd: string, async: boolean): boolean | Promise<boolean> {
  if (async) return execFileP('git', ['check-ignore', '-q', 'node_modules'], { cwd }).then(() => true, () => false);
  try {
    execFileSync('git', ['check-ignore', '-q', 'node_modules'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
