import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { excludeFromGit } from './config.js';

/** Where the office kept its worktrees before they moved beside the project: inside it, relative to the project. */
export const LEGACY_WORKTREES_DIR = path.join('.agent-office', 'worktrees');
/** What a floor's worktrees folder is called next to the floor: `<name>.worktrees`. */
const HOME_SUFFIX = '.worktrees';

/**
 * Where the office makes new worktrees for the floor `dir`: a folder beside it, `<dir>.worktrees`,
 * rather than inside it, where the project's own tools (lint, tsc, jest, the IDE) would find the
 * copies. Absolute, and computed from `dir` as given (not its realpath): a floor that is a symlink
 * has its home beside the link, so that `path.join(dir, <stored relative path>)` lands in it.
 */
export function worktreesHome(dir: string): string {
  const abs = path.resolve(dir);
  return path.join(path.dirname(abs), path.basename(abs) + HOME_SUFFIX);
}

/** Every folder a floor's worktrees can be in, absolute: the one new ones go to, then the one older ones are in. */
export function worktreeHomes(dir: string): string[] {
  return [worktreesHome(dir), path.join(path.resolve(dir), LEGACY_WORKTREES_DIR)];
}

/** The floor dir a worktree path belongs to (`…/<x>.worktrees/<slug>/…` is `…/<x>`, `…/.agent-office/worktrees/<slug>/…` too); undefined for any other path. */
export function officeOfWorktree(abs: string): string | undefined {
  const parts = path.resolve(abs).split(path.sep);
  // The innermost home wins: a floor can itself be a worktree.
  for (let i = parts.length - 2; i >= 1; i--) {
    const legacy = parts[i] === '.agent-office' && parts[i + 1] === 'worktrees';
    const fresh = parts[i].length > HOME_SUFFIX.length && parts[i].endsWith(HOME_SUFFIX);
    // A slug has to follow the home.
    if (legacy && i + 2 < parts.length) return parts.slice(0, i).join(path.sep) || path.sep;
    if (fresh && i + 1 < parts.length) return parts.slice(0, i).concat(parts[i].slice(0, -HOME_SUFFIX.length)).join(path.sep) || path.sep;
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
 * or `.agent-office/worktrees/x`. `abs` may be real (as `git worktree list` prints it) while `dir`
 * is reached through a symlink: create() and list() give the same string for the same worktree.
 * Undefined when it isn't in one of the floor's homes.
 */
export function storedPath(dir: string, abs: string): string | undefined {
  const real = realish(abs);
  for (const home of worktreeHomes(dir)) {
    const realHome = realish(home);
    if (within(realHome, real)) return path.join(path.relative(path.resolve(dir), home), path.relative(realHome, real));
  }
  return undefined;
}

/**
 * Makes the floor's worktrees folder, with its node_modules link (see linkModules). When it lands inside a git work tree (the floor is in a monorepo,
 * or its parent folder is a repository of its own) that work tree is told to ignore it, so the
 * copies don't show up there as untracked. Throws when the folder can't be made, naming it; the
 * ignore is a courtesy and never throws.
 */
export function ensureHome(dir: string): string {
  const home = worktreesHome(dir);
  try {
    mkdirSync(home, { recursive: true });
  } catch (err) {
    throw new Error(`can't make ${home} for the worktrees: ${(err as Error).message}`);
  }
  linkModules(dir, home);
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rel = path.relative(realish(top), realish(home));
    if (top && within(realish(top), realish(home))) excludeFromGit(path.dirname(home), `/${rel.split(path.sep).join('/')}/`);
  } catch {
    // not in a work tree: nothing to ignore
  }
  return home;
}

/**
 * Links the floor's node_modules into its worktrees folder, `<floor>.worktrees/node_modules`: a worktree
 * there finds it by Node's lookup through the parent folders, and by `npm run` through the ancestors'
 * node_modules/.bin, as a worktree nested in the floor did. It is one link beside the worktrees, not one
 * in each, so `npm ci` in a worktree makes the worktree's own node_modules and never reaches the
 * floor's. Never throws; leaves anything already there alone.
 */
function linkModules(floor: string, home: string): void {
  try {
    const link = path.join(home, 'node_modules');
    try {
      lstatSync(link);
      return;
    } catch {
      // nothing there yet
    }
    const target = path.join(path.resolve(floor), 'node_modules');
    lstatSync(target);
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // no node_modules to link, or no way to: the worktrees work without
  }
}
