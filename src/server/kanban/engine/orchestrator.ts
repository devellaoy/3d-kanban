// Runs the task process on ordinary office workers (docs/kanban-architecture.md §4): hires, prompts,
// relaunches and sends home workers through upstream's WorkerManager, follows their turns with
// addObserver, reads each turn's result from the session log (adapters/), and feeds the outcome to
// the pure machine (machine.ts), whose effects it then carries out. Every change goes out to the
// browsers as kanban.task / kanban.run / kanban.plan / kanban.comment.
//
// Only turns of runs the engine started move a task: someone typing into a task worker's terminal
// while no run is going doesn't.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import type { WorkerManager, WorkerObservation } from '../../workers.js';
import { DESK_BY_ID, deskBuilt, nextFreeSeat, watchSpotOf } from '../../../shared/layout.js';
import type { WorkerInfo } from '../../../shared/protocol.js';
import { isBusy } from '../../../shared/status.js';
import { withContract } from '../../../shared/kanban/prompts.js';
import type { AskingKind, DepartureIntent, KanbanComment, KanbanEffort, KanbanPrReviewRequest, KanbanRole, KanbanRun, KanbanTask, KanbanTool, KanbanWorkerSummary, PrRef, QueuedRun, RunPhase } from '../../../shared/kanban/types.js';
import { BRANCH_PREFIX, Worktrees } from '../../worktrees.js';
import type { NewComment, TaskUpdate } from '../db/repository.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import { projectRepos, repoSources } from '../projects.js';
import { sameRepo } from '../../../shared/floors.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import type { TaskAgentAdapter, TurnResult } from './adapters/types.js';
import { Composer, isFolderProject, reportDir, reposText, skillPhase, taskRepos, workerReposText, type ComposeExtra } from './compose.js';
import { next, type Effect, type LastRun, type MachineEvent, type MachineState, type PromptKind } from './machine.js';
import { backoffMs, looksInterrupted, planOutcome, prLines, resetTime, reviewFindings, reviewVerdict, stripPlanMarkers } from './markers.js';
import { branchExists, currentBranch, hasChanges, missingFolders } from './workspace.js';

export interface EngineOptions {
  /** How often due retries, queued tasks and newly opened floors are looked at (60 s). */
  sweepMs?: number;
  /** How long a stopped turn gets to come to rest after Esc before its worker is sent home (4 s). */
  stopGraceMs?: number;
  /** Reading a turn's result again while the log is still being written: tries, and the pause between. */
  readTries?: number;
  readPauseMs?: number;
  /** A compact that never says it's done is taken as done after this long (3 min). */
  compactTimeoutMs?: number;
  adapters?: Partial<Record<KanbanTool, TaskAgentAdapter>>;
  now?: () => number;
}

/** A run the engine started and is following, by the worker it runs on. */
interface Live {
  taskId: number;
  runId: number;
  phase: RunPhase;
  round?: number;
  role: KanbanRole;
  tool: KanbanTool;
  workerId: string;
  floorId: string;
  /** Claude asked to leave plan mode (ExitPlanMode): its needs_input is the finished plan. */
  exitPlan: boolean;
  /** What its agent's needs_input waits on, as its hooks last said (heardAsk); unknown when unset. */
  asks?: AskingKind;
  /**
   * Claude's final answer as its Stop hook gave it (`last_assistant_message`): what the turn said
   * when its session log still hasn't caught up by the time the engine reads it (see readResult).
   * Claude's only: a Codex turn's end is in its log (task_complete).
   */
  stopText?: string;
  /** Its turn has ended and is being dealt with. */
  ended: boolean;
  stopping?: { by?: string; timer?: NodeJS.Timeout };
  compactTimer?: NodeJS.Timeout;
}

/** What an operation carries into the effects it causes. */
interface Via {
  who?: KanbanCaller;
  commentId?: number;
  /** A pull-request review's request (reviewPrs), for its run. */
  prReview?: KanbanPrReviewRequest;
  /** Where a start's first hire sits (start with a desk: the 3D hire form). */
  deskId?: string;
}

/**
 * The account a task's new hire runs as: always the task's creator, whoever set it off (a comment,
 * Continue, Approve, Retry, the queue, the usage-limit sweep). A task with no creator account (the
 * shared password, a migrated task) runs as the caller's, else as the office's own sign-in.
 */
export function hireOwner(task: Pick<KanbanTask, 'createdByAccount'>, who?: Pick<KanbanCaller, 'accountId'>): string | undefined {
  return task.createdByAccount ?? who?.accountId ?? undefined;
}

/** A run that couldn't get a worker yet: why, for the task's conversation (see the machine's noRoom). */
interface NoRoom {
  queued: string;
}

type RunEffect = Extract<Effect, { type: 'run' }>;

const queuedOf = (eff: RunEffect): QueuedRun => ({ phase: eff.phase, role: eff.role, prompt: eff.prompt, ...(eff.round !== undefined ? { round: eff.round } : {}), ...(eff.pending ? { pending: true } : {}), ...(eff.text !== undefined ? { text: eff.text } : {}) });
const runOf = (q: QueuedRun): RunEffect => ({ type: 'run', phase: q.phase, role: q.role, prompt: q.prompt as PromptKind, ...(q.round !== undefined ? { round: q.round } : {}), ...(q.pending ? { pending: true } : {}), ...(q.text !== undefined ? { text: q.text } : {}) });

/** A pull request as a review request may name it: the pulls plugin hands on what it looked up. */
type ReviewedPr = PrRef & { title?: string; url?: string; branch?: string };

/**
 * The configured base branch of each git repository a task's worktree is cut in (the primary always,
 * the others as `repoIds` says), by checkout folder, for SpawnExtra.bases and the fetch before a hire.
 */
export function baseBranches(def: FloorDef, repoIds: string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of projectRepos(def)) if (r.kind === 'git' && r.baseBranch && (r.primary || !repoIds || repoIds.includes(r.id))) out[path.resolve(r.dir)] = r.baseBranch;
  return out;
}

const OFFICE: KanbanCaller = { name: 'Kanban', admin: true };
/** How the engine sends its own workers home: nothing for removed() to act on, it has seen to the task itself. */
const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };
const SUMMARY_MAX = 20_000;
/** How much of a Stop hook's final answer is kept (it becomes a comment, a summary, a PR comment). */
const STOP_TEXT_MAX = 100_000;
const PENDING_MAX = 50;
const ESC = '\x1b';
const RESTING = new Set(['done', 'idle', 'needs_input', 'exited']);
/** A tool that asks the user a question in the terminal: Claude's AskUserQuestion, Codex's request_user_input. */
const QUESTION_TOOL = /(?:^|[._])(?:AskUserQuestion|ask_user_question|request_user_input)$/;
/** Why an answer from the kanban isn't typed into a terminal that isn't asking a question (answer). */
const ASKS_PERMISSION = 'The agent is asking for a permission in its terminal: answer it there (⌨️ Open its terminal)';
const ASKS_UNKNOWN = 'The agent is waiting on something in its terminal: answer it there (⌨️ Open its terminal)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
/** The final answer a Claude Stop hook carries (`last_assistant_message`), capped; undefined without one. */
const stopMessage = (payload: unknown) => {
  const last = (payload as { last_assistant_message?: unknown } | undefined)?.last_assistant_message;
  return typeof last === 'string' && last.trim() ? clip(last.trim(), STOP_TEXT_MAX) : undefined;
};
const sameArgs = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * A prompt as it may be typed into a terminal: prompts go in as a bracketed paste, so an escape in a
 * comment or an agent's findings could end the paste early and type keys of its own.
 */
const typeable = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

function stateOf(t: KanbanTask): MachineState {
  return { status: t.status, phase: t.phase, runState: t.runState, waitingReason: t.waitingReason, waitingText: t.waitingText, reviewRound: t.reviewRound, retryAt: t.retryAt, retryAttempts: t.retryAttempts };
}

export class Orchestrator {
  private live = new Map<string, Live>();
  private floors = new Map<string, { workers: WorkerManager; off: () => void }>();
  /** One thing at a time per task: an operation or a turn's end. */
  private chains = new Map<number, Promise<unknown>>();
  /** When a task's run of usage limits began, to cap the total wait (autoResume.maxWaitHours). */
  private limitSince = new Map<number, number>();
  private sweepTimer?: NodeJS.Timeout;
  /** A drain of every project is due (a worker went home somewhere: a desk or room under the worker limit freed). */
  private drainDue = false;
  /** Each repository's worktree plumbing, for fetching its base before a hire (see freshBase). */
  private trees = new Map<string, Worktrees>();
  private adapters: Record<KanbanTool, TaskAgentAdapter>;
  private compose: Composer;
  private opts: Required<Omit<EngineOptions, 'adapters'>>;
  private disposed = false;

  constructor(
    private ctx: KanbanContext,
    options: EngineOptions = {},
  ) {
    this.adapters = { claude: claudeAdapter, codex: codexAdapter, ...options.adapters };
    this.compose = new Composer(ctx);
    this.opts = {
      sweepMs: options.sweepMs ?? 60_000,
      stopGraceMs: options.stopGraceMs ?? 4000,
      readTries: options.readTries ?? 12,
      readPauseMs: options.readPauseMs ?? 250,
      compactTimeoutMs: options.compactTimeoutMs ?? 180_000,
      now: options.now ?? Date.now,
    };
  }

  // --- Life cycle ---------------------------------------------------------------------------------

  begin() {
    for (const def of this.ctx.projects()) this.watch(def.id);
    this.reconcile();
    this.sweepTimer = setInterval(() => void this.sweep(), this.opts.sweepMs);
    this.sweepTimer.unref?.();
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const f of this.floors.values()) f.off();
    this.floors.clear();
    for (const l of this.live.values()) {
      clearTimeout(l.stopping?.timer);
      clearTimeout(l.compactTimer);
    }
    this.live.clear();
  }

  /** Follows a floor's workers (again, when the floor was reopened with a new WorkerManager). */
  private watch(floorId: string): Floor | undefined {
    const floor = this.ctx.floor(floorId);
    const known = this.floors.get(floorId);
    if (!floor) {
      if (known) {
        known.off();
        this.floors.delete(floorId);
      }
      return undefined;
    }
    if (known?.workers === floor.workers) return floor;
    known?.off();
    const unobserve = floor.workers.addObserver((o) => this.observed(floorId, o));
    const unguard = floor.workers.addKeepGuard((info) => this.keepsWorktree(floorId, info));
    this.floors.set(floorId, {
      workers: floor.workers,
      off: () => {
        unobserve();
        unguard();
      },
    });
    return floor;
  }

  /** Runs `fn` after whatever is already going on for the task. */
  private serial<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
    const before = this.chains.get(taskId) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => {});
    this.chains.set(taskId, tail);
    void tail.then(() => {
      if (this.chains.get(taskId) === tail) this.chains.delete(taskId);
    });
    return run;
  }

  /** Every run left `running` by the last office: re-attached to its worker, or interrupted when that's gone. */
  private reconcile() {
    const runs = this.ctx.repo.runningRuns();
    const attached = new Set<number>();
    for (const run of runs) {
      const task = this.ctx.repo.getTask(run.taskId);
      if (!task) {
        this.ctx.repo.finishRun(run.id, { status: 'interrupted', error: 'Its task is gone' });
        continue;
      }
      const floor = this.watch(task.project);
      const info = run.workerId ? floor?.workers.get(run.workerId) : undefined;
      if (!floor || !info || info.status === 'exited' || info.status === 'idle' || attached.has(task.id)) {
        void this.serial(task.id, () => this.interruptedRun(run, task, 'The office restarted while it ran: Retry to carry on'));
        continue;
      }
      attached.add(task.id);
      const live: Live = { taskId: task.id, runId: run.id, phase: run.phase, ...(run.round !== undefined ? { round: run.round } : {}), role: run.role, tool: run.tool, workerId: info.id, floorId: task.project, exitPlan: false, ended: false };
      this.live.set(info.id, live);
      if (info.status === 'done') void this.serial(task.id, () => this.turnEnded(live));
      else if (info.status === 'needs_input') void this.serial(task.id, () => this.needsInput(live, info));
    }
    // Tasks the engine was busy with that have no run to follow any more.
    for (const t of this.ctx.repo.tasksWhere({ runState: ['starting', 'running', 'stopping'] })) {
      if (attached.has(t.id) || [...this.live.values()].some((l) => l.taskId === t.id)) continue;
      void this.serial(t.id, async () => {
        const task = this.ctx.repo.getTask(t.id);
        if (task && task.runState !== 'idle' && task.runState !== 'queued') await this.apply(t.id, { type: 'interrupted', text: 'The office restarted while it ran: Retry to carry on' });
      });
    }
    for (const def of this.ctx.projects()) void this.drain(def.id);
    // Task workers kept from the last office carry only their task and role: their cards come back.
    for (const def of this.ctx.projects()) {
      const ids = new Set(this.ctx.floor(def.id)?.workers.list().flatMap((w) => (w.kanban ? [w.kanban.taskId] : [])));
      for (const id of ids) this.syncSummaries(this.ctx.repo.getTask(id));
    }
  }

  private async interruptedRun(run: KanbanRun, task: KanbanTask, text: string) {
    this.finishRun(run.id, task.project, { status: 'interrupted', error: text });
    if (task.status === 'in_progress' || task.status === 'waiting') await this.apply(task.id, { type: 'interrupted', text });
  }

  /** Every minute: newly opened floors, usage-limit retries that are due, queued tasks with room now. */
  private async sweep() {
    if (this.disposed) return;
    for (const def of this.ctx.projects()) this.watch(def.id);
    const now = this.opts.now();
    for (const t of this.ctx.repo.tasksWhere({ status: ['waiting'], retryDue: now })) {
      if (t.waitingReason !== 'usage_limit') continue;
      void this.serial(t.id, async () => {
        const task = this.ctx.repo.getTask(t.id);
        if (!task || task.status !== 'waiting' || task.waitingReason !== 'usage_limit' || !task.retryAt || task.retryAt > this.opts.now()) return;
        const err = await this.apply(task.id, { type: 'retry', last: this.lastRun(task.id) }, { who: OFFICE });
        if (err) this.note(task, `Couldn't carry on after the usage limit: ${err}`);
      });
    }
    for (const def of this.ctx.projects()) void this.drain(def.id);
  }

  // --- Small helpers ------------------------------------------------------------------------------

  private reviewSettings(task: Pick<KanbanTask, 'project' | 'overrides'>) {
    return this.ctx.settings.effectiveReview(task.project, task.overrides);
  }

  /** A folder project: no git, so no worktrees, no change check, no pull requests. */
  private folder(project: string): boolean {
    const def = this.ctx.project(project);
    return !!def && isFolderProject(def);
  }

  private card(id: number) {
    return this.ctx.repo.card(id, (t) => {
      const r = this.reviewSettings(t);
      return { rounds: r.rounds, tool: r.tool };
    });
  }

  private pushTask(task: KanbanTask | undefined) {
    if (!task) return;
    const card = this.card(task.id);
    if (card) this.ctx.broadcast({ t: 'kanban.task', task: card }, task.project);
    this.syncSummaries(task);
  }

  /**
   * The task's card on each of its workers (WorkerInfo.kanban), so the 3D office and /lite show it
   * with the ordinary worker.update. Called on every change of the task; unchanged ones aren't sent.
   */
  syncSummaries(task: KanbanTask | undefined) {
    if (!task) return;
    const workers = this.ctx.floor(task.project)?.workers;
    if (!workers) return;
    const mine = workers.list().filter((w) => w.kanban?.taskId === task.id);
    if (!mine.length) return;
    const card = this.card(task.id);
    for (const w of mine) {
      const summary: KanbanWorkerSummary = {
        taskId: task.id,
        role: w.kanban!.role,
        title: task.title,
        status: task.status,
        ...(task.phase ? { phase: task.phase } : {}),
        runState: task.runState,
        ...(task.reviewRound ? { round: task.reviewRound } : {}),
        ...(card ? { rounds: card.reviewRounds } : {}),
        ...(task.waitingReason ? { waitingReason: task.waitingReason } : {}),
        ...(task.retryAt ? { retryAt: task.retryAt } : {}),
      };
      workers.setKanbanSummary(w.id, summary);
    }
  }

  private update(id: number, patch: TaskUpdate): KanbanTask | undefined {
    const task = this.ctx.repo.updateTask(id, patch);
    this.pushTask(task);
    return task;
  }

  private addComment(project: string, c: NewComment): KanbanComment {
    const { comment, deduped } = this.ctx.repo.addComment(c);
    if (!deduped) this.ctx.broadcast({ t: 'kanban.comment', comment, project }, project);
    return comment;
  }

  /** Links uploads already attached to the task to its new comment, and sends the comment again so clients show them. */
  private linked(project: string, comment: KanbanComment, files: { id: string }[]) {
    if (!files.length) return;
    this.ctx.repo.linkAttachments(files.map((f) => f.id), comment.taskId, comment.id);
    this.ctx.broadcast({ t: 'kanban.comment', comment: this.ctx.repo.getComment(comment.id) ?? comment, project }, project);
  }

  /** A line from the office in the task's conversation (the repository never repeats one). */
  private note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number) {
    this.addComment(task.project, { taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text, ...(runId !== undefined ? { runId } : {}) });
  }

  private finishRun(id: number, project: string, patch: Parameters<KanbanContext['repo']['finishRun']>[1]) {
    const run = this.ctx.repo.finishRun(id, patch);
    if (run) this.ctx.broadcast({ t: 'kanban.run', run, project }, project);
    return run;
  }

  /**
   * The run Retry and Continue carry on: the latest, not counting compacts (they only tidy the session).
   * One stopped with no worker never started (see queuedStopped): it goes again as it would have.
   */
  private lastRun(taskId: number): LastRun | undefined {
    const runs = this.ctx.repo.listRuns(taskId).filter((r) => r.phase !== 'compact');
    const last = runs[runs.length - 1];
    const fresh = last?.status === 'stopped' && !last.workerId && !last.sessionId;
    return last && { phase: last.phase, ...(last.round !== undefined ? { round: last.round } : {}), role: last.role, ...(fresh ? { fresh } : {}) };
  }

  /**
   * A queued run taken out of the queue before it started (Stop, a move): recorded as a stopped run of
   * its phase and round, with no worker or session, as a stopped live run is, so Retry runs that one.
   */
  private queuedStopped(task: KanbanTask, q: QueuedRun, error: string) {
    const review = this.reviewSettings(task);
    const tool: KanbanTool = q.phase === 'pr-review' ? (this.lastPrReview(task.id)?.tool ?? review.tool) : q.role === 'reviewer' ? review.tool : task.tool;
    const run = this.ctx.repo.createRun({ taskId: task.id, phase: q.phase, ...(q.round !== undefined ? { round: q.round } : {}), role: q.role, tool, status: 'stopped' });
    this.finishRun(run.id, task.project, { status: 'stopped', error });
  }

  private liveOf(taskId: number): Live | undefined {
    for (const l of this.live.values()) if (l.taskId === taskId) return l;
    return undefined;
  }

  /**
   * Tasks of a project holding one of its maxConcurrent slots. A run queued for a desk or the worker
   * limit (queuedRun) keeps its task's slot: only a start waiting for a slot doesn't have one. Were it
   * let go, more tasks would start meanwhile and take the desks its own worker is waiting for.
   */
  private busyCount(project: string, except?: number): number {
    const ids = new Set<number>();
    for (const t of this.ctx.repo.tasksWhere({ status: ['in_progress'] })) if (t.project === project && (t.runState !== 'queued' || t.queuedRun)) ids.add(t.id);
    for (const l of this.live.values()) if (l.floorId === project) ids.add(l.taskId);
    if (except !== undefined) ids.delete(except);
    return ids.size;
  }

  /**
   * Queued tasks start, oldest first, while the project has room: first the runs that waited for a
   * desk or for the office's worker limit (queuedRun, already holding their maxConcurrent slot), then
   * the starts waiting for a slot. They run as their creator's account.
   */
  private async drain(project: string) {
    const max = this.ctx.settings.project(project).maxConcurrent;
    const queued = this.ctx.repo.tasksWhere({ runState: ['queued'] }).filter((t) => t.project === project);
    queued.sort((a, b) => Number(!a.queuedRun) - Number(!b.queuedRun));
    for (const t of queued) {
      const floor = this.ctx.floor(project);
      if (!floor) return;
      // No room for this one; a reviewer whose implementer is still at its desk may have it (see sharesLimit),
      // and needs no desk of its own when it can stand behind its implementer's (see watchSpotFor).
      const watch = t.queuedRun?.role === 'reviewer' ? this.watchSpotFor(t, floor) : undefined;
      if (this.noRoom(floor, watch, t.queuedRun && this.sharesLimit(t, t.queuedRun.role, floor), t.queuedRun?.role)) continue;
      if (!t.queuedRun && this.busyCount(project) >= max) return;
      await this.serial(t.id, async () => {
        const task = this.ctx.repo.getTask(t.id);
        if (!task || task.runState !== 'queued') return;
        // A queued task may have been moved out of the process since (to do, done, archived): no hire then.
        if (task.status !== 'in_progress' && task.status !== 'waiting' && task.status !== 'review') {
          if (task.queuedRun) this.queuedStopped(task, task.queuedRun, 'The task left the process before it started');
          this.update(t.id, { runState: 'idle', queuedRun: null });
          return;
        }
        const via: Via = { who: { name: task.createdBy, admin: false } };
        if (task.queuedRun) {
          const err = await this.apply(t.id, { type: 'dequeue', run: runOf(task.queuedRun) }, via);
          if (err) this.note(task, `Couldn't start it from the queue: ${err}`);
          return;
        }
        if (task.status !== 'in_progress' || this.busyCount(project, t.id) >= max) return;
        await this.apply(t.id, { type: 'start', slot: true }, via);
      });
    }
  }

  /** Every project's queue looks again, once whatever freed the room has settled (upstream's queue pumps then too). */
  private drainSoon() {
    if (this.drainDue || this.disposed) return;
    this.drainDue = true;
    setImmediate(() => {
      this.drainDue = false;
      if (this.disposed) return;
      for (const def of this.ctx.projects()) void this.drain(def.id);
    });
  }

  /** Upstream's why-message when `owner` (see hireOwner) has no Claude sign-in, saying whose it is when it isn't the caller's. */
  private signInMissing(task: Pick<KanbanTask, 'id' | 'createdBy' | 'createdByAccount'>, owner: string, who?: KanbanCaller): string {
    const why = this.ctx.runAs!.why('claude');
    if (owner !== task.createdByAccount || owner === who?.accountId) return why;
    return `Task #${task.id} runs as its creator, ${task.createdBy}, whose Claude sign-in is missing. ${why}`;
  }

  /**
   * Why a new hire can't be made now, as the queued task's conversation says it: no free desk (the
   * `preferred` one or any other), or the office at its worker limit. Undefined when there's room.
   * `countsWith` (see sharesLimit): the worker limit isn't this hire's to wait for. `role`: a reviewer's
   * `preferred` is the spot behind its implementer's seat (see watchSpotFor), anyone else's a seat.
   */
  private noRoom(floor: Floor, preferred?: string, countsWith?: string, role?: KanbanRole): string | undefined {
    const desk = (preferred && !this.deskRefusal(floor, preferred, role === 'reviewer')) || nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0);
    if (!desk) return "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees.";
    if (countsWith) return undefined;
    const full = this.ctx.capacity?.();
    return full ? `Queued: ${full.replace(/[.\s]+$/, '')}. It starts by itself when the office has room.` : undefined;
  }

  /**
   * Where a task's reviewer goes: the spot behind its implementer's chair, over its shoulder, watching
   * its screen, so a review takes no desk. The implementer's desk while it's there, else the desk the
   * task last sat at (it comes back there for the fixes), but only while nobody else sits there: never
   * behind another task's or a person's worker. Undefined otherwise (the reviewer then takes the next
   * free seat, as any hire does).
   */
  private watchSpotFor(task: Pick<KanbanTask, 'id' | 'workerId' | 'deskId'>, floor: Floor): string | undefined {
    const implementer = task.workerId ? floor.workers.get(task.workerId) : undefined;
    let deskId = implementer?.deskId;
    if (!deskId && task.deskId) {
      const there = floor.workers.list().find((w) => w.deskId === task.deskId);
      if (!there || there.kanban?.taskId === task.id) deskId = task.deskId;
    }
    const desk = deskId ? DESK_BY_ID.get(deskId) : undefined;
    if (!desk || desk.station || desk.room || desk.watch) return undefined;
    return watchSpotOf(desk.id);
  }

  /**
   * A task counts once against the office's worker limit: its reviewer's hire doesn't wait for the
   * place its own implementer holds, which nothing would ever free (the implementer stays at its desk
   * for the fixes). The implementer's worker id while it is at its desk, for SpawnExtra.countsWith;
   * once it's gone, a reviewer is held to the limit like any hire.
   */
  private sharesLimit(task: Pick<KanbanTask, 'workerId'>, role: KanbanRole, floor: Floor): string | undefined {
    return role === 'reviewer' && task.workerId && floor.workers.get(task.workerId) ? task.workerId : undefined;
  }

  /**
   * A worktree cut next starts from what's on GitHub now, as upstream's hires do (withFreshBase, the
   * queue): the floor's base and each other repository's, the configured base branch where there is one.
   */
  private async freshBase(floor: Floor, def: FloorDef, repoIds: string[] | null) {
    const fetching: Promise<void>[] = [];
    const bases = baseBranches(def, repoIds);
    const own = floor.workers.fetchBase?.(bases[path.resolve(def.dir)]);
    if (own) fetching.push(own);
    for (const r of repoSources(def, repoIds)) {
      try {
        let trees = this.trees.get(r.dir);
        if (!trees) this.trees.set(r.dir, (trees = new Worktrees(r.dir)));
        const f = trees.fetch(bases[path.resolve(r.dir)]);
        if (f) fetching.push(f);
      } catch {
        // not a checkout git can fetch in: its worktree starts from what's there
      }
    }
    await Promise.all(fetching);
  }

  /** Tells the office's team notifications, once per transition, that a task waits on a person. */
  private announce(task: KanbanTask, what: string) {
    const name = this.ctx.project(task.project)?.name ?? task.project;
    try {
      this.ctx.notify?.(`🗂️ #${task.id} ${clip(task.title, 80)} ${what} in ${name}`);
    } catch (err) {
      console.error(`agent-office: couldn't announce kanban task #${task.id}: ${(err as Error).message}`);
    }
  }

  // --- Applying the machine -----------------------------------------------------------------------

  /** Feeds an event to the machine, saves the task's new state and carries out the effects. */
  private async apply(taskId: number, e: MachineEvent, via: Via = {}): Promise<string | undefined> {
    const task = this.ctx.repo.getTask(taskId);
    if (!task) return 'No such task';
    const review = this.reviewSettings(task);
    const defaultAnswer = this.compose.text('kanban.defaultAnswer', task.project, { taskId: task.id });
    const tr = next(stateOf(task), e, { type: task.type, usePlan: task.usePlan, useReview: task.useReview, planApproval: task.planApproval }, { rounds: review.rounds, reReviewLastFix: review.reReviewLastFix, ...(defaultAnswer ? { defaultAnswer } : {}) });
    if ('error' in tr) return tr.error;
    const s = tr.state;
    this.update(taskId, {
      status: s.status,
      phase: s.phase,
      runState: s.runState,
      waitingReason: s.waitingReason,
      waitingText: s.waitingText,
      reviewRound: s.reviewRound,
      retryAt: s.retryAt,
      retryAttempts: s.retryAttempts,
      // Out of the queue, however it went (started, stopped): its queued run is no more.
      ...(s.runState !== 'queued' && task.queuedRun ? { queuedRun: null } : {}),
    });
    const plan = s.status === 'waiting' && (s.waitingReason === 'plan_approval' || s.waitingReason === 'plan_questions') ? s.waitingReason : undefined;
    if (plan && !(task.status === 'waiting' && task.waitingReason === plan)) this.announce(task, plan === 'plan_approval' ? 'needs plan approval' : 'has questions');
    let error: string | undefined;
    for (const effect of tr.effects) {
      const err = await this.effect(taskId, effect, via);
      if (err && !error) error = err;
    }
    return error;
  }

  private async effect(taskId: number, eff: Effect, via: Via): Promise<string | undefined> {
    const task = this.ctx.repo.getTask(taskId);
    if (!task) return 'No such task';
    switch (eff.type) {
      case 'run': {
        const r = await this.launch(task, eff, via);
        if (r && typeof r === 'object') {
          // No desk, or the office's worker limit: it waits in the queue, and starts as it is (drain).
          this.update(taskId, { queuedRun: queuedOf(eff) });
          await this.apply(taskId, { type: 'noRoom', text: r.queued });
          return undefined;
        }
        const err = r;
        if (err) {
          this.note(task, `Couldn't start the ${eff.phase} phase: ${err}`);
          await this.apply(taskId, { type: 'failed', error: err });
        }
        return err;
      }
      case 'acceptPlan': {
        const plan = this.ctx.repo.acceptPlan(taskId, via.who?.name ?? 'Kanban');
        if (plan) this.ctx.broadcast({ t: 'kanban.plan', plan, project: task.project }, task.project);
        this.update(taskId, { flags: { ...task.flags, planAccepted: true } });
        return undefined;
      }
      case 'planFeedback': {
        const latest = this.ctx.repo.latestPlan(taskId);
        if (latest && latest.status === 'draft') {
          const plan = this.ctx.repo.setPlanFeedback(latest.id, eff.text);
          if (plan) this.ctx.broadcast({ t: 'kanban.plan', plan, project: task.project }, task.project);
        }
        return undefined;
      }
      case 'reviewerHome':
        await this.reviewerHome(task);
        return undefined;
      case 'interrupt':
        this.interrupt(task, via.who);
        return undefined;
      case 'queueComment': {
        const c = via.commentId !== undefined ? this.ctx.repo.getComment(via.commentId) : undefined;
        if (!c || task.pendingMessages.some((p) => p.commentId === c.id)) return undefined;
        const pending = [...task.pendingMessages, { commentId: c.id, text: c.text, by: c.authorName, at: c.createdAt }].slice(-PENDING_MAX);
        this.ctx.repo.setCommentPending(c.id, true);
        const updated = this.ctx.repo.getComment(c.id);
        if (updated) this.ctx.broadcast({ t: 'kanban.comment', comment: updated, project: task.project }, task.project);
        this.update(taskId, { pendingMessages: pending });
        return undefined;
      }
      case 'note':
        this.note(task, eff.text);
        return undefined;
      case 'finished':
        this.update(taskId, { finishedAt: this.opts.now() });
        this.ctx.toast(task.project, `🗂️ #${task.id} ${clip(task.title, 60)} is ready for review`, 'info');
        this.announce(task, 'is ready for review');
        return undefined;
    }
  }

  // --- Starting runs ------------------------------------------------------------------------------

  /** The pending comments, taken off the task to be typed in now: one message, and who wrote it. */
  private takePending(task: KanbanTask): { text: string; author: string } | undefined {
    if (!task.pendingMessages.length) return undefined;
    const msgs = task.pendingMessages;
    for (const m of msgs) {
      this.ctx.repo.setCommentPending(m.commentId, false);
      const c = this.ctx.repo.getComment(m.commentId);
      if (c) this.ctx.broadcast({ t: 'kanban.comment', comment: c, project: task.project }, task.project);
    }
    this.update(task.id, { pendingMessages: [] });
    const authors = [...new Set(msgs.map((m) => m.by))];
    const text = msgs.length === 1 ? msgs[0].text : msgs.map((m) => `${m.by}:\n${m.text}`).join('\n\n');
    return { text, author: authors.join(', ') };
  }

  /** The findings of the task's latest review, or the implementer's latest fix reply. */
  private latestSummary(taskId: number, phase: RunPhase): string | undefined {
    const runs = this.ctx.repo.listRuns(taskId).filter((r) => r.phase === phase && r.summary);
    return runs[runs.length - 1]?.summary;
  }

  /** The session a role carries on, if it's one of the tool it runs now. */
  private sessionFor(task: KanbanTask, role: KanbanRole, tool: KanbanTool): string | undefined {
    const id = role === 'implementer' ? task.sessionId : task.reviewerSessionId;
    if (!id) return undefined;
    const run = [...this.ctx.repo.listRuns(task.id)].reverse().find((r) => r.role === role && r.sessionId === id);
    return !run || run.tool === tool ? id : undefined;
  }

  /** What a phase prompt falls back to when there's no session to say "continue" to. */
  private freshKind(task: KanbanTask, phase: RunPhase): PromptKind {
    switch (phase) {
      case 'plan':
        return 'plan';
      case 'implement':
        return task.type === 'investigate' ? 'investigate' : 'implement';
      case 'review':
        return 'review';
      case 'pr':
        return 'pr.create';
      case 'pr-fix':
        return 'pr.fix';
      case 'compact':
        return 'compact';
      default:
        return 'continue';
    }
  }

  /** Starts a run: in the role's live worker (typed, or relaunched with the phase's flags), or a new hire. */
  private async launch(task: KanbanTask, eff: RunEffect, via: Via): Promise<string | NoRoom | undefined> {
    const def = this.ctx.project(task.project);
    const floor = this.watch(task.project);
    if (!def || !floor) return "The project's floor isn't open";
    if (eff.phase === 'pr-review') return this.launchPrReview(task, def, floor, via);
    const role = eff.role;
    const review = this.reviewSettings(task);
    const defaults = this.ctx.settings.get().defaults;
    const tool: KanbanTool = role === 'reviewer' ? review.tool : task.tool;
    const model = role === 'reviewer' ? review.model : (task.model ?? (task.tool === defaults.tool ? defaults.model : undefined));
    const effort: KanbanEffort | undefined = role === 'reviewer' ? review.effort : (task.effort ?? (task.tool === defaults.tool ? defaults.effort : undefined));
    const adapter = this.adapters[tool];
    const folder = isFolderProject(def);
    if (folder && (eff.phase === 'pr' || eff.phase === 'pr-fix')) return 'A folder project has no git repositories to open pull requests in';
    if (eff.phase === 'pr-fix' && !task.prs.some((p) => p.state === 'OPEN' || p.state === 'DRAFT')) return 'The task has no open pull requests to fix';

    // Its worktree is gone (its worker went home with leave-on-merge, or it was pruned): anyone seated
    // there would only be marked lost. The workspace goes, its branch stays, and a fresh worktree takes
    // over that branch (see checkoutFor).
    const gone = !folder && task.workspace ? missingFolders(floor.dir, task.workspace) : [];
    if (gone.length) await this.dropWorkspace(task, floor, gone);
    if (role === 'reviewer' && !folder && !this.ctx.repo.getTask(task.id)?.workspace) {
      return `${gone.length ? 'Its worktree is gone' : 'It has no worktree yet'}, so there is nothing to review in: comment to have its agent carry on in a fresh worktree${task.branch ? ` on branch ${task.branch}` : ''}, then review`;
    }

    // What the prompt says.
    let text = eff.text;
    let author = via.who?.name;
    if (eff.pending) {
      const p = this.takePending(task);
      if (p) ({ text, author } = p);
    }
    const refsFile = eff.phase === 'plan' ? this.ctx.refs.referencedTasksFile(task.id, [task.title, task.description, text ?? ''].join('\n')) : undefined;
    const x: ComposeExtra = {
      phase: eff.phase,
      round: eff.round,
      rounds: review.rounds,
      text,
      author,
      findings: eff.prompt === 'fix' ? reviewFindings(this.latestSummary(task.id, 'review') ?? '') : undefined,
      fixSummary: eff.prompt === 'rereview' ? this.latestSummary(task.id, 'fix') : undefined,
      refsFile,
    };
    const fresh = this.ctx.repo.getTask(task.id) ?? task;
    const build = (kind: PromptKind) => this.compose.build(kind, def, fresh, tool, floor.dir, x);
    /** The prompt, told first to check out the task's branch when a fresh worktree has yet to (implement has it as its branch step). */
    const withCheckout = (prompt: string) => {
      if (!x.checkout) return prompt;
      const block = this.compose.checkout(fresh, x.checkout);
      return prompt.includes(block) ? prompt : `${block}\n\n${prompt}`;
    };

    // The role's worker, when it's still at its desk.
    const workerId = role === 'implementer' ? fresh.workerId : fresh.reviewerWorkerId;
    let info = workerId ? floor.workers.get(workerId) : undefined;
    if (info && info.provider !== tool && info.status !== 'working') {
      // The task's tool was changed: the worker at the desk runs the other CLI. A new hire takes over.
      await floor.sendHome(info.id, 'keep', ENGINE);
      this.update(task.id, role === 'implementer' ? { workerId: null } : { reviewerWorkerId: null });
      info = undefined;
    }
    const owner = hireOwner(fresh, via.who);
    // A reviewer stands behind its implementer's chair rather than taking a desk of its own (see watchSpotFor).
    const preferred = role === 'implementer' ? (via.deskId ?? fresh.deskId) : this.watchSpotFor(fresh, floor);
    const countsWith = this.sharesLimit(fresh, role, floor);
    if (!info) {
      // A new hire runs on its owner's own Claude sign-in (upstream's rule), never on the office's
      // instead; it needs a free desk and room under the office's worker limit (a reviewer shares its
      // implementer's), else it's queued; and a worktree it gets starts from what's on GitHub now.
      if (owner && tool === 'claude' && this.ctx.runAs && !this.ctx.runAs.claudeReady(owner)) return this.signInMissing(fresh, owner, via.who);
      const full = this.noRoom(floor, preferred, countsWith, role);
      if (full) return { queued: full };
      if (!folder && !fresh.workspace) await this.freshBase(floor, def, fresh.repoIds);
    }

    // How it launches.
    const addDirs: string[] = [];
    if (refsFile) addDirs.push(path.dirname(refsFile));
    // Always: a file sent later in an answer typed into the live session must be readable without a prompt.
    const uploads = path.join(this.ctx.filesDir, 'uploads');
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    addDirs.push(uploads);
    const investigate = task.type === 'investigate' && role === 'implementer';
    if (investigate) addDirs.push(reportDir(this.ctx, task.id));
    for (const r of taskRepos(def, task)) if (!r.primary && (r.kind === 'folder' || folder)) addDirs.push(r.dir);
    const extras = this.ctx.workerExtras(task.id, tool, skillPhase(eff.phase));
    const launchArgs = adapter.launchArgs(eff.phase, {
      permission: this.ctx.settings.implementPermission(task.project, task.overrides),
      sandbox: review.sandbox,
      investigate,
      addDirs,
      model,
      effort,
      extra: extras.args,
    });
    const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;

    const run = this.ctx.repo.createRun({ taskId: task.id, phase: eff.phase, ...(eff.round !== undefined ? { round: eff.round } : {}), role, tool, model, effort });
    this.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
    const follow = (workerId: string): Live => {
      const live: Live = { taskId: task.id, runId: run.id, phase: eff.phase, ...(eff.round !== undefined ? { round: eff.round } : {}), role, tool, workerId, floorId: task.project, exitPlan: false, ended: false };
      this.live.set(workerId, live);
      if (eff.phase === 'compact') {
        live.compactTimer = setTimeout(() => void this.serial(task.id, () => this.turnEnded(live)), this.opts.compactTimeoutMs);
        live.compactTimer.unref?.();
      }
      return live;
    };
    const fail = (err: string) => {
      this.finishRun(run.id, task.project, { status: 'failed', error: err });
      return err;
    };

    if (info && info.kind === 'agent' && info.status !== 'working' && info.status !== 'starting') {
      x.checkout = await this.checkoutFor(fresh, def, floor.dir, role, eff.phase, false);
      const prompt = typeable(withCheckout(build(eff.prompt === 'continue' && !info.sessionId ? this.freshKind(fresh, eff.phase) : eff.prompt)));
      const live = follow(info.id);
      let err: string | undefined;
      // The task's model and effort as they are now (changed since the last run, say): a worker on
      // other ones is relaunched with them even when the phase's flags are the same.
      const spawnModel = adapter.spawnModel(model);
      const spawnEffort = adapter.spawnEffort(effort);
      const same = sameArgs(floor.workers.launchArgsOf(info.id), launchArgs) && info.model === spawnModel && info.effort === spawnEffort;
      if (same && (info.status === 'done' || info.status === 'idle')) err = floor.workers.prompt(info.id, prompt, via.who?.name);
      else if (info.sessionId) err = await floor.workers.relaunch(info.id, { launchArgs, prompt, env: extras.env, model: spawnModel, effort: spawnEffort });
      else err = 'no session';
      if (!err) {
        this.ctx.repo.updateRun(run.id, { workerId: info.id, sessionId: info.sessionId });
        this.update(task.id, { runState: 'running' });
        return undefined;
      }
      this.live.delete(info.id);
      clearTimeout(live.compactTimer);
      // It can't carry on in place (no session yet, say): a new hire in the same worktree takes over.
      await floor.sendHome(info.id, 'keep', ENGINE);
      this.update(task.id, role === 'implementer' ? { workerId: null } : { reviewerWorkerId: null });
    } else if (info && (info.status === 'working' || info.status === 'starting')) {
      return fail(`${info.name} is busy: wait for its turn to end`);
    }

    // A new hire.
    // The task's desk (the one it was started at, or where it last sat) when it's free, else the next free one.
    const desk = (preferred && !this.deskRefusal(floor, preferred, role === 'reviewer') ? preferred : undefined) ?? nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0)?.id;
    if (!desk) {
      // Taken while its base was fetched: back to the queue.
      this.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its worker' });
      return { queued: this.noRoom(floor, preferred, countsWith, role) ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
    }
    const now = this.ctx.repo.getTask(task.id) ?? fresh;
    const session = this.sessionFor(now, role, tool);
    let kind = eff.prompt;
    if (!session) {
      if (kind === 'continue' || kind === 'rereview') kind = kind === 'rereview' ? 'review' : this.freshKind(now, eff.phase);
      if (kind === 'replan') kind = 'plan';
    }
    x.checkout = await this.checkoutFor(now, def, floor.dir, role, eff.phase, !folder && !now.workspace);
    let prompt = build(kind);
    // A fresh session taking over work already under way is told where things stand first.
    if (!session && role === 'implementer' && (kind === 'fix' || kind === 'resume' || kind === 'continue' || kind === 'pr.create' || kind === 'pr.fix' || kind === 'compact') && (now.workspace || x.checkout)) {
      prompt = this.compose.handoff(def, now, floor.dir, kind === 'compact' ? '' : withCheckout(prompt));
    } else prompt = withCheckout(prompt);
    if (eff.prompt === 'replan' && !session && text) prompt = `${prompt}\n\n${this.compose.text('kanban.sinceSaid', task.project, { text })}`.trim();
    prompt = typeable(prompt);
    const reuse = now.workspace ? { worktree: now.workspace.worktree, repos: now.workspace.repos } : undefined;
    const worktree = !folder && !reuse;
    const hired = floor.workers.spawn(desk, by, prompt, worktree, 'agent', tool, adapter.spawnModel(model), adapter.spawnEffort(effort), undefined, owner, worktree ? repoSources(def, task.repoIds) : [], undefined, {
      launchArgs,
      ...(reuse ? { reuse } : { bases: baseBranches(def, task.repoIds) }),
      ...(session ? { resumeSessionId: session } : {}),
      ...(countsWith ? { countsWith } : {}),
      kanban: { taskId: task.id, role },
      env: extras.env,
      settingsFile: 'kanban',
    });
    if (typeof hired === 'string') return fail(hired);
    const live = follow(hired.id);
    this.ctx.repo.updateRun(run.id, { workerId: hired.id, ...(session ? { sessionId: session } : {}) });
    const patch: TaskUpdate = role === 'implementer' ? { workerId: hired.id, deskId: desk } : { reviewerWorkerId: hired.id };
    if (preferred && desk !== preferred) this.note(task, `${DESK_BY_ID.get(preferred)?.label ?? preferred} is taken, so ${hired.name} sits at ${DESK_BY_ID.get(desk)?.label ?? desk}.`);
    if (role === 'implementer' && !now.workspace && hired.worktree) {
      patch.workspace = { worktree: hired.worktree, ...(hired.repos?.length ? { repos: hired.repos } : {}) };
      // A branch the task already has (a migrated task, one whose worktree went) stays its branch:
      // the agent was told to check it out (checkoutFor), and syncBranch follows it there.
      if (!now.branch) patch.branch = hired.worktree.branch;
    }
    patch.runState = 'running';
    this.update(task.id, patch);
    this.exitedAtHire(live);
    return undefined;
  }

  /**
   * A worker that couldn't even start (its folder is gone, so upstream marks it lost and exited
   * before the engine follows it): its run is interrupted right away rather than left running.
   */
  private exitedAtHire(live: Live) {
    const info = this.ctx.floor(live.floorId)?.workers.get(live.workerId);
    if (info?.status === 'exited') void this.serial(live.taskId, () => this.exited(live));
  }

  /**
   * The task's branch in each repository, one line each, when the worktree the run goes into isn't on
   * it: a fresh one (`freshTree`) for a task that already has a branch, or one still on the branch
   * the office cut for it. Undefined when there's nothing to check out (a plan or compact, an
   * investigation, a folder project, no branch yet, or already on it).
   */
  private async checkoutFor(task: KanbanTask, def: FloorDef, floorDir: string, role: KanbanRole, phase: RunPhase, freshTree: boolean): Promise<string | undefined> {
    if (role !== 'implementer' || phase === 'plan' || phase === 'compact' || task.type === 'investigate' || !task.branch || isFolderProject(def)) return undefined;
    if (!freshTree) {
      if (!task.workspace) return undefined;
      const on = await currentBranch(path.join(floorDir, task.workspace.worktree.path));
      if (!on || on === task.branch) return undefined;
    }
    const branches = this.ctx.repo.repoBranches(task.id);
    return taskRepos(def, task)
      .filter((r) => r.kind === 'git')
      .map((r) => `- ${r.name}: \`${branches[r.id] ?? task.branch}\``)
      .join('\n');
  }

  /** The task's workspace is gone: its workers go home, and it (and the sessions that ran there) is forgotten; its branch stays. */
  private async dropWorkspace(task: KanbanTask, floor: Floor, gone: string[]) {
    const ids = [task.workerId, task.reviewerWorkerId].filter((x): x is string => !!x && !this.live.has(x));
    this.update(task.id, { workspace: null, sessionId: null, reviewerSessionId: null, ...(task.workerId && ids.includes(task.workerId) ? { workerId: null } : {}), ...(task.reviewerWorkerId && ids.includes(task.reviewerWorkerId) ? { reviewerWorkerId: null } : {}) });
    for (const id of ids) if (floor.workers.get(id)) await floor.sendHome(id, 'keep', ENGINE);
    const where = gone.map((d) => path.relative(floor.dir, d) || d).join(', ');
    this.note(task, `Its worktree is gone (${where}): a fresh worktree takes over${task.branch ? `, and the agent checks out the task's branch ${task.branch} there first` : ''}.`);
  }

  /** How a task's worker goes home: a reviewer in a worktree of its own (a pull-request review's) takes it away; the rest keep theirs. */
  private homeCleanup(task: KanbanTask | undefined, info: WorkerInfo | undefined): 'keep' | 'all' {
    if (!info?.worktree || info.kanban?.role !== 'reviewer') return 'keep';
    return info.worktree.path !== task?.workspace?.worktree.path ? 'all' : 'keep';
  }

  /** The request of the task's latest pull-request review (for a Retry), as reviewPrs recorded it. */
  private lastPrReview(taskId: number): KanbanPrReviewRequest | undefined {
    const e = [...this.ctx.repo.listEvents(taskId)].reverse().find((x) => x.kind === 'pr.review');
    const req = (e?.data as { request?: KanbanPrReviewRequest } | undefined)?.request;
    return req && Array.isArray(req.prs) ? req : undefined;
  }

  /**
   * A pull-request review's run: its own reviewer, hired fresh in a worktree of each repository the
   * pull requests are in (never the floor's checkout, never the task's worktree), with the review's
   * read-only flags. A Retry reviews them again from the start.
   */
  private async launchPrReview(task: KanbanTask, def: FloorDef, floor: Floor, via: Via): Promise<string | NoRoom | undefined> {
    if (isFolderProject(def)) return 'A folder project has no pull requests to review';
    const req = via.prReview ?? this.lastPrReview(task.id);
    if (!req?.prs.length) return 'There are no pull requests to review: pick them again';
    const review = this.reviewSettings(task);
    const tool: KanbanTool = req.tool ?? review.tool;
    const same = !req.tool || req.tool === review.tool;
    const model = req.model ?? (same ? review.model : undefined);
    const effort = req.effort ?? (same ? review.effort : undefined);
    const adapter = this.adapters[tool];
    const involved = projectRepos(def).filter((r) => !r.primary && r.kind === 'git' && r.remote && req.prs.some((p) => sameRepo(r.remote!, p.repo))).map((r) => r.id);

    // Whoever reviewed for the task before goes home: this review starts in a worktree of its own.
    const prev = task.reviewerWorkerId ? floor.workers.get(task.reviewerWorkerId) : undefined;
    if (prev) {
      if (prev.status === 'working' || prev.status === 'starting') return `${prev.name} is busy: wait for its turn to end`;
      await floor.sendHome(prev.id, this.homeCleanup(task, prev), ENGINE);
    }
    this.update(task.id, { reviewerWorkerId: null, reviewerSessionId: null });

    const attached = req.taskId !== undefined;
    const prs = (req.prs as ReviewedPr[]).map((p) => `- ${p.repo}#${p.number}${p.title ? ` “${p.title}”` : ''}${p.branch ? ` (branch ${p.branch})` : ''} ${p.url ?? `https://github.com/${p.repo}/pull/${p.number}`}`).join('\n');
    const x: ComposeExtra = {
      phase: 'pr-review',
      prs,
      prTask: attached ? `They are kanban task #${task.id}'s: ${task.title}${task.ticket ? ` (${task.ticket})` : ''}` : '',
      prRepos: reposText(def, { repoIds: involved, workspace: undefined }, floor.dir),
    };
    const prompt = typeable(this.compose.build('pr.review', def, task, tool, floor.dir, x));
    const extras = this.ctx.workerExtras(task.id, tool, skillPhase('pr-review'));
    const launchArgs = adapter.launchArgs('pr-review', { permission: this.ctx.settings.implementPermission(task.project, task.overrides), sandbox: review.sandbox, model, effort, extra: extras.args });

    const owner = hireOwner(task, via.who);
    const signIn = owner && tool === 'claude' && this.ctx.runAs && !this.ctx.runAs.claudeReady(owner) ? this.signInMissing(task, owner, via.who) : undefined;
    const countsWith = this.sharesLimit(this.ctx.repo.getTask(task.id) ?? task, 'reviewer', floor);
    // No desk, or the office's worker limit: queued as any hire is (the drain runs it again, the
    // pull requests from its pr.review event).
    const full = signIn ? undefined : this.noRoom(floor, undefined, countsWith);
    if (full) return { queued: full };

    const run = this.ctx.repo.createRun({ taskId: task.id, phase: 'pr-review', role: 'reviewer', tool, model, effort });
    this.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
    const fail = (err: string) => {
      this.finishRun(run.id, task.project, { status: 'failed', error: err });
      return err;
    };
    if (signIn) return fail(signIn);
    await this.freshBase(floor, def, involved);
    const desk = nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0)?.id;
    if (!desk) {
      // Taken while its bases were fetched: back to the queue.
      this.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its reviewer' });
      return { queued: this.noRoom(floor, undefined, countsWith) ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
    }
    const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;
    const hired = floor.workers.spawn(desk, by, prompt, true, 'agent', tool, adapter.spawnModel(model), adapter.spawnEffort(effort), undefined, owner, repoSources(def, involved), undefined, {
      launchArgs,
      bases: baseBranches(def, involved),
      ...(countsWith ? { countsWith } : {}),
      kanban: { taskId: task.id, role: 'reviewer' },
      env: extras.env,
      settingsFile: 'kanban',
    });
    if (typeof hired === 'string') return fail(hired);
    const live: Live = { taskId: task.id, runId: run.id, phase: 'pr-review', role: 'reviewer', tool, workerId: hired.id, floorId: task.project, exitPlan: false, ended: false };
    this.live.set(hired.id, live);
    this.ctx.repo.updateRun(run.id, { workerId: hired.id });
    this.update(task.id, { reviewerWorkerId: hired.id, runState: 'running' });
    this.exitedAtHire(live);
    return undefined;
  }

  // --- Following workers --------------------------------------------------------------------------

  private observed(floorId: string, o: WorkerObservation) {
    if (this.disposed) return;
    if (o.event === 'removed') {
      const taskId = o.info.kanban?.taskId ?? this.live.get(o.workerId)?.taskId;
      if (taskId !== undefined) void this.serial(taskId, () => this.removed(o.workerId, o.info, o.departure));
      // A desk freed, and room under the office's worker limit (every floor's): queued tasks look again.
      this.drainSoon();
      return;
    }
    if (o.event === 'cleaned') {
      const taskId = o.info.kanban?.taskId;
      if (taskId !== undefined) void this.serial(taskId, () => this.cleaned(floorId, taskId, o.info));
      return;
    }
    const live = this.live.get(o.workerId);
    if (!live || live.ended || live.floorId !== floorId) return;
    if (o.event === 'hook') {
      if ((o.hookEvent === 'PreToolUse' || o.hookEvent === 'PermissionRequest') && o.tool === 'ExitPlanMode') live.exitPlan = true;
      else if (o.hookEvent === 'PreToolUse' && o.tool) live.exitPlan = false;
      if (o.hookEvent === 'UserPromptSubmit') live.stopText = undefined;
      else if (o.hookEvent === 'Stop' && live.tool === 'claude') live.stopText = stopMessage(o.payload);
      this.heardAsk(live, o);
      const source = (o.payload as { source?: unknown } | undefined)?.source;
      if (live.phase === 'compact' && o.hookEvent === 'SessionStart' && source === 'compact') void this.serial(live.taskId, () => this.turnEnded(live));
      return;
    }
    const status = o.status;
    if (live.stopping) {
      if (status && RESTING.has(status)) void this.serial(live.taskId, () => this.stoppedRun(live));
      return;
    }
    switch (status) {
      case 'working':
        void this.serial(live.taskId, async () => {
          const task = this.ctx.repo.getTask(live.taskId);
          if (task?.status === 'waiting' && task.waitingReason === 'agent_asking') await this.apply(live.taskId, { type: 'working' });
        });
        return;
      case 'done':
        void this.serial(live.taskId, () => this.turnEnded(live));
        return;
      case 'needs_input':
        void this.serial(live.taskId, () => this.needsInput(live, o.info));
        return;
      case 'exited':
        void this.serial(live.taskId, () => this.exited(live));
        return;
    }
  }

  /**
   * What the agent's needs_input waits on, from its hooks (heard before the status they cause):
   * AskUserQuestion (Codex: request_user_input) is a question; PermissionRequest or a permission_prompt
   * notification a permission; another tool, a finished tool, a new prompt or the turn's end forget it
   * (unknown). In memory only: after an office restart it's unknown, answered in the terminal.
   */
  private heardAsk(live: Live, o: WorkerObservation) {
    const question = !!o.tool && QUESTION_TOOL.test(o.tool);
    let kind = live.asks;
    switch (o.hookEvent) {
      case 'PreToolUse':
        kind = question ? 'question' : undefined;
        break;
      case 'PermissionRequest':
        kind = question ? 'question' : 'permission';
        break;
      case 'Notification':
        // A question's own prompt notification doesn't make it a permission.
        if ((o.payload as { notification_type?: unknown } | undefined)?.notification_type === 'permission_prompt' && kind !== 'question') kind = 'permission';
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'UserPromptSubmit':
      case 'SessionStart':
      case 'Stop':
      case 'Interrupt':
        kind = undefined;
        break;
    }
    if (kind === live.asks) return;
    live.asks = kind;
    this.ctx.repo.setAskingKind(live.taskId, kind);
    const task = this.ctx.repo.getTask(live.taskId);
    if (task?.status === 'waiting' && task.waitingReason === 'agent_asking') this.pushTask(task);
  }

  private async needsInput(live: Live, info: WorkerInfo) {
    if (live.ended || this.live.get(live.workerId) !== live) return;
    if (live.phase === 'plan' && live.tool === 'claude') {
      // ExitPlanMode asks for approval: that is the plan being done. The hook says so, or the transcript.
      const file = this.ctx.floor(live.floorId)?.workers.transcripts(live.workerId)?.claude;
      if (live.exitPlan || (file && this.adapters.claude.readTurnResult(file)?.exitPlan)) return this.turnEnded(live, true);
    }
    const task = this.ctx.repo.getTask(live.taskId);
    if (!task || (task.status === 'waiting' && task.waitingReason === 'agent_asking')) return;
    await this.apply(live.taskId, { type: 'asking', text: `The agent is asking something in its terminal${info.activity ? `: ${clip(info.activity, 160)}` : ''}` });
  }

  /** Its agent exited mid-run, or couldn't start at all because its folder is gone (upstream's lost): the run was interrupted. */
  private async exited(live: Live) {
    if (live.ended || this.live.get(live.workerId) !== live) return;
    live.ended = true;
    this.forget(live);
    const task = this.ctx.repo.getTask(live.taskId);
    const lost = !!this.ctx.floor(live.floorId)?.workers.get(live.workerId)?.lost;
    const why = lost ? "Its worktree is gone, so its agent couldn't start" : 'The agent exited before its turn was done';
    this.finishRun(live.runId, live.floorId, { status: 'interrupted', error: why });
    if (task) await this.apply(task.id, { type: 'interrupted', text: `${why}: Retry to carry on${lost ? ` in a fresh worktree${task.branch ? ` on branch ${task.branch}` : ''}` : ''}` });
    void this.drain(live.floorId);
  }

  /**
   * A task worker left its desk. The engine's own departures (ENGINE) only finish what they were
   * part of; anyone else's go by the rules in docs/kanban-coupling.md (see departed), with exactly one
   * status line in the task's conversation. The intent comes with the removal itself, so nothing
   * else about the departure has to arrive in time.
   */
  private async removed(workerId: string, info: WorkerInfo, departure?: DepartureIntent) {
    const live = this.live.get(workerId);
    const taskId = info.kanban?.taskId ?? live?.taskId;
    if (taskId === undefined) return;
    const own = live && !live.ended ? live : undefined;
    if (own) {
      own.ended = true;
      this.forget(own);
    }
    const before = this.ctx.repo.getTask(taskId);
    if (before) {
      const patch: TaskUpdate = {};
      if (before.workerId === workerId) patch.workerId = null;
      if (before.reviewerWorkerId === workerId) patch.reviewerWorkerId = null;
      if (Object.keys(patch).length) this.update(taskId, patch);
    }
    const task = this.ctx.repo.getTask(taskId);
    const intent = departure ?? { by: 'Someone', reason: 'sent-home' };
    if (task && intent.reason !== 'engine') await this.departed(task, info, own, intent);
    else if (own) {
      if (own.stopping) await this.finishStopped(own);
      else {
        this.finishRun(own.runId, own.floorId, { status: 'interrupted', error: 'Its worker was sent home' });
        if (task) await this.apply(taskId, { type: 'interrupted', text: 'Its worker was sent home mid-run: Retry to carry on' });
      }
    }
    if (own) void this.drain(own.floorId);
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
  private async departed(task: KanbanTask, info: WorkerInfo, own: Live | undefined, intent: DepartureIntent) {
    const role = info.kanban?.role ?? own?.role ?? 'implementer';
    const open = task.status !== 'done' && task.status !== 'archived' && task.status !== 'todo';
    const merged = intent.reason === 'merged';
    const done = open && (merged ? this.allMerged(task) : intent.done === true);
    let line = this.departureLine(intent, info.name);
    let then: (() => Promise<unknown>) | undefined;
    if (own) {
      const what = own.phase === 'pr-review' || own.phase === 'review' ? 'review round' : `${own.phase} run`;
      this.finishRun(own.runId, own.floorId, { status: 'stopped', error: `${line} mid-run` });
      if (done) {
        line += `: its ${what} was stopped, and the task is done`;
        then = () => this.markDone(task, intent.by);
      } else if (role === 'reviewer') {
        const pending = task.pendingMessages.length > 0;
        line += pending ? `: its ${what} was dropped, and the comments that came in meanwhile go to the agent now` : `: its ${what} was dropped, and the task is in Review`;
        then = () => this.apply(task.id, { type: 'reviewAbandoned', pending });
      } else {
        line += `: its ${what} was stopped. Retry to carry on.`;
        then = () => this.apply(task.id, { type: 'stopped', by: intent.by, text: `${this.departureLine(intent, info.name)} mid-run: Retry to carry on` });
      }
    } else if (done) {
      line += ', and the task is done';
      then = () => this.markDone(task, intent.by);
    } else if (role === 'implementer' && task.status === 'in_progress' && task.runState !== 'queued' && !this.liveOf(task.id)) {
      line += ': Retry to carry on';
      then = () => this.apply(task.id, { type: 'interrupted', text: `${line}` });
    } else if (role === 'implementer' && task.retryAt && intent.reason === 'sent-home') {
      // Only X stops the auto-resume: a release (the Release button, a move to done) or the office's own recycling leaves it due.
      line += ": it doesn't carry on by itself after the usage limit any more, Retry when it should";
      then = async () => this.update(task.id, { retryAt: null });
    }
    if (merged && open && !done) line += `, but not every pull request of the task has merged, so it stays in ${task.status === 'in_progress' ? 'In progress' : task.status === 'waiting' ? 'Waiting' : 'Review'}`;
    this.note(task, `${line}.`.replace(/\.\.$/, '.'));
    await then?.();
  }

  /**
   * The task is done because its worker went home with it: another run of it stops, and its workers
   * still at their desks go home too (the worktree kept), as they do when a card is moved to done.
   */
  private async markDone(task: KanbanTask, by: string) {
    const other = this.liveOf(task.id);
    if (other) {
      other.ended = true;
      this.forget(other);
      this.finishRun(other.runId, other.floorId, { status: 'stopped', error: `${by} made the task done` });
    }
    const now = this.opts.now();
    this.update(task.id, { status: 'done', doneAt: now, archivedAt: null, runState: 'idle', waitingReason: null, waitingText: null, retryAt: null, finishedAt: task.finishedAt ?? now });
    this.ctx.repo.appendEvent(task.id, 'moved', { by, from: task.status, to: 'done', sentHome: true });
    await this.sendIdleHome(task.id, by, other?.workerId);
  }

  /** The task's workers at rest (and `also`, busy or not) go home with their worktree kept: it's done or archived. */
  private async sendIdleHome(taskId: number, by: string, also?: string) {
    const task = this.ctx.repo.getTask(taskId);
    const floor = task && this.ctx.floor(task.project);
    if (!floor) return;
    const going = floor.workers.list().filter((w) => w.kanban?.taskId === taskId && (w.id === also || !isBusy(w.status)));
    for (const w of going) await floor.sendHome(w.id, 'keep', { by, reason: 'released' });
  }

  /**
   * kill has dealt with a task worker's worktree: if that was the task's and it's gone now, the task's
   * workspace goes (and the sessions that ran there), and its branch unless git still has it here or
   * on origin, for whoever carries on in a fresh worktree.
   */
  private async cleaned(floorId: string, taskId: number, info: WorkerInfo) {
    const task = this.ctx.repo.getTask(taskId);
    const floor = this.ctx.floor(floorId);
    if (!task?.workspace || !floor || !info.worktree || task.workspace.worktree.path !== info.worktree.path) return;
    if (!missingFolders(floor.dir, task.workspace).length) return;
    const branch = task.branch;
    let stays = false;
    if (branch) {
      const def = this.ctx.project(task.project);
      const dirs = def ? taskRepos(def, task).filter((r) => r.kind === 'git').map((r) => r.dir) : [floor.dir];
      for (const dir of dirs.length ? dirs : [floor.dir]) if (!stays) stays = await branchExists(dir, branch);
    }
    this.update(task.id, { workspace: null, sessionId: null, reviewerSessionId: null, ...(branch && !stays ? { branch: null } : {}) });
  }

  /**
   * The worktree guard (WorkerManager.addKeepGuard): a task worker's worktree stays as it goes home,
   * whatever cleanup was asked for, while another worker of the task sits in it, or while the task has
   * a run going there (a Retry carries on in it).
   */
  private keepsWorktree(floorId: string, info: WorkerInfo): boolean {
    const taskId = info.kanban?.taskId;
    const wt = info.worktree?.path;
    if (taskId === undefined || !wt) return false;
    const others = this.ctx.floor(floorId)?.workers.list() ?? [];
    if (others.some((w) => w.id !== info.id && w.kanban?.taskId === taskId && w.worktree?.path === wt)) return true;
    const task = this.ctx.repo.getTask(taskId);
    const running = !!this.liveOf(taskId) || (!!task && task.runState !== 'idle' && task.runState !== 'queued');
    return running && task?.workspace?.worktree.path === wt;
  }

  private forget(live: Live) {
    if (this.live.get(live.workerId) === live) this.live.delete(live.workerId);
    if (live.asks) this.ctx.repo.setAskingKind(live.taskId, undefined);
    clearTimeout(live.compactTimer);
    clearTimeout(live.stopping?.timer);
  }

  /**
   * The turn's result from the session log, read again while the log is still catching up: the Stop
   * hook can come before Claude has logged its final answer (the log then ends at a tool's result).
   * A log that never catches up falls back on the answer the Stop hook carried (its text only, as a
   * final answer of its own), but never while the log's last tool call is still running: a Stop then
   * didn't come from Claude (anything run in the agent's shell has the hook token, and could carry
   * a verdict of its own choosing): what the log has goes on, as it does without a Stop answer.
   */
  private async readResult(live: Live): Promise<TurnResult | undefined> {
    const workers = this.ctx.floor(live.floorId)?.workers;
    const adapter = this.adapters[live.tool];
    let result: TurnResult | undefined;
    for (let i = 0; i < this.opts.readTries; i++) {
      const logs = workers?.transcripts(live.workerId);
      const file = live.tool === 'claude' ? logs?.claude : logs?.codex;
      result = file ? adapter.readTurnResult(file) : undefined;
      if (result?.complete) return result;
      await sleep(this.opts.readPauseMs);
    }
    if (live.tool !== 'claude' || result?.complete) return result;
    if (result && !result.toolRunning && live.stopText) return { text: live.stopText, complete: true };
    const why = !result ? 'no session log' : result.toolRunning ? 'a Stop while a tool was still running' : 'no last_assistant_message in its Stop hook';
    console.warn(`agent-office: kanban task #${live.taskId}: the ${live.phase} run's final answer never reached its session log (${why}): going on with the last text the log has`);
    return result;
  }

  /**
   * Keeps the task's branch and workspace as the implementer's worker has them now, asking git which
   * branch each folder is on (upstream follows only a single worktree's). The branch the office cut
   * for a fresh worktree never replaces a branch the task already has: that one is still to be
   * checked out there (see checkoutFor).
   */
  private async syncBranch(task: KanbanTask, info: WorkerInfo | undefined) {
    if (!info?.worktree || info.kanban?.role !== 'implementer') return;
    const floorDir = this.ctx.floor(task.project)?.dir;
    const pick = async (rel: string, given: string, made: string | undefined, known: string | undefined) => {
      const on = (floorDir && (await currentBranch(path.join(floorDir, rel)))) || given;
      const own = made ?? given;
      return known && known !== on && on === own && own.startsWith(BRANCH_PREFIX) ? known : on;
    };
    const branch = await pick(info.worktree.path, info.worktree.branch, info.worktree.made, task.branch);
    const ws = { worktree: info.worktree, ...(info.repos?.length ? { repos: info.repos } : {}) };
    if (JSON.stringify(ws) !== JSON.stringify(task.workspace) || task.branch !== branch) this.update(task.id, { workspace: ws, branch });
    this.ctx.repo.setRepoBranch(task.id, task.project, branch);
    const def = this.ctx.project(task.project);
    const known = this.ctx.repo.repoBranches(task.id);
    for (const r of info.repos ?? []) {
      const id = def && taskRepos(def, task).find((x) => path.resolve(x.dir) === path.resolve(r.dir))?.id;
      if (id) this.ctx.repo.setRepoBranch(task.id, id, await pick(r.path, r.branch, undefined, known[id]));
    }
  }

  /** A run's turn is over: read what it said, keep it, and move the task on. `planExit`: ExitPlanMode. */
  private async turnEnded(live: Live, planExit = false) {
    if (live.ended || this.live.get(live.workerId) !== live) return;
    live.ended = true;
    this.forget(live);
    const floor = this.ctx.floor(live.floorId);
    const info = floor?.workers.get(live.workerId);
    const result = live.phase === 'compact' ? { text: '', complete: true } : await this.readResult(live);
    let task = this.ctx.repo.getTask(live.taskId);
    if (!task) return;
    // Sessions and branches, as they are now.
    if (info?.sessionId) this.update(task.id, live.role === 'implementer' ? { sessionId: info.sessionId } : { reviewerSessionId: info.sessionId });
    if (live.role === 'implementer') await this.syncBranch(task, info);
    task = this.ctx.repo.getTask(live.taskId) ?? task;
    const sessionId = info?.sessionId;

    if (!result || (!result.complete && !result.text.trim())) {
      this.finishRun(live.runId, task.project, { status: 'failed', error: "The turn ended without a reply the office could read", sessionId });
      await this.apply(task.id, { type: 'failed', error: "The agent's turn ended without a reply the office could read: look at its terminal, then Retry" });
      void this.drain(task.project);
      return;
    }
    if (live.phase !== 'compact' && looksInterrupted(result.text, result.apiError)) {
      await this.limited(task, live, result, sessionId);
      return;
    }
    this.limitSince.delete(task.id);

    const agent = info?.name ?? (live.role === 'reviewer' ? 'Reviewer' : 'Agent');
    const say = (kind: KanbanComment['kind'], text: string) => {
      if (text.trim()) this.addComment(task!.project, { taskId: task!.id, authorKind: 'agent', authorName: live.role === 'reviewer' ? `${agent} (reviewer)` : agent, tool: live.tool, kind, text: text.trim(), runId: live.runId });
    };
    // Comments typed while any run went (a review's included) are worked on once it's over (see the machine).
    const pending = task.pendingMessages.length > 0;
    // A folder project has no git to ask: it always counts as changed.
    const changes = async () => (this.folder(task!.project) || !floor ? true : hasChanges(floor.dir, task!.workspace));
    const text = result.text.trim();
    let event: MachineEvent;
    let verdict: KanbanRun['verdict'];
    switch (live.phase) {
      case 'plan': {
        const exited = planExit || !!result.exitPlan;
        const outcome = planOutcome(`${text}\n${result.plan ?? ''}`, exited);
        if (outcome === 'ready') {
          const planText = stripPlanMarkers(result.plan?.trim() || text);
          const plan = this.ctx.repo.addPlan(task.id, planText, live.runId);
          this.ctx.broadcast({ t: 'kanban.plan', plan, project: task.project }, task.project);
          say('plan', planText);
        } else say('questions', text);
        event = { type: 'planned', outcome, pending };
        break;
      }
      case 'implement':
        say('result', text);
        if (task.type === 'investigate') this.update(task.id, { summary: clip(text, SUMMARY_MAX) });
        else this.update(task.id, { summary: clip(text, SUMMARY_MAX) });
        event = { type: 'implemented', changes: task.type === 'investigate' ? false : await changes(), pending };
        break;
      case 'review':
        verdict = reviewVerdict(text);
        say('review', text);
        event = { type: 'reviewed', ...(live.round !== undefined ? { round: live.round } : {}), approved: verdict === 'approved', pending };
        break;
      case 'fix':
        say('result', text);
        this.update(task.id, { summary: clip(text, SUMMARY_MAX) });
        event = { type: 'fixed', ...(live.round !== undefined ? { round: live.round } : {}), changes: await changes(), pending };
        break;
      case 'resume':
        say('result', text);
        this.update(task.id, { summary: clip(text, SUMMARY_MAX) });
        event = { type: 'resumed', changes: task.type === 'investigate' ? false : await changes(), pending };
        break;
      case 'pr':
      case 'pr-fix': {
        say('result', text);
        this.recordPrs(task, text);
        if (live.phase === 'pr') this.update(task.id, { flags: { ...(this.ctx.repo.getTask(task.id)?.flags ?? task.flags), prRequested: true } });
        event = { type: 'prDone', pending };
        break;
      }
      case 'compact':
        event = { type: 'compacted', pending };
        break;
      case 'pr-review':
        verdict = reviewVerdict(text);
        say('review', text);
        event = { type: 'prReviewed', pending };
        break;
    }
    this.finishRun(live.runId, task.project, { status: 'succeeded', summary: clip(text, SUMMARY_MAX), ...(verdict ? { verdict } : {}), ...(sessionId ? { sessionId } : {}) });
    await this.apply(task.id, event, { who: OFFICE });
    void this.drain(task.project);
  }

  /** The pull requests a PR turn reported (PR: lines), kept on the task by repository. */
  private recordPrs(task: KanbanTask, text: string) {
    const def = this.ctx.project(task.project);
    const repos = def ? taskRepos(def, task) : [];
    const branches = this.ctx.repo.repoBranches(task.id);
    let changed = false;
    for (const pr of prLines(text)) {
      if (pr.number === undefined) continue;
      const repo = repos.find((r) => r.remote && pr.repo && r.remote.toLowerCase() === pr.repo.toLowerCase());
      const repoId = repo?.id ?? task.project;
      const branch = branches[repoId] ?? task.branch;
      this.ctx.repo.upsertPrLink(task.id, { repoId, ...(pr.repo ? { repo: pr.repo } : {}), number: pr.number, url: pr.url, state: 'OPEN', ...(branch ? { branch } : {}) });
      changed = true;
    }
    if (changed) this.pushTask(this.ctx.repo.getTask(task.id));
  }

  /** A usage limit or lost connection: retry later, within autoResume's limits. */
  private async limited(task: KanbanTask, live: Live, result: TurnResult, sessionId?: string) {
    const auto = this.ctx.settings.get().autoResume;
    const now = this.opts.now();
    const attempts = task.retryAttempts + 1;
    const since = this.limitSince.get(task.id) ?? now;
    this.limitSince.set(task.id, since);
    const said = result.apiError ?? result.text;
    this.finishRun(live.runId, task.project, { status: 'failed', error: clip(`Interrupted: ${said}`, 2000), ...(sessionId ? { sessionId } : {}) });
    const reset = resetTime(said, now);
    const at = reset !== undefined ? reset + 60_000 : now + backoffMs(attempts);
    if (!auto.enabled || attempts > auto.maxAttempts || at - since > auto.maxWaitHours * 3_600_000) {
      this.limitSince.delete(task.id);
      await this.apply(task.id, { type: 'gaveUp', text: clip(`A usage limit or a lost connection stopped it${auto.enabled ? ` (${attempts - 1} tries)` : ''}: Retry once it has reset. ${said}`, 500) });
    } else {
      this.note(task, `A usage limit or a lost connection interrupted it. It carries on by itself at ${new Date(at).toLocaleString('en-GB')}.`);
      await this.apply(task.id, { type: 'limited', retryAt: at, attempts, text: clip(said, 300) });
    }
    void this.drain(task.project);
  }

  // --- Stopping -----------------------------------------------------------------------------------

  /** Esc into the running turn's terminal; sent home (worktree kept) if it hasn't stopped in a few seconds. */
  private interrupt(task: KanbanTask, who?: KanbanCaller) {
    const live = this.liveOf(task.id);
    if (!live) {
      // Between runs (a relaunch starting): nothing to interrupt, it's just stopped.
      void this.serial(task.id, () => this.apply(task.id, { type: 'stopped', ...(who ? { by: who.name } : {}) }));
      return;
    }
    const floor = this.ctx.floor(live.floorId);
    live.stopping = { ...(who ? { by: who.name } : {}) };
    floor?.workers.write(live.workerId, ESC, who?.name ?? 'Kanban');
    live.stopping.timer = setTimeout(() => {
      if (this.live.get(live.workerId) !== live || live.ended) return;
      const f = this.ctx.floor(live.floorId);
      if (!f) return void this.serial(live.taskId, () => this.stoppedRun(live));
      // Its removal (see removed) finishes the stop.
      void f.sendHome(live.workerId, this.homeCleanup(this.ctx.repo.getTask(live.taskId), f.workers.get(live.workerId)), ENGINE);
    }, this.opts.stopGraceMs);
    live.stopping.timer.unref?.();
  }

  private async stoppedRun(live: Live) {
    if (live.ended || this.live.get(live.workerId) !== live) return;
    live.ended = true;
    this.forget(live);
    await this.finishStopped(live);
    void this.drain(live.floorId);
  }

  private async finishStopped(live: Live) {
    this.finishRun(live.runId, live.floorId, { status: 'stopped' });
    await this.apply(live.taskId, { type: 'stopped', ...(live.stopping?.by ? { by: live.stopping.by } : {}) });
  }

  private async reviewerHome(task: KanbanTask) {
    const id = task.reviewerWorkerId;
    const floor = this.ctx.floor(task.project);
    this.update(task.id, { reviewerWorkerId: null, reviewerSessionId: null });
    const info = id ? floor?.workers.get(id) : undefined;
    if (id && info) await floor!.sendHome(id, this.homeCleanup(task, info), ENGINE);
  }

  // --- The API ------------------------------------------------------------------------------------

  private op(taskId: number, fn: (task: KanbanTask) => Promise<string | undefined | void>): Promise<string | void> {
    return this.serial(taskId, async () => {
      const task = this.ctx.repo.getTask(taskId);
      if (!task) return 'No such task';
      this.watch(task.project);
      return (await fn(task)) ?? undefined;
    });
  }

  start(taskId: number, who: KanbanCaller, opts: { deskId?: string } = {}): Promise<string | void> {
    return this.op(taskId, async (task) => {
      if (task.status !== 'todo') return 'Only a task in To do can be started';
      const floor = this.ctx.floor(task.project);
      if (!floor) return "The project's floor isn't open";
      const why = opts.deskId ? this.deskRefusal(floor, opts.deskId) : undefined;
      if (why) return why;
      const slot = this.busyCount(task.project, task.id) < this.ctx.settings.project(task.project).maxConcurrent;
      if (!task.startedAt) this.update(task.id, { startedAt: this.opts.now(), flags: { ...task.flags, descriptionLocked: true } });
      // Its desk, kept for a start that's queued and for later hires (see launch).
      if (opts.deskId) this.update(task.id, { deskId: opts.deskId });
      return this.apply(task.id, { type: 'start', slot }, { who, ...(opts.deskId ? { deskId: opts.deskId } : {}) });
    });
  }

  /** Why a task's worker can't be hired at `deskId` now, if it can't: a desk or bean bag that's built and free. */
  private deskRefusal(floor: Floor, deskId: string, watch = false): string | undefined {
    const desk = DESK_BY_ID.get(deskId);
    if (!desk || desk.station || desk.room || !!desk.watch !== watch) return `${deskId} isn't a desk a task's worker can be hired at`;
    if (!deskBuilt(desk, floor.workers.wing?.() ?? 0)) return `${desk.label} isn't built on this floor yet`;
    if (floor.workers.deskOccupied(deskId)) return `${desk.label} is taken: pick a free desk`;
    return undefined;
  }

  stop(taskId: number, who: KanbanCaller): Promise<string | void> {
    // A task asking in its terminal is idle but its run still goes: the machine stops that too.
    return this.op(taskId, async (task) => {
      const queued = task.runState === 'queued' ? task.queuedRun : undefined;
      const err = await this.apply(taskId, { type: 'stop' }, { who });
      if (!err && queued) this.queuedStopped(task, queued, `Stopped by ${who.name} before it started`);
      return err;
    });
  }

  continue(taskId: number, who: KanbanCaller, answer?: string, attachmentIds?: string[]): Promise<string | void> {
    return this.op(taskId, async (task) => {
      const asking = this.asking(task);
      if (asking) {
        // Its run is still going, on a question in its terminal: the answer is typed in there. A
        // permission prompt (or who knows what) is answered in the terminal: typed text + Enter would
        // pick its highlighted option.
        const text = answer?.trim();
        if (!text) return 'Type your answer, or answer in the terminal';
        const files = this.ctx.repo.linkAttachments(attachmentIds ?? [], taskId);
        const err = this.answer(asking, [text, this.compose.filesInline(files)].filter(Boolean).join(' '), who);
        if (!err) this.linked(task.project, this.addComment(task.project, { taskId, authorKind: 'user', authorName: who.name, kind: 'message', text, runId: asking.runId }), files);
        return err;
      }
      if (this.liveOf(task.id)) return 'It is still running: answer in its terminal, or stop it first';
      const files = this.ctx.repo.linkAttachments(attachmentIds ?? [], taskId);
      if (answer?.trim()) this.linked(task.project, this.addComment(task.project, { taskId, authorKind: 'user', authorName: who.name, kind: 'message', text: answer.trim() }), files);
      return this.apply(taskId, { type: 'continue', answer, last: this.lastRun(taskId) }, { who });
    });
  }

  /**
   * The live run whose agent asks something in its terminal (task waiting, agent_asking; its worker
   * needs_input), for an answer from the kanban to be typed in; undefined otherwise.
   */
  private asking(task: KanbanTask): Live | undefined {
    if (task.status !== 'waiting' || task.waitingReason !== 'agent_asking') return undefined;
    const live = this.liveOf(task.id);
    if (!live || live.ended || live.stopping) return undefined;
    return this.ctx.floor(live.floorId)?.workers.get(live.workerId)?.status === 'needs_input' ? live : undefined;
  }

  /**
   * Types `text` into the asking worker's terminal (upstream's prompt), which answers its question
   * as someone typing there would; only a question (heardAsk), never a permission prompt or an unknown
   * one. The task stays waiting: the worker's own hooks say when the agent goes on (needs_input →
   * working, the machine's working), and a question with more to answer keeps it asking.
   */
  private answer(live: Live, text: string, who: KanbanCaller): string | undefined {
    if (live.asks !== 'question') return live.asks === 'permission' ? ASKS_PERMISSION : ASKS_UNKNOWN;
    const workers = this.ctx.floor(live.floorId)?.workers;
    return workers ? workers.prompt(live.workerId, typeable(text), who.name) : "The project's floor isn't open";
  }

  retry(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, (task) => {
      if (this.liveOf(task.id)) return Promise.resolve('It is still running');
      // Its hire runs as the task's creator, like every other (hireOwner).
      return this.apply(taskId, { type: 'retry', last: this.lastRun(taskId) }, { who });
    });
  }

  review(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, (task) => {
      if (this.liveOf(task.id)) return Promise.resolve('Stop it first: it is running');
      // A worktree deleted as its worker went home: the branch is still there to carry on from.
      if (!task.workspace && !this.folder(task.project)) return Promise.resolve(task.branch ? `Its worktree is gone: comment to have its agent carry on in a fresh worktree on branch ${task.branch}, then review` : 'It has no work to review yet');
      const dir = this.ctx.floor(task.project)?.dir;
      if (task.workspace && dir && missingFolders(dir, task.workspace).length) return Promise.resolve(`Its worktree is gone: comment to have its agent carry on in a fresh worktree${task.branch ? ` on branch ${task.branch}` : ''}, then review`);
      return this.apply(taskId, { type: 'review' }, { who });
    });
  }

  approvePlan(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, (task) => {
      if (!this.ctx.repo.latestPlan(task.id)) return Promise.resolve('There is no plan to approve yet');
      return this.apply(taskId, { type: 'approvePlan' }, { who });
    });
  }

  requestPlanChanges(taskId: number, who: KanbanCaller, text: string, attachmentIds?: string[]): Promise<string | void> {
    return this.op(taskId, (task) => {
      const files = this.ctx.repo.linkAttachments(attachmentIds ?? [], taskId);
      if (text.trim()) this.linked(task.project, this.addComment(task.project, { taskId, authorKind: 'user', authorName: who.name, kind: 'message', text: text.trim() }), files);
      return this.apply(taskId, { type: 'requestPlanChanges', text }, { who });
    });
  }

  pr(taskId: number, who: KanbanCaller, mode: 'create' | 'fix'): Promise<string | void> {
    return this.op(taskId, (task) => {
      if (this.liveOf(task.id)) return Promise.resolve('Stop it first: it is running');
      if (this.folder(task.project)) return Promise.resolve('A folder project has no git repositories to open pull requests in');
      // A task whose worktree went still has its branch: a fresh worktree checks it out (see launch).
      if (!task.workspace && !task.branch) return Promise.resolve('It has no work to open pull requests for yet');
      if (mode === 'fix' && !task.prs.some((p) => p.state === 'OPEN' || p.state === 'DRAFT')) return Promise.resolve('The task has no open pull requests to fix');
      return this.apply(taskId, { type: 'pr', mode }, { who });
    });
  }

  compact(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, (task) => {
      if (this.liveOf(task.id)) return Promise.resolve('Stop it first: it is running');
      if (!task.sessionId && !task.workerId) return Promise.resolve('It has no agent session to compact');
      return this.apply(taskId, { type: 'compact' }, { who });
    });
  }

  release(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, async (task) => {
      if (this.liveOf(task.id) || task.runState !== 'idle' || task.status === 'in_progress') return 'Stop it first: it is running';
      const floor = this.ctx.floor(task.project);
      const ids = [task.workerId, task.reviewerWorkerId].filter((x): x is string => !!x);
      if (!ids.length) return 'It has no worker to release';
      // Its worktree and session stay on the task, for whoever carries on later.
      this.update(task.id, { workerId: null, reviewerWorkerId: null, reviewerSessionId: null });
      for (const id of ids) {
        const info = floor?.workers.get(id);
        if (info) await floor!.sendHome(id, this.homeCleanup(task, info), { by: who.name, reason: 'released' });
      }
      return undefined;
    });
  }

  /**
   * The task was moved to done or archived: its workers at rest go home, worktree kept. A run still
   * live is finished as stopped and its worker goes too: the move rules only let a task out while
   * nothing works on it, so that's an agent asking in its terminal (needs_input), which isBusy counts
   * as busy but which nobody will answer now. The task keeps nothing running or queued.
   */
  releaseIdle(taskId: number, who: KanbanCaller): Promise<void> {
    return this.op(taskId, async (task) => {
      if (task.status !== 'done' && task.status !== 'archived') return;
      const live = this.liveOf(task.id);
      if (live) {
        live.ended = true;
        this.forget(live);
        const where = task.status === 'done' ? 'Done' : 'the archive';
        this.finishRun(live.runId, live.floorId, { status: 'stopped', error: `${who.name} moved the task to ${where}` });
        this.note(task, `${who.name} moved the task to ${where}, so its ${live.phase === 'review' || live.phase === 'pr-review' ? 'review round' : `${live.phase} run`} was stopped.`, live.runId);
      } else if (task.queuedRun) this.queuedStopped(task, task.queuedRun, `${who.name} moved the task to ${task.status === 'done' ? 'Done' : 'the archive'} before it started`);
      if (live || task.runState !== 'idle' || task.queuedRun) this.update(task.id, { runState: 'idle', queuedRun: null, waitingReason: null, waitingText: null, retryAt: null });
      await this.sendIdleHome(task.id, who.name, live?.workerId);
    }).then(() => undefined);
  }

  commented(taskId: number, commentId: number, who: KanbanCaller): Promise<void> {
    return this.op(taskId, async (task) => {
      const c = this.ctx.repo.getComment(commentId);
      if (!c || c.taskId !== taskId || c.authorKind !== 'user') return;
      // The agent asks a question in its terminal: the comment is the answer, typed in there now.
      // Queued, it would wait for a turn's end that the question itself holds up. A permission prompt
      // (or an unknown one) is answered in the terminal: the comment waits for the turn's end.
      const asking = this.asking(task);
      const own = this.ctx.repo.listAttachments(taskId).filter((a) => a.commentId === c.id);
      if (asking?.asks === 'question' && !this.answer(asking, [c.text, this.compose.filesInline(own)].filter(Boolean).join(' '), who)) return;
      const live = this.liveOf(task.id);
      const err = await this.apply(taskId, { type: 'comment', text: c.text, busy: !!live || task.runState !== 'idle' }, { who, commentId });
      if (err) this.note(task, `Couldn't hand the comment to the agent: ${err}`);
      if (live && task.status === 'waiting' && task.waitingReason === 'agent_asking') {
        const there = asking && asking.asks !== 'question' ? (asking.asks === 'permission' ? ASKS_PERMISSION : ASKS_UNKNOWN) : undefined;
        this.note(task, there ? `${there}. The comment is kept and goes to it once that turn is over.` : 'The agent is asking something in its terminal: the comment goes to it once that turn is over.');
      }
    }).then(() => undefined);
  }

  /**
   * Several pull requests reviewed together, as a run of its own (phase pr-review): on the task the
   * request names, or on a new investigate task for it. The request comes checked (KanbanPullsApi.review);
   * this checks only what the engine itself needs.
   */
  async reviewPrs(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string> {
    const def = this.ctx.project(req.project);
    if (!def) return `There's no project ${req.project}`;
    if (!this.watch(req.project)) return "The project's floor isn't open, so there's nowhere to seat a reviewer";
    if (isFolderProject(def)) return 'A folder project has no pull requests to review';
    if (!req.prs.length) return 'Pick at least one pull request';
    const labels = req.prs.map((p) => `${p.repo}#${p.number}`);
    let created: KanbanTask | undefined;
    // The review goes into the named task only when every PR is that task's; PRs of several tasks, or
    // of none the kanban knows, are a review task of their own, so one task's findings and column
    // aren't another's.
    let named = req.taskId;
    let mixed: string | undefined;
    if (named !== undefined) {
      const t = this.ctx.repo.getTask(named);
      if (!t || t.project !== req.project) return `There's no task #${named} in this project`;
      const theirs = (req.prs as ReviewedPr[]).filter((p) => !this.prOfTask(t, def, p));
      if (theirs.length) {
        const whose = theirs.map((p) => {
          const ids = this.ctx.repo.tasksOfPr(p.repo, p.number).filter((id) => id !== t.id);
          return `${p.repo}#${p.number} ${ids.length ? `is ${ids.map((id) => `#${id}`).join(', ')}'s` : 'belongs to no task the kanban knows'}`;
        });
        mixed = `This review was asked for on task #${t.id}, but not every pull request is its (${whose.join('; ')}), so it is a review task of its own.`;
        named = undefined;
      }
    }
    if (named === undefined) {
      const review = this.ctx.settings.effectiveReview(req.project);
      const involved = projectRepos(def).filter((r) => r.primary || (r.kind === 'git' && r.remote && req.prs.some((p) => sameRepo(r.remote!, p.repo))));
      const ticket = this.commonTicket(req.prs as ReviewedPr[]);
      created = this.ctx.repo.createTask({
        project: req.project,
        title: clip(`PR review: ${labels.join(', ')}`, 100),
        description: `A review of these pull requests together:\n${(req.prs as ReviewedPr[]).map((p) => `- ${p.repo}#${p.number}${p.title ? ` ${p.title}` : ''}${p.url ? ` (${p.url})` : ''}`).join('\n')}`,
        type: 'investigate',
        ...(ticket ? { ticket } : {}),
        repoIds: involved.map((r) => r.id),
        tool: req.tool ?? review.tool,
        usePlan: false,
        planApproval: 'auto',
        useReview: false,
        createdBy: who.name,
        ...(who.accountId ? { createdByAccount: who.accountId } : {}),
        startedAt: this.opts.now(),
        flags: { descriptionLocked: true },
      });
      this.pushTask(created);
      if (mixed) this.note(created, mixed);
    }
    const taskId = created?.id ?? named!;
    const request: KanbanPrReviewRequest = { project: req.project, prs: req.prs, ...(named !== undefined ? { taskId: named } : {}), ...(req.tool ? { tool: req.tool } : {}), ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) };
    const err = await this.op(taskId, async (task) => {
      if (this.liveOf(task.id)) return 'Stop it first: it is running';
      this.ctx.repo.appendEvent(task.id, 'pr.review', { by: who.name, prs: labels, request });
      return this.apply(task.id, { type: 'prReview' }, { who, prReview: request });
    });
    const task = this.ctx.repo.getTask(taskId);
    if (!err && task?.runState === 'queued' && task.queuedRun?.phase === 'pr-review') {
      // No room now (a desk, the worker limit): the task waits in the queue and the review starts by itself.
      this.note(task, `${who.name} asked for a review of ${labels.join(', ')}`);
      return { taskId };
    }
    const workerId = task?.reviewerWorkerId;
    const info = workerId ? this.ctx.floor(req.project)?.workers.get(workerId) : undefined;
    if (err || !task || !workerId || !info) {
      // A review task that never got its reviewer is no use to anyone: it goes again.
      if (created && task && !this.liveOf(task.id)) {
        this.ctx.repo.deleteTask(task.id);
        this.ctx.broadcast({ t: 'kanban.task.removed', id: task.id, project: task.project }, task.project);
      }
      return err || 'The reviewer could not be hired';
    }
    this.note(task, `${who.name} asked ${info.name} to review ${labels.join(', ')}`);
    return { taskId, workerId };
  }

  /** Whether a pull request is the task's: linked to it (pr_links), or opened from its branch in that repository. */
  private prOfTask(task: KanbanTask, def: FloorDef, p: ReviewedPr): boolean {
    const r = projectRepos(def).find((x) => x.kind === 'git' && !!x.remote && sameRepo(x.remote, p.repo));
    if (task.prs.some((k) => k.number === p.number && (k.repo ? sameRepo(k.repo, p.repo) : k.repoId === r?.id))) return true;
    if (!r || !p.branch) return false;
    return (this.ctx.repo.repoBranches(task.id)[r.id] ?? task.branch) === p.branch;
  }

  /** The ticket every one of the pull requests belongs to (their tasks', or named in their titles or branches), if there's one. */
  private commonTicket(prs: ReviewedPr[]): string | undefined {
    const sets = prs.map((p) => {
      const out = new Set<string>();
      for (const id of this.ctx.repo.tasksOfPr(p.repo, p.number)) {
        const t = this.ctx.repo.getTask(id)?.ticket;
        if (t) out.add(t);
      }
      for (const m of `${p.title ?? ''} ${p.branch ?? ''}`.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?![0-9])/g)) out.add(m[1]);
      return out;
    });
    return [...(sets[0] ?? [])].find((t) => sets.every((x) => x.has(t)));
  }

  /**
   * "O" at a desk: a task worker's task gets its pr phase; an ordinary office worker gets the layered
   * kanban.pr.create prompt typed in, for its own agent to open the pull requests. 'fallback' only for
   * a shell (no agent to ask), so the caller can use upstream's openPr.
   */
  async prForWorker(floorId: string, workerId: string, who: KanbanCaller): Promise<string | void> {
    const floor = this.watch(floorId);
    if (!floor) return 'No such floor';
    const info = floor.workers.get(workerId);
    if (!info) return 'No such worker';
    if (info.kanban) return this.pr(info.kanban.taskId, who, 'create');
    if (info.kind === 'shell') return 'fallback';
    if (info.status === 'needs_input') return `${info.name} is waiting on an answer in its terminal`;
    const def = this.ctx.project(floorId);
    const tool = info.provider === 'codex' ? 'codex' : 'claude';
    const picked = this.ctx.settings.project(floorId).skills.pr?.[tool] ?? [];
    const what = info.task?.name ?? info.title;
    const text = withContract(
      this.compose.text('kanban.pr.create', floorId, {
        subject: `your current work${what ? ` (${what})` : ''}`,
        taskId: '-',
        title: what ?? '',
        ticket: '',
        ticketId: 'none',
        repos: workerReposText(info, floor.dir, def?.name ?? floor.project.name, floor.project.branch),
        summary: info.task?.summary ? `What you worked on:\n${info.task.summary}` : '',
        skills: picked.length ? `Skills picked for this step (use them where they fit): ${picked.map((n) => (tool === 'claude' ? `/${n}` : n)).join(', ')}.` : '',
        language: this.compose.text('kanban.language', floorId),
      }),
      'pr',
    );
    const typed = typeable(text);
    const running = info.status !== 'exited';
    const err = running ? floor.workers.prompt(workerId, typed, who.name) : floor.workers.resume(workerId, typed);
    return err ?? undefined;
  }
}
