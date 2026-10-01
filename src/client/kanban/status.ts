// A kanban worker's agent ends its turn every time it waits for its sub-agents or teammates, and
// upstream sets the worker `done` on each of those Stops. While the task's run is still going the
// 3D office and /lite show it as working instead, so it doesn't flicker ✅ ↔ ⌨️ (docs/kanban.md).

import type { WorkerInfo } from '../../shared/protocol';

/**
 * The worker as the office shows it. A worker upstream calls `done` whose kanban run is still
 * `running` is working: it keeps the `workingSince` it had (`prev` is what the client had before
 * this update), so its timer doesn't restart. Every other worker comes back unchanged.
 */
export function shownWorker(w: WorkerInfo, prev?: WorkerInfo): WorkerInfo {
  if (w.status !== 'done' || w.kanban?.runState !== 'running') return w;
  return { ...w, status: 'working', workingSince: w.workingSince ?? prev?.workingSince ?? Date.now() };
}
