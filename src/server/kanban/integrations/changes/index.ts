// A task's changes without its worker (the detail's Changes tab): per repository, the whole change
// against its base, its commits and each commit's own diff, and while a workspace exists its
// uncommitted work. Read from the task's worktrees when they are there, else from the task's branch
// in the project's own checkout (`origin/<base>...<branch>`, or the local base when origin has none).
// Anyone signed in to the kanban may read these, as they may open the Changes window.
//
//   GET /api/kanban/tasks/<id>/changes                      → KanbanChangesList
//   GET /api/kanban/tasks/<id>/changes?repo=<repoId>        → KanbanRepoChanges
//   GET /api/kanban/tasks/<id>/commits?repo=<repoId>        → KanbanCommitList
//   GET /api/kanban/tasks/<id>/commit?repo=<repoId>&hash=<sha> → KanbanCommitChanges
//   GET /api/kanban/tasks/<id>/uncommitted?repo=<repoId>     → KanbanUncommitted (git status only)
//
// Git runs read-only, with argument lists and timeouts. The only network is a `git fetch` of the
// project's checkout, started in the background at most every few minutes and never waited for: the
// answer uses what the checkout knows now, and the next one sees what the fetch brought.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import type { KanbanChangesList, KanbanCommitChanges, KanbanCommitList, KanbanRepoChanges, KanbanUncommitted, KanbanRepoChangesInfo, KanbanTask, ProjectRepo } from '../../../../shared/kanban/types.js';
import { PROJECT_ID_RE, REPO_ID_RE } from '../../../../shared/kanban/protocol.js';
import { repoFloorId } from '../../projects.js';
import { sendJson } from '../util.js';
import { HASH_RE, REF_RE, branchOf, commitDiff, commitOf, commitsIn, diffRange, firstCommit, originHead, uncommittedCount, workingTree } from './git.js';
import { worktreeDir } from '../../../worktree-home.js';

const ROUTE_RE = /^\/api\/kanban\/tasks\/(\d{1,12})\/(changes|commits|commit|uncommitted)$/;
/** A checkout is fetched at most this often. */
const FETCH_EVERY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;

export interface ChangesOptions {
  /** Whether the project's checkout may be fetched in the background (tests turn it off). */
  fetch?: boolean;
}

/** Where one repository of a task is read from, worked out. */
export interface Located {
  info: KanbanRepoChangesInfo;
  dir?: string;
  baseSha?: string;
  headSha?: string;
  /** Read from the task's worktree (which then has uncommitted work to show). */
  worktree: boolean;
}

/** The repositories a task works in: its subset (the primary always in), and any it has a branch in. */
export function taskRepos(ctx: KanbanContext, task: KanbanTask): ProjectRepo[] {
  const all = ctx.repos(task.project);
  const branches = ctx.repo.repoBranches(task.id);
  return all.filter((r) => r.primary || !task.repoIds || task.repoIds.includes(r.id) || !!branches[r.id]);
}

/** The worktree of `repo` in the task's workspace, when there is one on disk. */
function worktreeOf(ctx: KanbanContext, task: KanbanTask, repo: ProjectRepo): { dir: string; base?: string; branch?: string; from?: string } | undefined {
  const ws = task.workspace;
  const floorDir = ctx.project(task.project)?.dir;
  if (!ws || !floorDir) return undefined;
  const w = repo.primary ? ws.worktree : ws.repos?.find((r) => r.floor === repoFloorId(task.project, repo.id));
  if (!w) return undefined;
  const dir = worktreeDir(floorDir, w.path);
  return existsSync(dir) ? { dir, base: w.base, branch: w.branch, from: w.from } : undefined;
}

/** Works out where `repo`'s change is and what it's measured against. */
export async function locate(ctx: KanbanContext, task: KanbanTask, repo: ProjectRepo, kick?: (dir: string) => void): Promise<Located> {
  const base: KanbanRepoChangesInfo = { id: repo.id, name: repo.name, ...(repo.primary ? { primary: true } : {}), source: 'checkout' };
  if (repo.kind !== 'git') return { info: { ...base, error: 'A folder repository has no git history to show' }, worktree: false };
  const wt = worktreeOf(ctx, task, repo);
  if (wt) {
    const branch = (await branchOf(wt.dir)) ?? wt.branch;
    const info: KanbanRepoChangesInfo = { ...base, source: 'worktree', ...(branch ? { branch } : {}) };
    const headSha = await commitOf(wt.dir, 'HEAD');
    if (!headSha) return { info: { ...info, error: "git can't read the worktree" }, dir: wt.dir, worktree: true };
    const baseBranch = repo.baseBranch ?? wt.from ?? (await originHead(wt.dir));
    const b = await firstCommit(wt.dir, [baseBranch && `origin/${baseBranch}`, baseBranch, wt.base]);
    return { info: { ...info, headCommit: headSha, ...(b ? { base: b.ref === wt.base ? b.ref.slice(0, 12) : b.ref, baseCommit: b.sha } : { error: 'Its base branch is unknown' }) }, dir: wt.dir, baseSha: b?.sha, headSha, worktree: true };
  }
  const dir = repo.dir;
  if (!existsSync(dir)) return { info: { ...base, error: `${dir} isn't there` }, worktree: false };
  const branch = ctx.repo.repoBranches(task.id)[repo.id] ?? (repo.primary ? task.branch : undefined) ?? task.prs.find((p) => p.repoId === repo.id)?.branch;
  if (!branch || !REF_RE.test(branch)) return { info: { ...base, error: 'It has no branch yet' }, dir, worktree: false };
  kick?.(dir);
  const head = await firstCommit(dir, [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]);
  const info: KanbanRepoChangesInfo = { ...base, branch };
  if (!head) return { info: { ...info, error: `The branch ${branch} isn't in ${repo.name}'s checkout (or on its origin)` }, dir, worktree: false };
  const baseBranch = repo.baseBranch ?? (await originHead(dir)) ?? (await branchOf(dir));
  const b = await firstCommit(dir, [baseBranch && `origin/${baseBranch}`, baseBranch]);
  if (!b) return { info: { ...info, headCommit: head.sha, error: 'Its base branch is unknown' }, dir, headSha: head.sha, worktree: false };
  return { info: { ...info, headCommit: head.sha, base: b.ref, baseCommit: b.sha }, dir, baseSha: b.sha, headSha: head.sha, worktree: false };
}

export function createChangesPlugin(ctx: KanbanContext, opts: ChangesOptions = {}): KanbanPlugin {
  const fetchedAt = new Map<string, number>();
  /** A background `git fetch` of a project checkout, never waited for and never more often than FETCH_EVERY_MS. */
  const kick = (dir: string) => {
    if (opts.fetch === false) return;
    const now = Date.now();
    if (now - (fetchedAt.get(dir) ?? 0) < FETCH_EVERY_MS) return;
    fetchedAt.set(dir, now);
    try {
      const child = spawn('git', ['fetch', '--quiet', '--no-tags', 'origin'], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore', detached: false });
      const timer = setTimeout(() => child.kill('SIGKILL'), FETCH_TIMEOUT_MS);
      timer.unref?.();
      child.on('error', () => clearTimeout(timer));
      child.on('close', () => clearTimeout(timer));
      child.unref();
    } catch {
      // no git: the answer says what the checkout knows
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const m = ROUTE_RE.exec(url.pathname);
    if (!m) return false;
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' }), true;
    const task = ctx.repo.getTask(Number(m[1]));
    if (!task) return sendJson(res, 404, { error: `There's no task #${m[1]}` }), true;
    const repos = taskRepos(ctx, task);
    const repoParam = url.searchParams.get('repo');
    if (m[2] === 'changes' && repoParam === null) {
      const list: KanbanChangesList = { taskId: task.id, project: task.project, repos: await Promise.all(repos.map(async (r) => (await locate(ctx, task, r, kick)).info)) };
      return sendJson(res, 200, list), true;
    }
    if (!repoParam || !(REPO_ID_RE.test(repoParam) || PROJECT_ID_RE.test(repoParam))) return sendJson(res, 400, { error: 'repo must be one of the task’s repository ids' }), true;
    const repo = repos.find((r) => r.id === repoParam);
    if (!repo) return sendJson(res, 404, { error: `${repoParam} isn't one of task #${task.id}'s repositories` }), true;
    const hash = url.searchParams.get('hash');
    if (m[2] === 'commit' && (!hash || !HASH_RE.test(hash))) return sendJson(res, 400, { error: 'hash must be a commit id (7 to 40 hex digits)' }), true;
    const at = await locate(ctx, task, repo, kick);
    try {
      if (m[2] === 'uncommitted') {
        const out: KanbanUncommitted = { taskId: task.id, repo: repo.id, uncommitted: at.worktree && at.dir ? await uncommittedCount(at.dir) : null };
        return sendJson(res, 200, out), true;
      }
      if (m[2] === 'changes') {
        const whole = at.dir && at.baseSha && at.headSha ? await diffRange(at.dir, [`${at.baseSha}...${at.headSha}`]) : { files: [], diff: '', truncated: false };
        const out: KanbanRepoChanges = { taskId: task.id, ...at.info, ...whole, workingTree: at.worktree && at.dir ? await workingTree(at.dir) : null };
        return sendJson(res, 200, out), true;
      }
      const commits = at.dir && at.baseSha && at.headSha ? await commitsIn(at.dir, at.baseSha, at.headSha) : [];
      if (m[2] === 'commits') {
        let uncommitted: number | null = null;
        if (at.worktree && at.dir) uncommitted = (await workingTree(at.dir, 1)).files.length;
        const out: KanbanCommitList = { taskId: task.id, ...at.info, commits, uncommitted };
        return sendJson(res, 200, out), true;
      }
      // Only a commit of the task's own range: nothing else of the repository is shown this way.
      const matches = commits.filter((c) => c.hash.startsWith(hash!));
      if (matches.length > 1) return sendJson(res, 400, { error: `${hash} is more than one of the task's commits: give more of it` }), true;
      const commit = matches[0];
      if (!commit || !at.dir) return sendJson(res, 404, { error: `${hash} isn't one of task #${task.id}'s commits in ${repo.name}` }), true;
      const out: KanbanCommitChanges = { taskId: task.id, repo: repo.id, commit, ...(await commitDiff(at.dir, commit.hash)) };
      return sendJson(res, 200, out), true;
    } catch (err) {
      return sendJson(res, 200, { taskId: task.id, ...at.info, error: `git couldn't say: ${(err as Error).message}`, files: [], diff: '', truncated: false, ...(m[2] === 'changes' ? { workingTree: null } : m[2] === 'commits' ? { commits: [], uncommitted: null } : {}) }), true;
    }
  };

  return { name: 'changes', http: { '/api/kanban/tasks/': (req, res, url) => handle(req, res, url) } };
}
