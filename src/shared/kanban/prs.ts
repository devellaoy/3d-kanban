// When a task's pull requests can be fixed by its agent (🛠️ Fix PRs): one rule for the task view,
// the PR window's "Fix via task #N" and the engine's `pr` command, so they never disagree.

import { isRunning } from './moves.js';
import type { KanbanPrLink, RunState, TaskStatus, WaitingReason } from './types.js';

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
  if (!prStatusOk(task.status)) return no('Pull requests are fixed from Waiting, Review or Done');
  const open = openPrs(task);
  if (!open.length) return no('The task has no open pull requests to fix');
  if (isFork && open.every((p) => isFork(p) === true)) return no('A pull request from a fork: fix it by hand');
  return { ok: true };
}

/** What the task's PR action does: open the pull requests, fix their review comments and checks, or merge their target branches in and resolve the conflicts. */
export type PrMode = 'create' | 'fix' | 'conflicts';
