// The lounge figures (docs/kanban-architecture.md §6): a floor's tasks on hold, as the 3D office shows
// them by the TV. The server sends a floor's list to the people on it whenever it changes, and with
// the floor when someone arrives (FloorView.kanbanLounge).

import { sortFigures, type LoungeFigure } from '../../shared/kanban/lounge.js';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { KanbanRepository } from './db/repository.js';

/** The look of a figure whose task has no remembered worker. */
export const LOUNGE_NEUTRAL_COLOR = '#8d99ae';

/** A held task as its figure. */
export function figureOf(t: KanbanTask): LoungeFigure | undefined {
  if (t.status !== 'on_hold' || !t.hold) return undefined;
  return { taskId: t.id, title: t.title, name: t.hold.worker?.name ?? 'Worker', color: t.hold.worker?.color ?? LOUNGE_NEUTRAL_COLOR, ...(t.hold.note ? { note: t.hold.note } : {}), ...(t.hold.until !== undefined ? { until: t.hold.until } : {}), at: t.hold.at };
}

/** The figures of one floor (its project's tasks on hold), oldest hold first. */
export function loungeFigures(repo: Pick<KanbanRepository, 'tasksWhere'>, floorId: string): LoungeFigure[] {
  const out: LoungeFigure[] = [];
  for (const t of repo.tasksWhere({ status: ['on_hold'] })) {
    const f = t.project === floorId ? figureOf(t) : undefined;
    if (f) out.push(f);
  }
  return sortFigures(out);
}

/** Sends a floor's figures when they differ from what its people were last sent. */
export class LoungeSender {
  private sent = new Map<string, string>();

  constructor(
    private repo: Pick<KanbanRepository, 'tasksWhere'>,
    private toFloor: ((floorId: string, msg: KanbanServerMsg) => void) | undefined,
  ) {}

  /** A task of `floorId` was added, changed or removed. */
  changed(floorId: string) {
    const figures = loungeFigures(this.repo, floorId);
    const sig = JSON.stringify(figures);
    // A floor nothing was sent to since the start always gets its first message (a browser may have been shown figures this one doesn't know of).
    if (this.sent.get(floorId) === sig) return;
    this.sent.set(floorId, sig);
    this.toFloor?.(floorId, { t: 'kanban.lounge', floor: floorId, figures });
  }
}
