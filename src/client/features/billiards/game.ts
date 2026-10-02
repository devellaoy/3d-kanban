/**
 * The billiards game on top of the simulation (sim.ts): whose turn it is, what's been potted, the shots
 * taken, and the cue ball in hand after a scratch. No eight-ball rules: practice is you alone, and "two
 * players" is hot-seat, where you keep the table while you pot something and hand it over when you don't.
 * Pure (no three.js, no clock), so the state is a plain value that could be shared between browsers later.
 */
import { HALF_L, HALF_W, HEAD_SPOT, R, STEP, blocked, rack, settled, step, strike, type Ball, type SimEvent } from './sim';

export type Mode = 'practice' | 'hotseat';

/** `aim`: the cue ball is down and it's someone's shot. `rolling`: the balls are moving. `inhand`: the cue ball is to be put down first. */
export type Phase = 'aim' | 'rolling' | 'inhand';

/** What a shot did, once the balls stopped. */
export interface Outcome {
  /** The object balls that went down (not the cue ball), in order. */
  potted: number[];
  scratch: boolean;
  /** The table is bare: the next rack is up. */
  cleared: boolean;
}

/** Never simulate more than this many steps for one frame, so a long stall doesn't freeze the page catching up. */
const MAX_STEPS = 240;
/** The cue ball in hand can go anywhere behind this line (the head string), as in a break. */
export const KITCHEN = HEAD_SPOT.x;

/** What can draw the cue back: Space or the left mouse button. */
export type ChargeInput = 'space' | 'mouse';

/** Whether releasing `released` ends a charge begun by `by`: only its own input does (or losing focus, `abort`). */
export function endsCharge(by: ChargeInput, released: ChargeInput, abort: boolean): boolean {
  return abort || by === released;
}

export class Billiards {
  balls: Ball[] = rack();
  phase: Phase = 'aim';
  mode: Mode = 'practice';
  /** Whose turn: 0 or 1 (always 0 in practice). */
  turn: 0 | 1 = 0;
  /** Shots taken since the rack, and the balls each player has potted since then. */
  shots = 0;
  score: [number, number] = [0, 0];
  /** Every object ball potted since the rack, in order. */
  potted: number[] = [];
  /** The last shot's result, until the next one. */
  last: Outcome | null = null;
  /** How many shots the last cleared rack took (the best of those is kept by the page). */
  clearedIn: number | null = null;
  private acc = 0;
  /** The object balls on the table when the shot was taken. */
  private inPlay: number[] = [];

  get cue(): Ball {
    return this.balls[0];
  }

  /** A new rack: shots and scores back to nothing, the first player's break. */
  reset(): void {
    this.balls = rack();
    this.phase = 'aim';
    this.turn = 0;
    this.shots = 0;
    this.score = [0, 0];
    this.potted = [];
    this.last = null;
    this.clearedIn = null;
    this.acc = 0;
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset();
  }

  /** Takes the shot: the cue ball goes at `angle` with `power` 0–1. False when it isn't time to shoot. */
  shoot(angle: number, power: number): boolean {
    if (this.phase !== 'aim' || power <= 0) return false;
    strike(this.balls, angle, power);
    this.phase = 'rolling';
    this.shots++;
    this.inPlay = this.balls.filter((b) => b.id !== 0 && !b.potted).map((b) => b.id);
    this.last = null;
    this.clearedIn = null;
    this.acc = 0;
    return true;
  }

  /**
   * Moves the simulation on by `dt` seconds, in whole STEPs, and returns what happened. When the balls
   * stop, the shot is settled (see Outcome) and the turn passes.
   */
  update(dt: number): SimEvent[] {
    if (this.phase !== 'rolling') return [];
    this.acc = Math.min(this.acc + dt, MAX_STEPS * STEP);
    const out: SimEvent[] = [];
    while (this.acc >= STEP && this.phase === 'rolling') {
      this.acc -= STEP;
      step(this.balls, out);
      if (settled(this.balls)) this.settle();
    }
    return out;
  }

  private settle(): void {
    const potted = this.balls.filter((b) => b.potted && b.id !== 0 && this.inPlay.includes(b.id)).map((b) => b.id);
    const scratch = this.cue.potted;
    this.potted.push(...potted);
    this.score[this.turn] += potted.length;
    const cleared = this.balls.every((b) => b.id === 0 || b.potted);
    this.last = { potted, scratch, cleared };
    if (cleared) this.clearedIn = this.shots;
    // A hot-seat player keeps the table after potting something (and not scratching), else it changes hands.
    if (this.mode === 'hotseat' && (scratch || potted.length === 0)) this.turn = this.turn === 0 ? 1 : 0;
    this.phase = scratch ? 'inhand' : 'aim';
    if (scratch) {
      this.cue.x = HEAD_SPOT.x;
      this.cue.y = HEAD_SPOT.y;
      this.cue.potted = false;
      // The head spot's taken by a ball sitting on it: a free place along the head string, nearest first.
      for (let k = 1; blocked(this.balls, this.cue.x, this.cue.y, 0) && k < 40; k++) {
        this.cue.y = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * R * 1.5;
      }
    }
    if (cleared) this.rerack();
  }

  /** The table was cleared: a fresh rack (the cue ball back on the head spot), and the turn as it is. */
  private rerack(): void {
    const fresh = rack();
    this.balls = fresh;
    this.potted = [];
    // clearedIn has the count of the rack that was cleared; the new rack's shots and score start from nothing.
    this.shots = 0;
    this.score = [0, 0];
    this.phase = 'aim';
  }

  /**
   * Slides the cue ball in hand by (dx, dy), staying behind the head string and off the other balls.
   * Returns whether it moved.
   */
  nudgeCue(dx: number, dy: number): boolean {
    if (this.phase !== 'inhand') return false;
    const x = Math.min(KITCHEN, Math.max(-HALF_L + R, this.cue.x + dx));
    const y = Math.min(HALF_W - R, Math.max(-HALF_W + R, this.cue.y + dy));
    if (blocked(this.balls, x, y, 0)) return false;
    this.cue.x = x;
    this.cue.y = y;
    return true;
  }

  /** Puts the cue ball down where it is, and the shot is on. False when it isn't in hand or sits on another ball. */
  placeCue(): boolean {
    if (this.phase !== 'inhand' || blocked(this.balls, this.cue.x, this.cue.y, 0)) return false;
    this.phase = 'aim';
    return true;
  }

  /** The line the hint bar and the panel show: whose turn it is. */
  get player(): string {
    return this.mode === 'practice' ? 'Practice' : `Player ${this.turn + 1}`;
  }
}
