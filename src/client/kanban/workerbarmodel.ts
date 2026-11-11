// The kanban page's bar of plain workers, without the DOM (workerbar.ts): which workers it shows, in
// what order, a tab's name and tooltip, and whether the bar has tabs at all.

import { DESK_BY_ID } from '../../shared/layout';
import type { WorkerInfo } from '../../shared/protocol';

/** A worker the bar shows: not a kanban task's, not a board agent at its kiosk, not a meeting's. Shells are in. */
export function isPlainWorker(w: WorkerInfo): boolean {
  return !w.kanban && !w.meeting && !DESK_BY_ID.get(w.deskId)?.station;
}

/** The bar's workers, oldest first (by id when hired in the same ms), so a tab never jumps. */
export function barWorkers(workers: Iterable<WorkerInfo>): WorkerInfo[] {
  return [...workers].filter(isPlainWorker).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

/** A tab's tooltip: the name, then what it's on (when it is on something), and 🐚 shell for a shell. */
export function tabTitle(w: WorkerInfo): string {
  const work = w.task?.name ?? w.title;
  return [w.name, work, w.kind === 'shell' ? '🐚 shell' : undefined].filter(Boolean).join(' · ');
}

export type BarState = 'tabs' | 'elsewhere' | 'none';

/** What the bar shows: 'none' with no project floor under the page (the roof), 'elsewhere' when the board's picked project isn't the floor the page is on, else 'tabs'. boardProject null = "All projects". */
export function barState(boardProject: string | null, floor: string | null | undefined, hasProject: boolean): BarState {
  if (!hasProject) return 'none';
  return boardProject !== null && boardProject !== floor ? 'elsewhere' : 'tabs';
}
