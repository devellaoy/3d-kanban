// How a turn's Stop becomes the run's end (docs/kanban-architecture.md §4, "The end of a turn"). The agent says it is done with
// its final marker (WORK DONE, PLAN READY / QUESTIONS:, the review's verdict line: see the contracts in shared/kanban/prompts.ts); the
// log heuristics (background agents, teammates, unheard prompts) only tell when a turn is certainly not the end. A turn without the
// marker is an interim update: the run is held, and when its agent has rested a while with nothing running it is nudged for the
// marker, a few times, before the run ends on its last text. Split out of the orchestrator like TurnHolds, which it builds on.

import { finishNudge, WORK_DONE } from '../../../shared/kanban/prompts.js';
import type { KanbanTask, KanbanTool } from '../../../shared/kanban/types.js';
import type { Floor } from '../../floor.js';
import type { TurnResult } from './adapters/types.js';
import { finalMarker, looksInterrupted } from './markers.js';
import { typeable, type HeldRun, type TurnHolds } from './turnhold.js';

/** A run as the turn end follows it. */
export interface EndLive extends HeldRun {
  tool: KanbanTool;
}

/** How long a nudge's look at the worker waits again at most when it only has to see the worker rest (ms). */
const POLL_MAX_MS = 15_000;

/** What deciding on a turn's end borrows from the orchestrator. */
export interface TurnEndDeps<L extends EndLive> {
  holds: TurnHolds<L>;
  following(live: L): boolean;
  serial<T>(taskId: number, fn: () => Promise<T>): Promise<T>;
  task(id: number): KanbanTask | undefined;
  floor(floorId: string): Floor | undefined;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  /** The run's turn as its session log has it now. */
  read(live: L): Promise<TurnResult | undefined>;
  /** The run's turn ended (`force`: the hold's timeout). */
  turnEnded(live: L, planExit: boolean, force: boolean): Promise<void>;
  /** How long its agent must have rested without a hook before it is nudged (ms), and how often it is nudged at most. */
  nudgeIdleMs(): number;
  maxNudges(): number;
}

/** What a turn's end comes to: the run goes on (`end` false), or it ends on `result` (undefined: the log had none to read). */
/** `unfinished`: the agent never gave its marker, even when asked: the run ends, but the task is not moved on (it waits for the user). */
export type Ending = { end: false } | { end: true; result: TurnResult | undefined; unfinished?: true; lost?: NonNullable<TurnResult['lost']> };

/** What the marker of a phase is called, for the note that an agent never gave it. */
const markerName = (phase: string) => (phase === 'plan' ? 'PLAN READY or QUESTIONS:' : phase === 'review' || phase === 'pr-review' ? 'a REVIEW: verdict line' : WORK_DONE);

/** What a task that waits because its agent never gave its marker says (see Ending.unfinished). */
export const unfinishedText = (phase: string) => `The agent never gave its final answer (${markerName(phase)}): Continue to carry on, or move it on yourself`;

/** What a task that waits because its agent never got the office's prompt or comment says (see TurnResult.lost). */
export const lostText = (launch: boolean) => `The agent never received ${launch ? 'its prompt' : 'a comment typed into its terminal'} (nothing of it showed in its log in 15 minutes), so its last answer is not an answer to it: the ${launch ? 'comment that started it is' : 'comment is'} kept; Continue or Retry to carry on`;

export class TurnEnd<L extends EndLive> {
  constructor(private deps: TurnEndDeps<L>) {}

  /**
   * Whether the run's turn is its end. `planExit`: ExitPlanMode, the plan itself. The marker decides: with it the run ends whatever the
   * counters say (a dead teammate, a dev server left on). Without it the turn is an interim update, and the run is held: for a Stop that
   * the log shows to be mid-work (background agents or commands, teammates, an unanswered notification, a prompt of the office's not yet
   * heard) until its next one; otherwise until the agent is nudged for its marker. A usage limit, an unreadable turn and an agent that
   * has been nudged as often as it is end the run on what there is. `force`: the hold's timeout; the run is nudged then, or ends.
   */
  async decide(live: L, result: TurnResult | undefined, o: { planExit: boolean; force: boolean }): Promise<Ending> {
    if (o.planExit || !result) return { end: true, result };
    // A prompt or comment the log never showed in the wait for it: the answer read is an older turn's, never the run's. It ends unfinished, the comments kept.
    if (result.lost) return { end: true, result, unfinished: true, lost: result.lost };
    // A person's typed turn after the office's may have ended the work: its marker counts.
    const r = this.adopt(live, result);
    // An earlier turn's marker (the office's prompt isn't in the log yet) is no answer to this one.
    if (!r.unheard && finalMarker(live.phase, `${r.text}\n${r.plan ?? ''}`, r.exitPlan)) {
      if (r.background || r.resuming) console.warn(`agent-office: kanban task #${live.taskId}: the ${live.phase} run gave its final marker while the log shows work still out (${r.background ?? 0} background); ending it`);
      return { end: true, result: r };
    }
    const running = !!(r.background || r.unheard || (r.resuming && !live.held));
    if (running && !o.force) return this.wait(live);
    if (looksInterrupted(r.text, r.apiError)) return { end: true, result: r };
    // A prompt typed into the terminal took the turn the work ended in, or came before the office's answer reached the log: the agent is asked to give its answer again.
    if (!o.force && live.tool === 'claude' && r.typed && (r.interim || !r.complete) && this.deps.holds.restate(live, r.typedOpen)) return { end: false };
    if (!r.complete && !r.text.trim()) return { end: true, result: r };
    if ((live.nudges ?? 0) >= this.deps.maxNudges()) return this.exhausted(live, r);
    return o.force ? this.nudge(live, r) : this.wait(live);
  }

  /** The turn read, with the final answer of a typed turn after the office's in place of the office's own when only that one has the marker. */
  private adopt(live: L, r: TurnResult): TurnResult {
    if (r.unheard || !r.lastText || finalMarker(live.phase, r.text, r.exitPlan)) return r;
    return finalMarker(live.phase, r.lastText, r.exitPlan) ? { ...r, text: r.lastText, complete: true } : r;
  }

  /** The turn was an interim update: the run is held, and its agent nudged once it has rested long enough. */
  private wait(live: L): Ending {
    this.deps.holds.hold(live);
    this.schedule(live, this.interval(live));
    return { end: false };
  }

  private interval(live: L): number {
    return this.deps.nudgeIdleMs() * 2 ** (live.nudges ?? 0);
  }

  private schedule(live: L, ms: number) {
    clearTimeout(live.nudgeTimer);
    live.nudgeTimer = setTimeout(() => void this.deps.serial(live.taskId, () => this.look(live)), Math.max(50, ms));
    live.nudgeTimer.unref?.();
  }

  /**
   * Whether the held run's agent is due its nudge: it rests (done or idle: not in a dialog, not gone), has fired no hook of any kind for
   * the interval, and the log shows nothing running. Looked at again later otherwise.
   */
  private async look(live: L) {
    if (live.ended || !this.deps.following(live) || live.restating) return;
    const interval = this.interval(live);
    const status = this.deps.floor(live.floorId)?.workers.get(live.workerId)?.status;
    const quiet = Date.now() - (live.lastHookAt ?? live.promptAt ?? 0);
    if ((status !== 'done' && status !== 'idle') || quiet < interval) return this.schedule(live, status === 'done' || status === 'idle' ? interval - quiet : Math.min(interval, POLL_MAX_MS));
    const result = await this.deps.read(live);
    if (live.ended || !this.deps.following(live) || live.restating) return;
    if (!result) return this.schedule(live, interval);
    if (result.lost) return this.deps.turnEnded(live, false, true);
    const r = this.adopt(live, result);
    // The agent did finish (its Stop was missed): the turn's end is decided on what the log says.
    if (!r.unheard && finalMarker(live.phase, `${r.text}\n${r.plan ?? ''}`, r.exitPlan)) return this.deps.turnEnded(live, false, false);
    if (r.background || r.unheard || r.resuming) return this.schedule(live, interval);
    if ((live.nudges ?? 0) >= this.deps.maxNudges() || !this.send(live)) return this.deps.turnEnded(live, false, true);
  }

  /** The agent is asked for its marker. The run goes on; it ends instead when the nudge can't be typed or enough were. */
  private nudge(live: L, r: TurnResult): Ending {
    return this.send(live) ? { end: false } : this.exhausted(live, r);
  }

  /**
   * Types the nudge into the run's worker (a turn it is busy with takes it as a queued prompt; either way its next Stop answers it). False
   * when it can't: no worker, one gone or in a dialog, or a prompt that won't go in. Nudging is over for the run then.
   */
  private send(live: L): boolean {
    const info = this.deps.floor(live.floorId)?.workers.get(live.workerId);
    clearTimeout(live.nudgeTimer);
    if (!info || info.status === 'exited' || info.status === 'needs_input' || !this.deps.holds.retype(live, typeable(finishNudge(live.phase)))) {
      live.nudges = this.deps.maxNudges();
      return false;
    }
    live.nudges = (live.nudges ?? 0) + 1;
    return true;
  }

  /**
   * The agent was nudged as often as it may be, and never gave its marker. A plan goes on with its last text (the old reading of it);
   * any other run ends `unfinished`: the task waits for the user, with the last text shown, rather than moving on.
   */
  private exhausted(live: L, r: TurnResult): Ending {
    const task = this.deps.task(live.taskId);
    if (live.phase !== 'plan') return { end: true, result: r, unfinished: true };
    if (task) this.deps.note(task, `Its agent never gave ${markerName(live.phase)} to end its final answer, even when asked for it: went on with its last answer.`, live.runId);
    return { end: true, result: r };
  }
}
