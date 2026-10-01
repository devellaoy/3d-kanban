// The 3D office's worker views, as the kanban changes them (docs/kanban-coupling.md): a task worker's
// name tag says which task it is on ("Ada · #14"), and the ⏳ retry countdown on its card ticks down
// between worker updates. The seams are in features/workers/views.ts.

import type { WorkerInfo, WorkerTask } from '../../shared/protocol';
import { store } from '../state';
import type { Worker } from '../world/character';
import { kanbanCard, workerLabel } from './office';

/** The name tag each task worker shows ("Ada · #14"), to redraw it only when it changes. */
const names = new Map<string, string>();

/** Redraws `model`'s name tag when `w`'s label changed: a task worker's says which task. */
export function tagTaskWorker(model: Worker, w: WorkerInfo) {
  if ((w.kanban || names.has(w.id)) && names.get(w.id) !== workerLabel(w)) {
    model.setName(workerLabel(w));
    if (w.kanban) names.set(w.id, workerLabel(w));
    else names.delete(w.id);
  }
}

/** A worker's gone: forget its name tag. */
export function forgetTaskWorker(id: string) {
  names.delete(id);
}

/** A task's ⏳ retry countdown on its worker's card ticks down between worker updates. */
export function tickRetryCountdown(views: ReadonlyMap<string, { model: Worker }>, meetingCard: (w: WorkerInfo) => WorkerTask | undefined) {
  return setInterval(() => {
    const now = Date.now();
    for (const w of store.workers.values()) {
      if (!w.kanban?.retryAt || meetingCard(w)) continue;
      views.get(w.id)?.model.setTask(kanbanCard(w, now));
    }
  }, 1000);
}
