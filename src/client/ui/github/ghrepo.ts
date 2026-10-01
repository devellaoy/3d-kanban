// A project's PR board lists the pull requests of all its repositories (GhPull.repo), so two cards
// can share a number. For the PR and issue windows (ui/pull.ts) and the desks (main.ts,
// state.ts): which repository a request or WS message goes to, keys that tell `api#5` from the
// primary repository's #5, and lookups by repository and number. No repository: the single-repository behaviour.

import { sameRepo } from '../../../shared/floors';
import type { WorkerInfo } from '../../../shared/protocol';

/** owner/name of an issue or PR: its `repo`, or from its URL (https://github.com/owner/name/pull/12). */
export function repoOfItem(it: { url: string; repo?: string }): string {
  if (typeof it.repo === 'string' && it.repo) return it.repo;
  const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/.exec(it.url);
  return m ? m[1] : '';
}

/** `url` with `repo=owner%2Fname` for one of the project's repositories (the server's ?repo=); unchanged without one. */
export function ghUrl(url: string, repo?: string): string {
  return repo ? `${url}${url.includes('?') ? '&' : '?'}repo=${encodeURIComponent(repo)}` : url;
}

/** `{ repo }` to spread into a gh.* WS message for one of the project's repositories; nothing without one. */
export function ghRepoField(repo?: string): { repo?: string } {
  return repo ? { repo } : {};
}

/** A waiter's key: what, which number and (when known) which repository, e.g. `pull:5@owner/api`. */
export function ghKey(kind: string, number: number, repo?: string): string {
  return `${kind}:${number}${repo ? `@${repo.toLowerCase()}` : ''}`;
}

/**
 * The waiter a gh.merged / gh.commented / gh.closed / gh.labeled reply is for. A reply naming its
 * repository gets that one's (or, failing that, one sent without a repository). The office's replies
 * don't name it today, so one without gets the first waiter for the kind and number, whichever
 * repository: only one such request is ever in flight at a time in practice.
 */
export function ghWaiter<T>(waiters: Map<string, T>, kind: string, number: number, repo?: string): T | undefined {
  const base = ghKey(kind, number);
  if (repo) return waiters.get(ghKey(kind, number, repo)) ?? waiters.get(base);
  for (const [k, w] of waiters) if (k === base || k.startsWith(`${base}@`)) return w;
  return undefined;
}

/**
 * The `repo` a board item or a server reply names, only when it names one: an item of a project's
 * multi-repo board (GhPull.repo), or a reply that says which repository it's about (upstream's don't).
 */
export function namedRepo(v: object): string | undefined {
  const r = (v as { repo?: unknown }).repo;
  return typeof r === 'string' && r ? r : undefined;
}

/** A window's label for an item: `api#5` for one with a repository, `#5` without (upstream's). */
export function ghLabel(number: number, repo?: string): string {
  return repo ? `${repo.split('/').pop() || repo}#${number}` : `#${number}`;
}

/** Whether two board items are the same issue or PR: the same number in the same repository. */
export function sameItem(a: { number: number; url: string; repo?: string }, b: { number: number; url: string; repo?: string }): boolean {
  if (a.number !== b.number) return false;
  const ra = repoOfItem(a);
  const rb = repoOfItem(b);
  return !ra || !rb || sameRepo(ra, rb);
}

/** The board's card for number `number` of `repo`; by number alone when the repository isn't known. */
export function findItem<T extends { number: number; url: string; repo?: string }>(items: readonly T[], number: number, repo?: string): T | undefined {
  return items.find((it) => it.number === number && (!repo || sameRepo(repoOfItem(it), repo)));
}

/** The repository a worker's own-floor pull request (WorkerInfo.pr) is in: off its URL, else the floor's. */
export function ownPullRepo(pr: { url: string }, primary?: string): string | undefined {
  return repoOfItem(pr) || primary || undefined;
}

/**
 * The worker a pull request of `repo` came from: its own floor's PR (WorkerInfo.pr) in the floor's
 * repository `primary`, one of its other repositories' (WorkerRepo.pr), or the branch it works on in
 * that repository. Upstream's workerForPull goes by number or branch alone, which would take another
 * repository's #5 for this one's.
 */
export function workerForRepoPull(workers: Iterable<WorkerInfo>, pr: { number: number; headRefName: string }, repo: string, primary?: string): WorkerInfo | undefined {
  // Without the floor's repository, a PR is taken as the floor's own (as upstream).
  const own = !primary || sameRepo(primary, repo);
  for (const w of workers) {
    if (w.pr?.number === pr.number && sameRepo(ownPullRepo(w.pr, primary) ?? repo, repo)) return w;
    if (own && w.worktree && w.worktree.branch === pr.headRefName) return w;
    for (const r of w.repos ?? []) {
      const rRepo = r.repo || (r.pr ? repoOfItem(r.pr) : '');
      if (!sameRepo(rRepo, repo)) continue;
      if (r.pr?.number === pr.number || r.branch === pr.headRefName) return w;
    }
  }
  return undefined;
}
