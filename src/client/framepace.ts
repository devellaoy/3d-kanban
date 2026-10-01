// How often the 3D office is drawn: every screen refresh while you play, fewer when nothing is going on.

/** How the office is being watched: full rate, or a calmer one. */
export type PaceMode = 'active' | 'idle' | 'covered' | 'background';

/**
 * Frames a second drawn in each mode (the screen refreshes decide which ones). A page without the focus
 * may still be in plain sight (the office on a second screen, watched while you type elsewhere), so it
 * gets the idle rate, not the covered one.
 */
export const PACE_FPS: Record<PaceMode, number> = { active: Infinity, idle: 30, covered: 15, background: 30 };

/** No input for this long (ms) and the office goes idle. */
export const IDLE_AFTER_MS = 2500;

/** What's going on, for picking the mode. */
export interface PaceState {
  /** You are walking, jumping or falling. */
  moving: boolean;
  /** Something is going on that needs every frame: an activity, a filter, the elevator, a button held. */
  busy: boolean;
  /** A window is open over the office. */
  modal: boolean;
  /** The page has the keyboard's focus. */
  focused: boolean;
}

/** The longest gap between screen refreshes (ms) that tells us the refresh rate; longer ones are stalls. */
const MAX_GAP_MS = 100;
const GAPS = 30;

/**
 * Picks the mode from input and state, and says which screen refreshes (requestAnimationFrame
 * callbacks) to draw: every Nth one, counted rather than timed, so the drawn frames are evenly spaced.
 */
export class FramePace {
  private lastInput = -Infinity;
  private heldUntil = -Infinity;
  private lastTs: number | null = null;
  /** The latest gaps, in a ring that's never reallocated, and a scratch copy to sort. */
  private readonly gaps = new Float64Array(GAPS);
  private readonly sorted = new Float64Array(GAPS);
  private seen = 0;
  private interval = 1000 / 60;
  private since = Infinity;
  private lastMode: PaceMode = 'active';

  /** Input happened at `now`. */
  poke(now: number) {
    this.lastInput = now;
  }

  /** Full rate until `ms` after `now` (or as long as one already running holds it). */
  hold(now: number, ms: number) {
    this.heldUntil = Math.max(this.heldUntil, now + ms);
  }

  mode(now: number, s: PaceState): PaceMode {
    if (now - this.lastInput < IDLE_AFTER_MS || now < this.heldUntil || s.moving || s.busy) return 'active';
    if (s.modal) return 'covered';
    return s.focused ? 'idle' : 'background';
  }

  /** A screen refresh at `ts` (ms): learns how far apart they are. */
  vsync(ts: number) {
    if (this.lastTs !== null) {
      const gap = ts - this.lastTs;
      if (gap > 0 && gap <= MAX_GAP_MS) {
        this.gaps[this.seen++ % GAPS] = gap;
        // The median: every gap until the ring has filled, then once a ring's worth.
        if (this.seen <= GAPS || this.seen % GAPS === 0) {
          const n = Math.min(this.seen, GAPS);
          this.sorted.set(this.gaps.subarray(0, n));
          this.interval = this.sorted.subarray(0, n).sort()[n >> 1];
        }
      }
    }
    this.lastTs = ts;
  }

  /** Whether to draw at this refresh (call once per callback, after vsync). */
  due(_ts: number, mode: PaceMode): boolean {
    const was = this.lastMode;
    this.lastMode = mode;
    if (mode === 'active') {
      this.since = Infinity;
      return true;
    }
    // Coming down from active (or the very first call): the count starts here, so the next draw is N refreshes on.
    if (was === 'active') this.since = 0;
    const n = Math.max(1, Math.round(1000 / PACE_FPS[mode] / this.interval));
    if (++this.since < n) return false;
    this.since = 0;
    return true;
  }
}
