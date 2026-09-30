// Which columns a task can be dragged to by hand (docs/kanban-architecture.md §3). Pure: the board
// uses it to show where a card can go, and the server enforces the same rules.

import type { RunState, TaskStatus } from './types.js';

/** What the rules look at: where the task is, whether the engine is busy with it, whether a worker sits on it. */
export interface MoveSubject {
  status: TaskStatus;
  runState: RunState;
  /** A worker (implementer or reviewer) is still hired for it. */
  hasWorker: boolean;
}

/**
 * What a move does. `start`: todo → in_progress starts the task (the engine's start). `reset`: back
 * to todo, the automation's state cleared, to start over. `status`: only the column changes.
 */
export type MoveAction = 'start' | 'reset' | 'status';

export type MoveCheck = { ok: true; action: MoveAction } | { ok: false; reason: string };

const COLUMN: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  review: 'Review',
  done: 'Done',
  archived: 'Archive',
};

/** Whether the engine is working on it: a run under way, starting, queued or being stopped. */
export function isRunning(t: Pick<MoveSubject, 'status' | 'runState'>): boolean {
  return t.status === 'in_progress' || t.runState !== 'idle';
}

/** Whether `task` can be moved to `to` by hand, and what the move does. */
export function checkMove(task: MoveSubject, to: TaskStatus): MoveCheck {
  const from = task.status;
  const no = (reason: string): MoveCheck => ({ ok: false, reason });
  if (from === to) return no(`It's already in ${COLUMN[to]}`);
  if ((from === 'todo' && to === 'done') || (from === 'done' && to === 'todo')) return no('A task goes to Done only once it has been worked on: start it, or archive it');
  if (to === 'archived') return isRunning(task) ? no('Stop it first: it is running') : { ok: true, action: 'status' };
  if (from === 'todo' && to === 'in_progress') return { ok: true, action: 'start' };
  if ((from === 'waiting' || from === 'review') && to === 'done') return { ok: true, action: 'status' };
  if (from === 'done' && to === 'review') return { ok: true, action: 'status' };
  if (from === 'archived' && to === 'done') return { ok: true, action: 'status' };
  if ((from === 'waiting' || from === 'review') && to === 'todo') {
    if (isRunning(task)) return no('Stop it first: it is running');
    return task.hasWorker ? no('Send its worker home first (Release), then it can start over') : { ok: true, action: 'reset' };
  }
  if (from === 'in_progress') return no('It is running: stop it first');
  if (to === 'in_progress') return no('Use Continue, Retry or a comment to put it back to work');
  if (to === 'waiting') return no('Only the automation moves a task to Waiting');
  if (to === 'review') return no('Only the automation moves a task to Review');
  return no(`It can't go from ${COLUMN[from]} to ${COLUMN[to]}`);
}

/** Every column `task` can be dragged to. */
export function moveTargets(task: MoveSubject): TaskStatus[] {
  const all: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'review', 'done', 'archived'];
  return all.filter((to) => checkMove(task, to).ok);
}

/** A column's name for people. */
export function columnName(status: TaskStatus): string {
  return COLUMN[status];
}
