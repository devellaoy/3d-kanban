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

/** Runs git in a repository's checkout; rejects when it fails. */
export type GitRunner = (dir: string, args: string[]) => Promise<unknown>;

const execFileP = promisify(execFile);
const FETCH_TIMEOUT_MS = 60_000;

/** The default: git with the office's fetch environment (no prompts for credentials). */
export const runGit: GitRunner = (dir, args) => execFileP('git', [...NO_FSMONITOR, ...args], { cwd: dir, env: fetchEnv(process.env), timeout: FETCH_TIMEOUT_MS });

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
  /** Every pull request whose head was fetched, by `prKey`. */
  fetched: Map<string, FetchedHead>;
  /** The pull requests that are checked out in the reviewer's worktree (the first of each repository, when its fetch worked), by `prKey`. */
  checkedOut: Set<string>;
}

/** A pull request's line in a prompt: its repository and number, title, branch and URL. */
export const prLine = (p: HeadPr) => `- ${p.repo}#${p.number}${p.title ? ` “${p.title}”` : ''}${p.branch ? ` (branch ${p.branch})` : ''} ${p.url ?? `https://github.com/${p.repo}/pull/${p.number}`}`;

export const prKey = (p: Pick<PrRef, 'repo' | 'number'>) => `${p.repo.toLowerCase()}#${p.number}`;

/** The project's git repository the pull request is in. */
const repoOf = (def: FloorDef, p: PrRef): ProjectRepo | undefined => projectRepos(def).find((r) => r.kind === 'git' && !!r.remote && sameRepo(r.remote, p.repo));

/**
 * Fetches one pull request's head (GitHub: its `refs/pull/<n>/head`, which a fork's pull request has too; elsewhere the head branch by
 * name, for a pull request from the same repository) and its base branch, into `repo`'s checkout. Undefined when it can't be fetched.
 */
export async function fetchHead(repo: ProjectRepo, p: HeadPr, git: GitRunner): Promise<FetchedHead | undefined> {
  const github = hostOf(repo.remote) === 'github';
  if (!github && (!p.branch || p.fork)) return undefined;
  const ref = github ? `office-pr/${p.number}` : p.branch!;
  const specs = [`+${github ? `refs/pull/${p.number}/head` : `refs/heads/${p.branch}`}:refs/remotes/origin/${ref}`];
  const base = p.base && p.base !== ref ? p.base : undefined;
  if (base) specs.push(`+refs/heads/${base}:refs/remotes/origin/${base}`);
  try {
    await git(repo.dir, ['fetch', '--quiet', '--no-tags', 'origin', ...specs]);
  } catch {
    return undefined;
  }
  return { ref, ...(base ? { base } : {}), repo };
}

/**
 * Fetches the heads for a review of `prs`: the first pull request of each repository, or every one with `every` (the UI test names each
 * head to check out). Never rejects.
 */
export async function fetchPrHeads(def: FloorDef, prs: HeadPr[], git: GitRunner = runGit, every = false): Promise<PrHeads> {
  const out: PrHeads = { bases: {}, fetched: new Map(), checkedOut: new Set() };
  const first = new Set<string>();
  const jobs = prs.map(async (p) => {
    const repo = repoOf(def, p);
    if (!repo) return;
    const mine = !first.has(repo.id);
    first.add(repo.id);
    if (!mine && !every) return;
    const got = await fetchHead(repo, p, git).catch(() => undefined);
    if (!got) return;
    out.fetched.set(prKey(p), got);
    if (mine) {
      out.checkedOut.add(prKey(p));
      out.bases[path.resolve(repo.dir)] = got.ref;
    }
  });
  await Promise.all(jobs);
  return out;
}

/** How a pull request's line in the review prompt says it is to be read. */
export function readingNote(p: HeadPr, heads: PrHeads, def: FloorDef): string {
  const got = heads.fetched.get(prKey(p));
  const github = !!repoOf(def, p) && hostOf(repoOf(def, p)!.remote) === 'github';
  if (got && heads.checkedOut.has(prKey(p))) {
    const diff = got.base ? `git diff origin/${got.base}...HEAD` : undefined;
    return `Checked out in your worktree of ${got.repo.name}: read its change there${diff ? ` with \`${diff}\`` : github ? ` with \`gh pr diff ${p.number} -R ${p.repo}\`` : ''}.`;
  }
  return github ? `Not checked out (your worktree of its repository is on the base branch): read it with \`gh pr diff ${p.number} -R ${p.repo}\`.` : 'Not checked out (your worktree of its repository is on the base branch): read it with office-pr, as the note about repositories below says.';
}
