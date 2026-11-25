// Which worker and session of a task a run goes to: the implementer's own, the main reviewer's (seat 0:
// task.reviewerWorkerId / reviewerSessionId) or an additional reviewer's (seat 1..4: its entry of
// task.coReviewers). Reads and writes of these ids in the engine go through here.

import type { CoReviewer, ReviewerSpec } from '../../../shared/kanban/review.js';
import type { KanbanRole, KanbanTask } from '../../../shared/kanban/types.js';

export interface Slot {
  workerId?: string | null;
  sessionId?: string | null;
}

type Columns = { workerId?: string | null; sessionId?: string | null; reviewerWorkerId?: string | null; reviewerSessionId?: string | null; coReviewers?: CoReviewer[] | null };

/** The ids the role (and the reviewer's seat, 0 by default) holds on the task. */
export function slot(task: Pick<KanbanTask, 'workerId' | 'sessionId' | 'reviewerWorkerId' | 'reviewerSessionId' | 'coReviewers'>, role: KanbanRole, seat = 0): Slot {
  if (role === 'implementer') return { workerId: task.workerId, sessionId: task.sessionId };
  if (seat > 0) {
    const c = task.coReviewers?.find((x) => x.seat === seat);
    return { workerId: c?.workerId, sessionId: c?.sessionId };
  }
  return { workerId: task.reviewerWorkerId, sessionId: task.reviewerSessionId };
}

/**
 * The task columns to write for the role's (and seat's) ids: only the ones given, a null clears one. A seat of 1 or more
 * writes its entry of coReviewers, so it needs the task as it is now; `spec` (re)sets the entry's tool, model and effort.
 */
export function slotPatch(role: KanbanRole, ids: Slot, seat = 0, task?: Pick<KanbanTask, 'coReviewers'>, spec?: ReviewerSpec): Columns {
  if (role === 'implementer') {
    return { ...(ids.workerId !== undefined ? { workerId: ids.workerId } : {}), ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}) };
  }
  if (seat > 0) {
    const list = [...(task?.coReviewers ?? [])];
    const at = list.findIndex((c) => c.seat === seat);
    const base: CoReviewer = at >= 0 ? { ...list[at] } : { seat, tool: spec?.tool ?? 'claude' };
    if (spec) Object.assign(base, { tool: spec.tool, model: spec.model, effort: spec.effort });
    if (ids.workerId !== undefined) ids.workerId === null ? delete base.workerId : (base.workerId = ids.workerId);
    if (ids.sessionId !== undefined) ids.sessionId === null ? delete base.sessionId : (base.sessionId = ids.sessionId);
    for (const k of ['model', 'effort'] as const) if (base[k] === undefined) delete base[k];
    if (at >= 0) list[at] = base;
    else list.push(base);
    return { coReviewers: list.sort((a, b) => a.seat - b.seat) };
  }
  return { ...(ids.workerId !== undefined ? { reviewerWorkerId: ids.workerId } : {}), ...(ids.sessionId !== undefined ? { reviewerSessionId: ids.sessionId } : {}) };
}
