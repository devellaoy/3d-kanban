// When a task's pull requests can be fixed by its agent (🛠️ Fix PRs): one rule for the task view,
// the PR window's "Fix via task #N" and the engine's `pr` command, so they never disagree.

import { isRunning } from './moves.js';
import type { KanbanPrLink, RunPhase, RunState, TaskStatus, WaitingReason } from './types.js';

/** What the rule looks at. */
export interface PrSubject<P extends Pick<KanbanPrLink, 'state'> = Pick<KanbanPrLink, 'state'>> {
  status: TaskStatus;
  waitingReason?: WaitingReason;
  runState: RunState;
  prs: P[];
}

export type FixCheck = { ok: true } | { ok: false; reason: string };

/** Branches that are nobody's work: a PR from one is a release or a fork's, never a task's to check out or link. */
export const INTEGRATION_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

/** Where a PR's review stands. */
export type PrReview = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

/** A PR's review: GitHub's decision when it is one of the three, else from the latest opinions (a change request beats an approval); undefined: unknown or none asked. */
export function reviewOf(decision: string | null | undefined, opinions: string[]): PrReview | undefined {
  if (decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED') return decision;
  if (opinions.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  return opinions.includes('APPROVED') ? 'APPROVED' : undefined;
}

/** The marks a PR shows: only an open or draft one has any, and unresolved comments only when there are some. */
export function prMarks(p: { state: KanbanPrLink['state']; review?: PrReview; unresolved?: number }): { review?: PrReview; unresolved?: number } {
  if (p.state !== 'OPEN' && p.state !== 'DRAFT') return {};
  return { ...(p.review ? { review: p.review } : {}), ...(p.unresolved && p.unresolved > 0 ? { unresolved: p.unresolved } : {}) };
}

const REVIEW_WORDS: Record<PrReview, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' };

/** The marks in words, for a tooltip or an aria-label. */
export function prMarkWords(p: { state: KanbanPrLink['state']; review?: PrReview; unresolved?: number }): string[] {
  const m = prMarks(p);
  return [...(m.review ? [REVIEW_WORDS[m.review]] : []), ...(m.unresolved ? [`${m.unresolved} unresolved comment${m.unresolved === 1 ? '' : 's'}`] : [])];
}

/** The task's pull requests still open (drafts too). */
export function openPrs<T extends Pick<KanbanPrLink, 'state'>>(task: { prs: T[] }): T[] {
  return task.prs.filter((p) => p.state === 'OPEN' || p.state === 'DRAFT');
}

/** The columns pull requests are opened and fixed from: the one place the rule lives (the task view, the PR window, the machine, the engine). */
export function prStatusOk(status: TaskStatus): boolean {
  return status === 'waiting' || status === 'review' || status === 'done';
}

/**
 * Whether the task's agent can be sent to address its open pull requests now; if not, why.
 * `isFork` says whether a PR's head is in another repository (undefined: not known); a fork's branch
 * is somebody else's code, so a task whose open PRs are all forks' is refused.
 */
export function canFixPrs<P extends Pick<KanbanPrLink, 'state'>>(task: PrSubject<P>, isFork?: (p: P) => boolean | undefined): FixCheck {
  const no = (reason: string): FixCheck => ({ ok: false, reason });
  if (isRunning(task)) return no('Stop it first: it is running');
  if (task.status === 'waiting' && task.waitingReason === 'agent_asking') return no('The agent is asking in its terminal: answer it first');
  if (task.status === 'on_hold') return no('It is on hold: resume it first');
  if (!prStatusOk(task.status)) return no('Pull requests are worked on from Waiting, Review or Done');
  const open = openPrs(task);
  if (!open.length) return no('The task has no open pull requests to work on');
  if (isFork && open.every((p) => isFork(p) === true)) return no('A pull request from a fork: handle it by hand');
  return { ok: true };
}

/** What the task's PR action does: open the pull requests, fix their review comments and checks, or merge their target branches in and resolve the conflicts. */
export const PR_MODES = ['create', 'fix', 'conflicts'] as const;
export type PrMode = (typeof PR_MODES)[number];

/** The runs of the PR actions. */
export const isPrPhase = (phase: RunPhase): boolean => phase === 'pr' || phase === 'pr-fix' || phase === 'pr-conflicts';

/** Runs that work on each open PR's own branch (Fix PRs, Resolve conflicts). */
export const onPrBranches = (phase: RunPhase): boolean => phase === 'pr-fix' || phase === 'pr-conflicts';
