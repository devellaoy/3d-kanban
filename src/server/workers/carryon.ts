// Carrying on after the office restarted: the workers that were in the middle of a turn pick it up
// again by themselves (⚙️ Settings, see CarryOnSetting), one after another so they don't all hit
// the provider at once. Everyone else wakes as before, with no prompt.
import type { WorkerStatus } from '../../shared/protocol.js';
import { midTurn } from './lifecycle.js';
import type { Worker } from './types.js';

/** Between one carrying-on worker's start and the next one's. */
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

/** The line that separates a restarted worker's old output from its new one (once). */
export function restoredNote(w: Worker): string {
  const auto = w.autoResume;
  w.autoResume = false;
  return auto ? AUTO_RESUMED_NOTE : RESTORED_NOTE;
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
  return enabled && !!w.interrupted && !w.carryOnSent && w.info.kind === 'agent' && !!w.info.sessionId && !w.info.kanban;
}

export class CarryOn {
  constructor(private host: CarryOnHost) {}

  /** Whether `w` was cut off mid-turn and picks its turn up by itself: its own session, a prompt to go on. Not a task's worker: the kanban's engine resumes those. */
  carries(w: Worker): boolean {
    return carries(w, this.host.enabled());
  }

  /** Whether resuming `w` now tells it to go on: it was cut off mid-turn and carries on by itself at start (see carries), or its terminal host died under a running office (always, a task's worker included: the engine follows its run). */
  prompts(w: Worker): boolean {
    const lost = !!w.hostLost && !!w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
    w.hostLost = false;
    return lost || this.carries(w);
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
    if (!live && w.relaunching) {
      w.cutOff = 'starting';
      w.interrupted = true;
      w.relaunching = false; // the relaunch sees it and starts nothing in a closing office
    } else if (keep && w.pty?.id) w.cutOff = undefined;
    else if (live) {
      w.cutOff = w.info.status;
      if (midTurn(w)) w.interrupted = true;
    } else if (!w.interrupted) w.cutOff = undefined;
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    let n = 0;
    // A DeepSeek Harness worker has no PTY but is still running: only the ones that are gone wake up.
    for (const w of this.host.workers.values()) {
      if (w.pty || w.dsh || w.carryOnPending) continue;
      // Cut off mid-turn and the office is to carry on.
      const auto = this.host.enabled() && !!w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
      if (auto) w.autoResume = true;
      // Whatever its status was, its old process is gone with the teammates and background agents it had (see SpawnExtra.restartedAt).
      if (w.info.kind === 'agent' && (w.cutOff || w.interrupted)) (w.extra ??= {}).restartedAt = Date.now();
      if (!this.carries(w)) {
        this.host.resume(w.info.id);
        continue;
      }
      w.carryOnPending = true;
      const id = w.info.id;
      const timer = setTimeout(() => this.go(id), n++ * this.host.staggerMs());
      timer.unref();
    }
  }

  private go(id: string) {
    const w = this.host.workers.get(id);
    if (!w) return;
    w.carryOnPending = false;
    if (this.host.closing() || w.pty || w.dsh) return;
    // Turned off meanwhile, or a spent budget that lets nobody start something big: they wake, and wait to be told.
    const why = !this.host.enabled() ? 'carrying on after a restart was turned off' : this.host.hiringPaused() ? 'the budget for today is spent' : undefined;
    if (why) {
      w.interrupted = false;
      w.autoResume = false;
      w.carryOnDropped = why;
    }
    const error = this.host.resume(id);
    // It can't start (its worktree is gone, say): there is no turn to pick up, and whoever waits for it is told.
    if (error) {
      w.interrupted = false;
      w.autoResume = false;
      w.carryOnDropped = error;
    }
  }
}
