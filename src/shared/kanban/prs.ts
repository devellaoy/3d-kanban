// When a task's pull requests can be fixed by its agent (🛠️ Fix PRs): one rule for the task view,
// the PR window's "Fix via task #N" and the engine's `pr` command, so they never disagree.

import { isRunning } from './moves.js';
import type { KanbanPrLink, RunState, TaskStatus, TaskType } from './types.js';

/** What the rule looks at. */
export interface PrSubject {
  type: TaskType;
  status: TaskStatus;
  runState: RunState;
  prs: Pick<KanbanPrLink, 'state'>[];
}

export type FixCheck = { ok: true } | { ok: false; reason: string };

/** The task's pull requests still open (drafts too). */
export function openPrs<T extends Pick<KanbanPrLink, 'state'>>(task: { prs: T[] }): T[] {
  return task.prs.filter((p) => p.state === 'OPEN' || p.state === 'DRAFT');
}

/** Whether the task's agent can be sent to address its open pull requests now; if not, why. */
export function canFixPrs(task: PrSubject): FixCheck {
  const no = (reason: string): FixCheck => ({ ok: false, reason });
  if (task.type === 'investigate') return no('An investigation has no changes to open pull requests for');
  if (isRunning(task)) return no('Stop it first: it is running');
  if (task.status !== 'waiting' && task.status !== 'review' && task.status !== 'done') return no('Pull requests are fixed from Waiting, Review or Done');
  if (!openPrs(task).length) return no('The task has no open pull requests to fix');
  return { ok: true };
}
