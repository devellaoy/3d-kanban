// The pull requests' heads for a pull-request review: before the reviewer is hired, each repository's checkout fetches the head of
// the first pull request picked in it (and its base branch), and the hire cuts the reviewer's worktree from that head. Any other
// pull request of the repository, and any one whose fetch failed, stays on the configured base: its line in the prompt says to
// read it with gh pr diff. A failed fetch never fails the review. The git call is injectable (tests).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FloorDef } from '../../building.js';
import { sameRepo } from '../../../shared/floors.js';
import { hostOf } from '../../../shared/hosting/remote.js';
import type { PrRef, ProjectRepo } from '../../../shared/kanban/types.js';
import { NO_FSMONITOR } from '../../floor-git.js';
import { fetchEnv } from '../../worktrees.js';
import { projectRepos } from '../projects.js';

/** Runs git in a repository's checkout; rejects when it fails or when `signal` aborts it. */
export type GitRunner = (dir: string, args: string[], signal?: AbortSignal) => Promise<unknown>;

const execFileP = promisify(execFile);
const FETCH_TIMEOUT_MS = 60_000;
/**
 * How long a review waits in all for its pull requests' heads and bases (every repository in parallel): the browser gives up on the
 * answer after 30 s, and the review's start must not outlast that. A fetch not done by then is abandoned for this review.
 */
export const HEADS_DEADLINE_MS = 12_000;

/** The default: git with the office's fetch environment (no prompts for credentials). */
export const runGit: GitRunner = (dir, args, signal) => execFileP('git', [...NO_FSMONITOR, ...args], { cwd: dir, env: fetchEnv(process.env), timeout: FETCH_TIMEOUT_MS, ...(signal ? { signal } : {}) });

/** A pull request as a review request names it: what the pulls plugin looked up of it. */
export type HeadPr = PrRef & { title?: string; url?: string; branch?: string; base?: string; fork?: boolean };

/** One pull request's head, fetched. */
export interface FetchedHead {
  /** The branch name the head is under in the checkout (`refs/remotes/origin/<ref>`): what a worktree is cut from. */
  ref: string;
  /** The pull request's base branch, fetched with it (`refs/remotes/origin/<base>`). */
  base?: string;
  repo: ProjectRepo;
}

export interface PrHeads {
  /** `SpawnExtra.bases` to add to the configured ones: repository checkout (absolute) → the ref its reviewer's worktree is cut from. */
  bases: Record<string, string>;
  /** For a UI test (`every`): each repository's checkout (absolute) → the base branch of the first pull request tested there, fetched, which the tester's worktree is cut from. */
  uiBases: Record<string, string>;
  /** Every pull request whose head was fetched, by `prKey`. */
  fetched: Map<string, FetchedHead>;
  /** The pull requests that are checked out in the reviewer's worktree (the first of each repository, when its fetch worked), by `prKey`. */
  checkedOut: Set<string>;
}

/** A pull request's line in a prompt: its repository and number, title, branch and URL. */
export const prLine = (p: HeadPr) => `- ${p.repo}#${p.number}${p.title ? ` “${p.title}”` : ''}${p.branch ? ` (branch ${p.branch})` : ''} ${p.url ?? `https://github.com/${p.repo}/pull/${p.number}`}`;

export const prKey = (p: Pick<PrRef, 'repo' | 'number'>) => `${p.repo.toLowerCase()}#${p.number}`;

/** The project's git repository the pull request is in. */
export const repoOf = (def: FloorDef, p: PrRef): ProjectRepo | undefined => projectRepos(def).find((r) => r.kind === 'git' && !!r.remote && sameRepo(r.remote, p.repo));

/** Whether the office may check a pull request's code out: only when it is confirmed not to be from a fork. Unknown counts as a fork (an outsider's code, and its agent configuration, must never be run by a mistake). */
export const trusted = (p: Pick<HeadPr, 'fork'>) => p.fork === false;

/** Fetches `base` of the checkout into `refs/remotes/origin/<base>`; false when it can't be. */
export async function fetchBase(repo: ProjectRepo, base: string, git: GitRunner, signal?: AbortSignal): Promise<boolean> {
  try {
    await git(repo.dir, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches one pull request's head (GitHub: its `refs/pull/<n>/head`; elsewhere the head branch by name, for a pull request from the same
 * repository) and its base branch, into `repo`'s checkout. Undefined when it can't be fetched, and for any pull request not confirmed to
 * be from the same repository (`fork: false`): never a fork's code, never one that might be.
 */
export async function fetchHead(repo: ProjectRepo, p: HeadPr, git: GitRunner, signal?: AbortSignal): Promise<FetchedHead | undefined> {
  if (!trusted(p)) return undefined;
  const github = hostOf(repo.remote) === 'github';
  if (!github && !p.branch) return undefined;
  const ref = github ? `office-pr/${p.number}` : p.branch!;
  const specs = [`+${github ? `refs/pull/${p.number}/head` : `refs/heads/${p.branch}`}:refs/remotes/origin/${ref}`];
  const base = p.base && p.base !== ref ? p.base : undefined;
  if (base) specs.push(`+refs/heads/${base}:refs/remotes/origin/${base}`);
  try {
    await git(repo.dir, ['fetch', '--quiet', '--no-tags', 'origin', ...specs], signal);
  } catch {
    return undefined;
  }
  return { ref, ...(base ? { base } : {}), repo };
}

/**
 * Fetches the heads for a review of `prs`: the first pull request of each repository, or every one with `every` (the UI test names each
 * head to check out, and gets each repository's first base). Every repository in parallel, all under one deadline (`ms`): what is not
 * fetched by then is abandoned (its git is aborted) and falls back to gh pr diff. Never rejects.
 */
export async function fetchPrHeads(def: FloorDef, prs: HeadPr[], git: GitRunner = runGit, every = false, ms = HEADS_DEADLINE_MS): Promise<PrHeads> {
  const out: PrHeads = { bases: {}, uiBases: {}, fetched: new Map(), checkedOut: new Set() };
  const first = new Set<string>();
  const stop = new AbortController();
  let open = true;
  const jobs = prs.map(async (p) => {
    const repo = repoOf(def, p);
    if (!repo) return;
    const mine = !first.has(repo.id);
    first.add(repo.id);
    if (!mine && !every) return;
    const got = await fetchHead(repo, p, git, stop.signal).catch(() => undefined);
    // A UI test's worktree starts from the first tested pull request's target, even when its head could not be fetched.
    const base = got?.base ?? (every && mine && trusted(p) && p.base && (await fetchBase(repo, p.base, git, stop.signal)) ? p.base : undefined);
    if (!open) return;
    if (every && mine && base) out.uiBases[path.resolve(repo.dir)] = base;
    if (!got) return;
    out.fetched.set(prKey(p), got);
    if (mine) {
      out.checkedOut.add(prKey(p));
      out.bases[path.resolve(repo.dir)] = got.ref;
    }
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(jobs), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
  open = false;
  stop.abort();
  return out;
}

/** How a pull request's line in the review prompt says it is to be read. */
export function readingNote(p: HeadPr, heads: PrHeads, def: FloorDef): string {
  const got = heads.fetched.get(prKey(p));
  const repo = repoOf(def, p);
  const github = !!repo && hostOf(repo.remote) === 'github';
  if (got && heads.checkedOut.has(prKey(p))) {
    const diff = got.base ? `git diff origin/${got.base}...HEAD` : undefined;
    return `Checked out in your worktree of ${got.repo.name}: read its change there${diff ? ` with \`${diff}\`` : github ? ` with \`gh pr diff ${p.number} -R ${p.repo}\`` : ''}.`;
  }
  const other = [...heads.checkedOut].find((k) => k !== prKey(p) && !!repo && heads.fetched.get(k)?.repo.id === repo.id);
  const why = p.fork === true ? "From a fork, so not checked out (the office never checks out a fork's code)"
    : p.fork === undefined ? 'Not checked out: the office could not confirm it is not from a fork, and never checks out code that might be'
    : other ? `Not checked out: your worktree of its repository has pull request #${other.slice(other.lastIndexOf('#') + 1)}'s head checked out, not this one's`
    : 'Not checked out (your worktree of its repository is on the base branch)';
  return github ? `${why}: read it with \`gh pr diff ${p.number} -R ${p.repo}\`.` : `${why}: read it with office-pr, as the note about repositories below says.`;
}
