// What Resume does to a task on hold and what a comment does to a task, in words: the tooltips and the
// hint the task view shows (taskactionbar.ts, taskconv.ts). No DOM here, so the tests read them as they are.

import { isRunning } from '../../shared/kanban/moves.js';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { columnName } from './labels';

/** Where Resume puts a task on hold: the column it was held from (Waiting for a hold that doesn't say). */
export function resumeTarget(task: Pick<KanbanTask, 'hold'>): 'waiting' | 'review' {
  return task.hold?.from === 'review' ? 'review' : 'waiting';
}

/** Resume's tooltip: it only changes the state. */
export function resumeTitle(task: Pick<KanbanTask, 'hold'>): string {
  return `Take it off hold: it goes back to ${columnName(resumeTarget(task))}, nothing starts`;
}

/** What sending a comment does to the task as it is now (docs/kanban.md, "Comments"): Send's tooltip. */
export function sendTitle(task: Pick<KanbanTask, 'status' | 'runState'>): string {
  if (task.status === 'todo' || task.status === 'done' || task.status === 'archived') return 'Add the comment to the task: it is kept with it, and no agent starts';
  if (task.status === 'on_hold') return 'Add the comment: the task comes off hold and the agent goes back to work with it';
  if (isRunning(task)) return 'Add the comment: the agent gets it in its terminal now, or at its next rest when it can’t take it yet';
  return 'Add the comment: the agent takes it and goes back to work';
}

/** The same in a few words, beside the comment box. */
export function commentNote(status: KanbanTask['status']): string {
  if (status === 'todo' || status === 'done') return 'a comment is kept with the task';
  if (status === 'on_hold') return 'a comment takes it off hold and starts the agent';
  return 'a comment puts the agent back to work';
}
