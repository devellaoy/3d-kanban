// A task worker leaving its desk (docs/kanban-coupling.md, "3D actions -> task events"): what the
// departure does to its run and its task. Split out of the orchestrator like Handoffs; the engine's
// own state (its live runs, the machine, the repository) reaches it through the small `Departing`
// interface, so the rules here can be read without the rest of the engine.

import type { WorkerInfo } from '../../../shared/protocol.js';
import type { DepartureIntent, KanbanRole, KanbanTask, RunPhase } from '../../../shared/kanban/types.js';
import type { TaskUpdate } from '../db/repository.js';
import type { KanbanContext } from '../registry.js';
import type { MachineEvent } from './machine.js';

/** What a departure needs to know about a run the engine follows (the orchestrator's Live). */
export interface DepartingRun {
  taskId: number;
  runId: number;
  phase: RunPhase;
  role: KanbanRole;
  floorId: string;
  ended: boolean;
  stopping?: unknown;
}

/** What the departures borrow from the orchestrator. */
export interface Departing<L extends DepartingRun> {
  /** The run following this worker, if any. */
  live(workerId: string): L | undefined;
  /** The run still live on the task, if any. */
  liveOf(taskId: number): L | undefined;
  /** A run's turn is no longer followed. */
  forget(live: L): void;
  task(id: number): KanbanTask | undefined;
  update(id: number, patch: TaskUpdate): unknown;
  apply(taskId: number, e: MachineEvent): Promise<unknown>;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string): unknown;
  finishRun(runId: number, floorId: string, patch: Parameters<KanbanContext['repo']['finishRun']>[1]): unknown;
  /** A run stopped on purpose ends. */
  finishStopped(live: L): Promise<unknown>;
  /** The task is done because its worker went home with it. */
  markDone(task: KanbanTask, by: string): Promise<unknown>;
  /** Fills the floor's free desks. */
  drain(floorId: string): Promise<unknown>;
}

export class Departures<L extends DepartingRun> {
  constructor(private d: Departing<L>) {}

  /**
   * A task worker left its desk. The engine's own departures (ENGINE) only finish what they were
   * part of; anyone else's go by the rules in docs/kanban-coupling.md (see departed), with exactly one
   * status line in the task's conversation. The intent comes with the removal itself, so nothing
   * else about the departure has to arrive in time.
   */
  async removed(workerId: string, info: WorkerInfo, departure?: DepartureIntent) {
    const live = this.d.live(workerId);
    const taskId = info.kanban?.taskId ?? live?.taskId;
    if (taskId === undefined) return;
    const own = live && !live.ended ? live : undefined;
    if (own) {
      own.ended = true;
      this.d.forget(own);
    }
    const before = this.d.task(taskId);
    if (before) {
      const patch: TaskUpdate = {};
      if (before.workerId === workerId) patch.workerId = null;
      if (before.reviewerWorkerId === workerId) patch.reviewerWorkerId = null;
      if (Object.keys(patch).length) this.d.update(taskId, patch);
    }
    const task = this.d.task(taskId);
    const intent = departure ?? { by: 'Someone', reason: 'sent-home' };
    if (task && intent.reason !== 'engine') await this.departed(task, info, own, intent);
    else if (own) {
      if (own.stopping) await this.d.finishStopped(own);
      else {
        this.d.finishRun(own.runId, own.floorId, { status: 'interrupted', error: 'Its worker was sent home' });
        if (task) await this.d.apply(taskId, { type: 'interrupted', text: 'Its worker was sent home mid-run: Retry to carry on' });
      }
    }
    if (own) void this.d.drain(own.floorId);
  }

  /** Who sent a worker home, and why, as the task's conversation says it. */
  private departureLine(intent: DepartureIntent, name: string): string {
    switch (intent.reason) {
      case 'queue':
        return `${intent.by} sent ${name} home to make room for its next task`;
      case 'meeting':
        return `${intent.by} sent ${name} home`;
      case 'merged':
        return `${intent.by} sent ${name} home as its pull requests merged`;
      default:
        return `${intent.by} sent ${name} home`;
    }
  }

  /** Every pull request linked to the task has merged (and so none is open or a draft). */
  private allMerged(task: KanbanTask): boolean {
    return task.prs.length > 0 && task.prs.every((p) => p.state === 'MERGED');
  }

  /**
   * The rules for a task worker someone sent home (docs/kanban-coupling.md, "3D actions → task
   * events"). An implementer: its run, if one went, is stopped (task waiting with Retry); without a
   * run the task keeps its column, but in_progress with nothing running is waiting. A reviewer: its
   * round is dropped; the comments that came in meanwhile are worked on, else the task goes to Review.
   * `done` (or, when leave-on-merge sent it, every linked PR merged) makes the task done instead.
   */
  private async departed(task: KanbanTask, info: WorkerInfo, own: L | undefined, intent: DepartureIntent) {
    const role = info.kanban?.role ?? own?.role ?? 'implementer';
    const open = task.status !== 'done' && task.status !== 'archived' && task.status !== 'todo';
    const merged = intent.reason === 'merged';
    const done = open && (merged ? this.allMerged(task) : intent.done === true);
    let line = this.departureLine(intent, info.name);
    let then: (() => Promise<unknown>) | undefined;
    if (own) {
      const what = own.phase === 'pr-review' || own.phase === 'review' ? 'review round' : `${own.phase} run`;
      this.d.finishRun(own.runId, own.floorId, { status: 'stopped', error: `${line} mid-run` });
      if (done) {
        line += `: its ${what} was stopped, and the task is done`;
        then = () => this.d.markDone(task, intent.by);
      } else if (role === 'reviewer') {
        const pending = task.pendingMessages.length > 0;
        line += pending ? `: its ${what} was dropped, and the comments that came in meanwhile go to the agent now` : `: its ${what} was dropped, and the task is in Review`;
        then = () => this.d.apply(task.id, { type: 'reviewAbandoned', pending });
      } else {
        line += `: its ${what} was stopped. Retry to carry on.`;
        then = () => this.d.apply(task.id, { type: 'stopped', by: intent.by, text: `${this.departureLine(intent, info.name)} mid-run: Retry to carry on` });
      }
    } else if (done) {
      line += ', and the task is done';
      then = () => this.d.markDone(task, intent.by);
    } else if (role === 'implementer' && task.status === 'in_progress' && task.runState !== 'queued' && !this.d.liveOf(task.id)) {
      line += ': Retry to carry on';
      then = () => this.d.apply(task.id, { type: 'interrupted', text: `${line}` });
    } else if (role === 'implementer' && task.retryAt && intent.reason === 'sent-home') {
      // Only X stops the auto-resume: a release (a move to done) or the office's own recycling leaves it due.
      line += ": it doesn't carry on by itself after the usage limit any more, Retry when it should";
      then = async () => this.d.update(task.id, { retryAt: null });
    }
    if (merged && open && !done) line += `, but not every pull request of the task has merged, so it stays in ${task.status === 'in_progress' ? 'In progress' : task.status === 'waiting' ? 'Waiting' : 'Review'}`;
    this.d.note(task, `${line}.`.replace(/\.\.$/, '.'));
    await then?.();
  }
}
