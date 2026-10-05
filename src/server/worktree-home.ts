import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, stat, symlink } from 'node:fs/promises';
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

/** `alt` is what a file is copied from instead when `src` isn't there yet (Windows copies files rather than linking them). */
type Entry = { src: string; dest: string; dir: boolean; alt?: string };
/** What an entry of a node_modules is: a folder (a link is followed), and where it really points when it is a link (undefined for any other entry, and for a dangling link). */
type Kind = { dir: boolean; target?: string };
/** What the node_modules walk asks of the file system, so the one walk serves a sync and an async caller. */
type Ask =
  | { op: 'exists' | 'isDir' | 'list' | 'mkdir' | 'top' | 'real' | 'entry'; path: string }
  /** Which of `paths` (relative to `cwd`) git ignores. */
  | { op: 'ignored'; cwd: string; paths: string[] }
  | ({ op: 'link' } & Entry);
/**
 * What a walk carries: the repository (`top` is its real root, asked for at the first link) and the
 * worktree's root (`realRoot` its real path), the packages whose own node_modules was walked, and
 * the packages (relative to the root, '' for the root's own) whose node_modules was made.
 */
type Ctx = { repo: string; top?: string; root: string; realRoot: string; seen: Set<string>; made: string[] };

/** The repository's real root, from git on the first call. */
function* topOf(ctx: Ctx): Generator<Ask, string, unknown> {
  return (ctx.top ??= ((yield { op: 'top', path: ctx.repo }) as string | undefined) ?? realish(ctx.repo));
}

/** The nearest folder above `r` (relative to the repository root) that is a package of it, undefined when none is. */
function* packageAbove(top: string, r: string): Generator<Ask, string | undefined, unknown> {
  for (let p = path.dirname(r); p !== '.' && p !== path.dirname(p); p = path.dirname(p)) {
    if (yield { op: 'exists', path: path.join(top, p, 'package.json') }) return p;
  }
  return undefined;
}

/**
 * The walk that makes a worktree's node_modules (see linkNodeModules), asking for each file system step
 * it needs by yielding it: scopes and `.bin` become real folders with a link per child, anything
 * else a link, and the dot entries other than `.bin` are left out. A link that points at a workspace
 * package (a folder of the repository outside any node_modules) is made to point at the worktree's
 * copy of it, and that copy gets the package's own node_modules the same way. The copy has to really
 * be in the worktree: a folder that is a link in the branch is not followed.
 */
function* walkModules(repo: string, worktree: string): Generator<Ask, void, unknown> {
  const realRoot = (yield { op: 'real', path: worktree }) as string | undefined;
  if (!realRoot) return;
  const ctx: Ctx = { repo: path.resolve(repo), root: worktree, realRoot, seen: new Set(), made: [] };
  // `from` is followed: a project's node_modules may itself be a link (to a shared or cached install).
  yield* modules(path.join(ctx.repo, 'node_modules'), path.join(worktree, 'node_modules'), ctx);
  // `node_modules/` in a .gitignore matches the folder. When it doesn't, the project's shared
  // info/exclude (git has none per worktree) is told to ignore it at the package's place in any worktree.
  const paths = ctx.made.map((rel) => path.join(rel, 'node_modules')).filter((p) => !/[\x00-\x1f\x7f]/.test(p));
  if (!paths.length) return;
  const ignored = new Set((yield { op: 'ignored', cwd: worktree, paths: paths.map((p) => p.split(path.sep).join('/')) }) as string[]);
  for (const p of paths) {
    if (!ignored.has(p.split(path.sep).join('/'))) excludeFromGit(worktree, `/${p.split(path.sep).map(gitignoreEscape).join('/')}/`);
  }
}

/** Links `from` (a node_modules of the repository) into `to`, in the worktree; `rel` is the package it belongs to, relative to the repository root, '' for the root's own. */
function* modules(from: string, to: string, ctx: Ctx, rel = ''): Generator<Ask, void, unknown> {
  if (yield { op: 'exists', path: to }) return;
  if (!(yield { op: 'isDir', path: from })) return;
  yield { op: 'mkdir', path: to };
  ctx.made.push(rel);
  // Whether `p`, in the worktree, really is where it says: no link along the way, so nothing is followed out of the worktree.
  const inside = function* (p: string): Generator<Ask, boolean, unknown> {
    return ((yield { op: 'real', path: path.join(ctx.root, p) }) as string | undefined) === path.join(ctx.realRoot, p);
  };
  // Where a link to `at` should point: the worktree's copy when it is a package of the repository, else `at` itself.
  const remap = function* (at: string, e: Kind): Generator<Ask, { src: string; rel?: string; alt?: string }, unknown> {
    if (!e.target) return { src: at };
    const top = yield* topOf(ctx);
    if (!within(top, e.target)) return { src: at };
    const r = path.relative(top, e.target);
    // Installed packages (a pnpm store, an npm link) stay shared.
    if (r.split(path.sep).includes('node_modules')) return { src: at };
    const cand = path.join(ctx.root, r);
    if (yield* inside(r)) return { src: cand, rel: r };
    // Not in the worktree: a file of build output not made there yet (a `.bin` link into `dist/`) still
    // goes to the worktree's copy when the package it is in is there, so building it there is what it
    // runs. Anything else, a folder above all (an untracked package, even one inside a tracked one), stays the project's.
    if (e.dir) return { src: at };
    const p = yield* packageAbove(top, r);
    return p !== undefined && (yield* inside(path.join(p, 'package.json'))) ? { src: cand, alt: at } : { src: at };
  };
  const put = function* (at: string, dest: string, e: Kind): Generator<Ask, void, unknown> {
    const { src, rel: pkgRel, alt } = yield* remap(at, e);
    yield { op: 'link', src, dest, dir: e.dir, alt };
    if (pkgRel === undefined || !e.dir || ctx.seen.has(src)) return;
    ctx.seen.add(src);
    yield* modules(path.join(ctx.top as string, pkgRel, 'node_modules'), path.join(src, 'node_modules'), ctx, pkgRel);
  };
  const fill = function* (src: string, dest: string, nested: boolean): Generator<Ask, void, unknown> {
    for (const name of (yield { op: 'list', path: src }) as string[]) {
      if (!nested && name.startsWith('.') && name !== '.bin') continue;
      const at = path.join(src, name);
      const e = (yield { op: 'entry', path: at }) as Kind;
      if (!nested && e.dir && (name === '.bin' || name.startsWith('@'))) {
        yield { op: 'mkdir', path: path.join(dest, name) };
        yield* fill(at, path.join(dest, name), true);
      } else yield* put(at, path.join(dest, name), e);
    }
  };
  yield* fill(from, to, false);
}

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const existsAsync = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
// A dangling link isn't a folder, and is linked anyway.
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isDirAsync = (p: string): Promise<boolean> => stat(p).then((st) => st.isDirectory(), () => false);
const real = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};
const realAsync = (p: string): Promise<string | undefined> => realpath(p).then((r) => r, () => undefined); // fs/promises' realpath is the native one

/** One lstat tells a link from the rest; only a link costs more. */
const entryOf = (p: string): Kind => {
  try {
    const lst = lstatSync(p);
    return lst.isSymbolicLink() ? { dir: isDir(p), target: real(p) } : { dir: lst.isDirectory() };
  } catch {
    return { dir: false };
  }
};
const entryOfAsync = async (p: string): Promise<Kind> => {
  try {
    const lst = await lstat(p);
    return lst.isSymbolicLink() ? { dir: await isDirAsync(p), target: await realAsync(p) } : { dir: lst.isDirectory() };
  } catch {
    return { dir: false };
  }
};

const link = ({ src, dest, dir, alt }: Entry): void => {
  if (process.platform !== 'win32') symlinkSync(src, dest, dir ? 'dir' : 'file');
  else if (dir) symlinkSync(src, dest, 'junction');
  else copyFileSync(alt && !exists(src) ? alt : src, dest);
};
const linkAsync = async ({ src, dest, dir, alt }: Entry): Promise<void> => {
  if (process.platform !== 'win32') await symlink(src, dest, dir ? 'dir' : 'file');
  else if (dir) await symlink(src, dest, 'junction');
  else await copyFile(alt && !(await existsAsync(src)) ? alt : src, dest);
};

/** The git work tree root of `cwd`, real; undefined when it isn't in one. */
function topOfGit(cwd: string, async: false): string | undefined;
function topOfGit(cwd: string, async: true): Promise<string | undefined>;
function topOfGit(cwd: string, async: boolean): string | undefined | Promise<string | undefined> {
  const args = ['rev-parse', '--show-toplevel'];
  if (async) return execFileP('git', args, { cwd }).then((r) => realish(r.stdout.trim()), () => undefined);
  try {
    return realish(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return undefined;
  }
}

/**
 * Gives a new worktree a node_modules of its own, made of links to the packages of the repository it
 * is of (`repo`), which a worktree beside the project can no longer find through its parent folders.
 * Only when `repo` has one and the worktree doesn't; never throws. Installed packages stay shared (see
 * docs/how-it-works.md for why it isn't one link), but a workspace package (a link into the repository
 * outside node_modules) points at the worktree's own copy of it, whose own node_modules is linked the
 * same way, so the worktree's tests and builds use its own edits to it. The `/node_modules/` lines it
 * may add to the repository's info/exclude apply to every checkout of it. Sync, for create(); see linkNodeModulesAsync.
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
      else if (a.op === 'top') got = topOfGit(a.path, false);
      else if (a.op === 'real') got = real(a.path);
      else if (a.op === 'entry') got = entryOf(a.path);
      else if (a.op === 'ignored') got = ignoredBy(a.cwd, a.paths, false);
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
      if (a.op === 'exists') got = await existsAsync(a.path);
      else if (a.op === 'isDir') got = await isDirAsync(a.path);
      else if (a.op === 'list') got = await readdir(a.path);
      else if (a.op === 'mkdir') await mkdir(a.path);
      else if (a.op === 'link') await linkAsync(a);
      else if (a.op === 'top') got = await topOfGit(a.path, true);
      else if (a.op === 'real') got = await realAsync(a.path);
      else if (a.op === 'entry') got = await entryOfAsync(a.path);
      else if (a.op === 'ignored') got = await ignoredBy(a.cwd, a.paths, true);
      r = walk.next(got);
    }
  } catch {
    // as linkNodeModules
  }
}

/** The ones of `paths` that git ignores in `cwd`, one `git check-ignore` for all (NUL-separated, so no name is quoted); none when git can't tell. */
function ignoredBy(cwd: string, paths: string[], async: false): string[];
function ignoredBy(cwd: string, paths: string[], async: true): Promise<string[]>;
function ignoredBy(cwd: string, paths: string[], async: boolean): string[] | Promise<string[]> {
  const args = ['check-ignore', '-z', '--stdin'];
  const input = paths.join('\0');
  const parse = (out: string) => out.split('\0').filter(Boolean);
  if (async) {
    const p = execFileP('git', args, { cwd });
    p.child.stdin?.on('error', () => undefined);
    p.child.stdin?.end(input);
    return p.then((r) => parse(r.stdout), () => []);
  }
  try {
    return parse(execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })); // exit 1, none ignored, throws
  } catch {
    return [];
  }
}

/**
 * The workspace packages in a worktree's node_modules (top level and scopes) that are links into the
 * worktree itself and whose `main` isn't there: build output not made in the worktree yet. Their names;
 * never throws.
 */
export function unbuiltWorkspaces(worktree: string): string[] {
  const out: string[] = [];
  try {
    const nm = path.join(worktree, 'node_modules');
    const realWt = real(worktree);
    const check = (name: string): void => {
      const at = path.join(nm, name);
      try {
        if (!lstatSync(at).isSymbolicLink()) return;
        const dir = path.resolve(path.dirname(at), readlinkSync(at));
        if (!within(worktree, dir) && !(realWt && within(realWt, dir))) return;
        const main = String((JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { main?: unknown }).main || 'index.js');
        if (![main, `${main}.js`, path.join(main, 'index.js')].some((m) => exists(path.resolve(dir, m)))) out.push(name);
      } catch {
        // not a package, or no way to tell
      }
    };
    for (const name of readdirSync(nm)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@') && lstatSync(path.join(nm, name)).isDirectory()) for (const child of readdirSync(path.join(nm, name))) check(`${name}/${child}`);
      else check(name);
    }
  } catch {
    // no node_modules
  }
  return out;
}
