// What the engine does with the runs the last office left `running` when the whole office was shut down and started again
// (docs/kanban-architecture.md §4, "After a full restart"). Split out of the orchestrator like Holds; the engine's own state
// reaches it through the small `RestartDeps` interface. Only runs whose worker's terminal did NOT survive the restart come here
// (`workers.cutOffStatus` is defined): a worker whose terminal was kept is followed as before.
//
// A run to carry on is not retried at once: it is finished as interrupted and its task is put back in the engine's own queue
// (`runState` queued, `queuedRun.restarted`; prompt 'restarted', or the phase's own when a relaunch was cut off before the phase's prompt went in), in the database, so it keeps its project slot, survives another shutdown
// and starts through `drain` (see `admit` there) under the same limits as any queued run.

import type { Floor } from '../../floor.js';
import type { KanbanContext } from '../registry.js';
import type { WorkerInfo, WorkerStatus } from '../../../shared/protocol.js';
import type { KanbanRun, KanbanTask, QueuedRun } from '../../../shared/kanban/types.js';
import { claudeAdapter } from './adapters/claude.js';
import { ownPrompt, type MachineEvent } from './machine.js';
import { sessionLogged } from './sessions.js';
import { missingFolders } from './workspace.js';
import type { HeldRun } from './turnhold.js';

/** What the engine lends to the restart handling. */
export interface RestartDeps<L extends HeldRun> {
  ctx: Pick<KanbanContext, 'repo' | 'runAs'>;
  serial<T>(taskId: number, fn: () => Promise<T>): Promise<T>;
  /** Whether the project is a folder project (no worktrees). */
  folder(project: string): boolean;
  finishRun(id: number, project: string, patch: { status: 'interrupted' | 'stopped'; error?: string }): void;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  update(id: number, patch: { runState?: KanbanTask['runState']; queuedRun?: KanbanTask['queuedRun'] | null; sessionId?: string; reviewerSessionId?: string }): void;
  apply(taskId: number, e: MachineEvent): Promise<string | undefined>;
  drain(project: string): void;
  /** Follows the run on its worker as an ordinary live run; its result is read from the run's start, not from the woken process's. */
  attach(run: KanbanRun, task: KanbanTask, info: WorkerInfo): L;
  turnEnded(live: L, planExit?: boolean): Promise<void>;
  /** Why the office has stopped hiring (its daily budget), if it has. */
  hiringPaused(): string | undefined;
  /** The gap between one run being carried on and the next (ms), so the woken agents don't all start together. */
  staggerMs: number;
}

export class Restarts<L extends HeldRun> {
  private timer?: NodeJS.Timeout;
  /** When the next queued 'restarted' run may start (the stagger). */
  private nextAt = 0;

  constructor(private deps: RestartDeps<L>) {}

  /** Whether a queued run is one a restart put back (it carries on by itself, under the stagger and the restart's checks). */
  static queued(q: QueuedRun | undefined): boolean {
    return !!q && (q.prompt === 'restarted' || !!q.restarted);
  }

  dispose() {
    clearTimeout(this.timer);
  }

  /**
   * Migration for a removed feature (remove once no office from before #327 is left): a compact from an
   * older office is over and its task never moved for it, so it just rests. A compact waiting in the
   * queue has no run, so the tasks are asked for here, and the runs are only finished by reconcile.
   */
  dropCompacts() {
    for (const t of this.deps.ctx.repo.tasksWhere({ runState: ['queued', 'starting', 'running', 'stopping'] })) {
      if (t.queuedRun?.prompt !== 'compact' && t.phase !== 'compact') continue;
      this.deps.update(t.id, { runState: 'idle', queuedRun: null });
      this.deps.note(t, 'Compacting is no longer a feature of the office: the compact from before the restart was dropped.');
    }
  }

  /** The run's worker on the floor. A run whose launch was cut short before it recorded its worker (a second shutdown while it waited for the woken worker to rest) has the task's own, if that was cut off too. */
  workerOf(run: KanbanRun, task: KanbanTask, floor?: Floor): WorkerInfo | undefined {
    if (!floor) return undefined;
    if (run.workerId) return floor.workers.get(run.workerId);
    const w = floor.workers.get((run.role === 'implementer' ? task.workerId : task.reviewerWorkerId) ?? '');
    return w && floor.workers.cutOffStatus(w.id) !== undefined ? w : undefined;
  }

  /**
   * Why a run can't be carried on after the restart, as its task says it: its worktree is gone (the worker lost, or the task's folders missing:
   * the launch would silently cut a fresh one) or its Claude session is (the restored worker's own session first, else the task's). Undefined when both are there.
   */
  private gone(task: KanbanTask, role: KanbanRun['role'], tool: KanbanRun['tool'], floor: Floor, info?: WorkerInfo): string | undefined {
    if (info?.lost || (!this.deps.folder(task.project) && task.workspace && missingFolders(floor.dir, task.workspace).length)) {
      return `The office restarted, but its worktree is gone: Retry to carry on in a fresh worktree${task.branch ? ` on branch ${task.branch}` : ''}`;
    }
    return this.sessionGone(task, role, tool, floor, info);
  }

  /** Whether the Claude session is gone (see `gone`); then the task learns it, so a launch whose resume fails falls back to a fresh session with the handoff. */
  private sessionGone(task: KanbanTask, role: KanbanRun['role'], tool: KanbanRun['tool'], floor: Floor, info?: WorkerInfo): string | undefined {
    const session = info?.sessionId ?? (role === 'implementer' ? task.sessionId : task.reviewerSessionId);
    if (!session || sessionLogged(this.deps.ctx, task, tool, session, info ? floor.workers.transcripts(info.id)?.claude : undefined) !== false) return undefined;
    // Known to the task from now on, so that a Retry whose resume fails falls back to a fresh session with the handoff (see Orchestrator.exited).
    this.deps.update(task.id, role === 'implementer' ? { sessionId: session } : { reviewerSessionId: session });
    return "The office restarted, but its agent's session is gone: Retry starts it again in a fresh session";
  }

  /** Whether a queued run's worker still sits at its desk: it carries on in it, so it needs no desk of its own nor room under the office's worker limit. */
  reuses(t: KanbanTask, floor: Floor): boolean {
    const id = t.queuedRun?.role === 'reviewer' ? t.reviewerWorkerId : t.workerId;
    return !!id && !!floor.workers.get(id);
  }

  /**
   * A queued 'restarted' run has room: whether it starts now. Not when the office setting was turned off or the budget paused hiring in the
   * meantime (the task then waits interrupted, with a note why), nor before the stagger has passed (the drain looks again then).
   */
  async admit(t: KanbanTask, floor: Floor): Promise<boolean> {
    const paused = this.deps.hiringPaused();
    const q = t.queuedRun!;
    const id = q.role === 'reviewer' ? t.reviewerWorkerId : t.workerId;
    // The same preconditions as at the restart: the office was down again since, and the launch would quietly start a fresh worktree or session.
    const lost = this.gone(t, q.role, this.deps.ctx.repo.listRuns(t.id).at(-1)?.tool ?? t.tool, floor, id ? floor.workers.get(id) : undefined);
    const why = !floor.workers.carriesOnAfterRestart() ? "the office's setting for that is off" : paused;
    if (why || lost) {
      await this.deps.serial(t.id, async () => {
        const task = this.deps.ctx.repo.getTask(t.id);
        if (!task || task.runState !== 'queued' || !Restarts.queued(task.queuedRun)) return;
        await this.deps.apply(task.id, { type: 'interrupted', text: lost ?? 'The office restarted while it ran: Retry to carry on' });
        if (!lost) this.deps.note(task, `It doesn't carry on by itself: ${why}`);
      });
      return false;
    }
    const wait = this.nextAt - Date.now();
    if (wait > 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.deps.drain(t.project), wait);
      this.timer.unref?.();
      return false;
    }
    this.nextAt = Date.now() + this.deps.staggerMs;
    return true;
  }

  /**
   * The run's worker lost its terminal in the restart; `cut` is what it was doing then. Decided from that, not from the worker's
   * status now (a woken worker without a prompt turns idle after a while). Synchronous: the first drain after it sees the queue.
   */
  resume(run: KanbanRun, task: KanbanTask, floor: Floor, info: WorkerInfo, cut: WorkerStatus): void {
    const { ctx, note } = this.deps;
    // The user's Stop hadn't completed when the office closed: it completes now, as a Stop does, and nothing carries on.
    if (task.runState === 'stopping') {
      void this.deps.serial(task.id, async () => {
        this.deps.finishRun(run.id, task.project, { status: 'stopped' });
        await this.deps.apply(task.id, { type: 'stopped' });
      });
      return;
    }
    // A plan finished (ExitPlanMode) is not a question: its result is handled, and the task reaches plan approval.
    if (cut === 'needs_input' && run.phase === 'plan' && this.readLog(run, floor, info)?.exitPlan) {
      const live = this.deps.attach(run, task, info);
      void this.deps.serial(task.id, () => this.deps.turnEnded(live, true));
      return;
    }
    // Waiting for an answer to its question (the agent was cut off at its prompt): the task waits for the user, whatever else is gone; the answer goes the normal ways.
    if (cut === 'needs_input' || (task.status === 'waiting' && task.waitingReason === 'agent_asking')) {
      this.deps.finishRun(run.id, task.project, { status: 'interrupted', error: 'The office restarted while its agent was asking' });
      if (!(task.status === 'waiting' && task.waitingReason === 'agent_asking')) void this.deps.serial(task.id, () => this.deps.apply(task.id, { type: 'asking', text: 'The agent was asking something in its terminal when the office restarted' }));
      // On a first turn only the worker knows the session: if Claude lost it, the answer (or a Retry) must start a fresh one, which the task's knowing it lets the launch do.
      const lostSession = this.sessionGone(task, run.role, run.tool, floor, info) ? ' Its agent\'s session is gone, so the answer starts a fresh session with the handoff.' : '';
      note(task, `The office restarted while its agent was asking: answer here to carry on.${lostSession}`, run.id);
      return;
    }
    const lost = this.gone(task, run.role, run.tool, floor, info);
    if (lost) return this.interrupt(run, task, lost);
    // Its turn had finished (the run was prompted), wasn't held for background work, and left none or teammates out in the log (they died with the shutdown): its result is handled, nothing is run again.
    if (cut === 'done' && run.promptedAt !== undefined && ctx.repo.runHeldAt(run.id) === undefined && !this.leftWork(run, floor, info)) {
      const live = this.deps.attach(run, task, info);
      void this.deps.serial(task.id, () => this.deps.turnEnded(live));
      return;
    }
    // Cut off mid-turn, held for its background work, or its turn ended with work still out.
    const paused = this.deps.hiringPaused();
    if (!floor.workers.carriesOnAfterRestart() || paused) {
      this.interrupt(run, task, 'The office restarted while it ran: Retry to carry on');
      if (paused) note(task, `It doesn't carry on by itself: ${paused}`);
      return;
    }
    this.deps.finishRun(run.id, task.project, { status: 'interrupted', error: 'The office restarted mid-run' });
    // A relaunch cut off before its new process started (cut 'starting') on a phase's first run: nothing was said to the agent in this phase, so it gets the phase's own prompt, not a "carry on" for a cut-off turn.
    const own = cut === 'starting' && !ctx.repo.listRuns(task.id).some((r) => r.id !== run.id && r.phase === run.phase && r.role === run.role && r.round === run.round) ? ownPrompt(run.phase, run.round, task) : 'continue';
    this.deps.update(task.id, { runState: 'queued', queuedRun: { phase: run.phase, role: run.role, prompt: own === 'continue' ? 'restarted' : own, restarted: true, ...(run.round !== undefined ? { round: run.round } : {}) } });
    note(task, 'The office restarted mid-run: its agent carries on by itself shortly.', run.id);
  }

  /** Whether the session log of the run's turns shows background agents, commands or teammates still out. */
  private leftWork(run: KanbanRun, floor: Floor, info: WorkerInfo): boolean {
    return !!this.readLog(run, floor, info)?.background;
  }

  /** What the run's turns say in the session log, read from the run's start. */
  private readLog(run: KanbanRun, floor: Floor, info: WorkerInfo) {
    const file = run.tool === 'claude' ? floor.workers.transcripts(info.id)?.claude : undefined;
    return file ? claudeAdapter.readTurnResult(file, { since: run.startedAt, runStart: run.startedAt, promptAt: run.promptedAt }) : undefined;
  }

  /** The run is over for good: it waits interrupted for a Retry. */
  private interrupt(run: KanbanRun, task: KanbanTask, text: string) {
    this.deps.finishRun(run.id, task.project, { status: 'interrupted', error: text });
    if (task.status === 'in_progress' || task.status === 'waiting') void this.deps.serial(task.id, () => this.deps.apply(task.id, { type: 'interrupted', text }));
  }
}
