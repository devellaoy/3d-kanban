// Idle agents close (docs/kanban.md "Idle agents close"): a task worker's agent process that nobody
// has touched for settings.idleCloseHours is ended in place. The worker stays at its desk, exited and
// marked `dozing` (WorkerInfo.dozing), so CarryOn.wakeAll leaves it alone; opening its window
// (`worker.attach` from a person in the office) or pressing R resumes it on its session.

import type { WorkerInfo } from '../../shared/protocol.js';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { KanbanContext, KanbanPlugin } from './registry.js';

/** How often the plugin looks for idle agents. */
export const IDLE_SWEEP_MS = 5 * 60_000;

/** The part of a task that tells whether anything is going on for it. */
export type IdleTask = Pick<KanbanTask, 'runState' | 'queuedRun' | 'updatedAt'>;

/** A status in which a worker's agent has nothing to do but wait. */
const RESTING = new Set<WorkerInfo['status']>(['done', 'idle', 'needs_input']);

/** Whether a worker is at rest with nobody looking: what a close needs, apart from time. */
export function restingUnwatched(w: WorkerInfo, task: IdleTask | undefined): boolean {
  return (
    w.kind === 'agent' &&
    !!w.kanban &&
    !w.dozing &&
    !!w.sessionId &&
    RESTING.has(w.status) &&
    w.viewerIds.length === 0 &&
    !!task &&
    task.runState === 'idle' &&
    !task.queuedRun
  );
}

/**
 * The workers whose agent is to be closed at `now` after `hours` of quiet. `seen` is the plugin's memory of when each worker
 * was last busy or looked at (it is updated here): without it an agent woken by someone opening its window would be closed
 * again minutes after they leave, since resuming it with no prompt moves none of the task's own clocks. A worker not seen
 * before is seen now, so a restart of the office starts every clock over.
 */
export function idleVictims(now: number, hours: number, workers: WorkerInfo[], taskOf: (taskId: number) => IdleTask | undefined, seen: Map<string, number>): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const w of workers) {
    if (w.kind !== 'agent' || !w.kanban) continue;
    ids.add(w.id);
    const task = taskOf(w.kanban.taskId);
    if (w.viewerIds.length > 0 || !RESTING.has(w.status) || (task && task.runState !== 'idle')) seen.set(w.id, now);
    else if (!seen.has(w.id)) seen.set(w.id, now);
    if (hours <= 0 || !restingUnwatched(w, task)) continue;
    const last = Math.max(w.waitingSince ?? 0, w.lastInput?.at ?? 0, task!.updatedAt, seen.get(w.id) ?? 0);
    if (last < now - hours * 3_600_000) out.push(w.id);
  }
  for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
  return out;
}

export interface Idle {
  plugin: KanbanPlugin;
  /** One look at every floor's workers, closing the idle agents; resolves to the workers closed. */
  sweep(now?: number): Promise<string[]>;
}

export function createIdle(ctx: KanbanContext, opts: { now?: () => number; everyMs?: number } = {}): Idle {
  const clock = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const close = async (floorId: string, id: string, now: number, hours: number): Promise<boolean> => {
    const floor = ctx.floor(floorId);
    const info = floor?.workers.get(id);
    const taskId = info?.kanban?.taskId;
    if (!floor || !info || taskId === undefined) return false;
    // Inside the engine's turn for the task, so a comment, Retry or approval cannot type into the process as it dies.
    const done = await ctx.engine.serialized?.(taskId, async (task) => {
      const now2 = floor.workers.get(id);
      if (!now2 || !restingUnwatched(now2, task)) return false;
      const err = await floor.workers.doze(id, now);
      if (err) return false;
      // Someone opened it while the process was going down (their attach found it still running): it carries on at once.
      if ((floor.workers.get(id)?.viewerIds.length ?? 0) > 0) {
        floor.workers.resume(id);
        return false;
      }
      const { comment, deduped } = ctx.repo.addComment({ taskId, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: `Closed ${info.name}'s idle agent after ${hours} h; opening the task resumes it.` });
      if (!deduped) ctx.broadcast({ t: 'kanban.comment', comment, project: task.project }, task.project);
      return true;
    });
    return done === true;
  };

  const sweep = async (at?: number): Promise<string[]> => {
    const now = at ?? clock();
    const hours = ctx.settings.get().idleCloseHours;
    const closed: string[] = [];
    for (const project of ctx.projects()) {
      const floor = ctx.floor(project.id);
      if (!floor) continue;
      const victims = idleVictims(now, hours, floor.workers.list(), (id) => ctx.repo.getTask(id), seen);
      for (const id of victims) {
        try {
          if (await close(project.id, id, now, hours)) closed.push(id);
        } catch (err) {
          console.error(`agent-office: closing an idle agent failed: ${(err as Error).message}`);
        }
      }
    }
    return closed;
  };

  return {
    sweep,
    plugin: {
      name: 'idle',
      start() {
        timer = setInterval(() => {
          if (running) return;
          running = true;
          void sweep().finally(() => (running = false));
        }, opts.everyMs ?? IDLE_SWEEP_MS);
        timer.unref?.();
      },
      stop() {
        clearInterval(timer);
        timer = undefined;
      },
    },
  };
}
