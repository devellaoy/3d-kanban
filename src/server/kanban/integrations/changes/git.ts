// What the Changes tab asks git, read-only: the files and the unified diff between two points, the
// commits in a range, one commit's diff and the uncommitted work of a checkout. Always execFile with
// an argument list (never a shell), a timeout, no pager, no external diff drivers and no optional
// locks (an agent may be working in the same checkout at that very moment). A diff is read as a
// stream and cut at its cap, so a huge change never fills the office's memory.

import { spawn } from 'node:child_process';
import type { KanbanChangedFile } from '../../../../shared/kanban/types.js';

/** How long one git call may take. */
export const GIT_TIMEOUT_MS = 15_000;
/** The most of a unified diff one answer carries. */
export const DIFF_CAP_BYTES = 2 * 1024 * 1024;
/** The most commits a range lists. */
export const COMMITS_MAX = 500;
/** The most files a list names. */
export const FILES_MAX = 2000;
/** Untracked files get a diff of their own (as new files) up to this many, each up to UNTRACKED_MAX_BYTES. */
const UNTRACKED_DIFFS = 50;
const UNTRACKED_MAX_BYTES = 256 * 1024;

/** A ref or commit the office hands git: nothing that could be read as an option or a pathspec. */
export const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}^~+-]{1,250}$/;
export const HASH_RE = /^[0-9a-f]{7,40}$/;

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' };

export interface GitOut {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The output went over `cap` and was cut there (the process was stopped). */
  capped: boolean;
}

/**
 * Runs git in `cwd`, reading at most `cap` bytes of its output. Resolves whatever the exit code; a
 * timeout or a git that can't start rejects.
 */
export function git(cwd: string, args: string[], opts: { cap?: number; timeoutMs?: number } = {}): Promise<GitOut> {
  const cap = opts.cap ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let capped = false;
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} took too long`));
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      if (capped) return;
      if (size + b.length > cap) {
        out.push(b.subarray(0, cap - size));
        size = cap;
        capped = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(b);
      size += b.length;
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 4000) err += b.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err.trim(), capped });
    });
  });
}

/** git's answer, or a thrown error with git's own words when it failed. */
async function ok(cwd: string, args: string[], opts?: { cap?: number }): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0 && !r.capped) throw new Error(r.stderr.split('\n').filter(Boolean).slice(-1)[0] || `git ${args[0]} failed`);
  return r.stdout;
}

/** The commit `ref` names, or undefined when it names none here. */
export async function commitOf(cwd: string, ref: string): Promise<string | undefined> {
  if (!REF_RE.test(ref)) return undefined;
  try {
    const r = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** The first of `refs` that names a commit here, with that commit. */
export async function firstCommit(cwd: string, refs: (string | undefined)[]): Promise<{ ref: string; sha: string } | undefined> {
  for (const ref of refs) {
    if (!ref) continue;
    const sha = await commitOf(cwd, ref);
    if (sha) return { ref, sha };
  }
  return undefined;
}

/** The branch origin/HEAD points at ("main"), when the clone knows it. */
export async function originHead(cwd: string): Promise<string | undefined> {
  try {
    const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const b = r.stdout.trim().replace(/^origin\//, '');
    return r.code === 0 && b && REF_RE.test(b) ? b : undefined;
  } catch {
    return undefined;
  }
}

/** The branch a checkout is on; undefined when it's detached. */
export async function branchOf(cwd: string): Promise<string | undefined> {
  try {
    const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const b = r.stdout.trim();
    return r.code === 0 && b ? b : undefined;
  } catch {
    return undefined;
  }
}

/** Splits `-z` output into its fields. */
function fields(out: string): string[] {
  const f = out.split('\0');
  if (f.length && f[f.length - 1] === '') f.pop();
  return f;
}

/** `git diff --name-status -z` → status per path (renames and copies keep where they came from). */
export function parseNameStatus(out: string): { path: string; oldPath?: string; status: KanbanChangedFile['status'] }[] {
  const f = fields(out);
  const files: { path: string; oldPath?: string; status: KanbanChangedFile['status'] }[] = [];
  for (let i = 0; i < f.length; ) {
    const code = f[i++] ?? '';
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = f[i++] ?? '';
      const path = f[i++] ?? '';
      files.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'copied' });
    } else {
      const path = f[i++] ?? '';
      const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'T' ? 'typechange' : letter === 'U' ? 'unmerged' : 'modified';
      files.push({ path, status });
    }
  }
  return files;
}

/** `git diff --numstat -z` → lines added and removed per path ("-" for a binary file). */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const f = fields(out);
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < f.length; ) {
    const head = f[i++] ?? '';
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    // A rename: the path field is empty and the old and new paths follow as fields of their own.
    let path = m[3];
    if (!path) {
      i++; // old path
      path = f[i++] ?? '';
    }
    const binary = m[1] === '-' && m[2] === '-';
    map.set(path, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

function merge(names: ReturnType<typeof parseNameStatus>, nums: ReturnType<typeof parseNumstat>): KanbanChangedFile[] {
  return names.slice(0, FILES_MAX).map((n) => {
    const s = nums.get(n.path);
    return { path: n.path, ...(n.oldPath ? { oldPath: n.oldPath } : {}), status: n.status, additions: s?.additions ?? 0, deletions: s?.deletions ?? 0, ...(s?.binary ? { binary: true } : {}) };
  });
}

const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];

/** The files between two points and their unified diff, cut at `cap`. `range` is what git diff takes: [`a...b`] or [a, b]. */
export async function diffRange(cwd: string, range: string[], cap = DIFF_CAP_BYTES): Promise<{ files: KanbanChangedFile[]; diff: string; truncated: boolean }> {
  const [names, nums, diff] = await Promise.all([
    ok(cwd, ['diff', ...DIFF_OPTS, '--name-status', '-z', ...range, '--']),
    ok(cwd, ['diff', ...DIFF_OPTS, '--numstat', '-z', ...range, '--']),
    git(cwd, ['diff', ...DIFF_OPTS, ...range, '--'], { cap }),
  ]);
  if (diff.code !== 0 && !diff.capped) throw new Error(diff.stderr || 'git diff failed');
  return { files: merge(parseNameStatus(names), parseNumstat(nums)), diff: diff.stdout, truncated: diff.capped };
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
}

/** The commits in `from..to`, newest first. */
export async function commitsIn(cwd: string, from: string, to: string): Promise<CommitInfo[]> {
  const out = await ok(cwd, ['log', `--max-count=${COMMITS_MAX}`, '--no-color', '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${from}..${to}`, '--']);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, author, date] = r.split('\x1f');
      return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: (date ?? '').trim() };
    })
    .filter((c) => /^[0-9a-f]{40,64}$/.test(c.hash));
}

/** One commit's own change (against its first parent). */
export async function commitDiff(cwd: string, hash: string, cap = DIFF_CAP_BYTES): Promise<{ files: KanbanChangedFile[]; diff: string; truncated: boolean }> {
  const parent = await commitOf(cwd, `${hash}^`);
  // A root commit: against the empty tree.
  const from = parent ?? (await ok(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  return diffRange(cwd, [from, hash], cap);
}

/**
 * What a checkout has that isn't committed: staged and unstaged edits against HEAD, and new files
 * git doesn't track yet (as added files, each with a diff of its own when it's small enough).
 */
export async function workingTree(cwd: string, cap = DIFF_CAP_BYTES): Promise<{ files: KanbanChangedFile[]; diff: string; truncated: boolean }> {
  const tracked = await diffRange(cwd, ['HEAD'], cap);
  const others = fields(await ok(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).slice(0, FILES_MAX);
  let diff = tracked.diff;
  let truncated = tracked.truncated;
  const files = [...tracked.files];
  let diffed = 0;
  for (const p of others) {
    const file: KanbanChangedFile = { path: p, status: 'untracked', additions: 0, deletions: 0 };
    files.push(file);
    if (truncated || diffed >= UNTRACKED_DIFFS) continue;
    diffed++;
    try {
      const r = await git(cwd, ['diff', ...DIFF_OPTS, '--no-index', '--', '/dev/null', p], { cap: UNTRACKED_MAX_BYTES });
      // --no-index answers 1 when the files differ, which a new file always does.
      if ((r.code !== 0 && r.code !== 1) || r.capped) continue;
      const lines = r.stdout.split('\n');
      if (lines.some((l) => l.startsWith('Binary files'))) file.binary = true;
      else file.additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      if (diff.length + r.stdout.length > cap) truncated = true;
      else diff += r.stdout;
    } catch {
      // gone meanwhile, or unreadable: listed without a diff
    }
  }
  return { files, diff, truncated };
}

/** How many files differ from HEAD (staged, unstaged or new), from `git status` alone: no diff is read. */
export async function uncommittedCount(cwd: string): Promise<number> {
  const recs = fields(await ok(cwd, ['status', '--porcelain=v1', '-z', '-uall']));
  let n = 0;
  for (let i = 0; i < recs.length; i++) {
    if (!recs[i]) continue;
    n++;
    // A rename or copy carries its old path in the next field.
    if (/^[RC]/.test(recs[i])) i++;
  }
  return n;
}
