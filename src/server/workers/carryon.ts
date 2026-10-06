// Carrying on after the office restarted: the workers that were in the middle of a turn pick it up
// again by themselves (⚙️ Settings, see CarryOnSetting), one after another so they don't all hit
// the provider at once. Everyone else wakes as before, with no prompt.
import type { WorkerStatus } from '../../shared/protocol.js';
import { midTurn } from './lifecycle.js';
import type { CarryOnState, Worker } from './types.js';

/**
 * Between one carrying-on worker's start and the next one's. Shorter than the kanban's stagger between
 * runs (RestartDeps.staggerMs, 5 s): a worker only wakes a process with its prompt, a run then
 * launches a whole phase (worktree checks, relaunch, a long prompt).
 */
export const CARRY_ON_STAGGER_MS = 3000;
/** Between a worker's saved scrollback and what it prints after the office restarted. */
const RESTORED_NOTE = '\x1b[2m──── the office restarted · earlier output above ────\x1b[0m\r\n';
/** The same, for a worker that picks up where it was by itself. */
const AUTO_RESUMED_NOTE = '\x1b[2m──── the office restarted · carrying on by itself ────\x1b[0m\r\n';

const STATUSES = new Set<unknown>(['starting', 'idle', 'working', 'needs_input', 'done', 'exited', 'offline'] satisfies WorkerStatus[]);

/** A saved `cutOff`, if it is a status. */
export function validCutOff(v: unknown): WorkerStatus | undefined {
  return STATUSES.has(v) ? (v as WorkerStatus) : undefined;
}

/** Changes what a worker's carrying on says (`undefined` takes a flag away); it has none left when all are gone. */
export function setCarryOn(w: Worker, patch: Partial<CarryOnState>) {
  const next: Record<string, unknown> = { ...w.carryOn, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  w.carryOn = Object.keys(next).length ? (next as CarryOnState) : undefined;
}

/** The worker's turn is heard (it works): the carry-on, if one was sent, arrived, and the cut-off has served. */
export function reached(w: Worker) {
  w.interrupted = false;
  setCarryOn(w, { state: undefined, reason: undefined, cutOff: undefined });
}

/** The worker's carry-on is given up, for `reason`: it is at rest, not on its turn. */
export function drop(w: Worker, reason: string) {
  w.interrupted = false;
  setCarryOn(w, { state: 'dropped', reason });
}

/** The line that separates a restarted worker's old output from its new one: the carrying-on one when its start carries a turn on by itself (a task's worker is the engine's: it gets none). */
export function restoredNote(w: Worker): string {
  return w.carryOn?.state === 'sent' && !w.info.kanban ? AUTO_RESUMED_NOTE : RESTORED_NOTE;
}

/** What the carrying on needs of the manager. */
export interface CarryOnHost {
  workers: Map<string, Worker>;
  resume(id: string): string | undefined;
  /** ⚙️ Settings. */
  enabled(): boolean;
  /** Why no agent may start right now (today's budget is spent), if that's so. */
  hiringPaused(): string | undefined;
  closing(): boolean;
  staggerMs(): number;
}

/** Whether `w` was cut off mid-turn and picks its turn up by itself (see CarryOn.carries). */
export function carries(w: Worker, enabled: boolean): boolean {
  return enabled && !!w.interrupted && w.carryOn?.state !== 'sent' && w.info.kind === 'agent' && !!w.info.sessionId && !w.info.kanban;
}

export class CarryOn {
  constructor(private host: CarryOnHost) {}

  /** Whether `w` was cut off mid-turn and picks its turn up by itself: its own session, a prompt to go on. Not a task's worker: the kanban's engine resumes those. */
  carries(w: Worker): boolean {
    return carries(w, this.host.enabled());
  }

  /** Whether resuming `w` now tells it to go on: it was cut off mid-turn and carries on by itself at start (see carries), or its terminal host died under a running office (always, a task's worker included: the engine follows its run). */
  prompts(w: Worker): boolean {
    const lost = !!w.carryOn?.hostLost && !!w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
    setCarryOn(w, { hostLost: undefined });
    return lost || this.carries(w);
  }

  /** `w` starts (with `prompt` of its own, or none): whether it is told to carry on (see prompts). A carried-on turn counts as cut off until its prompt is heard (see reached). */
  start(w: Worker, prompt: string | undefined): boolean {
    const prompted = this.prompts(w) && !prompt;
    w.interrupted = prompted;
    if (prompted) setCarryOn(w, { state: 'sent', reason: undefined });
    else if (w.carryOn?.state !== 'dropped') setCarryOn(w, { state: undefined, reason: undefined });
    return prompted;
  }

  /** `w`'s terminal was picked back up still running: nothing to carry on. */
  adopted(w: Worker) {
    w.interrupted = false;
    setCarryOn(w, { cutOff: undefined });
  }

  /** The terminal host died under `w` in the middle of a turn: it is resumed with the carry-on prompt. */
  hostLost(w: Worker) {
    w.interrupted = true;
    setCarryOn(w, { hostLost: true });
  }

  /** A fresh session starts where `w`'s last one couldn't be resumed: a carry-on it was on is given up (the session is gone), a plain resume has nothing to give up. */
  sessionLost(w: Worker, reason: string) {
    if (w.carryOn?.state === 'sent') drop(w, reason);
    else w.interrupted = false;
  }

  /**
   * The office is closing: what the worker was doing is kept (`cutOff`, since its status reads
   * `exited` once its process is killed) and a turn in progress is marked to carry on, whether the
   * office restarts or stops. A terminal that stays in the host (`keep`) is picked back up instead.
   * A worker not started since the last restart keeps what it had.
   */
  cutOff(w: Worker, keep: boolean) {
    const live = !!(w.pty || w.dsh);
    // Between its old process and its new one (a relaunch): nothing ran, but a prompt was about to go in, so it counts as cut off before it started.
    if (!live && w.carryOn?.relaunching) {
      // The relaunch sees the marker gone and starts nothing in a closing office.
      setCarryOn(w, { cutOff: 'starting', relaunching: undefined });
      w.interrupted = true;
    } else if (keep && w.pty?.id) setCarryOn(w, { cutOff: undefined });
    else if (live) {
      setCarryOn(w, { cutOff: w.info.status });
      if (midTurn(w)) w.interrupted = true;
    } else if (!w.interrupted) setCarryOn(w, { cutOff: undefined });
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    let n = 0;
    // A DeepSeek Harness worker has no PTY but is still running: only the ones that are gone wake up.
    for (const w of this.host.workers.values()) {
      if (w.pty || w.dsh || w.carryOn?.state === 'pending') continue;
      const agent = w.info.kind === 'agent';
      // Whatever its status was, its old process is gone with the teammates and background agents it had (see SpawnExtra.restartedAt).
      if (agent && (w.carryOn?.cutOff || w.interrupted)) (w.extra ??= {}).restartedAt = Date.now();
      // Its carry-on prompt went in, but the process exited before it took it (this runs at runtime too, when someone walks in): the turn is lost, and it is said so rather than resumed with no prompt.
      if (agent && !w.info.kanban && w.carryOn?.state === 'sent') drop(w, 'its process exited before it took the carry-on prompt');
      if (!this.carries(w)) {
        this.host.resume(w.info.id);
        continue;
      }
      setCarryOn(w, { state: 'pending' });
      const id = w.info.id;
      const timer = setTimeout(() => this.go(id), n++ * this.host.staggerMs());
      timer.unref();
    }
  }

  private go(id: string) {
    const w = this.host.workers.get(id);
    if (!w) return;
    if (w.carryOn?.state === 'pending') setCarryOn(w, { state: undefined });
    if (this.host.closing() || w.pty || w.dsh) return;
    // Turned off meanwhile, or a spent budget that lets nobody start something big: they wake, and wait to be told.
    const why = !this.host.enabled() ? 'carrying on after a restart was turned off' : this.host.hiringPaused() ? 'the budget for today is spent' : undefined;
    if (why) drop(w, why);
    const error = this.host.resume(id);
    // It can't start (its worktree is gone, say): there is no turn to pick up, and whoever waits for it is told.
    if (error) drop(w, error);
  }
}
