// What the engine does with a turn's Stop that isn't the run's end (docs/kanban-architecture.md §4): the run is held for the background
// work it set off, and asked to restate its final answer when a prompt typed into its terminal took the turn the work ended in. Split
// out of the orchestrator like Holds; the engine's own state reaches it through the small `TurnHoldDeps` interface.

import { isBusy } from '../../../shared/status.js';
import type { Floor } from '../../floor.js';
import type { KanbanTask, RunPhase } from '../../../shared/kanban/types.js';

/**
 * A prompt as it may be typed into a terminal: prompts go in as a bracketed paste, so an escape in a
 * comment or an agent's findings could end the paste early and type keys of its own.
 */
export const typeable = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

/** At most this many restates a run gets: an agent that keeps being typed at isn't asked for ever. */
const MAX_RESTATES = 2;

/** The part of a followed run the hold and the restate keep state in. */
export interface HeldRun {
  taskId: number;
  runId: number;
  phase: RunPhase;
  workerId: string;
  floorId: string;
  ended: boolean;
  /** Its turn stopped while background work it set off still works: the run goes on until a Stop with none left. */
  background?: boolean;
  /** It has been held for background work at least once: a later Stop on an unanswered notification is the resumed turn's own. */
  held?: boolean;
  holdTimer?: NodeJS.Timeout;
  /** The Stop hook's final answer (see Live). */
  stopText?: string;
  /** When the office last gave the run its prompt (ms): the launch, or a restate. The answer is read from that prompt's turns. */
  promptAt?: number;
  /** How many times the run was asked to restate its answer. */
  restates?: number;
  /** A restate was typed and its prompt hasn't been heard yet: a Stop meanwhile is the typed turn's again. */
  restating?: boolean;
}

/** What holding a turn borrows from the orchestrator. */
export interface TurnHoldDeps<L extends HeldRun> {
  /** Whether the engine still follows the run. */
  following(live: L): boolean;
  serial<T>(taskId: number, fn: () => Promise<T>): Promise<T>;
  task(id: number): KanbanTask | undefined;
  floor(floorId: string): Floor | undefined;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  /** The run's turn ended; `force` is the hold's timeout. */
  turnEnded(live: L, planExit: boolean, force: boolean): Promise<void>;
  /** The office gives the run a prompt now: `promptAt` is set and kept (see Orchestrator.prompted). */
  prompted(live: L): void;
  /** The restate prompt for the task's phase (kanban.restate with the phase's contract). */
  restateText(task: KanbanTask, phase: RunPhase): string;
  /** How long a hold waits for the run's next Stop (ms). */
  waitMs(): number;
}

export class TurnHolds<L extends HeldRun> {
  constructor(private deps: TurnHoldDeps<L>) {}

  /** The turn stopped on background work: the run goes on, and its next Stop is heard from the hook. */
  hold(live: L) {
    live.background = true;
    live.held = true;
    // Stop #1's answer is the interim "I'll wait" text, never the run's.
    live.stopText = undefined;
    this.arm(live);
  }

  /**
   * A prompt typed into the terminal took the turn the run's background work ended in, or came before the office's answer reached the log, so the office's last text is only the interim or an unfinished one: the
   * agent is asked to give its final answer again, and the run goes on (true). Not when it was asked twice already or the prompt can't be typed:
   * the run ends on the office's own last text (false), with a note.
   */
  restate(live: L): boolean {
    const task = this.deps.task(live.taskId);
    const workers = this.deps.floor(live.floorId)?.workers;
    const prompt = task && workers && (live.restates ?? 0) < MAX_RESTATES ? typeable(this.deps.restateText(task, live.phase)) : undefined;
    // The typed turn is still running (the office's own Stop came first): wait for its Stop, which asks again; no restate is used up.
    if (prompt && workers && isBusy(workers.get(live.workerId)?.status ?? 'idle')) {
      this.hold(live);
      return true;
    }
    if (prompt && workers) {
      // Set before the prompt goes in: its turn is the one the answer is read from, and a Stop on the typed turn's tail isn't it.
      this.deps.prompted(live);
      live.restates = (live.restates ?? 0) + 1;
      live.stopText = undefined;
      live.held = false;
      live.restating = true;
      this.arm(live);
      if (!workers.prompt(live.workerId, prompt)) return true;
      clearTimeout(live.holdTimer);
      live.restating = false;
    }
    if (task) this.deps.note(task, 'Someone typed into its terminal while it worked: went on with its last answer to the office\'s prompt.', live.runId);
    return false;
  }

  /** (Re)starts the wait for the run's next Stop; when it never comes the run goes on with what its log says. */
  private arm(live: L) {
    clearTimeout(live.holdTimer);
    live.holdTimer = setTimeout(() => void this.deps.serial(live.taskId, async () => {
      if (live.ended || !this.deps.following(live)) return;
      const task = this.deps.task(live.taskId);
      const ms = this.deps.waitMs();
      const waited = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
      console.warn(`agent-office: kanban task #${live.taskId}: no Stop in ${waited} after the ${live.phase} run was held for background work: going on with what its log says`);
      if (task) this.deps.note(task, `Waited ${waited} for its background work to report back; went on with what its log says.`, live.runId);
      live.restating = false;
      await this.deps.turnEnded(live, false, true);
    }), this.deps.waitMs());
    live.holdTimer.unref?.();
  }
}
