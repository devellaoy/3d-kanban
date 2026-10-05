// What the engine does with the runs the last office left `running` when the whole office was shut down and started again
// (docs/kanban-architecture.md §4, "After a full restart"). Split out of the orchestrator like Holds; the engine's own state
// reaches it through the small `RestartDeps` interface. Only runs whose worker's terminal did NOT survive the restart come here
// (`workers.cutOffStatus` is defined): a worker whose terminal was kept is followed as before.

import type { Floor } from '../../floor.js';
import type { KanbanContext } from '../registry.js';
import type { WorkerInfo, WorkerStatus } from '../../../shared/protocol.js';
import type { KanbanRun, KanbanTask } from '../../../shared/kanban/types.js';
import { sessionLogged } from './sessions.js';
import { missingFolders } from './workspace.js';
import type { HeldRun } from './turnhold.js';

/** What the engine lends to the restart handling. */
export interface RestartDeps<L extends HeldRun> {
  ctx: Pick<KanbanContext, 'repo' | 'runAs'>;
  serial<T>(taskId: number, fn: () => Promise<T>): Promise<T>;
  /** Whether the project is a folder project (no worktrees). */
  folder(project: string): boolean;
  /** Finishes the run as interrupted and moves its task to waiting/interrupted with `text`. */
  interrupted(run: KanbanRun, task: KanbanTask, text: string): Promise<void>;
  finishRun(id: number, project: string, patch: { status: 'interrupted'; error: string }): void;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  /** Follows the run on its worker as an ordinary live run; its result is read from the run's start, not from the woken process's. */
  attach(run: KanbanRun, task: KanbanTask, info: WorkerInfo): L;
  turnEnded(live: L): Promise<void>;
  /** The machine's `asking`: the task waits for the user's answer. */
  asking(taskId: number): Promise<void>;
  /** Why the office has stopped hiring (its daily budget), if it has. */
  hiringPaused(): string | undefined;
  /** The machine's Retry with the restarted prompt; a refusal as text. */
  retry(taskId: number): Promise<string | undefined>;
  /** The gap between one run being carried on and the next (ms), so the woken agents don't all start together. */
  staggerMs: number;
}

export class Restarts<L extends HeldRun> {
  private timers = new Set<NodeJS.Timeout>();
  /** Runs carried on so far: the stagger of the next one. */
  private carried = 0;

  constructor(private deps: RestartDeps<L>) {}

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * The run's worker lost its terminal in the restart; `cut` is what it was doing then. Decided from that, not from the worker's
   * status now (a woken worker without a prompt turns idle after a while).
   */
  resume(run: KanbanRun, task: KanbanTask, floor: Floor, info: WorkerInfo, cut: WorkerStatus): void {
    const { ctx, serial, folder, interrupted, note } = this.deps;
    const branch = task.branch ? ` on branch ${task.branch}` : '';
    // Waiting for an answer to its question (the agent was cut off at its prompt): the task waits for the user, whatever else is gone; the answer goes the normal ways.
    if (cut === 'needs_input' || (task.status === 'waiting' && task.waitingReason === 'agent_asking')) {
      void serial(task.id, async () => {
        this.deps.finishRun(run.id, task.project, { status: 'interrupted', error: 'The office restarted while its agent was asking' });
        const now = ctx.repo.getTask(task.id);
        if (now && !(now.status === 'waiting' && now.waitingReason === 'agent_asking')) await this.deps.asking(task.id);
        note(task, 'The office restarted while its agent was asking: answer here to carry on.', run.id);
      });
      return;
    }
    // Its worktree is gone: nothing to carry on in.
    if (info.lost || (!folder(task.project) && task.workspace && missingFolders(floor.dir, task.workspace).length)) {
      void serial(task.id, () => interrupted(run, task, `The office restarted, but its worktree is gone: Retry to carry on in a fresh worktree${branch}`));
      return;
    }
    // Its Claude session is gone: nothing to resume.
    const session = run.role === 'implementer' ? task.sessionId : task.reviewerSessionId;
    if (session && sessionLogged(ctx, task, run.tool, session, floor.workers.transcripts(info.id)?.claude) === false) {
      void serial(task.id, () => interrupted(run, task, "The office restarted, but its agent's session is gone: Retry starts it again in a fresh session"));
      return;
    }
    // Its turn had finished and wasn't held for background work: its result is handled, nothing is run again.
    if (cut === 'done' && ctx.repo.runHeldAt(run.id) === undefined) {
      const live = this.deps.attach(run, task, info);
      void serial(task.id, () => this.deps.turnEnded(live));
      return;
    }
    // Cut off mid-turn (or while held for its background work).
    const paused = this.deps.hiringPaused();
    const carryOn = floor.workers.carriesOnAfterRestart() && !paused;
    void serial(task.id, async () => {
      await interrupted(run, task, carryOn ? 'The office restarted mid-run: its agent carries on by itself' : 'The office restarted while it ran: Retry to carry on');
      if (paused) note(task, `It doesn't carry on by itself: ${paused}`);
    });
    if (!carryOn) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void serial(task.id, async () => {
        const now = ctx.repo.getTask(task.id);
        // Someone already retried it, or moved it on.
        if (!now || now.status !== 'waiting' || now.waitingReason !== 'interrupted' || now.runState !== 'idle') return;
        const err = await this.deps.retry(task.id);
        if (err) note(now, `The office restarted, but its agent couldn't carry on by itself: ${err}`);
      });
    }, this.carried++ * this.deps.staggerMs);
    timer.unref?.();
    this.timers.add(timer);
  }
}
