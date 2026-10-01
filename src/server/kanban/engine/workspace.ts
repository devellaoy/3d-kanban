// What the engine asks git about a task's workspace: whether anything changed against where its
// branches started (no changes, no review), which branch each repository is on now, and whether its
// folders are still there at all.

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TaskWorkspace } from '../../../shared/kanban/types.js';

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
  for (const d of repoFolders(floorDir, ws)) {
    try {
      if (await changedSince(d.dir, d.base)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The folders of a workspace with the base each started from, primary first. */
function repoFolders(floorDir: string, ws: TaskWorkspace): { dir: string; base: string | undefined }[] {
  return [{ dir: path.join(floorDir, ws.worktree.path), base: ws.worktree.base }, ...(ws.repos ?? []).map((r) => ({ dir: path.join(floorDir, r.path), base: r.base }))];
}

/** The folders of a workspace, primary first. */
const folders = (floorDir: string, ws: TaskWorkspace): string[] => repoFolders(floorDir, ws).map((d) => d.dir);

/** Runs git with `input` on stdin and hands back its raw stdout (a diff can be big). Throws on a failure or a timeout. */
function gitOut(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (err) => (clearTimeout(timer), reject(err)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`git ${args[0]} exited with ${code}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** One folder's part of the fingerprint. Throws when git can't say. */
async function folderPrint(dir: string): Promise<string> {
  const head = (await gitOut(dir, ['rev-parse', 'HEAD'])).toString().trim();
  const diff = sha256(await gitOut(dir, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv']));
  const files = (await gitOut(dir, ['ls-files', '-o', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean);
  const prints: string[] = [];
  for (const f of files) prints.push(`${f}\0${await untrackedPrint(dir, f)}`);
  return [dir, head, diff, prints.join('\n')].join('\0');
}

/** What an untracked entry holds: a link's target, a nested repository's HEAD, or a file's mode and contents. Nothing is written anywhere. */
async function untrackedPrint(dir: string, rel: string): Promise<string> {
  const full = path.join(dir, rel);
  let st;
  try {
    st = await lstat(full);
  } catch {
    return 'gone';
  }
  try {
    if (st.isSymbolicLink()) return `l:${await readlink(full)}`;
    if (st.isDirectory()) return `d:${await gitOut(full, ['rev-parse', 'HEAD']).then((b) => b.toString().trim(), () => '')}`;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
    return `f:${st.mode & 0o111 ? 'x' : '-'}${hash.digest('hex')}`;
  } catch {
    return 'gone';
  }
}

/**
 * What the workspace holds now, per repository: HEAD, the tracked changes and the untracked files'
 * contents (ignored ones not). Undefined when git can't say: the caller then counts it as changed.
 */
export async function workspaceFingerprint(floorDir: string, ws: TaskWorkspace | undefined): Promise<string | undefined> {
  if (!ws) return undefined;
  try {
    const parts: string[] = [];
    for (const d of repoFolders(floorDir, ws)) parts.push(await folderPrint(d.dir));
    return sha256(parts.join('\0\0'));
  } catch {
    return undefined;
  }
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
