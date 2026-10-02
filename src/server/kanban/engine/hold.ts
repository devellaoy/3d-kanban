// A task put on hold and taken off it (docs/kanban-architecture.md §3 and §4). Putting it on hold
// parks it: its workers go home (the worktree, session and desk stay on the task), nothing runs for
// it and it uses no maxConcurrent slot. Taking it off hold hires the implementer again through the
// engine's own launch, in the same worktree and session. Split out of the orchestrator like
// Departures; the engine's own state reaches it through the small `Holding` interface.

import type { KanbanCaller, KanbanContext } from '../registry.js';
import type { KanbanTask } from '../../../shared/kanban/types.js';
import type { TaskHold } from '../../../shared/kanban/hold.js';
import { checkMove } from '../../../shared/kanban/moves.js';
import { isBusy } from '../../../shared/status.js';
import type { NewComment, TaskUpdate } from '../db/repository.js';
import type { MachineEvent, RunEffect } from './machine.js';

/** What holding borrows from the orchestrator. */
export interface Holding {
  /** The run still live on the task, if any. */
  liveOf(taskId: number): { workerId: string; phase: string; runId: number } | undefined;
  /** A run still live is over as stopped: `error` says why. */
  stopLive(live: { workerId: string }, error: string): void;
  update(id: number, patch: TaskUpdate): unknown;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): unknown;
  addComment(project: string, c: NewComment): unknown;
  apply(taskId: number, e: MachineEvent, via?: { who?: KanbanCaller }): Promise<string | undefined>;
  /** The task's workers at rest (and `also`) go home with the reason 'hold'. */
  sendHome(taskId: number, by: string, also?: string): Promise<number>;
  drain(floorId: string): Promise<unknown>;
  filesText(project: string, taskId: number, files: { name: string; stored: string }[]): string;
  finishRun(runId: number, floorId: string, patch: Parameters<KanbanContext['repo']['finishRun']>[1]): unknown;
  /** Carries out a run effect (a launch, with what a failed or queued one does). */
  effect(taskId: number, eff: RunEffect, via: unknown): Promise<string | undefined>;
}

/** "15.11.2026", as a person writes the day in Finland. */
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
};

export class Holds {
  constructor(
    private ctx: KanbanContext,
    private d: Holding,
    private now: () => number,
  ) {}

  /** Parks a task of Waiting or Review: its workers go home, the desk frees up. Resolves to why not. */
  async hold(task: KanbanTask, who: KanbanCaller, opts: { note?: string; until?: number } = {}): Promise<string | undefined> {
    const check = checkMove({ status: task.status, runState: task.runState }, 'on_hold');
    if (!check.ok) return check.reason;
    // Sending somebody's workers home, or ending the run they are asking in, is the creator's call (or an admin's), as a reset is.
    if (!who.admin && task.createdBy !== who.name) return 'Only whoever made it, or an admin, can put a task on hold';
    const floor = this.ctx.floor(task.project);
    const live = this.d.liveOf(task.id);
    const mine = floor?.workers.list().filter((w) => w.kanban?.taskId === task.id || w.id === task.workerId || w.id === task.reviewerWorkerId) ?? [];
    // A plan waiting for the user's say leaves its worker at the plan's exit prompt (needs_input): it may go home, the session carries on after.
    const planWait = task.status === 'waiting' && (task.waitingReason === 'plan_approval' || task.waitingReason === 'plan_questions');
    const atPlan = planWait ? mine.find((w) => w.id === task.workerId && w.status === 'needs_input' && w.id !== live?.workerId) : undefined;
    const busy = mine.find((w) => isBusy(w.status) && w.id !== live?.workerId && w.id !== atPlan?.id);
    if (busy) return `${busy.name} is still working: stop it or send it home first`;
    // An agent that only asks in its terminal is idle but its run goes on: it ends as stopped, as it does when the task is moved to Done.
    if (live) {
      this.d.stopLive(live, `${who.name} put the task on hold`);
      this.d.note(task, `${who.name} put the task on hold, so its ${live.phase === 'review' || live.phase === 'pr-review' ? 'review round' : `${live.phase} run`} was stopped.`, live.runId);
    }
    const seated = mine.find((w) => w.id === task.workerId && w.kanban?.role !== 'reviewer') ?? mine.find((w) => w.kanban?.role === 'implementer');
    const at = this.now();
    const deskId = seated?.deskId ?? task.deskId;
    const hold: TaskHold = {
      at,
      by: who.name,
      from: task.status === 'review' ? 'review' : 'waiting',
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.until !== undefined ? { until: opts.until } : {}),
      ...(planWait ? { reason: task.waitingReason, ...(task.waitingText ? { text: task.waitingText } : {}), ...(task.phase ? { phase: task.phase } : {}) } : {}),
      ...(seated ? { worker: { name: seated.name, color: seated.color } } : {}),
      ...(deskId ? { deskId } : {}),
    };
    // Recorded before the workers go: their departure is the hold's, whatever the task looked like then.
    this.d.update(task.id, { hold, status: 'on_hold', runState: 'idle', queuedRun: null, retryAt: null, retryAttempts: 0, waitingReason: null, waitingText: null });
    await this.d.sendHome(task.id, who.name, live?.workerId ?? atPlan?.id);
    const wt = task.workspace?.worktree;
    const parts = [`⏸️ Put on hold by ${who.name}`];
    if (opts.note) parts[0] += `: ${opts.note}`;
    if (opts.until !== undefined) parts[0] += ` (until ${day(opts.until)})`;
    parts[0] += '.';
    if (wt) parts.push(`Its worktree stays at ${wt.path} on branch ${wt.branch}; ▶️ Resume (move it to In progress) to carry on in the same session.`);
    else parts.push('▶️ Resume (move it to In progress) to carry on.');
    this.d.note(task, parts.join(' '));
    void this.d.drain(task.project);
    return undefined;
  }

  /** Stop on a queued unhold (it waited for a desk): the task is back on hold, its hold intact, and what was said meanwhile plain comments again. */
  cancelUnhold(task: KanbanTask, who: KanbanCaller) {
    for (const m of task.pendingMessages) {
      this.ctx.repo.setCommentPending(m.commentId, false);
      const c = this.ctx.repo.getComment(m.commentId);
      if (c) this.ctx.broadcast({ t: 'kanban.comment', comment: c, project: task.project }, task.project);
    }
    this.d.update(task.id, { status: 'on_hold', runState: 'idle', queuedRun: null, pendingMessages: [], waitingReason: null, waitingText: null });
    this.d.note(task, `${who.name} stopped the resume before it started: the task is back on hold.`);
  }

  /** The user's comments since `since` are kept as pending messages (files included), by comment id, for the next run that resumes the work. They are exempt from the cap on queued comments. */
  queueHeld(task: KanbanTask, since: number) {
    const comments = this.ctx.repo.userCommentsSince(task.id, since).filter((c) => !task.pendingMessages.some((p) => p.commentId === c.id));
    if (!comments.length) return;
    const files = this.ctx.repo.listAttachments(task.id);
    const queued = comments.map((c) => ({ commentId: c.id, text: [c.text, this.d.filesText(task.project, task.id, files.filter((a) => a.commentId === c.id))].filter(Boolean).join('\n\n'), by: c.authorName, at: c.createdAt, held: true as const }));
    for (const c of comments) {
      this.ctx.repo.setCommentPending(c.id, true);
      const now = this.ctx.repo.getComment(c.id);
      if (now) this.ctx.broadcast({ t: 'kanban.comment', comment: now, project: task.project }, task.project);
    }
    this.d.update(task.id, { pendingMessages: [...task.pendingMessages, ...queued] });
  }

  /**
   * The messages a run that resumes the work carries (`text`, for its prompt), and `ack` for when an agent has the prompt: they leave
   * the task by id then, their comments stop being pending. Not before: a launch that fails or waits for room keeps them.
   */
  carried(task: KanbanTask, prompt: string): { text?: string; ack: () => void } {
    const msgs = ['implement', 'replan', 'continue', 'unhold', 'resume'].includes(prompt) ? (this.ctx.repo.getTask(task.id) ?? task).pendingMessages : [];
    const ids = new Set(msgs.map((m) => m.commentId));
    return {
      ...(msgs.length ? { text: msgs.map((m) => `- ${m.by}: ${m.text}`).join('\n') } : {}),
      ack: () => {
        if (!ids.size) return;
        for (const id of ids) {
          this.ctx.repo.setCommentPending(id, false);
          const c = this.ctx.repo.getComment(id);
          if (c) this.ctx.broadcast({ t: 'kanban.comment', comment: c, project: task.project }, task.project);
        }
        this.d.update(task.id, { pendingMessages: (this.ctx.repo.getTask(task.id)?.pendingMessages ?? []).filter((m) => !ids.has(m.commentId)) });
      },
    };
  }

  /** A run whose stored session could not be resumed (its agent exited before it was heard from) starts again in a fresh one, once: the new run has no session to lose. */
  async freshSession(live: { runId: number; floorId: string; workerId: string; role: string; eff?: RunEffect; via?: unknown }, task: KanbanTask, session: string) {
    const floor = this.ctx.floor(live.floorId);
    this.d.finishRun(live.runId, live.floorId, { status: 'interrupted', error: "Its session couldn't be resumed" });
    if (floor?.workers.get(live.workerId)) await floor.sendHome(live.workerId, 'keep', { by: 'Kanban', reason: 'engine' });
    const reviewer = live.role !== 'implementer';
    this.d.update(task.id, reviewer ? { reviewerWorkerId: null, reviewerSessionId: null } : { workerId: null, sessionId: null });
    this.d.note(task, `${reviewer ? "The reviewer's" : 'Its'} session (${session}) couldn't be resumed (it is gone: Claude has no transcript of it), so a fresh one takes over from the task's worktree and what is known of it.`);
    const err = await this.d.effect(task.id, live.eff!, live.via ?? {});
    if (err) this.d.note(task, `Couldn't start it again: ${err}`);
  }

  /** Takes a task off hold: the implementer is hired again (same worktree and session) and carries on. */
  async unhold(task: KanbanTask, who: KanbanCaller, note?: string): Promise<string | undefined> {
    if (task.status !== 'on_hold') return 'Only a task on hold can be resumed';
    // Resuming hires a worker on the creator's sign-in for a task they (or an admin) parked: theirs to say, as the hold was.
    if (!who.admin && task.createdBy !== who.name) return 'Only whoever made it, or an admin, can resume a task on hold';
    const text = note?.trim();
    // Its message to the agent is the user's comment first: the prompt quotes the comments left since the hold.
    if (text) this.d.addComment(task.project, { taskId: task.id, authorKind: 'user', authorName: who.name, kind: 'message', text });
    if (task.hold?.deskId && task.hold.deskId !== task.deskId) this.d.update(task.id, { deskId: task.hold.deskId });
    // What was said meanwhile (the note included) is kept by id on the task until an agent has it: the prompt of whatever run comes next carries it.
    if (task.hold) this.queueHeld(task, task.hold.at);
    const back = task.hold?.reason ? { reason: task.hold.reason, ...(task.hold.text ? { text: task.hold.text } : {}), ...(task.hold.phase ? { phase: task.hold.phase } : {}) } : undefined;
    return this.d.apply(task.id, { type: 'unhold', ...(text ? { text } : {}), ...(back ? { back } : {}) }, { who });
  }
}
