// What the engine does with a user's comment on a task (docs/kanban-architecture.md §4, "Comments"). Split out of the orchestrator like
// Holds; the engine's own state reaches it through the small `CommentDeps` interface.
//
// In order: an agent asking a question in its terminal takes the comment as its answer; an implementer at work gets it typed into its
// terminal at once (Claude Code and Codex queue what is typed while they work); a reviewer's round, or a run being stopped, keeps it
// queued (pendingMessages) for the next run that resumes the work; otherwise it resumes the work.

import type { Floor } from '../../floor.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import type { KanbanComment, KanbanTask, PendingMessage } from '../../../shared/kanban/types.js';
import type { AttachmentRow, TaskUpdate } from '../db/repository.js';
import { WORK_DONE } from '../../../shared/kanban/prompts.js';
import type { LastRun, MachineEvent, RunEffect } from './machine.js';
import { runTyped, setRunTyped } from '../db/typed.js';
import type { TurnResult } from './adapters/types.js';
import { promptHead, typeable, type HeldRun } from './turnhold.js';

/** The most comments a task keeps queued for its next run (the ones carried from a hold, queueHeld, are never dropped). */
const PENDING_MAX = 50;

/** What a comment needs of the run it may be typed into. */
export interface CommentLive extends HeldRun {
  role: string;
  tool: string;
  asks?: string;
  started?: boolean;
  armed?: boolean;
  ack?: () => void;
  stopping?: { by?: string; at?: number };
  eff?: RunEffect;
  via?: { commentId?: number; taken?: PendingMessage[] };
}

/** The part of the composer comments use: a comment's text for a prompt, and for an answer typed in a terminal. */
export interface CommentText {
  commentText(project: string, taskId: number, text: string, files: AttachmentRow[]): string;
  answerText(taskId: number, text: string, files: AttachmentRow[]): string;
}

/** What handling comments borrows from the orchestrator. */
export interface CommentDeps<L extends CommentLive> {
  ctx: Pick<KanbanContext, 'repo' | 'floor' | 'broadcast'>;
  compose: CommentText;
  liveOf(taskId: number): L | undefined;
  /** The live run whose agent asks a question in its terminal, if one does. */
  asking(task: KanbanTask): L | undefined;
  /** Types an answer into that terminal; why not when it can't. */
  answer(live: L, text: string, who: KanbanCaller): string | undefined;
  apply(taskId: number, e: MachineEvent, via: { who?: KanbanCaller; commentId?: number }): Promise<string | undefined>;
  update(id: number, patch: TaskUpdate): unknown;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  lastRun(taskId: number): LastRun | undefined;
  /** The text an asking agent's comment waits for, when it can't be typed in (a permission prompt). */
  askingNote(task: KanbanTask, live: L): string;
}

/** A comment's text for a prompt, its own files with it (the composer turns links into paths and lists what the text doesn't link). */
export function commentBody(compose: CommentText, task: Pick<KanbanTask, 'id' | 'project'>, c: Pick<KanbanComment, 'text'>, own: AttachmentRow[]): string {
  return compose.commentText(task.project, task.id, c.text, own);
}

export class Comments<L extends CommentLive> {
  constructor(private d: CommentDeps<L>) {}

  /** The files a comment came with. */
  private filesOf(c: KanbanComment): AttachmentRow[] {
    return c.attachmentIds.length ? this.d.ctx.repo.listAttachments(c.taskId).filter((a) => a.commentId === c.id) : [];
  }

  /** A user's comment on a task (on the task's chain). */
  async handle(task: KanbanTask, commentId: number, who: KanbanCaller): Promise<void> {
    const repo = this.d.ctx.repo;
    const c = repo.getComment(commentId);
    if (!c || c.taskId !== task.id || c.authorKind !== 'user') return;
    const own = this.filesOf(c);
    // The agent asks a question in its terminal: the comment is the answer, typed in there now. Queued, it would wait for a turn's end that the
    // question itself holds up. A permission prompt (or an unknown one) is answered in the terminal: the comment waits for the turn's end.
    const asking = this.d.asking(task);
    if (asking?.asks === 'question' && !this.d.answer(asking, this.d.compose.answerText(task.id, c.text, own), who)) return;
    const live = this.d.liveOf(task.id);
    const body = commentBody(this.d.compose, task, c, own);
    if (live && this.typeNow(task, live, c, body)) return;
    const err = await this.d.apply(task.id, { type: 'comment', text: body, busy: !!live || task.runState !== 'idle', last: this.d.lastRun(task.id) }, { who, commentId });
    if (err) return this.d.note(task, `Couldn't hand the comment to the agent: ${err}`);
    if (live && task.status === 'waiting' && task.waitingReason === 'agent_asking') this.d.note(task, this.d.askingNote(task, live));
    else if (live?.role === 'reviewer') this.d.note(task, 'A review round is running: the comment reaches the agent when the round is over.', live.runId);
  }

  /**
   * Types the comment into the implementer's terminal now, while it works (or between two turns of a held run). Not into a plan run (its
   * ExitPlanMode dialog may be open), a reviewer, an agent that asks or is being stopped, one whose launch prompt it hasn't taken yet, a
   * worker that is starting, in a dialog, gone or has no terminal (dsh); then the comment is queued as it always was. True when typed.
   */
  private typeNow(task: KanbanTask, live: L, c: KanbanComment, body: string): boolean {
    if (live.ended || live.stopping || live.asks || live.ack || live.armed === false || !live.started) return false;
    if (live.role !== 'implementer' || live.phase === 'plan') return false;
    const workers: Floor['workers'] | undefined = this.d.ctx.floor(live.floorId)?.workers;
    const info = workers?.get(live.workerId);
    if (!workers || !info || info.provider === 'dsh' || (info.status !== 'working' && info.status !== 'done' && info.status !== 'idle')) return false;
    const text = typeable(`Comment #${c.id} from ${c.authorName} on task #${task.id} while you work:\n${body}\n(Take it into account in your current work. When everything is finished, end your final reply with ${WORK_DONE} as before.)`);
    const at = Date.now();
    const err = workers.prompt(live.workerId, text, c.authorName);
    if (err) {
      this.d.note(task, `Couldn't type the comment into the agent's terminal (${err}): it goes to it once that turn is over.`, live.runId);
      return false;
    }
    // Its own prompt, not a person's: the log's segmentation and the run's answer go on as before (see readTurnResult's officePrompts).
    (live.officePrompts ??= []).push({ at, head: promptHead(text), msg: { commentId: c.id, text: body, by: c.authorName, at: c.createdAt } });
    setRunTyped(this.d.ctx.repo.db, live.runId, live.officePrompts);
    return true;
  }

  /** The machine's queueComment: the comment waits for the worker's next rest, its files with it. */
  queue(task: KanbanTask, commentId: number | undefined): void {
    const c = commentId !== undefined ? this.d.ctx.repo.getComment(commentId) : undefined;
    if (!c || task.pendingMessages.some((p) => p.commentId === c.id)) return;
    this.keep(task, [{ commentId: c.id, text: commentBody(this.d.compose, task, c, this.filesOf(c)), by: c.authorName, at: c.createdAt }]);
  }

  /**
   * A run that was handed comments never got them to its agent (its launch failed, or it was stopped or exited first): they are queued again, so
   * the next run carries them. Those are the messages the run took off the queue (`taken`, kept with the run until its prompt is acknowledged) and
   * the one comment a resume was started with. Dated by the comments themselves, so a Stop's own delivery (comments since the stop) doesn't send
   * them straight back.
   */
  requeue(task: KanbanTask, eff: { prompt?: string; text?: string } | undefined, commentId: number | undefined, taken?: PendingMessage[]) {
    const back: PendingMessage[] = [...(taken ?? [])];
    const c = commentId !== undefined && eff?.prompt === 'resume' && eff.text ? this.d.ctx.repo.getComment(commentId) : undefined;
    if (c && !back.some((m) => m.commentId === c.id)) back.push({ commentId: c.id, text: eff!.text!, by: c.authorName, at: c.createdAt });
    const fresh = this.restore(task, back);
    if (fresh) this.d.note(task, `The comment${fresh === 1 ? '' : 's'} didn't reach the agent: kept, and go${fresh === 1 ? 'es' : ''} to it with its next run.`);
  }

  /** A run ended because its agent never got its prompt or comments (TurnResult.lost): the comments go back in the queue. */
  giveBack(task: KanbanTask, live: L) {
    if (live.ack) this.requeue(task, live.eff, live.via?.commentId, live.via?.taken);
  }

  /**
   * A run is over: the comments typed into it that its agent never took are queued again. Those the log shows, or its prompt hook heard, are
   * the agent's (`read`: the run's log as it is now; when it can't be read, every comment no hook heard).
   */
  giveBackUnheard(live: L, read: () => TurnResult | undefined) {
    const prompts = live.officePrompts ?? [];
    const task = this.d.ctx.repo.getTask(live.taskId);
    // A log that can't be read tells nothing (every comment no hook heard goes back); one that can, and names none missing, shows them all.
    const result = read();
    const missing = new Set(result ? (result.waiting ?? []) : prompts.map((_, i) => i));
    if (task) this.restore(task, prompts.flatMap((p, i) => (!p.heard && missing.has(i) && p.msg ? [p.msg] : [])));
  }

  /** A log read: the typed comments it showed for the first time are remembered (`seen`) for good. Returns the read as it was. */
  saw(live: L, read: TurnResult | undefined): TurnResult | undefined {
    for (const i of read?.seen ?? []) if (live.officePrompts?.[i]) live.officePrompts[i].seen = true;
    if (read?.seen?.length) setRunTyped(this.d.ctx.repo.db, live.runId, live.officePrompts);
    return read;
  }

  /** The agent's prompt hook heard a prompt (see hearPrompt); kept on the run. */
  heard(live: L, text: unknown) {
    hearPrompt(live.officePrompts, text);
    setRunTyped(this.d.ctx.repo.db, live.runId, live.officePrompts);
  }

  /** After an office restart: the typed comments of runs that are not followed on any more go back in the queue (those a hook heard were the agent's). */
  giveBackTyped(runs: { id: number; taskId: number }[]) {
    for (const run of runs) {
      const task = this.d.ctx.repo.getTask(run.taskId);
      const typed = runTyped(this.d.ctx.repo.db, run.id);
      if (task) this.restore(task, typed.flatMap((p) => (!p.heard && p.msg ? [p.msg] : [])));
      if (typed.length) setRunTyped(this.d.ctx.repo.db, run.id, undefined);
    }
  }

  /** Puts messages a run took back on the task's queue (those it doesn't hold already); how many went back. */
  restore(task: Pick<KanbanTask, 'id' | 'project'>, msgs: PendingMessage[] | undefined): number {
    const now = this.d.ctx.repo.getTask(task.id);
    const fresh = now ? (msgs ?? []).filter((m) => this.d.ctx.repo.getComment(m.commentId) && !now.pendingMessages.some((p) => p.commentId === m.commentId)) : [];
    if (now && fresh.length) this.keep(now, fresh);
    return fresh.length;
  }

  private keep(task: KanbanTask, add: PendingMessage[]) {
    const repo = this.d.ctx.repo;
    const all: PendingMessage[] = [...task.pendingMessages, ...add].sort((x, y) => x.at - y.at);
    // Messages carried from a hold (queueHeld) are never dropped: nothing may go undelivered while its comment stays pending.
    const newest = new Set(all.filter((m) => !m.held).slice(-PENDING_MAX));
    for (const m of add) {
      repo.setCommentPending(m.commentId, true);
      const updated = repo.getComment(m.commentId);
      if (updated) this.d.ctx.broadcast({ t: 'kanban.comment', comment: updated, project: task.project }, task.project);
    }
    this.d.update(task.id, { pendingMessages: all.filter((m) => m.held || newest.has(m)) });
  }

  /** The comments older than a Stop whose own were delivered: only a Retry or Continue carries them (the automatic hand-over skips them). */
  park(task: KanbanTask, since: number) {
    const now = this.d.ctx.repo.getTask(task.id) ?? task;
    if (now.pendingMessages.some((m) => m.at < since && !m.parked)) this.d.update(task.id, { pendingMessages: now.pendingMessages.map((m) => (m.at < since ? { ...m, parked: true as const } : m)) });
  }

  /**
   * The pending comments (those made at or after `since`, when it is given; else all but the parked ones), taken off the task to be typed in now:
   * one message, who wrote it, and the messages themselves (kept by the run until its prompt is acknowledged: see requeue). The older ones stay
   * for a Retry or Continue.
   */
  take(task: KanbanTask, since?: number): { text: string; author: string; msgs: PendingMessage[] } | undefined {
    const msgs = since === undefined ? task.pendingMessages.filter((m) => !m.parked) : task.pendingMessages.filter((m) => m.at >= since);
    if (!msgs.length) return undefined;
    for (const m of msgs) {
      this.d.ctx.repo.setCommentPending(m.commentId, false);
      const c = this.d.ctx.repo.getComment(m.commentId);
      if (c) this.d.ctx.broadcast({ t: 'kanban.comment', comment: c, project: task.project }, task.project);
    }
    this.d.update(task.id, { pendingMessages: task.pendingMessages.filter((m) => !msgs.includes(m)) });
    return {
      text: msgs.length === 1 ? msgs[0].text : msgs.map((m) => `${m.by}:\n${m.text}`).join('\n\n'),
      author: [...new Set(msgs.map((m) => m.by))].join(', '),
      msgs,
    };
  }
}

/** The agent's prompt hook heard a prompt: the typed comment it is marks heard (by the start of its text; a hook without the text hears the oldest one waiting). */
export function hearPrompt(prompts: { head: string; heard?: boolean }[] | undefined, text: unknown) {
  const said = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : undefined;
  const p = said ? prompts?.find((x) => !x.heard && said.startsWith(x.head)) : prompts?.find((x) => !x.heard);
  if (p) p.heard = true;
}
