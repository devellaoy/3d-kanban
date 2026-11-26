// Runs the task process on ordinary office workers (docs/kanban-architecture.md §4): hires, prompts,
// relaunches and sends home workers through upstream's WorkerManager, follows their turns with
// addObserver, reads each turn's result from the session log (adapters/), and feeds the outcome to
// the pure machine (machine.ts), whose effects it then carries out. Every change goes out to the
// browsers as kanban.task / kanban.run / kanban.plan / kanban.comment.
//
// Only turns of runs the engine started move a task: someone typing into a task worker's terminal
// while no run is going doesn't.

import path from 'node:path';
import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import type { WorkerManager, WorkerObservation } from '../../workers.js';
import { DESK_BY_ID, nextFreeSeat } from '../../../shared/layout.js';
import type { WorkerInfo } from '../../../shared/protocol.js';
import { isBusy } from '../../../shared/status.js';
import type { TurnSignal } from '../../../shared/kanban/signals.js';
import type { DepartureIntent, KanbanComment, KanbanEffort, KanbanPrLink, KanbanPrReviewRequest, KanbanRole, KanbanRun, KanbanTask, KanbanTool, KanbanWorkerSummary, ProjectRepo, QueuedRun, RunPhase } from '../../../shared/kanban/types.js';
import type { AttachmentRow, NewComment, TaskUpdate } from '../db/repository.js';
import { launchDirs, prReviewRepoIds } from './launchdirs.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import { projectRepos, repoSources } from '../projects.js';
import { ADAPTERS } from './adapters/index.js';
import type { ReadOpts, TaskAgentAdapter, TurnResult } from './adapters/types.js';
import { Composer, isFolderProject, skillPhase, taskRepos, workerReposText, type ComposeExtra } from './compose.js';
import { canFixPrs, isPrPhase, onPrBranches, type PrRunMode } from '../../../shared/kanban/prs.js';
import { fixTargetsOf, forkTest, polledPulls } from '../integrations/pulls/prfix.js';
import { next, prPrompt, queuedOf, runOf, stateOf, type Effect, type LastRun, type MachineEvent, type PromptKind, type RunEffect } from './machine.js';
import { backoffMs, looksInterrupted, planOutcome, reviewFindings, reviewVerdict, stripPlanMarkers, stripWorkDone } from './markers.js';
import { endStop, type StopRun } from './stopping.js';
import { branchExists, homeCleanup, hasChanges, missingFolders, uncommitted } from './workspace.js';
import { Handoffs } from './handoff.js';
import { PrCommentsRuns } from './prcomments.js';
import { PrTurn } from './prturn.js';
import { Departures } from './departures.js';
import { Holds } from './hold.js';
import { Restarts, receipt } from './restart.js';
import { promptHead, TurnHolds, typeable } from './turnhold.js';
import { agentHook, newTurn, acceptSignal, heardQuestion, QUESTION_TOOL, StopGate, stopMessage } from './signals.js';
import { isUiRun, type Live, type Via } from './live.js';
import { lostText, stopFallback, TurnEnd, typedSettled, unfinishedText } from './turnend.js';
import { Comments } from './comments.js'; import { runTyped } from '../db/typed.js';
import type { ReviewPanelPart } from '../../../shared/kanban/review.js';
import { checkoutFor } from './checkoutfor.js';
import { slot, slotPatch } from './slot.js';
import { Seating, baseBranches } from './seating.js';
export { baseBranches };
import { PrReviews, type GitRunner } from './prreview-launch.js';
import { syncBranch } from './branchsync.js';
import { UsageLimits } from './usagelimit.js';
import { PANEL_WAIT_MS, ReviewPanel } from './panel.js';
import { RestWaits } from './restwait.js';
import { logOf, sessionLogged } from './sessions.js'; import { observeLeadHook, planFromHook, planModeOf } from './automode.js';

export interface EngineOptions {
  /** How often due retries, queued tasks and newly opened floors are looked at (60 s). */
  sweepMs?: number;
  /** How long a stopped turn gets to come to rest after Esc before its worker is sent home (4 s). */
  stopGraceMs?: number;
  /** Reading a turn's result again while the log is still being written: tries, and the pause between. */
  readTries?: number;
  readPauseMs?: number;
  /** A run held for background work goes on with what its log says after this long without a Stop (3 h). */
  backgroundWaitMs?: number;
  /** A held run whose agent has rested this long with nothing running (no hook of any kind) is nudged for its final marker; the wait doubles with each nudge (3 min). */
  nudgeIdleMs?: number;
  /** How many times a run is nudged before it ends on its last text (4). */
  maxNudges?: number;
  /** How long a review round waits for its additional reviewers once the main reviewer's own review is in (15 min). */
  panelWaitMs?: number;
  prGit?: GitRunner; prHeadsMs?: number; // prGit runs git to fetch a pull-request review's heads (the real git; tests inject their own: see prheads.ts)
  /** How many Stops of a run the Stop hook gate may block at most (2; 0 turns it off, as AGENT_OFFICE_KANBAN_STOP_GATE=off does). */
  maxGateBlocks?: number;
  /** A phase that finds its own worker still busy (its teammates keep it working) waits this long for it to rest before it fails (10 min). */
  busyWaitMs?: number;
  /** The gap between one run carried on after an office restart and the next (5 s). */
  restartStaggerMs?: number;
  adapters?: Partial<Record<KanbanTool, TaskAgentAdapter>>;
  now?: () => number;
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

const OFFICE: KanbanCaller = { name: 'Kanban', admin: true };
/** How the engine sends its own workers home: nothing for removed() to act on, it has seen to the task itself. */
const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };
const SUMMARY_MAX = 20_000;
/** The prompts a fresh session taking over work under way is handed off with. */
const HANDOFF_KINDS = new Set<PromptKind>(['fix', 'resume', 'continue', 'restarted', 'pr.create', 'pr.fix', 'pr.conflicts', 'pr.answers']);
const ESC = '\x1b';
const RESTING = new Set(['done', 'idle', 'needs_input', 'exited']);
/** Why an answer from the kanban isn't typed into a terminal that isn't asking a question (answer). */
const ASKS_PERMISSION = 'The agent is asking for a permission in its terminal: answer it there (Open the terminal)';
const ASKS_UNKNOWN = 'The agent is waiting on something in its terminal: answer it there (Open the terminal)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const sameArgs = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
export class Orchestrator {
  private live = new Map<string, Live>();
  /**
   * When each worker's Claude process last started (its SessionStart hook: startup or resume), for readTurnResult's `since`;
   * dropped when the worker exits or goes. After an office restart it's unknown until the next SessionStart: turnOpts falls back to the run's start.
   */
  private procSince = new Map<string, number>();
  /** A phase waiting for its own busy worker to rest: Stop cancels it, as the task's chain is held until it ends. */
  private rests = new RestWaits(() => this.opts.busyWaitMs);
  private floors = new Map<string, { workers: WorkerManager; off: () => void }>();
  /** One thing at a time per task: an operation or a turn's end. */
  private chains = new Map<number, Promise<unknown>>();
  private sweepTimer?: NodeJS.Timeout;
  /** A drain of every project is due (a worker went home somewhere: a desk or room under the worker limit freed). */
  private drainDue = false;
  private adapters: Record<KanbanTool, TaskAgentAdapter>;
  private compose: Composer;
  private handoffs: Handoffs;
  private prComments: PrCommentsRuns;
  private prTurn: PrTurn;
  private departures: Departures<Live>;
  private holds: Holds;
  private turnHolds: TurnHolds<Live>;
  private turnEnd: TurnEnd<Live>;
  private gate: StopGate<Live>;
  private comments: Comments<Live>;
  private restarts: Restarts<Live>;
  private prReviews: PrReviews;
  private seats: Seating;
  private panel: ReviewPanel;
  private limits: UsageLimits<Live>;
  private opts: Required<Omit<EngineOptions, 'adapters' | 'restartStaggerMs' | 'prGit' | 'prHeadsMs'>>;
  private disposed = false;

  constructor(
    private ctx: KanbanContext,
    options: EngineOptions = {},
  ) {
    this.adapters = { ...ADAPTERS, ...options.adapters };
    this.compose = new Composer(ctx);
    this.handoffs = new Handoffs(ctx, (p) => this.folder(p), (id, patch) => this.update(id, patch));
    this.prComments = new PrCommentsRuns(ctx, () => this.opts.now());
    this.prTurn = new PrTurn(ctx, { update: (id, patch) => this.update(id, patch), note: (task, text, runId) => this.note(task, text, runId), pushTask: (task) => this.pushTask(task) }, this.prComments);
    this.departures = new Departures<Live>({
      live: (workerId) => this.live.get(workerId),
      liveOf: (taskId) => this.liveOf(taskId),
      forget: (live) => this.forget(live),
      task: (id) => this.ctx.repo.getTask(id),
      update: (id, patch) => this.update(id, patch),
      apply: (id, e) => this.apply(id, e),
      note: (task, text) => this.note(task, text),
      finishRun: (id, project, patch) => this.finishRun(id, project, patch),
      finishStopped: (live) => this.finishStopped(live),
      markDone: (task, by) => this.markDone(task, by), drain: (floorId) => this.drain(floorId), giveBack: (task, live) => this.comments.giveBack(task, live),
      coLeft: (workerId, taskId, own, by) => this.panel.left(workerId, taskId, own, by), closePanel: (task, why) => this.panel.close(task, why, 'stopped'), gap: (taskId) => this.panel.gap(taskId),
    });
    this.holds = new Holds(ctx, {
      liveOf: (taskId) => this.liveOf(taskId),
      stopLive: (live, error) => this.stopLive(live as Live, error),
      update: (id, patch) => this.update(id, patch),
      note: (task, text, runId) => this.note(task, text, runId),
      apply: (id, e, via) => this.apply(id, e, via),
      sendHome: (taskId, by, also) => this.sendIdleHome(taskId, by, also, 'hold'),
      drain: (floorId) => this.drain(floorId),
      closePanel: (task, why) => this.panel.close(task, why, 'stopped'),
      commentText: (project, taskId, text, files) => this.compose.commentText(project, taskId, text, files),
      finishRun: (id, project, patch) => this.finishRun(id, project, patch),
      effect: (id, eff, via) => this.effect(id, eff, via as Via),
    }, () => this.opts.now());
    this.turnHolds = new TurnHolds<Live>({
      following: (live) => this.live.get(live.workerId) === live,
      serial: (taskId, fn) => this.serial(taskId, fn),
      task: (id) => this.ctx.repo.getTask(id),
      floor: (id) => this.ctx.floor(id),
      note: (task, text, runId) => this.note(task, text, runId),
      turnEnded: (live, planExit, force) => this.turnEnded(live, planExit, force),
      prompted: (live, text) => this.prompted(live, text),
      restateText: (task, phase) => this.compose.restate(task, phase),
      waitMs: () => this.opts.backgroundWaitMs,
      heldChanged: (live, held) => this.ctx.repo.setRunHeld(live.runId, held ? this.opts.now() : null),
    });
    this.turnEnd = new TurnEnd<Live>({
      holds: this.turnHolds,
      following: (live) => this.live.get(live.workerId) === live,
      serial: (taskId, fn) => this.serial(taskId, fn),
      task: (id) => this.ctx.repo.getTask(id),
      floor: (id) => this.ctx.floor(id),
      note: (task, text, runId) => this.note(task, text, runId),
      read: (live) => this.readResult(live),
      turnEnded: (live, planExit, force) => this.turnEnded(live, planExit, force),
      nudgeIdleMs: () => this.opts.nudgeIdleMs,
      maxNudges: () => this.opts.maxNudges,
    });
    this.gate = new StopGate<Live>({
      task: (id) => this.ctx.repo.getTask(id),
      note: (task, text, runId) => this.note(task, text, runId),
      read: async (live) => {
        const file = this.ctx.floor(live.floorId)?.workers.transcripts(live.workerId)?.claude;
        return file ? this.adapters.claude.readTurnResult(file, this.turnOpts(live)) : undefined;
      },
      uncommitted: async (live) => {
        // The worker's own folders (the task's workspace is only kept at a turn's end).
        const task = this.ctx.repo.getTask(live.taskId), floor = this.ctx.floor(live.floorId), info = floor?.workers.get(live.workerId);
        const ws = info?.worktree ? { worktree: info.worktree, ...(info.repos?.length ? { repos: info.repos } : {}) } : task?.workspace;
        return task && floor && ws && !this.folder(task.project) ? uncommitted(floor.dir, ws) : [];
      },
      launchArgs: (live) => this.ctx.floor(live.floorId)?.workers.launchArgsOf(live.workerId),
      maxBlocks: () => this.opts.maxGateBlocks,
      readPauseMs: () => this.opts.readPauseMs,
    });
    this.comments = new Comments<Live>({
      ctx,
      compose: this.compose,
      liveOf: (taskId) => this.liveOf(taskId),
      asking: (task) => this.asking(task),
      answer: (live, text, who) => this.answer(live, text, who),
      apply: (id, e, via) => this.apply(id, e, via),
      update: (id, patch) => this.update(id, patch),
      note: (task, text, runId) => this.note(task, text, runId),
      lastRun: (taskId) => this.lastRun(taskId),
      leave: (task, commentId) => this.holds.leave(task, commentId),
      askingNote: (_task, live) => {
        const there = live.asks !== 'question' ? (live.asks === 'permission' ? ASKS_PERMISSION : ASKS_UNKNOWN) : undefined;
        return there ? `${there}. The comment is kept and goes to it once that turn is over.` : 'The agent is asking something in its terminal: the comment goes to it once that turn is over.';
      },
    });
    this.restarts = new Restarts<Live>({
      ctx, adapters: this.adapters,
      serial: (taskId, fn) => this.serial(taskId, fn),
      folder: (project) => this.folder(project),
      finishRun: (id, project, patch) => this.finishRun(id, project, patch),
      note: (task, text, runId) => this.note(task, text, runId),
      update: (id, patch) => this.update(id, patch),
      apply: (id, e) => this.apply(id, e),
      drain: (project) => void this.drain(project),
      carried: (task, prompt, only) => this.holds.carried(task, prompt, only), requeue: (task, q) => this.comments.requeue(task, runOf(q), q.commentId, q.taken),
      attach: (run, task, info, launch) => Object.assign(this.attach(run, task, info, launch), { pinSince: true }),
      turnEnded: (live, planExit) => this.turnEnded(live, planExit),
      hiringPaused: () => this.ctx.hiringPaused?.(),
      staggerMs: options.restartStaggerMs ?? 5000,
    });
    this.seats = new Seating(ctx);
    this.prReviews = new PrReviews({
      ctx, adapters: this.adapters, compose: this.compose, comments: this.comments,
      watch: (floorId) => this.watch(floorId), op: (taskId, fn) => this.op(taskId, fn), apply: (id, e, via) => this.apply(id, e, via), running: (taskId) => this.running(taskId),
      reviewSettings: (task) => this.reviewSettings(task),
      sharesLimit: (task, role, floor) => this.seats.sharesLimit(task, role, floor),
      signInMissing: (task, owner, who) => this.seats.signInMissing(task, owner, who),
      noRoom: (floor, preferred, countsWith, role) => this.seats.noRoom(floor, preferred, countsWith, role),
      freshBase: (floor, def, repoIds) => this.seats.freshBase(floor, def, repoIds),
      hireOwner, baseBranches,
      finishRun: (id, project, patch) => this.finishRun(id, project, patch),
      update: (id, patch) => this.update(id, patch),
      note: (task, text, runId) => this.note(task, text, runId),
      pushTask: (task) => this.pushTask(task),
      follow: (live, prompt) => { this.live.set(live.workerId, live); this.prompted(live, prompt); this.ctx.floor(live.floorId)?.workers.follows(live.workerId, true); },
      exitedAtHire: (live) => this.exitedAtHire(live),
      now: () => this.opts.now(), git: options.prGit, headsMs: options.prHeadsMs,
    });
    this.panel = new ReviewPanel({
      ctx,
      now: () => this.opts.now(),
      waitMs: () => this.opts.panelWaitMs,
      launch: (task, eff, via, seat, part, more) => this.launchRun(task, eff, via, seat, part, more),
      livesOf: (taskId) => this.livesOf(taskId),
      forget: (live) => this.forget(live),
      finishRun: (id, project, patch) => this.finishRun(id, project, patch),
      update: (id, patch) => this.update(id, patch),
      note: (task, text, runId) => this.note(task, text, runId),
      say: (task, run, text) => this.say(task, run, text), posted: (task, text, verdict) => this.prReviews.publishedSolo(task, text, verdict),
      apply: (id, e, via) => this.apply(id, e, via),
      serial: (taskId, fn) => this.serial(taskId, fn),
      drain: (project) => void this.drain(project),
    });
    this.limits = new UsageLimits<Live>({
      ctx,
      now: () => this.opts.now(),
      finishRun: (id, project, patch) => this.finishRun(id, project, patch),
      note: (task, text) => this.note(task, text),
      apply: (id, e) => this.apply(id, e),
      drain: (project) => void this.drain(project),
    });
    this.opts = {
      sweepMs: options.sweepMs ?? 60_000,
      stopGraceMs: options.stopGraceMs ?? 4000,
      readTries: options.readTries ?? 12,
      readPauseMs: options.readPauseMs ?? 250,
      backgroundWaitMs: options.backgroundWaitMs ?? 3 * 3_600_000,
      nudgeIdleMs: options.nudgeIdleMs ?? 3 * 60_000,
      maxNudges: options.maxNudges ?? 4,
      maxGateBlocks: process.env.AGENT_OFFICE_KANBAN_STOP_GATE === 'off' ? 0 : (options.maxGateBlocks ?? 2),
      busyWaitMs: options.busyWaitMs ?? 600_000,
      panelWaitMs: options.panelWaitMs ?? PANEL_WAIT_MS,
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
    this.restarts.dispose();
    this.panel.dispose();
    clearInterval(this.sweepTimer);
    for (const f of this.floors.values()) f.off();
    this.floors.clear();
    for (const l of this.live.values()) clearTimeout(l.stopping?.timer);
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
    this.restarts.dropCompacts();
    const runs = this.ctx.repo.runningRuns();
    const attached = new Set<number>();
    for (const run of runs) {
      if (run.phase === 'compact') {
        this.finishRun(run.id, this.ctx.repo.getTask(run.taskId)?.project ?? '', { status: 'interrupted', error: 'Compacting is gone: the run was dropped when the office restarted' });
        continue;
      }
      const task = this.ctx.repo.getTask(run.taskId);
      if (!task) {
        this.ctx.repo.finishRun(run.id, { status: 'interrupted', error: 'Its task is gone' });
        continue;
      }
      const floor = this.watch(task.project);
      const info = this.restarts.workerOf(run, task, floor);
      if (run.seat) {
        // An additional reviewer's run is followed while its terminal survived and its agent works or has finished; otherwise its seat did not finish. It never moves the task.
        if (floor && info && info.status !== 'exited' && info.status !== 'idle' && floor.workers.cutOffStatus(info.id) === undefined) {
          const live = this.attach(run, task, info, undefined);
          if (info.status === 'done') void this.serial(task.id, () => this.turnEnded(live));
          else if (info.status === 'needs_input') void this.serial(task.id, () => this.needsInput(live, info));
        } else this.finishRun(run.id, task.project, { status: 'interrupted', error: 'The office restarted while it ran' });
        continue;
      }
      // A worker whose terminal didn't survive a full restart (cut off) was woken on its session: its saved status says what it was doing.
      const cut = floor && info && !attached.has(task.id) ? floor.workers.cutOffStatus(info.id) : undefined;
      if (floor && info && cut !== undefined) {
        attached.add(task.id);
        this.restarts.resume(run, task, floor, info, cut);
        continue;
      }
      if (!floor || !info || info.status === 'exited' || info.status === 'idle' || attached.has(task.id)) {
        void this.serial(task.id, () => this.interruptedRun(run, task, 'The office restarted while it ran: Retry to carry on'));
        continue;
      }
      attached.add(task.id);
      const launch = this.ctx.repo.runLaunch(run.id);
      const live = this.attach(run, task, info, launch);
      if (info.status === 'done' && this.restarts.delivered(run, floor, info, live, launch)) void this.serial(task.id, () => this.turnEnded(live));
      else if (info.status === 'needs_input') void this.serial(task.id, () => this.needsInput(live, info));
    }
    // The comments typed into runs that are not followed on any more (the followed ones keep tracking them) go back in the queue.
    this.comments.giveBackTyped(runs.filter((r) => ![...this.live.values()].some((l) => l.runId === r.id)));
    // Tasks the engine was busy with that have no run to follow any more.
    for (const t of this.ctx.repo.tasksWhere({ runState: ['starting', 'running', 'stopping'] })) {
      if (attached.has(t.id) || [...this.live.values()].some((l) => l.taskId === t.id) || this.panel.gap(t.id)) continue;
      void this.serial(t.id, async () => {
        const task = this.ctx.repo.getTask(t.id);
        if (task && task.runState !== 'idle' && task.runState !== 'queued') await this.apply(t.id, { type: 'interrupted', text: 'The office restarted while it ran: Retry to carry on' });
      });
    }
    this.panel.recover(); this.panel.stale();
    for (const def of this.ctx.projects()) void this.drain(def.id);
    // Task workers kept from the last office carry only their task and role: their cards come back.
    for (const def of this.ctx.projects()) {
      const ids = new Set(this.ctx.floor(def.id)?.workers.list().flatMap((w) => (w.kanban ? [w.kanban.taskId] : [])));
      for (const id of ids) this.syncSummaries(this.ctx.repo.getTask(id));
    }
  }

  /** Follows a run left `running` by the last office on its worker. */
  private attach(run: KanbanRun, task: KanbanTask, info: WorkerInfo, launch: QueuedRun | undefined): Live {
    const live: Live = { taskId: task.id, runId: run.id, phase: isUiRun(run) ? 'implement' : run.phase, ...(isUiRun(run) ? { ui: true as const } : {}), ...(run.round !== undefined ? { round: run.round } : {}), role: run.role, ...(run.seat ? { seat: run.seat } : {}), ...(run.panel ? { panel: run.panel } : {}), tool: run.tool, workerId: info.id, floorId: task.project, exitPlan: false, ended: false, promptAt: run.promptedAt, ack: this.restarts.ack(run, task, launch), officePrompts: runTyped(this.ctx.repo.db, run.id), ...(launch ? { eff: runOf(launch), via: { ...(launch.taken?.length ? { taken: launch.taken } : {}), ...(launch.commentId !== undefined ? { commentId: launch.commentId } : {}) } } : {}) };
    this.live.set(info.id, live);
    return live;
  }

  private async interruptedRun(run: KanbanRun, task: KanbanTask, text: string) {
    this.restarts.back(run, task); this.finishRun(run.id, task.project, { status: 'interrupted', error: text });
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
      const seat = w.kanban!.seat ?? task.coReviewers?.find((c) => c.workerId === w.id)?.seat;
      const summary: KanbanWorkerSummary = {
        taskId: task.id,
        role: w.kanban!.role,
        ...(seat ? { seat } : {}),
        title: task.title, ...(task.ticket ? { ticket: task.ticket } : {}),
        status: task.status,
        ...(task.phase ? { phase: task.phase, ...planModeOf(task.phase, workers.launchArgsOf(w.id)) } : {}),
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

  /** Adds a comment (the repository never repeats a system one) and sends it once; `attachmentIds` are linked to the task and the comment first. */
  private addComment(project: string, c: NewComment, attachmentIds?: string[]): KanbanComment {
    const { comment: added, deduped } = this.ctx.repo.addComment(c);
    if (attachmentIds?.length) this.ctx.repo.linkAttachments(attachmentIds, c.taskId, added.id);
    const comment = attachmentIds?.length ? this.ctx.repo.getComment(added.id) ?? added : added;
    if (!deduped) this.ctx.broadcast({ t: 'kanban.comment', comment, project }, project);
    return comment;
  }

  /** The uploads a message may take, without taking them yet: unattached ones, or already this task's (as linkAttachments). */
  private takable(taskId: number, ids?: string[]): AttachmentRow[] {
    const rows: AttachmentRow[] = [];
    for (const id of ids ?? []) {
      const a = this.ctx.repo.getAttachment(id);
      if (a && (a.taskId === undefined || a.taskId === taskId) && !rows.some((r) => r.id === id)) rows.push(a);
    }
    return rows;
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
   * The run Retry and Continue carry on: the latest, not counting the compacts older offices ran (they only tidied the session).
   * One stopped with no worker never started (see queuedStopped): it goes again as it would have.
   */
  private lastRun(taskId: number): LastRun | undefined {
    // A fetch of review comments is no work to carry on (the task went back to where it was), unless it is what is parked. An additional reviewer's run is not the task's.
    const fetching = this.ctx.repo.getTask(taskId)?.phase === 'pr-comments';
    const runs = this.ctx.repo.listRuns(taskId).filter((r) => r.phase !== 'compact' && !r.seat && (fetching || r.phase !== 'pr-comments'));
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
    const tool: KanbanTool = q.phase === 'pr-review' ? (this.prReviews.last(task.id)?.tool ?? review.tool) : q.role === 'reviewer' ? review.tool : task.tool;
    const run = this.ctx.repo.createRun({ taskId: task.id, phase: q.phase, ...(q.round !== undefined ? { round: q.round } : {}), role: q.role, tool, status: 'stopped' });
    this.finishRun(run.id, task.project, { status: 'stopped', error });
  }

  /** The task's run on its main worker (not an additional reviewer's: see livesOf). */
  private liveOf(taskId: number): Live | undefined {
    for (const l of this.live.values()) if (l.taskId === taskId && !l.seat) return l;
    return undefined;
  }

  /** Every run the engine follows on the task: the main one, and an additional reviewer's each. */
  private livesOf(taskId: number): Live[] {
    return [...this.live.values()].filter((l) => l.taskId === taskId);
  }

  /** Whether something of the task is running: a run, or a review round between its main reviewer's own review and its combining. */
  private running(taskId: number): boolean {
    return !!this.liveOf(taskId) || this.panel.gap(taskId);
  }

  /** A reviewer's result as the task's review comment. */
  private say(task: KanbanTask, run: KanbanRun, text: string) {
    const info = run.workerId ? this.ctx.floor(task.project)?.workers.get(run.workerId) : undefined;
    if (text.trim()) this.addComment(task.project, { taskId: task.id, authorKind: 'agent', authorName: `${info?.name ?? 'Reviewer'} (reviewer)`, tool: run.tool, kind: 'review', text: text.trim(), runId: run.id });
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
      if (!floor || this.disposed) return;
      // No room for this one; a reviewer whose implementer is still at its desk may have it (see sharesLimit),
      // and needs no desk of its own when it can stand behind its implementer's (see watchSpotFor).
      const watch = t.queuedRun?.role === 'reviewer' ? this.seats.watchSpotFor(t, floor) : undefined;
      const restarted = Restarts.queued(t.queuedRun);
      if (!(restarted && this.restarts.reuses(t, floor)) && this.seats.noRoom(floor, watch, t.queuedRun && this.seats.sharesLimit(t, t.queuedRun.role, floor), t.queuedRun?.role)) continue;
      if (restarted && !(await this.restarts.admit(t, floor))) continue;
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
        const via: Via = { who: { name: task.createdBy, admin: false }, ...(task.queuedRun?.taken?.length ? { taken: task.queuedRun.taken } : {}), ...(task.queuedRun?.commentId !== undefined ? { commentId: task.queuedRun.commentId } : {}) };
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

  /** Tells the office's team notifications, once per transition, that a task waits on a person. */
  private announce(task: KanbanTask, what: string) {
    const name = this.ctx.project(task.project)?.name ?? task.project;
    try {
      this.ctx.notify?.(`🗂️ #${task.id} ${clip(task.title, 80)} ${what} in ${name}`, undefined, task.id);
    } catch (err) {
      console.error(`agent-office: couldn't announce kanban task #${task.id}: ${(err as Error).message}`);
    }
  }

  // --- Applying the machine -----------------------------------------------------------------------

  /** Feeds an event to the machine, saves the task's new state and carries out the effects. */
  private async apply(taskId: number, e: MachineEvent, via: Via = {}): Promise<string | undefined> {
    const task = this.ctx.repo.getTask(taskId);
    if (!task) return 'No such task';
    e = this.prComments.ending(task, e); // a fetch of review comments that ends leaves the task where it was
    const review = this.reviewSettings(task);
    const defaultAnswer = this.compose.text('kanban.defaultAnswer', task.project, { taskId: task.id });
    const tr = next(stateOf(task), e, { type: task.type, usePlan: task.usePlan, useReview: task.useReview, planApproval: task.planApproval }, { rounds: review.rounds, reReviewLastFix: review.reReviewLastFix, ...(defaultAnswer ? { defaultAnswer } : {}) });
    if ('error' in tr) return tr.error;
    const s = tr.state;
    this.update(taskId, {
      ...(task.hold && s.status !== 'on_hold' ? { hold: null } : {}),
      status: s.status,
      phase: s.phase,
      runState: s.runState,
      waitingReason: s.waitingReason,
      waitingText: s.waitingText,
      reviewRound: s.reviewRound,
      ...(e.type === 'start' && task.handoffFingerprint ? { handoffFingerprint: null } : {}),
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
    // Taken on the task's chain after this op, so the git calls delay nothing.
    if (this.handoffs.due(task, e, tr.effects)) void this.serial(taskId, () => this.handoffs.store(taskId));
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
          this.comments.restore(task, via.taken);
          this.update(taskId, { queuedRun: { ...queuedOf(eff), ...(via.commentId !== undefined ? { commentId: via.commentId } : {}) } });
          await this.apply(taskId, { type: 'noRoom', text: r.queued });
          return undefined;
        }
        const err = r;
        if (err) {
          this.comments.requeue(task, eff, via.commentId, via.taken);
          this.note(task, `Couldn't start the ${eff.phase} phase: ${err}`);
          await this.apply(taskId, { type: 'failed', error: err });
        }
        return err;
      }
      case 'acceptPlan': {
        const plan = this.compose.acceptPlan(taskId, via.who?.name ?? 'Kanban');
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
      case 'queueComment':
        this.comments.queue(task, via.commentId);
        return undefined;
      case 'note':
        this.note(task, eff.text);
        return undefined;
      case 'commentsOrigin':
        this.prComments.origin(taskId, eff.back);
        return undefined;
      case 'finished':
        this.update(taskId, { finishedAt: this.opts.now() });
        this.ctx.toast(task.project, `🗂️ #${task.id} ${clip(task.title, 60)} is ready for review`, 'info');
        this.announce(task, 'is ready for review');
        return undefined;
    }
  }

  // --- Starting runs ------------------------------------------------------------------------------

  /** The findings of the task's latest review, or the implementer's latest fix reply. */
  private latestSummary(taskId: number, phase: RunPhase): string | undefined {
    const runs = this.ctx.repo.listRuns(taskId).filter((r) => r.phase === phase && r.summary && !r.seat); // an additional reviewer's findings are the main reviewer's to combine, not the implementer's
    return runs[runs.length - 1]?.summary;
  }

  /** The session a role carries on, if it's one of the tool it runs now. */
  private sessionFor(task: KanbanTask, role: KanbanRole, tool: KanbanTool, seat = 0): string | undefined {
    const id = slot(task, role, seat).sessionId;
    if (!id) return undefined;
    const run = [...this.ctx.repo.listRuns(task.id)].reverse().find((r) => r.role === role && (r.seat ?? 0) === seat && r.sessionId === id);
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
      default:
        return prPrompt(phase) ?? 'continue';
    }
  }

  /** Starts a run; a review round with additional reviewers then has them start theirs (see ReviewPanel.open). */
  private async launch(task: KanbanTask, eff: RunEffect, via: Via): Promise<string | NoRoom | undefined> {
    const plan = this.panel.plan(task, eff);
    const err = await this.launchRun(task, plan?.eff ?? eff, via, 0, plan?.part, plan?.more);
    if (!err && plan?.part === 'solo') await this.panel.open(this.ctx.repo.getTask(task.id) ?? task, eff, via);
    return err;
  }

  /**
   * Starts a run: in the role's live worker (typed, or relaunched with the phase's flags), or a new hire. `seat` 1..4: an additional
   * reviewer's run (its own worker, settings and desk; it never moves the task: see ReviewPanel); `part`: what the run is in a review
   * round with several reviewers; `more`: what its prompt takes besides the effect's.
   */
  async launchRun(task: KanbanTask, eff: RunEffect, via: Via, seat = 0, part?: ReviewPanelPart, more?: Partial<ComposeExtra>): Promise<string | NoRoom | undefined> {
    const co = seat > 0;
    if (!co) this.ctx.repo.setAskingKind(task.id, undefined);
    const def = this.ctx.project(task.project);
    const floor = this.watch(task.project);
    if (!def || !floor) return "The project's floor isn't open";
    // A pull-request review carried on after an office restart (or its reviewer's question answered) goes on with its own reviewer (see Restarts.reviewer).
    const { same: last, restarted } = co ? { same: undefined, restarted: false } : this.restarts.reviewer(task, eff, floor, part);
    if (eff.phase === 'pr-review' && !last) return this.prReviews.start(task, def, floor, via, restarted, eff, seat, part);
    const role = eff.role;
    const review = this.reviewSettings(task);
    const spec = co ? (task.coReviewers?.find((c) => c.seat === seat) ?? review.extra?.[seat - 1]) : undefined; // the seat as the round was opened with
    if (co && !spec) return `There is no additional reviewer ${seat} in the review settings`;
    const defaults = this.ctx.settings.get().defaults;
    const tool: KanbanTool = spec?.tool ?? last?.tool ?? (role === 'reviewer' ? review.tool : task.tool);
    const model = spec ? spec.model : last ? last.model : role === 'reviewer' ? review.model : (task.model ?? (task.tool === defaults.tool ? defaults.model : undefined));
    const effort: KanbanEffort | undefined = spec ? spec.effort : last ? last.effort : role === 'reviewer' ? review.effort : (task.effort ?? (task.tool === defaults.tool ? defaults.effort : undefined));
    const adapter = this.adapters[tool];
    const folder = isFolderProject(def);
    if (folder && isPrPhase(eff.phase)) return 'A folder project has no git repositories to open pull requests in';
    // Only pull requests of the project's own (a fork's, or one from a base branch, is handled by hand).
    const fixPrs = onPrBranches(eff.phase) ? fixTargetsOf(task, def, this.ctx.floor(task.project)) : undefined;
    if (fixPrs && !fixPrs.length) return 'The task has no open pull requests of its own to work on (a pull request from a fork is handled by hand)';

    // Its worktree is gone (its worker went home with leave-on-merge, or it was pruned): anyone seated
    // there would only be marked lost. The workspace goes, its branch stays, and a fresh worktree takes
    // over that branch (see checkoutFor).
    const gone = !folder && task.workspace ? missingFolders(floor.dir, task.workspace) : [];
    if (gone.length) await this.dropWorkspace(task, floor, gone);
    if (role === 'reviewer' && !folder && !last && !this.ctx.repo.getTask(task.id)?.workspace) {
      return `${gone.length ? 'Its worktree is gone' : 'It has no worktree yet'}, so there is nothing to review in: comment to have its agent carry on in a fresh worktree${task.branch ? ` on branch ${task.branch}` : ''}, then review`;
    }

    // What the prompt says.
    let text = eff.text;
    let author = via.who?.name;
    if (eff.pending && !co) {
      const p = this.comments.take(task, via.pendingSince);
      if (p) ({ text, author } = p);
      via.taken = p?.msgs;
    }
    // Messages kept on the task by id (what was said during a hold, comments typed while the run waited for a desk) go with the run that resumes the work.
    const carried = !eff.pending && role === 'implementer' ? this.holds.carried(task, eff.prompt) : undefined;
    const held = carried?.text;
    const heldTaken = () => (carried?.ack(), this.ctx.repo.clearRunLaunch(run.id)); // an agent has the prompt
    const refsFile = eff.phase === 'plan' ? this.ctx.refs.referencedTasksFile(task.id, [task.title, task.description, text ?? ''].join('\n')) : undefined;
    const x: ComposeExtra = {
      phase: eff.phase,
      round: eff.round,
      rounds: review.rounds, focus: role === 'reviewer' ? (spec ?? review).focus : undefined,
      text,
      author,
      findings: eff.prompt === 'fix' ? reviewFindings(this.latestSummary(task.id, 'review') ?? '') : undefined,
      fixSummary: eff.prompt === 'rereview' ? this.latestSummary(task.id, 'fix') : undefined,
      refsFile,
      ...(part === 'co' || part === 'combine' ? { panel: part } : {}),
      ...more,
      fixPrs, ...(eff.phase === 'pr-review' ? this.prReviews.composeExtra(def, task.id) : {}), // a continued PR review (or a combine) keeps the repositories and the pull requests of its request
      held, prAnswers: eff.phase === 'pr-answers' ? this.prComments.answersFor(task.id) : undefined,
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
    const workerId = slot(fresh, role, seat).workerId;
    let info = workerId ? floor.workers.get(workerId) : undefined;
    if (info && (co || (info.provider !== tool && info.status !== 'working'))) {
      // The task's tool was changed: the worker at the desk runs the other CLI. A new hire takes over. (An additional reviewer is always hired anew, on its session.)
      await floor.sendHome(info.id, 'keep', ENGINE);
      this.update(task.id, slotPatch(role, { workerId: null }, seat, this.ctx.repo.getTask(task.id)));
      info = undefined;
    }
    const owner = hireOwner(fresh, via.who);
    // A reviewer stands behind its implementer's chair rather than taking a desk of its own (see watchSpotFor).
    const preferred = co ? undefined : role === 'implementer' ? (via.deskId ?? fresh.deskId) : this.seats.watchSpotFor(fresh, floor);
    const countsWith = co ? undefined : this.seats.sharesLimit(fresh, role, floor);
    if (!info) {
      // A new hire runs on its owner's own Claude sign-in (upstream's rule), never on the office's
      // instead; it needs a free desk and room under the office's worker limit (a reviewer shares its
      // implementer's), else it's queued; and a worktree it gets starts from what's on GitHub now.
      if (owner && tool === 'claude' && this.ctx.runAs && !this.ctx.runAs.claudeReady(owner)) return this.seats.signInMissing(fresh, owner, via.who);
      const full = this.seats.noRoom(floor, preferred, countsWith, role);
      if (full) return { queued: full };
      if (!folder && !fresh.workspace) await this.seats.freshBase(floor, def, fresh.repoIds);
    }

    // How it launches.
    const investigate = task.type === 'investigate' && role === 'implementer' && !onPrBranches(eff.phase);
    const { addDirs, readDirs } = launchDirs(this.ctx, def, task, { refsFile, investigate, folder });
    const extras = this.ctx.workerExtras(task.id, tool, skillPhase(eff.phase));
    const launchArgs = adapter.launchArgs(eff.phase, {
      ...this.ctx.settings.launchPermissions(task.project, task.overrides),
      sandbox: review.sandbox,
      investigate,
      addDirs,
      readDirs,
      model,
      effort,
      extra: extras.args,
    });
    const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;

    const run = this.ctx.repo.createRun({ taskId: task.id, phase: eff.phase, ...(eff.round !== undefined ? { round: eff.round } : {}), role, tool, model, effort, ...(co ? { seat } : {}), ...(part ? { panel: part } : {}), ...(co ? {} : { launch: { ...queuedOf({ ...eff, text, pending: undefined }), ...(via.taken?.length ? { taken: via.taken } : {}), ...(via.commentId !== undefined ? { commentId: via.commentId } : {}), carried: carried?.ids ?? [] } }) });
    this.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
    const follow = (workerId: string, prompt: string): Live => {
      const live: Live = { taskId: task.id, runId: run.id, phase: eff.phase, ...(eff.round !== undefined ? { round: eff.round } : {}), role, ...(co ? { seat } : {}), ...(part ? { panel: part } : {}), tool, workerId, floorId: task.project, exitPlan: false, ended: false, eff: { ...eff, pending: undefined, ...(text !== undefined ? { text } : {}) }, via };
      this.live.set(workerId, live);
      this.prompted(live, prompt);
      floor.workers.follows(workerId, true);
      return live;
    };
    const fail = (err: string) => {
      this.finishRun(run.id, task.project, { status: 'failed', error: err });
      return err;
    };

    // Its own worker still busy, or its teammates still at work (they wake the lead again after a turn's end): the phase starts when all rest. Teammates are counted from the start of the task's last run on that worker (its live is usually forgotten by now), so a prompt typed since doesn't hide them.
    const teamWork = (id: string) => {
      const prior = this.live.get(id);
      return tool === 'claude' && this.teammatesWork(floor, id, prior ? this.turnOpts(prior) : { since: Math.max(this.procSince.get(id) ?? 0, floor.workers.restartedAt(id) ?? 0) || undefined, runStart: this.ctx.repo.listRuns(task.id).filter((r) => r.id !== run.id && r.workerId === id).at(-1)?.startedAt });
    };
    // A resume with text (a comment, Continue's answer) doesn't wait for teammates or a working agent, which queue what is typed meanwhile: only for one still starting.
    const quick = eff.phase === 'resume' && text !== undefined;
    const relaunches = (i: WorkerInfo) => !(sameArgs(floor.workers.launchArgsOf(i.id), launchArgs) && i.model === adapter.spawnModel(model) && i.effort === adapter.spawnEffort(effort));
    const waits = (i: WorkerInfo) => (quick ? i.status === 'starting' || (i.status === 'working' && relaunches(i)) : i.status === 'working' || i.status === 'starting' || teamWork(i.id));
    if (info && info.kind === 'agent' && info.kanban?.taskId === task.id && waits(info)) {
      const waited = await this.rests.until(floor, info.id, task.id, () => teamWork(info!.id), quick && info.status === 'starting');
      if (this.disposed) return undefined; // the office went down meanwhile: nothing may be typed or hired
      if (waited.cancelled) {
        // Stopped while it waited: nothing was prompted, and the run ends as stopped. The comments it took off the task (or was resumed with) go back.
        this.comments.requeue(task, eff, via.commentId, via.taken);
        this.finishRun(run.id, task.project, { status: 'stopped' });
        await this.apply(task.id, { type: 'stopped', ...(waited.by ? { by: waited.by } : {}) });
        return undefined;
      }
      info = floor.workers.get(info.id);
    }
    if (info && info.kind === 'agent' && ((info.status !== 'working' && info.status !== 'starting') || (quick && info.status === 'working' && !relaunches(info)))) {
      x.checkout = await checkoutFor(this.ctx, fresh, def, floor.dir, role, eff.phase, false);
      const prompt = typeable(withCheckout(build((eff.prompt === 'continue' || eff.prompt === 'restarted') && !info.sessionId ? this.freshKind(fresh, eff.phase) : eff.prompt)));
      const live = follow(info.id, prompt);
      let err: string | undefined;
      // The task's model and effort as they are now (changed since the last run, say): a worker on
      // other ones is relaunched with them even when the phase's flags are the same.
      const spawnModel = adapter.spawnModel(model);
      const spawnEffort = adapter.spawnEffort(effort);
      const typed = !relaunches(info) && (info.status === 'done' || info.status === 'idle' || info.status === 'working');
      // Relaunched on its session: its agent is heard from (and has the prompt) later, and events of the old process meanwhile are not its own. Set before any await.
      if (!typed && info.sessionId) Object.assign(live, { resumed: true, armed: false, ack: heldTaken });
      else if (typed) Object.assign(live, { typed: true, ack: heldTaken, ...(info.status === 'working' ? { started: true } : {}) });
      this.ctx.repo.updateRun(run.id, { workerId: info.id, sessionId: info.sessionId }); // before the relaunch awaits: a restart in that window finds the run's worker
      if (typed) err = floor.workers.prompt(info.id, prompt, via.who?.name);
      else if (info.sessionId) err = await floor.workers.relaunch(info.id, { launchArgs, prompt, env: extras.env, model: spawnModel, effort: spawnEffort });
      else err = 'no session';
      live.armed = true;
      if (!err) {
        this.update(task.id, { runState: 'running' });
        return undefined;
      }
      this.forget(live);
      // It can't carry on in place (no session yet, say): a new hire in the same worktree takes over.
      await floor.sendHome(info.id, 'keep', ENGINE);
      this.update(task.id, slotPatch(role, { workerId: null }, seat));
    } else if (info && (info.status === 'working' || info.status === 'starting')) {
      return fail(`${info.name} is busy: wait for its turn to end`);
    }

    // A new hire.
    // The task's desk (the one it was started at, or where it last sat) when it's free, else the next free one.
    const desk = (preferred && !this.seats.deskRefusal(floor, preferred, role === 'reviewer') ? preferred : undefined) ?? nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.())?.id;
    if (!desk) {
      // Taken while its base was fetched: back to the queue.
      this.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its worker' });
      return { queued: this.seats.noRoom(floor, preferred, countsWith, role) ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
    }
    const now = this.ctx.repo.getTask(task.id) ?? fresh;
    const session = this.sessionFor(now, role, tool, seat);
    let kind = eff.prompt;
    if (!session) {
      if (kind === 'continue' || kind === 'restarted' || (kind === 'rereview' && part !== 'combine')) kind = kind === 'rereview' ? 'review' : this.freshKind(now, eff.phase);
      if (kind === 'replan') kind = 'plan';
    }
    x.checkout = await checkoutFor(this.ctx, now, def, floor.dir, role, eff.phase, !folder && !now.workspace);
    let prompt = build(kind);
    // A fresh session taking over work already under way is told where things stand first.
    if (!session && role === 'implementer' && HANDOFF_KINDS.has(kind) && (now.workspace || x.checkout)) {
      prompt = this.compose.handoff(def, now, floor.dir, withCheckout(prompt));
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
      kanban: { taskId: task.id, role, ...(co ? { seat } : {}) },
      env: extras.env,
      settingsFile: 'kanban',
    });
    if (typeof hired === 'string') return /taken out of the floor/.test(hired) ? (this.finishRun(run.id, task.project, { status: 'interrupted', error: hired }), { queued: this.seats.noRoom(floor, preferred, countsWith, role) ?? "Queued: its desk was taken out of the floor. It starts by itself when a desk frees." }) : fail(hired); // a desk taken out while it was being set up: back to the queue
    const live = follow(hired.id, prompt);
    this.ctx.repo.updateRun(run.id, { workerId: hired.id, ...(session ? { sessionId: session } : {}) });
    const patch: TaskUpdate = { ...slotPatch(role, { workerId: hired.id }, seat, now, spec), ...(role === 'implementer' ? { deskId: desk } : {}) };
    if (preferred && desk !== preferred) this.note(task, `${DESK_BY_ID.get(preferred)?.label ?? preferred} is taken, so ${hired.name} sits at ${DESK_BY_ID.get(desk)?.label ?? desk}.`);
    if (role === 'implementer' && !now.workspace && hired.worktree) {
      patch.workspace = { worktree: hired.worktree, ...(hired.repos?.length ? { repos: hired.repos } : {}) };
      // A branch the task already has (a migrated task, one whose worktree went) stays its branch:
      // the agent was told to check it out (checkoutFor), and syncBranch follows it there.
      if (!now.branch) patch.branch = hired.worktree.branch;
    }
    if (!co) patch.runState = 'running';
    this.update(task.id, patch);
    // A fresh session has the prompt on its command line; a resumed one is heard from before it is known to have it (the session may be gone).
    Object.assign(live, { ack: heldTaken, ...(session ? { resumed: true } : {}) });
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

  /** The task's workspace is gone: its workers go home, and it (and the sessions that ran there) is forgotten; its branch stays. */
  private async dropWorkspace(task: KanbanTask, floor: Floor, gone: string[]) {
    const ids = [task.workerId, task.reviewerWorkerId, ...(task.coReviewers ?? []).map((c) => c.workerId)].filter((x): x is string => !!x && !this.live.has(x));
    this.update(task.id, { workspace: null, sessionId: null, reviewerSessionId: null, ...(task.coReviewers ? { coReviewers: null } : {}), ...(task.workerId && ids.includes(task.workerId) ? { workerId: null } : {}), ...(task.reviewerWorkerId && ids.includes(task.reviewerWorkerId) ? { reviewerWorkerId: null } : {}) });
    for (const id of ids) if (floor.workers.get(id)) await floor.sendHome(id, 'keep', ENGINE);
    const where = gone.map((d) => path.relative(floor.dir, d) || d).join(', ');
    this.note(task, `Its worktree is gone (${where}): a fresh worktree takes over${task.branch ? `, and the agent checks out the task's branch ${task.branch} there first` : ''}.`);
  }

  // --- Following workers --------------------------------------------------------------------------

  /** An agent's own announcement of how its turn ends (KanbanEngineApi.signal). */
  signal(workerId: string, sig: TurnSignal): string | void {
    return acceptSignal(this.live.get(workerId), sig);
  }

  /** Whether a Claude Stop hook of the worker may end its turn (KanbanEngineApi.stopGate). */
  stopGate(workerId: string, payload: unknown): Promise<{ block?: string; stale?: true }> {
    return this.gate.decide(this.live.get(workerId), payload);
  }

  private observed(floorId: string, o: WorkerObservation) {
    if (this.disposed) return;
    if (o.event === 'hook' && o.hookEvent === 'SessionStart' && !agentHook(o.payload)) {
      const source = (o.payload as { source?: unknown } | undefined)?.source;
      if (source === 'startup' || source === 'resume') this.procSince.set(o.workerId, this.opts.now());
    }
    // Its process is over: a later one (relaunch) says when it started by its own SessionStart.
    if (o.event === 'status' && o.status === 'exited') this.procSince.delete(o.workerId);
    if (o.event === 'removed') {
      this.procSince.delete(o.workerId);
      const taskId = o.info.kanban?.taskId ?? this.live.get(o.workerId)?.taskId;
      if (taskId !== undefined) void this.serial(taskId, () => this.departures.removed(o.workerId, o.info, o.departure));
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
    if (live.armed !== false && !live.started && (live.typed ? receipt(o) : (o.event === 'hook' && !agentHook(o.payload)) || (o.status && o.status !== 'starting' && o.status !== 'exited'))) live.started = true;
    // The agent has the prompt once it submits it or starts its turn, not when its process starts (a stop in between must still carry the prompt on).
    if (live.ack && live.armed !== false && receipt(o) && !(o.event === 'hook' && agentHook(o.payload))) (live.ack(), (live.ack = undefined));
    if (o.event === 'hook') {
      live.lastHookAt = Date.now();
      // The agent took a prompt: a comment typed before it is heard.
      if (o.hookEvent === 'UserPromptSubmit' && !agentHook(o.payload)) this.comments.heard(live, (o.payload as { prompt?: unknown } | undefined)?.prompt);
      // A subagent's or teammate's hook (it runs in the lead's process, so it reaches the lead's worker): none of the lead's turn,
      // but its question or permission prompt is still what the worker's needs_input waits on.
      if (agentHook(o.payload)) {
        const question = !!o.tool && QUESTION_TOOL.test(o.tool);
        const ask = o.hookEvent === 'PermissionRequest' || o.hookEvent === 'PostToolUse' || o.hookEvent === 'PostToolUseFailure' || (o.hookEvent === 'PreToolUse' && question) || (o.hookEvent === 'Notification' && (o.payload as { notification_type?: unknown } | undefined)?.notification_type === 'permission_prompt');
        if (ask) this.heardAsk(live, o);
        return;
      }
      observeLeadHook(live, o, () => this.ctx.floor(floorId)?.workers.launchArgsOf(live.workerId), (text) => { const t = this.ctx.repo.getTask(live.taskId); if (t) this.note(t, text, live.runId); });
      if (o.hookEvent === 'UserPromptSubmit') (Object.assign(live, { stopText: undefined, restating: false }), newTurn(live));
      else if (o.hookEvent === 'Stop') Object.assign(live, { gated: false, ...(live.tool === 'claude' ? { stopText: stopMessage(o.payload) } : {}) });
      // The resumed turn has started (these hooks also set the worker `working`): its end is a normal `done` again.
      if (live.background && (o.hookEvent === 'PreToolUse' || o.hookEvent === 'UserPromptSubmit')) this.turnHolds.release(live);
      // A Stop while stopping is the stop done (the worker may stay `done`, which emits no status).
      if (o.hookEvent === 'Stop' && live.stopping) return void this.serial(live.taskId, () => this.stoppedRun(live));
      // The worker stays `done` across the resumed turn (upstream drops an unchanged status), so its Stop is heard here.
      if (o.hookEvent === 'Stop' && live.background) void this.serial(live.taskId, () => this.turnEnded(live));
      this.heardAsk(live, o);
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
    const question = heardQuestion(live, o);
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
    if (!live.seat) this.ctx.repo.setAskingKind(live.taskId, kind); // an additional reviewer's asking is not the task's
    const task = this.ctx.repo.getTask(live.taskId);
    if (task?.status === 'waiting' && task.waitingReason === 'agent_asking') this.pushTask(task);
  }

  private async needsInput(live: Live, info: WorkerInfo) {
    if (live.ended || this.live.get(live.workerId) !== live) return;
    if (live.phase === 'plan' && live.tool === 'claude') {
      // ExitPlanMode asks for approval: that is the plan being done. The hook says so, or the transcript.
      const file = this.ctx.floor(live.floorId)?.workers.transcripts(live.workerId)?.claude;
      if (live.exitPlan || (file && this.adapters.claude.readTurnResult(file, this.turnOpts(live))?.exitPlan)) return this.turnEnded(live, true);
    }
    const task = this.ctx.repo.getTask(live.taskId);
    if (live.seat) return this.panel.coGone(live, `it is asking something in its terminal${info.activity ? `: ${clip(info.activity, 160)}` : ''}`); // nobody answers an additional reviewer
    if (live.panel && task) await this.panel.close(task, 'its main reviewer is asking something');
    if (!task || (task.status === 'waiting' && task.waitingReason === 'agent_asking')) return;
    await this.apply(live.taskId, { type: 'asking', text: this.comments.asked(task, live, info) });
  }

  /** Its agent exited mid-run, or couldn't start at all because its folder is gone (upstream's lost): the run was interrupted. */
  private async exited(live: Live) {
    if (live.ended || this.live.get(live.workerId) !== live) return;
    live.ended = true;
    this.forget(live);
    const task = this.ctx.repo.getTask(live.taskId);
    const lost = !!this.ctx.floor(live.floorId)?.workers.get(live.workerId)?.lost;
    if (live.seat) {
      // An additional reviewer's seat did not finish; one whose stored session was gone starts afresh next round.
      if (task && live.resumed && !live.started) this.update(task.id, slotPatch('reviewer', { sessionId: null }, live.seat, task));
      return this.panel.coGone(live, lost ? "its worktree is gone, so its agent couldn't start" : 'its agent exited before its turn was done');
    }
    if (live.panel && task) await this.panel.close(task, 'its main reviewer exited'); // a fresh session starts the round again
    // Its agent exited before it was heard from, resuming a stored session: the session is gone (a month on hold, a cleaned-up home). The run
    // starts once more in a fresh session, with the handoff; its messages are still the task's (nothing was acknowledged).
    const session = task ? slot(task, live.role).sessionId : undefined;
    if (live.resumed && !live.started && !lost && live.eff && task && session && sessionLogged(this.ctx, task, live.tool, session, this.ctx.floor(live.floorId)?.workers.transcripts(live.workerId)) === false) return this.holds.freshSession(live, task, session);
    if (task && live.ack) this.comments.requeue(task, live.eff, live.via?.commentId, live.via?.taken);
    const why = lost ? "Its worktree is gone, so its agent couldn't start" : 'The agent exited before its turn was done';
    this.finishRun(live.runId, live.floorId, { status: 'interrupted', error: why });
    if (task) await this.apply(task.id, { type: 'interrupted', text: `${why}: Retry to carry on${lost ? ` in a fresh worktree${task.branch ? ` on branch ${task.branch}` : ''}` : ''}` });
    void this.drain(live.floorId);
  }

  /**
   * The task is done because its worker went home with it: another run of it stops, and its workers
   * still at their desks go home too (the worktree kept), as they do when a card is moved to done.
   */
  private async markDone(task: KanbanTask, by: string) {
    const other = this.liveOf(task.id);
    if (other) this.stopLive(other, `${by} made the task done`);
    await this.panel.close(task, `${by} made the task done`, 'stopped');
    const now = this.opts.now();
    this.update(task.id, { status: 'done', doneAt: now, archivedAt: null, runState: 'idle', waitingReason: null, waitingText: null, retryAt: null, finishedAt: task.finishedAt ?? now });
    this.ctx.repo.appendEvent(task.id, 'moved', { by, from: task.status, to: 'done', sentHome: true });
    await this.sendIdleHome(task.id, by, other?.workerId);
  }

  /** A run still live on a task is over as stopped, and its worker's turn is no longer followed: `error` says why. */
  private stopLive(live: Live, error: string) {
    live.ended = true;
    this.forget(live);
    this.finishRun(live.runId, live.floorId, { status: 'stopped', error });
  }

  /** The task's workers at rest (and `also`, busy or not) go home, their worktree kept unless it was a PR review's own: the task is done, archived, reset or deleted. Returns how many went. */
  private async sendIdleHome(taskId: number, by: string, also?: string, reason: 'released' | 'hold' = 'released'): Promise<number> {
    const task = this.ctx.repo.getTask(taskId);
    const floor = task && this.ctx.floor(task.project);
    if (!floor) return 0;
    const going = floor.workers.list().filter((w) => (w.kanban?.taskId === taskId || w.id === task.workerId || w.id === task.reviewerWorkerId) && (w.id === also || !isBusy(w.status)));
    for (const w of going) await floor.sendHome(w.id, homeCleanup(task, w), { by, reason });
    return going.length;
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
    await this.panel.home(task.id); this.update(task.id, { workspace: null, sessionId: null, reviewerSessionId: null, ...(task.coReviewers ? { coReviewers: null } : {}), ...(branch && !stays ? { branch: null } : {}) });
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
    this.ctx.floor(live.floorId)?.workers.follows(live.workerId, false);
    if (live.asks && !live.seat) this.ctx.repo.setAskingKind(live.taskId, undefined); // an additional reviewer's asking is not the task's
    this.comments.giveBackUnheard(live, () => this.readNow(live));
    clearTimeout(live.holdTimer);
    clearTimeout(live.nudgeTimer);
    clearTimeout(live.stopping?.timer);
  }

  private readNow(live: Live): TurnResult | undefined { // the run's turn as its session log has it now
    const logs = this.ctx.floor(live.floorId)?.workers.transcripts(live.workerId), file = logOf(logs, live.tool);
    return this.comments.saw(live, file ? this.adapters[live.tool].readTurnResult(file, this.turnOpts(live)) : undefined);
  }

  /**
   * The turn's result from the session log, read again while the log is still catching up: the Stop
   * hook can come before Claude has logged its final answer (the log then ends at a tool's result).
   * A typed turn is settled only once its own answer is in the log too. A log that never catches up falls back on the answer the Stop hook
   * carried (see stopFallback), but never while the log's last tool call is still running: a Stop then
   * didn't come from Claude (anything run in the agent's shell has the hook token, and could carry
   * a verdict of its own choosing): what the log has goes on, as it does without a Stop answer.
   */
  private async readResult(live: Live): Promise<TurnResult | undefined> {
    let result: TurnResult | undefined;
    for (let i = 0; i < this.opts.readTries; i++) {
      result = this.readNow(live);
      // A typed prompt froze the answer at the office's turn: only the typed turn's own answer can still arrive (whether or not the office's is complete).
      if (result && (result.typed ? typedSettled(result) : result.complete)) return result;
      await sleep(this.opts.readPauseMs);
    }
    if (live.tool !== 'claude' || (result?.complete && !result.typed)) return result;
    const fell = result && !result.toolRunning ? stopFallback(result, live.stopText) : undefined; if (fell) return fell;
    const why = !result ? 'no session log' : result.toolRunning ? 'a Stop while a tool was still running' : 'no last_assistant_message in its Stop hook';
    console.warn(`agent-office: kanban task #${live.taskId}: the ${live.phase} run's final answer never reached its session log (${why}): going on with the last text the log has`);
    return result;
  }

  /** The office prompts the run now (its launch or a restate): its answer is read from that prompt's turns; the time is kept on the run for a restart. */
  private prompted(live: Live, text: string) {
    live.promptHead = promptHead(text);
    newTurn(live);
    this.ctx.repo.updateRun(live.runId, { promptedAt: (live.promptAt = Date.now()) });
  }

  /** readTurnResult's options: `since` is when the worker's Claude process started (its SessionStart, else, after an office restart, the run's start); `runStart` is when the run began; `promptAt` is when the office last prompted it. */
  private turnOpts(live: Live): ReadOpts {
    const run = this.ctx.repo.getRun(live.runId);
    return { since: live.pinSince ? run?.startedAt : (this.procSince.get(live.workerId) ?? run?.startedAt), runStart: run?.startedAt, promptAt: live.promptAt, promptHead: live.promptHead, officePrompts: live.officePrompts };
  }

  /** Whether the worker's Claude teammates (agent teams) still work, from their transcripts. */
  private teammatesWork(floor: Floor, id: string, opts: { since?: number; runStart?: number }): boolean {
    const file = floor.workers.transcripts(id)?.claude;
    return !!file && !!this.adapters.claude.readTurnResult(file, opts)?.background;
  }

  /** A run's turn is over: read what it said, keep it, and move the task on. `planExit`: ExitPlanMode; `force`: the hold's timeout. */
  private async turnEnded(live: Live, planExit = false, force = false) {
    if (live.ended || live.restating || this.live.get(live.workerId) !== live) return;
    // Read before ending: a log that lags (the launch's result not in it yet) shows the background tasks only by now.
    // Nothing else ends the run meanwhile: they all go through `serial`, and this re-checks after the wait.
    const turn = live.turn, read: TurnResult | undefined = await this.readResult(live);
    if (live.ended || this.live.get(live.workerId) !== live) return;
    // The agent's final marker ends the run; a turn without it is an interim update the run waits through (see TurnEnd).
    const ending = await this.turnEnd.decide(live, read, { planExit, force, turn });
    if (!ending.end) return;
    const result = planFromHook(live, ending.result, planExit);
    const unfinished = ending.unfinished;
    const asked = ending.asked;
    live.background = false;
    live.ended = true;
    this.forget(live);
    const floor = this.ctx.floor(live.floorId);
    const info = floor?.workers.get(live.workerId);
    let task = this.ctx.repo.getTask(live.taskId);
    if (!task) return;
    // Sessions and branches, as they are now.
    if (info?.sessionId) this.update(task.id, slotPatch(live.role, { sessionId: info.sessionId }, live.seat ?? 0, task));
    if (live.role === 'implementer' && !live.ui) await syncBranch(this.ctx, task, info, (id, patch) => this.update(id, patch)); // a UI test's worktree is never the task's
    task = this.ctx.repo.getTask(live.taskId) ?? task;
    const sessionId = info?.sessionId;
    // A round with several reviewers: an additional reviewer's turn is the panel's alone; the main reviewer's run that isn't a clean result (or is the combine) ends the round.
    if (live.seat) return this.panel.coEnded(live, task, { result, unfinished, asked, sessionId });
    const clean = !!result && (result.complete || !!result.text.trim()) && !looksInterrupted(result.text, result.apiError) && !unfinished && !asked;
    if (live.panel && !(live.panel === 'solo' && clean)) await this.panel.close(task, clean ? undefined : 'its main reviewer did not finish');

    if (!result || (!result.complete && !result.text.trim() && !(planExit && result.plan?.trim()))) { // a plan handed over with ExitPlanMode is the reply, with no text around it
      this.finishRun(live.runId, task.project, { status: 'failed', error: "The turn ended without a reply the office could read", sessionId });
      await this.apply(task.id, { type: 'failed', error: "The agent's turn ended without a reply the office could read: look at its terminal, then Retry" });
      void this.drain(task.project);
      return;
    }
    if (looksInterrupted(result.text, result.apiError)) {
      await this.limits.limited(task, live, result, sessionId);
      return;
    }
    this.limits.clear(task.id);

    const agent = info?.name ?? (live.role === 'reviewer' ? 'Reviewer' : 'Agent');
    const say = (kind: KanbanComment['kind'], text: string) => {
      if (text.trim()) this.addComment(task!.project, { taskId: task!.id, authorKind: 'agent', authorName: live.role === 'reviewer' ? `${agent} (reviewer)` : agent, tool: live.tool, kind, text: text.trim(), runId: live.runId });
    };
    if (unfinished && result) {
      // Not moved on: its last text stays visible, and the task waits for Continue or Retry.
      // The prompt or comments it never received: that text is an older turn's, not shown; the comments are queued again.
      const why = ending.lost ? lostText(!!ending.lost.launch) : unfinishedText(live.phase);
      if (ending.lost) this.comments.giveBack(task, live); else say('message', stripWorkDone(result.text.trim()));
      this.finishRun(live.runId, task.project, { status: 'failed', error: why, ...(sessionId ? { sessionId } : {}) });
      this.note(task, why, live.runId);
      await this.apply(task.id, { type: 'failed', error: why });
      void this.drain(task.project);
      return;
    }
    if (asked) {
      // The agent announced a question: it is kept as one, and the run is over; the task waits for the answer (a comment or Continue), which carries on in this phase.
      say('questions', stripWorkDone(result.text.trim()));
      this.finishRun(live.runId, task.project, { status: 'succeeded', summary: clip(stripWorkDone(result.text.trim()), SUMMARY_MAX), ...(sessionId ? { sessionId } : {}) });
      this.ctx.repo.setAskingKind(task.id, 'question');
      await this.apply(task.id, { type: 'asking', text: 'The agent asks: answer below or with a comment', ended: true });
      void this.drain(task.project);
      return;
    }
    // Comments typed while any run went (a review's included) are worked on once it's over (see the machine).
    const pending = task.pendingMessages.some((m) => !m.parked);
    // A folder project has no git to ask: it always counts as changed.
    const changes = async () => (this.folder(task!.project) || !floor ? true : hasChanges(floor.dir, task!.workspace));
    const text = stripWorkDone(result.text.trim());
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
        if (live.ui) { event = await this.prReviews.uiEnded(task, live, text, say); break; } // the UI test before a pull-request review: the review starts
        say('result', text);
        this.update(task.id, { summary: clip(text, SUMMARY_MAX) });
        event = { type: 'implemented', changes: task.type === 'investigate' ? false : await changes(), pending };
        break;
      case 'review':
        verdict = reviewVerdict(text);
        if (live.panel !== 'solo') say('review', text); // the solo run of a round with several reviewers is published by the panel, or replaced by its combine run
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
        event = await this.handoffs.resumed(task, pending, changes);
        break;
      case 'pr':
      case 'pr-fix':
      case 'pr-conflicts':
      case 'pr-answers':
      case 'pr-comments':
        event = await this.prTurn.ended(task, live, text, pending, (t) => say('result', t));
        break;
      case 'pr-review':
        verdict = reviewVerdict(text);
        event = this.prReviews.ended(task, live, text, pending, say);
        break;
      default:
        // 'compact' only lives in old runs (reconcile drops them), but a run must never be left running: it ends here.
        this.finishRun(live.runId, task.project, { status: 'interrupted', error: `A ${live.phase} run has nothing to follow it` });
        this.update(task.id, { runState: 'idle' });
        return;
    }
    this.finishRun(live.runId, task.project, { status: 'succeeded', summary: clip(text, SUMMARY_MAX), ...(verdict ? { verdict } : {}), ...(sessionId ? { sessionId } : {}) });
    if (live.panel === 'solo') await this.panel.soloEnded(task);
    else await this.apply(task.id, event, { who: OFFICE });
    void this.drain(task.project);
  }

  // --- Stopping -----------------------------------------------------------------------------------

  /** Esc into the running turn's terminal; restarted on its session at its desk (never sent home) if it hasn't stopped in a few seconds. */
  private interrupt(task: KanbanTask, who?: KanbanCaller) {
    void this.panel.close(task, `${who?.name ?? 'Kanban'} stopped the review round`, 'stopped'); // the additional reviewers' runs end; Retry runs the whole round again
    const live = this.liveOf(task.id);
    if (!live) {
      // Between runs (a relaunch starting): nothing to interrupt, it's just stopped.
      void this.serial(task.id, () => this.apply(task.id, { type: 'stopped', ...(who ? { by: who.name } : {}) }));
      return;
    }
    const floor = this.ctx.floor(live.floorId);
    live.stopping = { ...(who ? { by: who.name } : {}), at: Date.now() };
    // At rest while its background work goes on: nothing to interrupt, so it is restarted on its session at its desk (never sent
    // home), which ends its helper agents. A turn that has resumed gets Esc as usual.
    const at = Date.now();
    const run: StopRun = { workerId: live.workerId, floor: () => this.ctx.floor(live.floorId), serial: (fn) => this.serial(live.taskId, fn), stop: () => this.stoppedRun(live, true), deliver: () => this.deliverStopped(live), note: (text) => this.note(task, text, live.runId), interrupted: (file) => !!this.adapters[live.tool].interruptedSince?.(file, at) };
    const status = floor?.workers.get(live.workerId)?.status;
    if (live.background && floor && (status === 'done' || status === 'idle')) return void endStop(run, 'background');
    floor?.workers.write(live.workerId, ESC, who?.name ?? 'Kanban');
    live.stopping.timer = setTimeout(() => this.live.get(live.workerId) === live && !live.ended && void endStop(run, 'timeout'), this.opts.stopGraceMs);
    live.stopping.timer.unref?.();
  }

  /** Ends the run as stopped; false when it had ended already. */
  private async stoppedRun(live: Live, defer = false): Promise<boolean> {
    if (live.ended || this.live.get(live.workerId) !== live) return false;
    live.ended = true;
    this.forget(live);
    await this.finishStopped(live, defer);
    if (!live.afterStop) void this.drain(live.floorId);
    return true;
  }

  private async deliverStopped(live: Live) {
    await Promise.resolve(live.afterStop?.()).finally(() => (live.afterStop = undefined));
    void this.drain(live.floorId);
  }

  private async finishStopped(live: Live, defer = false) {
    const task = this.ctx.repo.getTask(live.taskId);
    // A comment the run was resumed with that its agent never took is kept for the next run.
    if (task && live.ack) this.comments.requeue(task, live.eff, live.via?.commentId, live.via?.taken);
    this.finishRun(live.runId, live.floorId, { status: 'stopped' });
    // Comments made while it stopped are worked on now; older ones wait for a Retry or Continue (parked: not for the turn ends that follow either).
    const since = live.stopping?.at;
    const pending = since !== undefined && !!this.ctx.repo.getTask(live.taskId)?.pendingMessages.some((m) => m.at >= since);
    if (pending && task) this.comments.park(task, since!);
    const go = () => this.apply(live.taskId, { type: 'stopped', ...(live.stopping?.by ? { by: live.stopping.by } : {}), ...(pending ? { pending } : {}) }, pending ? { pendingSince: since } : {}).then(() => undefined);
    if (defer && pending) live.afterStop = go; else await go();
  }

  private async reviewerHome(task: KanbanTask) {
    const id = slot(task, 'reviewer').workerId;
    const floor = this.ctx.floor(task.project);
    await this.panel.close(task);
    this.update(task.id, { ...slotPatch('reviewer', { workerId: null, sessionId: null }), ...(task.coReviewers ? { coReviewers: null } : {}) });
    const info = id ? floor?.workers.get(id) : undefined;
    if (id && info) await floor!.sendHome(id, homeCleanup(task, info), ENGINE);
  }

  // --- The API ------------------------------------------------------------------------------------

  op(taskId: number, fn: (task: KanbanTask) => Promise<string | undefined | void>): Promise<string | void> {
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
      const why = opts.deskId ? this.seats.deskRefusal(floor, opts.deskId) : undefined;
      if (why) return why;
      const slot = this.busyCount(task.project, task.id) < this.ctx.settings.project(task.project).maxConcurrent;
      if (!task.startedAt) this.update(task.id, { startedAt: this.opts.now(), flags: { ...task.flags, descriptionLocked: true } });
      // Its desk, kept for a start that's queued and for later hires (see launch).
      if (opts.deskId) this.update(task.id, { deskId: opts.deskId });
      return this.apply(task.id, { type: 'start', slot }, { who, ...(opts.deskId ? { deskId: opts.deskId } : {}) });
    });
  }

  stop(taskId: number, who: KanbanCaller): Promise<string | void> {
    // A phase waiting for its own busy worker holds the task's chain: cancel it first, and the stop is done when it has wound up.
    if (this.rests.cancel(taskId, who.name)) return this.serial(taskId, async () => undefined);
    // A task asking in its terminal is idle but its run still goes: the machine stops that too.
    return this.op(taskId, async (task) => {
      const queued = task.runState === 'queued' ? task.queuedRun : undefined;
      const err = await this.apply(taskId, { type: 'stop' }, { who });
      if (!err && queued) (this.queuedStopped(task, queued, `Stopped by ${who.name} before it started`), this.comments.requeue(task, queued, queued.commentId)); // the comment that started it is kept for the Retry
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
        const text = answer?.trim() ?? '';
        const rows = this.takable(taskId, attachmentIds);
        const typed = this.compose.answerText(taskId, text, rows);
        if (!typed) return 'Type your answer, or answer in the terminal';
        const err = this.answer(asking, typed, who);
        if (!err) this.addComment(task.project, { taskId, authorKind: 'user', authorName: who.name, kind: 'message', text, runId: asking.runId }, rows.map((r) => r.id));
        return err;
      }
      if (this.running(task.id)) return 'It is still running: answer in its terminal, or stop it first';
      const text = answer?.trim() ?? '', rows = this.takable(taskId, attachmentIds);
      const msg = this.compose.commentText(task.project, taskId, text, rows);
      if (task.status !== 'waiting' || task.runState !== 'idle') return 'Only a waiting task can be continued';
      // The answer is a comment first, so the run it starts has its id: whatever its agent never gets goes back in the queue (Comments.requeue).
      const c = text || rows.length ? this.addComment(task.project, { taskId, authorKind: 'user', authorName: who.name, kind: 'message', text }, rows.map((r) => r.id)) : undefined;
      return this.apply(taskId, { type: 'continue', answer: msg, last: this.lastRun(taskId) }, { who, ...(c ? { commentId: c.id } : {}) });
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
      if (this.running(task.id)) return Promise.resolve('It is still running');
      // Its hire runs as the task's creator, like every other (hireOwner).
      return this.apply(taskId, { type: 'retry', last: this.lastRun(taskId) }, { who });
    });
  }

  review(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, (task) => {
      if (this.running(task.id)) return Promise.resolve('Stop it first: it is running');
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
    return this.op(taskId, async (task) => {
      const rows = this.takable(taskId, attachmentIds);
      const msg = this.compose.commentText(task.project, taskId, text.trim(), rows);
      const err = await this.apply(taskId, { type: 'requestPlanChanges', text: msg }, { who });
      if (!err) this.addComment(task.project, { taskId, authorKind: 'user', authorName: who.name, kind: 'message', text: text.trim() }, rows.map((r) => r.id));
      return err;
    });
  }

  /** The PR runs, the review comments' fetch and answers among them (only the engine's own callers may name those two, see PrRunMode). */
  prRun(taskId: number, who: KanbanCaller, mode: PrRunMode): Promise<string | void> {
    return this.op(taskId, (task) => {
      // Fixing or resolving conflicts, the shared rule answers first: the server gives the reason the button does.
      const def = this.ctx.project(task.project);
      const fix = mode !== 'create' && def ? canFixPrs(task, forkTest(polledPulls(this.ctx.floor(task.project)), projectRepos(def))) : undefined;
      if (fix && !fix.ok) return Promise.resolve(fix.reason);
      if (this.running(task.id)) return Promise.resolve('Stop it first: it is running');
      if (this.folder(task.project)) return Promise.resolve('A folder project has no git repositories to open pull requests in');
      // A task whose worktree went still has its branch: a fresh worktree checks it out (see launch).
      // Fixing or resolving conflicts, an open pull request's branch is work enough (checkoutFor sends the agent to it).
      if (!task.workspace && !task.branch && !(fix && fixTargetsOf(task, def!, this.ctx.floor(task.project)).some((p) => p.branch))) return Promise.resolve(`It has no ${mode === 'create' ? 'work to open pull requests for' : 'pull request branch to work on'} yet`);
      return this.apply(taskId, { type: 'pr', mode }, { who });
    });
  }

  /**
   * The task is sent back to To do or deleted: its workers at rest go home, worktree kept. A run still
   * live is an agent asking in its terminal (needs_input), which nobody will answer now: it is finished
   * as stopped and its worker goes too. A reset forgets the workspace, so the task says where it stayed.
   */
  sendWorkersHome(taskId: number, who: KanbanCaller, why: 'reset' | 'delete'): Promise<string | void> {
    return this.op(taskId, async (task) => {
      if (task.runState !== 'idle' || task.status === 'in_progress') return 'Stop it first: it is running';
      const live = this.liveOf(task.id);
      const floor = this.ctx.floor(task.project);
      const going = floor?.workers.list().filter((w) => w.kanban?.taskId === task.id || w.id === task.workerId || w.id === task.reviewerWorkerId) ?? [];
      const busy = going.find((w) => isBusy(w.status) && w.id !== live?.workerId);
      if (busy) return `${busy.name} is still working: stop it or send it home first`;
      // A delete writes no notes: the task goes right after.
      if (live) {
        const did = why === 'reset' ? 'moved the task back to To do' : 'deleted the task';
        this.stopLive(live, `${who.name} ${did}`);
        if (why === 'reset') this.note(task, `${who.name} ${did}, so its ${live.phase === 'review' || live.phase === 'pr-review' ? 'review round' : `${live.phase} run`} was stopped.`, live.runId);
      }
      const sent = await this.sendIdleHome(task.id, who.name, live?.workerId);
      // The path is the floor's own (relative to it), not where the floor sits on the server.
      const wt = task.workspace?.worktree;
      if (why === 'reset' && wt) this.note(task, `${sent ? 'Its workers went home. ' : ''}The worktree was kept at ${wt.path} on branch ${wt.branch}.`);
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
      await this.panel.close(task, `${who.name} moved the task to ${task.status === 'done' ? 'Done' : 'the archive'}`, 'stopped');
      if (live) {
        const where = task.status === 'done' ? 'Done' : 'the archive';
        this.stopLive(live, `${who.name} moved the task to ${where}`);
        this.note(task, `${who.name} moved the task to ${where}, so its ${live.phase === 'review' || live.phase === 'pr-review' ? 'review round' : `${live.phase} run`} was stopped.`, live.runId);
      } else if (task.queuedRun) this.queuedStopped(task, task.queuedRun, `${who.name} moved the task to ${task.status === 'done' ? 'Done' : 'the archive'} before it started`);
      if (live || task.runState !== 'idle' || task.queuedRun) this.update(task.id, { runState: 'idle', queuedRun: null, waitingReason: null, waitingText: null, retryAt: null });
      await this.sendIdleHome(task.id, who.name, live?.workerId);
    }).then(() => undefined);
  }

  /** A task in Waiting or Review is parked: its workers go home, the worktree and session stay (hold.ts). */
  hold(taskId: number, who: KanbanCaller, opts: { note?: string; until?: number } = {}): Promise<string | void> {
    return this.op(taskId, (task) => this.holds.hold(task, who, opts));
  }

  /** A held task goes on to Review or Done: what was said while it was held waits for its next run (hold.ts). */
  releaseHeld(taskId: number): Promise<string | void> {
    return this.op(taskId, async (task) => {
      if (task.status === 'on_hold' && task.hold) this.holds.queueHeld(task, task.hold.at);
    });
  }

  /** A task on hold is taken off it: back in the column it was held from, nothing runs (hold.ts). */
  unhold(taskId: number, who: KanbanCaller): Promise<string | void> {
    return this.op(taskId, (task) => this.holds.unhold(task, who));
  }

  commented(taskId: number, commentId: number, who: KanbanCaller): Promise<void> {
    return this.op(taskId, (task) => this.comments.handle(task, commentId, who)).then(() => undefined);
  }

  /** Several pull requests reviewed together, as a run of its own (see PrReviews.review). */
  reviewPrs(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string> {
    return this.prReviews.review(req, who);
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
    if (info.kanban) return this.prRun(info.kanban.taskId, who, 'create');
    if (info.kind === 'shell') return 'fallback';
    if (info.status === 'needs_input') return `${info.name} is waiting on an answer in its terminal`;
    const text = this.compose.workerPr(floor, info);
    const typed = typeable(text);
    const running = info.status !== 'exited';
    const err = running ? floor.workers.prompt(workerId, typed, who.name) : floor.workers.resume(workerId, typed);
    return err ?? undefined;
  }
}
