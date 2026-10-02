import { meter } from '../../../shared/hoop';
import { STRIKE_WINDOW, biteDelay, castDistance, judgeStrike, nibbleCount, reachOf, rollSize, rollSpecies, type Catch, type Species, type Water } from './catch';
import type { Landing } from './spots';

// You, with a rod: the steps from winding up a cast to a fish in your hands, as a state machine that
// is told the time (so it is testable, and no frame rate matters). The scene only draws it.

/**
 * - ready: line in, rod in hand: hold E to wind up
 * - wind: the meter goes up and down (hold E, let go to cast)
 * - cast: the bobber's in the air
 * - wait: it floats; fish come and nibble
 * - bite: it goes under: strike now!
 * - reel: you hooked it, and it's coming in
 */
export type Stage = 'ready' | 'wind' | 'cast' | 'wait' | 'bite' | 'reel';

/** What happens as time passes. */
export type AnglerEvent = 'landed' | 'nibble' | 'bite' | 'missed' | 'landedIn';

/** How a strike came out. */
export type StrikeResult = 'spooked' | 'late' | 'hooked' | 'nothing';

/** How long a hooked fish takes to come in (seconds). */
export const REEL_TIME = 1.1;

/** How long the bobber is in the air: a longer cast takes longer. */
export const flightTime = (distance: number): number => 0.35 + distance * 0.032;

export class Angler {
  stage: Stage = 'ready';
  /** When the stage began (seconds, as `update` and the others are given). */
  since = 0;
  /** Where the bobber came down. */
  landed: Landing | null = null;
  /** What it will be, when the fish bites (junk, too). */
  plan: Species | null = null;
  /** What you caught, once hooked (shown until the next cast). */
  caught: Catch | null = null;
  /** When it bites, and how good your strike was (0–1) once hooked. */
  biteAt = 0;
  quality = 0;
  /** Nibbles still to come (times). */
  private nibbles: number[] = [];
  private water: Water = 'lake';
  private windAt = 0;
  private flight = 0;

  constructor(private readonly rng: () => number = Math.random) {}

  /** The meter (0–1) `now`, while winding up. */
  power(now: number): number {
    return this.stage === 'wind' ? meter(now - this.windAt) : 0;
  }

  /** Where the bobber flies, 0–1 (see flightTime). */
  flown(now: number): number {
    return this.stage === 'cast' ? Math.min(1, (now - this.since) / this.flight) : this.stage === 'ready' || this.stage === 'wind' ? 0 : 1;
  }

  /** Seconds since the bite began (negative before it), for the bobber's dip. */
  sinceBite(now: number): number {
    return now - this.biteAt;
  }

  /** E pressed with the line in: the meter starts. */
  windUp(now: number): boolean {
    if (this.stage !== 'ready') return false;
    this.stage = 'wind';
    this.windAt = now;
    this.since = now;
    this.caught = null;
    return true;
  }

  /** Dropped the wind-up without casting (a window opened, the page lost focus). */
  cancelWind(): void {
    if (this.stage === 'wind') this.stage = 'ready';
  }

  /**
   * E let go: the bobber flies as far as the meter says, to `land(distance)` (null: there's no water
   * there, so nothing's cast). Returns how far it goes, or null when it didn't.
   */
  release(now: number, water: Water, land: (distance: number) => Landing | null): number | null {
    if (this.stage !== 'wind') return null;
    const wanted = castDistance(meter(now - this.windAt));
    const at = land(wanted);
    if (!at) {
      this.stage = 'ready';
      return null;
    }
    this.water = water;
    this.landed = at;
    this.plan = rollSpecies(this.rng, water, reachOf(at.distance));
    this.flight = flightTime(at.distance);
    this.stage = 'cast';
    this.since = now;
    return at.distance;
  }

  /** Time passes: what happened in it. */
  update(now: number): AnglerEvent[] {
    const out: AnglerEvent[] = [];
    if (this.stage === 'cast' && now - this.since >= this.flight) {
      this.stage = 'wait';
      this.since = now;
      const delay = biteDelay(this.rng);
      this.biteAt = now + delay;
      const n = nibbleCount(this.rng);
      this.nibbles = Array.from({ length: n }, (_, i) => now + delay * (0.3 + (0.55 * (i + this.rng() * 0.6)) / Math.max(1, n))).sort((a, b) => a - b);
      out.push('landed');
    }
    if (this.stage === 'wait') {
      while (this.nibbles.length && now >= this.nibbles[0]) {
        this.nibbles.shift();
        // A nibble right on top of the bite is the bite.
        if (now < this.biteAt - 0.25) out.push('nibble');
      }
      if (now >= this.biteAt) {
        this.stage = 'bite';
        this.since = now;
        out.push('bite');
      }
    } else if (this.stage === 'bite' && now - this.biteAt > STRIKE_WINDOW) {
      this.stage = 'ready';
      this.since = now;
      this.plan = null;
      out.push('missed');
    } else if (this.stage === 'reel' && now - this.since >= REEL_TIME) {
      this.stage = 'ready';
      this.since = now;
      out.push('landedIn');
    }
    return out;
  }

  /** E pressed with the bobber out: strike. */
  strike(now: number): StrikeResult {
    if (this.stage === 'wait') {
      this.stage = 'ready';
      this.since = now;
      this.plan = null;
      return 'spooked';
    }
    if (this.stage !== 'bite') return 'nothing';
    const s = judgeStrike(this.sinceBite(now));
    if (s.result !== 'hooked') {
      this.stage = 'ready';
      this.since = now;
      this.plan = null;
      return 'late';
    }
    this.quality = s.quality;
    this.caught = rollSize(this.rng, this.plan!, s.quality);
    this.stage = 'reel';
    this.since = now;
    return 'hooked';
  }

  /** Reel in empty (Q, or stepping away): the line comes in and you start over. */
  reelIn(now: number): void {
    if (this.stage === 'reel') return;
    this.stage = 'ready';
    this.since = now;
    this.plan = null;
  }
}
