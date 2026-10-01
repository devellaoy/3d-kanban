/**
 * How often the office is drawn (see framepace.ts): every screen refresh while you play or anything is
 * moving, fewer when you've stopped, a window covers the view or the page is in the background. Input
 * and changes of focus bring the full rate straight back. `localStorage['agent-office.pace'] = 'full'`
 * turns it off.
 */
import { FramePace, type PaceMode } from '../framepace';
import { modalOpen, onModalChange } from '../ui/dom';
import type { Ctx } from './context';
import type { CoreState } from './ctx';

/** What the loop asks each screen refresh, and what it reports back. */
export interface FramePacer {
  /** Whether to draw at this screen refresh (`ts` is the requestAnimationFrame timestamp). */
  due(ts: number): boolean;
  /** The mode of the latest refresh. */
  readonly mode: PaceMode;
  /** Full rate for `ms` (an ease still running). */
  hold(ms: number): void;
  /** Forces a mode (for measuring), or null to work it out again. */
  force(mode: PaceMode | null): void;
  /** Frames drawn and skipped so far. */
  readonly drawn: number;
  readonly skipped: number;
  /** The average ms a drawn frame's ticks took, over the last 60. */
  readonly workMs: number;
  /** Reports how long a drawn frame's ticks took (ms). */
  worked(ms: number): void;
  /** This frame and the one before were at full rate: its timings mean something. */
  readonly full: boolean;
}

export function installFramePace(ctx: Ctx, core: CoreState): FramePacer {
  const pace = new FramePace();
  let always = false;
  try {
    always = localStorage.getItem('agent-office.pace') === 'full';
  } catch {
    // No storage: the usual pace.
  }
  let held = false;
  let forced: PaceMode | null = null;
  let mode: PaceMode = 'active';
  let wasActive = false;
  let full = false;
  let drawn = 0;
  let skipped = 0;
  const work = new Array<number>(60).fill(0);
  let worked = 0;
  let workSum = 0;

  const poke = () => pace.poke(performance.now());
  const opts = { capture: true, passive: true } as const;
  for (const type of ['keydown', 'keyup', 'pointermove', 'wheel', 'touchstart']) window.addEventListener(type, poke, opts);
  window.addEventListener('pointerdown', () => ((held = true), poke()), opts);
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => ((held = false), poke()), opts);
  window.addEventListener('blur', () => ((held = false), poke()));
  window.addEventListener('focus', poke);
  document.addEventListener('visibilitychange', poke);
  onModalChange(poke);

  /** The camera as the last drawn frame left it: when it has moved since (an ease settling, a turn
   * into a seat), the next few frames are drawn at full rate too. */
  const seen = new Float64Array(16);

  return {
    due(ts) {
      pace.vsync(ts);
      const { player } = ctx;
      const cam = ctx.camera.matrixWorld.elements;
      let moved = false;
      for (let i = 0; i < 16; i++) if (cam[i] !== seen[i]) moved = true;
      if (moved) {
        seen.set(cam);
        pace.hold(performance.now(), 300);
      }
      const busy = ctx.activities.busy() || ctx.view.covered() || ctx.view.filtering() || core.trip !== null || held;
      mode = always ? 'active' : (forced ?? pace.mode(performance.now(), { moving: player.moving || !player.grounded, busy, modal: modalOpen(), focused: document.hasFocus() }));
      const due = pace.due(ts, mode);
      if (due) drawn++;
      else skipped++;
      full = due && mode === 'active' && wasActive;
      if (due) wasActive = mode === 'active';
      return due;
    },
    get mode() {
      return mode;
    },
    hold: (ms) => pace.hold(performance.now(), ms),
    force: (m) => void (forced = m),
    get drawn() {
      return drawn;
    },
    get skipped() {
      return skipped;
    },
    get workMs() {
      return workSum / Math.min(60, Math.max(1, worked));
    },
    worked(ms) {
      workSum += ms - work[worked % 60];
      work[worked++ % 60] = ms;
    },
    get full() {
      return full;
    },
  };
}
