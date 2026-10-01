// What the engine asks git about a task's workspace: whether anything changed against where its
// branches started (no changes, no review), which branch each repository is on now, and whether its
// folders are still there at all.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRepo, TaskWorkspace } from '../../../shared/kanban/types.js';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** One folder's changes: uncommitted edits, or commits since `base`. Throws when git can't say. */
async function changedSince(dir: string, base: string | undefined): Promise<boolean> {
  if ((await git(dir, ['status', '--porcelain', '--untracked-files=normal'])).length) return true;
  if (!base) return true;
  return Number(await git(dir, ['rev-list', '--count', `${base}..HEAD`])) > 0;
}

/**
 * Whether the task changed anything in any repository of its workspace. Fails open: when git can't
 * tell (a folder project, a missing folder, an unknown base), it counts as changed, so a review is
 * never skipped by mistake.
 */
export async function hasChanges(floorDir: string, ws: TaskWorkspace | undefined): Promise<boolean> {
  if (!ws) return true;
  const dirs = [{ dir: path.join(floorDir, ws.worktree.path), base: ws.worktree.base }, ...(ws.repos ?? []).map((r) => ({ dir: path.join(floorDir, r.path), base: r.base }))];
  for (const d of dirs) {
    try {
      if (await changedSince(d.dir, d.base)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The folders of a workspace, primary first. */
function folders(floorDir: string, ws: TaskWorkspace): string[] {
  return [path.join(floorDir, ws.worktree.path), ...(ws.repos ?? []).map((r) => path.join(floorDir, r.path))];
}

/**
 * The folders of a workspace that are gone: removed when its worker went home (leave-on-merge), or
 * pruned. A worker seated there would only be marked lost, so the engine hires a fresh worktree instead.
 */
export function missingFolders(floorDir: string, ws: TaskWorkspace): string[] {
  return folders(floorDir, ws).filter((d) => !existsSync(d));
}

/** The branch a checkout is on; undefined when it's detached or git can't say. */
export async function currentBranch(dir: string): Promise<string | undefined> {
  try {
    const b = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b && b !== 'HEAD' ? b : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a branch is still there after its worktree was deleted: in the checkout at `dir`, or on its
 * origin. When origin can't be asked (offline, say), it counts as there: a branch name is only
 * dropped from a task once git has said it's in neither place.
 */
export async function branchExists(dir: string, branch: string): Promise<boolean> {
  try {
    await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    // not here: origin, then
  }
  try {
    await git(dir, ['remote', 'get-url', 'origin']);
  } catch {
    return false;
  }
  try {
    await run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: dir, encoding: 'utf8', timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return true;
  } catch (err) {
    // 2: origin answered, and hasn't got it.
    return (err as { code?: unknown }).code !== 2;
  }
}

/**
 * Whether each repository's worktree in `ws` is on the branch wanted for it (the primary's is
 * `ws.worktree`, the others' are `ws.repos` by name). Each is asked on its own: the primary being on
 * the right branch says nothing of the others. One with no worktree in `ws` isn't on it.
 */
export async function allOn(floorDir: string, ws: TaskWorkspace, want: { r: ProjectRepo; b: string }[]): Promise<boolean> {
  const on = await Promise.all(
    want.map(({ r }) => {
      const rel = r.primary ? ws.worktree.path : ws.repos?.find((x) => x.name === r.name)?.path;
      return rel ? currentBranch(path.join(floorDir, rel)) : undefined;
    }),
  );
  return want.every(({ b }, i) => on[i] === b);
}
