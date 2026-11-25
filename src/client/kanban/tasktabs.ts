// The worker tabs of a task worker's terminal window (ui/termtabs.ts setSiblings): one per worker of
// the task, so the implementer's and every reviewer's terminal is a click away. A review round runs the
// main reviewer and up to four additional ones side by side; each is a worker with a terminal of its own.
// The list is plain data (no DOM, no store), and `watchTaskSiblings` keeps it up to date from whatever
// holds the workers (the page's store, through worker3d.ts).

import type { KanbanWorkerSummary } from '../../shared/kanban/types.js';

/** A worker as the list reads it; `tool` is its agent's name as the window's title says it ("Claude"). */
export interface TaskTabWorker {
  id: string;
  name: string;
  kanban?: Pick<KanbanWorkerSummary, 'taskId' | 'role' | 'seat'>;
  tool?: string;
}

/** One tab: the same shape ui/termtabs.ts draws. */
export interface TaskSibling {
  workerId: string;
  label: string;
  title: string;
}

/** A reviewer's seat: 0 for the main reviewer (no seat, or 0), 1..4 for an additional one. */
const seatOf = (w: TaskTabWorker) => (w.kanban?.seat && w.kanban.seat > 0 ? w.kanban.seat : 0);
/** Where a worker's tab goes: the implementer, the main reviewer, then the additional reviewers by seat. */
const rank = (w: TaskTabWorker) => (w.kanban?.role === 'reviewer' ? 1 + seatOf(w) : 0);

function sibling(w: TaskTabWorker): TaskSibling {
  if (w.kanban?.role !== 'reviewer') return { workerId: w.id, label: 'Terminal', title: `${w.name} · implementer` };
  const seat = seatOf(w);
  // The main reviewer is the first; an additional one is numbered from 2 (its seat + 1).
  const who = seat ? `Reviewer ${seat + 1}` : 'Reviewer';
  return { workerId: w.id, label: w.tool ? `${who} · ${w.tool}` : who, title: `${w.name} · ${seat ? `reviewer ${seat + 1}` : 'main reviewer'}` };
}

/**
 * The tabs for the window of worker `selfId`: every worker on the same task, in order. Empty when
 * the worker has no task, isn't among `workers`, or is the task's only worker (the plain row stays).
 */
export function taskSiblings(selfId: string, workers: Iterable<TaskTabWorker>): TaskSibling[] {
  const all = [...workers];
  const taskId = all.find((w) => w.id === selfId)?.kanban?.taskId;
  if (taskId === undefined) return [];
  const team = all.filter((w) => w.kanban?.taskId === taskId);
  if (team.length < 2) return [];
  // A stable sort: two workers of one rank keep the order they came in.
  return team.sort((a, b) => rank(a) - rank(b)).map(sibling);
}

/** Where the workers are, and how to hear that they changed (hands back the way to stop). */
export interface TaskTabSource {
  workers(): Iterable<TaskTabWorker>;
  onChange(fn: () => void): () => void;
}

/**
 * Keeps `apply` told of worker `selfId`'s tabs while its window is open: now, and whenever a worker
 * of its task arrives, leaves or changes its name. Hands back the way to stop.
 */
export function watchTaskSiblings(selfId: string, source: TaskTabSource, apply: (list: TaskSibling[]) => void): () => void {
  let last = '';
  const update = () => {
    const list = taskSiblings(selfId, source.workers());
    const key = JSON.stringify(list);
    if (key === last) return; // the workers topic fires on every status change: the row is redrawn only when it differs
    last = key;
    apply(list);
  };
  update();
  return source.onChange(update);
}
