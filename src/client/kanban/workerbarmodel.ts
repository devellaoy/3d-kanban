// The kanban page's bar of workers and meeting rooms, without the DOM (workerbar.ts): which workers and
// rooms it shows a tab for, in what order, a tab's name and tooltip, and whether the bar has tabs at all.

import { DESK_BY_ID } from '../../shared/layout';
import type { Meeting, MeetingState, WorkerInfo } from '../../shared/protocol';
import { shownStatus } from '../../shared/status';

/** A worker the bar always shows: not a kanban task's, not a board agent at its kiosk, not a meeting's. Shells are in. */
export function isPlainWorker(w: WorkerInfo): boolean {
  return notKanbanOrStation(w) && !w.meeting;
}

/** Not a kanban task's worker and not a board agent at its kiosk (what both kinds of tab need). */
const notKanbanOrStation = (w: WorkerInfo) => !w.kanban && !DESK_BY_ID.get(w.deskId)?.station;

/**
 * The bar's workers, oldest first (by id when hired in the same ms), so a tab never jumps. A meeting's
 * worker is in only when no room tab `covers` it (e.g. it was left without a meeting by a restart), so it stays reachable.
 */
export function barWorkers(workers: Iterable<WorkerInfo>, covered: ReadonlySet<string> = new Set()): WorkerInfo[] {
  return [...workers]
    .filter((w) => notKanbanOrStation(w) && (!w.meeting || !covered.has(w.id)))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A meeting room's tab: its meeting and the workers still at its table. */
export interface BarRoom {
  id: string;
  label: string;
  title: string;
  status: Meeting['status'];
  /** The ids of the table's workers that are still in the office, in seat order. */
  workers: string[];
  /** Any of them waits on an answer. */
  needsInput: boolean;
}

/**
 * The rooms the bar shows a tab for: those whose meeting still has a worker at the table, in room order.
 * Not filtered by the floor's map: a room the map no longer has still gets its tab, so it can be cleared.
 */
export function barRooms(state: Pick<MeetingState, 'rooms'>, workers: ReadonlyMap<string, WorkerInfo>): BarRoom[] {
  const out: BarRoom[] = [];
  for (const r of state.rooms) {
    const m = r.current;
    if (!m) continue;
    const here = m.seats.flatMap((s) => (s.workerId && workers.has(s.workerId) ? [workers.get(s.workerId)!] : []));
    if (!here.length) continue;
    out.push({ id: r.id, label: r.label, title: m.title, status: m.status, workers: here.map((w) => w.id), needsInput: here.some((w) => shownStatus(w) === 'needs_input') });
  }
  return out;
}

/** The longest name a tab shows, its closing "..." included. */
export const TAB_NAME_MAX = 20;

/**
 * A tab's name: what the worker's card says it's on in the 3D office (its task), or the worker's own
 * name, as on its name tag there, while it's on nothing. Cut to TAB_NAME_MAX characters, ending in "...".
 */
export function tabName(w: Pick<WorkerInfo, 'name' | 'task'>): string {
  const chars = [...(w.task?.name || w.name).replace(/\s+/g, ' ').trim()];
  return chars.length > TAB_NAME_MAX ? `${chars.slice(0, TAB_NAME_MAX - 3).join('').trimEnd()}...` : chars.join('');
}

/** A tab's tooltip: the name, then what it's on (when it is on something), and "shell" for a shell. */
export function tabTitle(w: WorkerInfo): string {
  const work = w.task?.name ?? w.title;
  return [w.name, work, w.kind === 'shell' ? 'shell' : undefined].filter(Boolean).join(' · ');
}

export type BarState = 'tabs' | 'elsewhere' | 'none';

/** What the bar shows: 'none' with no project floor under the page (the roof), 'elsewhere' when the board's picked project isn't the floor the page is on, else 'tabs'. boardProject null = "All projects". */
export function barState(boardProject: string | null, floor: string | null | undefined, hasProject: boolean): BarState {
  if (!hasProject) return 'none';
  return boardProject !== null && boardProject !== floor ? 'elsewhere' : 'tabs';
}
