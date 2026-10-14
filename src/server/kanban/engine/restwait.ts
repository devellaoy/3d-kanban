// A phase that finds its own worker still busy waits for it (docs/kanban-architecture.md §4, "Starting a run"). Split out of the
// orchestrator like Holds; a Stop cancels the wait, as the task's chain is held until it ends.

import type { Floor } from '../../floor.js';

export class RestWaits {
  /** The phases waiting for their own worker, by task. */
  private waits = new Map<number, (by?: string) => void>();

  /** `busyWaitMs`: how long a wait lasts at most (the caller then looks at the worker again). */
  constructor(private busyWaitMs: () => number) {}

  /** Cancels the task's wait, if it has one (its phase then ends as stopped); false when it has none. */
  cancel(taskId: number, by?: string): boolean {
    const wait = this.waits.get(taskId);
    wait?.(by);
    return !!wait;
  }

  /**
   * Resolves when the worker is at rest (or gone) and `team` says its teammates are too (polled), or after busyWaitMs, or `cancelled` when the
   * task is stopped meanwhile. `started`: only a worker that is still starting is waited for (a prompt typed into a working agent is queued
   * by it), for a minute at most.
   */
  until(floor: Floor, id: string, taskId: number, team: () => boolean, started = false): Promise<{ cancelled: boolean; by?: string }> {
    return new Promise((resolve) => {
      const rested = () => {
        const status = floor.workers.get(id)?.status;
        return !status || (started ? status !== 'starting' : status !== 'working' && status !== 'starting' && !team());
      };
      let off = () => {};
      const finish = (cancelled = false, by?: string) => {
        clearTimeout(timer);
        clearInterval(poll);
        off();
        if (this.waits.get(taskId) === cancel) this.waits.delete(taskId);
        resolve({ cancelled, ...(by ? { by } : {}) });
      };
      const cancel = (by?: string) => finish(true, by);
      this.waits.set(taskId, cancel);
      const timer = setTimeout(() => finish(), started ? Math.min(60_000, this.busyWaitMs()) : this.busyWaitMs());
      timer.unref?.();
      // Teammates finishing is no status of the worker's: look again every so often.
      const poll = setInterval(() => rested() && finish(), 1000);
      poll.unref?.();
      off = floor.workers.addObserver((o) => {
        if (o.workerId === id && (o.event === 'removed' || (o.event === 'status' && rested()))) finish();
      });
      if (rested()) finish();
    });
  }
}
