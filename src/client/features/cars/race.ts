import type { RaceResult } from './records';

// A race: five red lights come on a second apart at the line, stay on a random moment, and go out.
// Moving before they do is a jump start (a time penalty). Then it's timed laps of the scenic loop (see
// LapTimer), and the total, with any penalty, is the result. Pure: the clock and the car come in.

export const RACE_LAPS = 3;
export const LIGHTS = 5;
/** Seconds between one red light and the next. */
export const LIGHT_STEP = 1;
/** How long all five stay on before they go out (seconds, at random between). */
export const HOLD = { min: 0.6, max: 2.4 } as const;
/** Added to a jump-starter's total (seconds). */
export const JUMP_PENALTY = 5;
/** How fast (m/s), or how far (m) from where it was, a car may go before the lights are out without it being a jump start. */
export const JUMP_SPEED = 1.2;
export const JUMP_MOVE = 1.5;
/** How near the line (m along the street) a car must be to line up for a race. */
export const GRID_REACH = 30;

export type RacePhase = 'idle' | 'countdown' | 'racing' | 'done';

export type RaceEvent =
  | { t: 'light'; n: number }
  | { t: 'go' }
  | { t: 'jump' }
  | { t: 'lap'; n: number; time: number; best: boolean }
  | { t: 'finish'; result: RaceResult }
  | { t: 'abort' };

export interface CarAt {
  x: number;
  z: number;
  speed: number;
}

export class Race {
  phase: RacePhase = 'idle';
  /** Red lights on now (0 to LIGHTS). */
  lights = 0;
  /** The laps finished so far. */
  laps: number[] = [];
  penalty = 0;
  jumped = false;
  /** The race's last result, once it's done. */
  result: RaceResult | null = null;
  private since = 0;
  private hold = 0;
  private goAt = 0;
  private grid: CarAt | null = null;

  constructor(
    readonly total = RACE_LAPS,
    private rand: () => number = Math.random,
  ) {}

  get running(): boolean {
    return this.phase === 'countdown' || this.phase === 'racing';
  }

  /** Lines up at `car`, lights starting now. False if a race is already on. */
  start(now: number, car: CarAt): boolean {
    if (this.running) return false;
    this.phase = 'countdown';
    this.lights = 0;
    this.laps = [];
    this.penalty = 0;
    this.jumped = false;
    this.result = null;
    this.since = now;
    this.hold = HOLD.min + this.rand() * (HOLD.max - HOLD.min);
    this.grid = { x: car.x, z: car.z, speed: 0 };
    return true;
  }

  /** Calls the race off (the car's out, or you asked). */
  abort(): RaceEvent[] {
    if (!this.running) return [];
    this.phase = 'idle';
    this.lights = 0;
    return [{ t: 'abort' }];
  }

  /** Seconds into the race since the lights went out, once they have. */
  elapsed(now: number): number | null {
    return this.phase === 'racing' ? now - this.goAt : null;
  }

  /** Time passes: the lights come on and go out, and a car that creeps is a jump start. */
  update(now: number, car: CarAt): RaceEvent[] {
    if (this.phase !== 'countdown') return [];
    const events: RaceEvent[] = [];
    const t = now - this.since;
    const jumping = Math.abs(car.speed) > JUMP_SPEED || (this.grid !== null && Math.hypot(car.x - this.grid.x, car.z - this.grid.z) > JUMP_MOVE);
    if (jumping && !this.jumped) {
      this.jumped = true;
      this.penalty = JUMP_PENALTY;
      events.push({ t: 'jump' });
    }
    const on = Math.min(LIGHTS, Math.floor(t / LIGHT_STEP));
    while (this.lights < on) events.push({ t: 'light', n: ++this.lights });
    if (t >= LIGHTS * LIGHT_STEP + this.hold) {
      this.phase = 'racing';
      this.lights = 0;
      this.goAt = now;
      events.push({ t: 'go' });
    }
    return events;
  }

  /** A lap of `time` seconds is done (see LapTimer). Only counts once the lights are out. */
  lapDone(time: number, best: boolean): RaceEvent[] {
    if (this.phase !== 'racing') return [];
    this.laps.push(time);
    const events: RaceEvent[] = [{ t: 'lap', n: this.laps.length, time, best }];
    if (this.laps.length >= this.total) {
      this.phase = 'done';
      this.result = { at: Date.now(), laps: [...this.laps], penalty: this.penalty, total: this.laps.reduce((a, b) => a + b, 0) + this.penalty };
      events.push({ t: 'finish', result: this.result });
    }
    return events;
  }
}

/** Whether a car at (x, z) is lined up at the start: on the street, near the line (x = 0). */
export function atLine(x: number, z: number, street: { minZ: number; maxZ: number }): boolean {
  return Math.abs(x) <= GRID_REACH && z > street.minZ - 1 && z < street.maxZ + 1;
}
