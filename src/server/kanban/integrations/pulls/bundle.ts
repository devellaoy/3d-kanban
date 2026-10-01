// Which pull requests of a project belong together (a "bundle"): the PRs of one task (the ones
// linked to it, and those from its branches), those from the same head branch in any of the
// project's repositories, or those naming the same ticket in their title or branch. Pure, so the
// rules are tested without GitHub.

import type { GhPull } from '../../../../shared/protocol.js';
import { sameRepo } from '../../../../shared/floors.js';
import type { KanbanPrBundleItem, KanbanPrLink, KanbanTask, ProjectRepo } from '../../../../shared/kanban/types.js';

/** A project repository's pull requests, as the board (or gh) listed them. */
export interface RepoPulls {
  /** owner/name. */
  repo: string;
  /** ProjectRepo.id. */
  repoId: string;
  pulls: Pick<GhPull, 'number' | 'title' | 'url' | 'state' | 'isDraft' | 'headRefName'>[];
}

export type BundleBy = { taskId?: number; branch?: string; ticket?: string };

export function prState(p: Pick<GhPull, 'state' | 'isDraft'>): KanbanPrLink['state'] {
  const s = String(p.state).toUpperCase();
  if (s === 'MERGED' || s === 'CLOSED') return s;
  return p.isDraft ? 'DRAFT' : 'OPEN';
}

/**
 * The ticket as it would show in a PR's title or branch: a Jira-style key (UYT-1415) as it is, a
 * GitHub issue's number is too common a word to match by. Undefined when it can't be matched by text.
 */
export function ticketToken(ticket: string | undefined): string | undefined {
  const t = ticket?.trim();
  if (!t) return undefined;
  if (/^gh[p]?:/i.test(t)) return undefined;
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t) ? t : undefined;
}

/** Whether a title or branch names the ticket, as a whole word (UYT-14 doesn't match UYT-145). */
export function mentionsTicket(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}(?![0-9])`, 'i').test(text);
}

/**
 * The tasks a PR is linked to among `links`: by repository (a link without one, through its repoId:
 * `remoteOf`) and number, or by URL. Unlike KanbanRepository.tasksOfPr it finds links made without a repository.
 */
export function prOwners(links: (Pick<KanbanPrLink, 'repoId' | 'repo' | 'number' | 'url'> & { taskId: number })[], remoteOf: (repoId: string) => string | undefined, repo: string, number: number, url: string): number[] {
  const ids = new Set<number>();
  for (const l of links) {
    const r = l.repo ?? remoteOf(l.repoId);
    if ((l.number === number && !!r && sameRepo(r, repo)) || (!!l.url && l.url === url)) ids.add(l.taskId);
  }
  return [...ids];
}

/** A PR the board lists that belongs to a task by its branch. */
export interface BranchPr {
  taskId: number;
  repoId: string;
  /** The project repository's owner/name. */
  repo: string;
  branch: string;
  pull: Pick<GhPull, 'number' | 'url' | 'state' | 'isDraft'>;
}

/** Branches that are nobody's work: a PR from one is a release or a fork's, not a task's. */
const INTEGRATION_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

/**
 * The PRs (open, draft or merged, not closed) whose head branch is an active task's branch in that
 * repository (the primary repository's falls back to the task's own `branch`), for PRs no task has
 * yet (`linked`). Done and archived tasks own no branch. A branch two active tasks share is
 * nobody's. Integration branches (main, master, develop, dev, trunk) are skipped; a task's branch
 * another PR is stacked on stays its. `home` is the primary remote, the repository of a board item
 * that names none.
 */
export function branchPrs(
  tasks: (Pick<KanbanTask, 'id' | 'branch' | 'status'> & { branches?: Record<string, string> })[],
  pulls: (Pick<GhPull, 'number' | 'url' | 'state' | 'isDraft'> & { repo?: string; headRefName?: string })[],
  repos: Pick<ProjectRepo, 'id' | 'remote' | 'primary'>[],
  home: string | undefined,
  linked: (repo: string, number: number, url: string) => boolean,
): BranchPr[] {
  const repoOf = (p: { repo?: string }) => {
    const repo = p.repo ?? home;
    return repo ? repos.find((x) => x.remote && sameRepo(x.remote, repo)) : undefined;
  };
  const owners = new Map<string, Set<number>>();
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'archived') continue;
    for (const r of repos) {
      const branch = t.branches?.[r.id] ?? (r.primary ? t.branch : undefined);
      if (!r.remote || !branch) continue;
      const key = `${r.id}\n${branch}`;
      owners.set(key, (owners.get(key) ?? new Set()).add(t.id));
    }
  }
  const out: BranchPr[] = [];
  const seen = new Set<string>();
  for (const p of pulls) {
    const r = repoOf(p);
    if (!r?.remote || !p.headRefName || prState(p) === 'CLOSED') continue;
    if (INTEGRATION_BRANCHES.has(p.headRefName.toLowerCase())) continue;
    const ids = owners.get(`${r.id}\n${p.headRefName}`);
    const key = `${r.id}#${p.number}`;
    if (ids?.size !== 1 || seen.has(key) || linked(r.remote, p.number, p.url)) continue;
    seen.add(key);
    out.push({ taskId: [...ids][0], repoId: r.id, repo: r.remote, branch: p.headRefName, pull: p });
  }
  return out;
}

/**
 * The bundle. `task` (with its links and per-repository branches) for a task's bundle; `tasksOf`
 * says which task each PR belongs to, for the list.
 */
export function findBundle(
  lists: RepoPulls[],
  by: BundleBy,
  task?: Pick<KanbanTask, 'id' | 'branch' | 'ticket' | 'prs'> & { branches?: Record<string, string> },
  tasksOf?: (repo: string, number: number) => number | undefined,
): KanbanPrBundleItem[] {
  const out = new Map<string, KanbanPrBundleItem>();
  const add = (l: RepoPulls, p: RepoPulls['pulls'][number]) => {
    const key = `${l.repo.toLowerCase()}#${p.number}`;
    if (out.has(key)) return;
    const taskId = tasksOf?.(l.repo, p.number);
    out.set(key, {
      repo: l.repo,
      number: p.number,
      url: p.url,
      title: p.title,
      state: prState(p),
      ...(p.headRefName ? { branch: p.headRefName } : {}),
      repoId: l.repoId,
      ...(taskId !== undefined ? { taskId } : {}),
    });
  };
  let branches = new Set<string>();
  let token: string | undefined;
  let links: KanbanPrLink[] = [];
  if (by.taskId !== undefined) {
    if (!task) return [];
    links = task.prs;
    for (const b of [task.branch, ...Object.values(task.branches ?? {}), ...task.prs.map((p) => p.branch)]) if (b) branches.add(b);
    token = ticketToken(task.ticket);
  } else if (by.branch) branches = new Set([by.branch]);
  else if (by.ticket) token = ticketToken(by.ticket) ?? by.ticket.trim();
  for (const l of lists) {
    for (const p of l.pulls) {
      const linked = links.some((k) => k.number === p.number && (k.repo ? k.repo.toLowerCase() === l.repo.toLowerCase() : k.repoId === l.repoId));
      if (linked || (p.headRefName && branches.has(p.headRefName)) || (token && (mentionsTicket(p.title, token) || mentionsTicket(p.headRefName ?? '', token)))) add(l, p);
    }
  }
  // Linked PRs the lists don't have (closed long ago, or a repository gh can't list right now).
  for (const k of links) {
    if (!k.repo) continue;
    const key = `${k.repo.toLowerCase()}#${k.number}`;
    if (!out.has(key)) out.set(key, { repo: k.repo, number: k.number, url: k.url, title: `PR #${k.number}`, state: k.state, ...(k.branch ? { branch: k.branch } : {}), repoId: k.repoId, ...(task ? { taskId: task.id } : {}) });
  }
  return [...out.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}
