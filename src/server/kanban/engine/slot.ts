// Which worker and session of a task a run goes to: the implementer's own, or a reviewer seat's. Seat 0 is the main
// reviewer (task.reviewerWorkerId / reviewerSessionId); the implementer has no seat. Reads and writes of these ids in
// the engine go through here, so a further seat of the review panel has one place to be added.

import type { KanbanRole, KanbanTask } from '../../../shared/kanban/types.js';

export interface Slot {
  workerId?: string | null;
  sessionId?: string | null;
}

/** The ids the role (and the reviewer's seat, 0 by default) holds on the task. */
export function slot(task: Pick<KanbanTask, 'workerId' | 'sessionId' | 'reviewerWorkerId' | 'reviewerSessionId'>, role: KanbanRole, seat = 0): Slot {
  if (role === 'implementer') return { workerId: task.workerId, sessionId: task.sessionId };
  // TODO(review panel): seat >= 1 reads task.coReviewers here.
  void seat;
  return { workerId: task.reviewerWorkerId, sessionId: task.reviewerSessionId };
}

/** The task columns to write for the role's (and seat's) ids: only the ones given, a null clears one. */
export function slotPatch(role: KanbanRole, ids: Slot, seat = 0): { workerId?: string | null; sessionId?: string | null; reviewerWorkerId?: string | null; reviewerSessionId?: string | null } {
  const out: { workerId?: string | null; sessionId?: string | null; reviewerWorkerId?: string | null; reviewerSessionId?: string | null } = {};
  if (role === 'implementer') {
    if (ids.workerId !== undefined) out.workerId = ids.workerId;
    if (ids.sessionId !== undefined) out.sessionId = ids.sessionId;
    return out;
  }
  // TODO(review panel): seat >= 1 writes task.coReviewers here (its own update, not these columns).
  void seat;
  if (ids.workerId !== undefined) out.reviewerWorkerId = ids.workerId;
  if (ids.sessionId !== undefined) out.reviewerSessionId = ids.sessionId;
  return out;
}
