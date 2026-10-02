import type { CarKind } from '../../../shared/garage';

// A car's suspension, as numbers only (nothing here knows about three.js): a spring and a damper at
// each of the four wheels, holding up a body that can heave (rise and fall), pitch (nose up and down)
// and roll (lean). The wheels follow the ground; the body follows the wheels through the springs, and
// is pushed on by how the car is accelerating, braking and cornering. A stiff set-up barely moves
// (the supercars); a loose one wallows, overshoots and keeps rocking after a bump (the 4x4).
// features/cars/ride.ts hangs this on a car's model.

/** Where the wheels are, in the car's frame: the axles (z, + toward the nose) and half the track (x, + to the left). */
export interface Stance {
  front: number;
  rear: number;
  half: number;
}

export interface SuspensionSpec {
  stance: Stance;
  /** How fast the body bobs up and down on its springs (Hz), and how well that's damped (1 would not overshoot at all). */
  freq: number;
  damping: number;
  /** How far round the body's weight is spread from its middle, front to back and side to side (m): the more, the lazier it pitches and rolls. */
  pitchRadius: number;
  rollRadius: number;
  /** How hard acceleration tips the body: height of the weight over the axis it turns about (m), for pitch and for roll. */
  pitchArm: number;
  rollArm: number;
  /** How far a corner of the body can sit above or below its wheel before it hits the stops (m). */
  travel: number;
  /** The most the body pitches, rolls and rises or sinks (radians, radians, m). */
  maxPitch: number;
  maxRoll: number;
  maxHeave: number;
}

/** The supercars: low, wide and stiff. */
const STIFF: SuspensionSpec = {
  stance: { front: 1.42, rear: -1.42, half: 0.79 },
  freq: 3,
  damping: 0.55,
  pitchRadius: 1.2,
  rollRadius: 0.7,
  pitchArm: 0.9,
  rollArm: 0.47,
  travel: 0.09,
  maxPitch: 0.06,
  maxRoll: 0.08,
  maxHeave: 0.08,
};

/** The 4x4: long travel, soft springs, little damping, and the weight up high. */
const LOOSE: SuspensionSpec = {
  stance: { front: 1.4, rear: -1.4, half: 0.88 },
  freq: 1.25,
  damping: 0.16,
  pitchRadius: 1.2,
  rollRadius: 0.7,
  pitchArm: 0.8,
  rollArm: 0.5,
  travel: 0.36,
  maxPitch: 0.15,
  maxRoll: 0.22,
  maxHeave: 0.3,
};

/** How each kind of car rides. */
export function suspensionOf(kind: CarKind): SuspensionSpec {
  return kind === 'offroad' ? LOOSE : STIFF;
}

/** The step the springs are worked out in (s): short enough for the stiffest. */
const SUBSTEP = 1 / 180;
/** The longest a frame is believed to be (s). */
const LONGEST = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The wheels: front left, front right, rear left, rear right, as (x, z) in the car's frame. Where
 * x is positive is the car's left, and z the nose.
 */
export function corners(s: Stance): readonly { x: number; z: number }[] {
  return [
    { x: s.half, z: s.front },
    { x: -s.half, z: s.front },
    { x: s.half, z: s.rear },
    { x: -s.half, z: s.rear },
  ];
}

/**
 * One car's body on its springs. `pitch` is positive with the nose down, `roll` positive with the left
 * side up (a left turn leans it right, its left side rising), as three.js turns a group about x and z;
 * `heave` is how high the body sits over where it would at rest, on flat ground.
 */
export class Suspension {
  heave = 0;
  pitch = 0;
  roll = 0;
  private vHeave = 0;
  private vPitch = 0;
  private vRoll = 0;
  readonly at: readonly { x: number; z: number }[];
  /** The ground under each wheel as of the last step, and the body's height over each wheel's spot (so how far the wheel is pushed up into it). */
  readonly ground = [0, 0, 0, 0];
  private before = [0, 0, 0, 0];
  private started = false;

  constructor(readonly spec: SuspensionSpec) {
    this.at = corners(spec.stance);
  }

  /** The body's height over (x, z) of the car's frame, on the springs as they are now. */
  heightAt(x: number, z: number): number {
    return this.heave - z * this.pitch + x * this.roll;
  }

  /** How far wheel `i` is pushed up into the body (+) or hangs below it (-): how the wheel is drawn against the body. */
  push(i: number): number {
    const c = this.at[i];
    return clamp(this.ground[i] - this.heightAt(c.x, c.z), -this.spec.travel, this.spec.travel);
  }

  /** Back to rest (a car that jumped somewhere else). */
  reset() {
    this.heave = this.pitch = this.roll = this.vHeave = this.vPitch = this.vRoll = 0;
    this.started = false;
  }

  /**
   * `dt` seconds on, with `ground` the height under each wheel (see corners), `aLong` the car's acceleration
   * along its nose (m/s², + forward) and `aLat` across it (+ toward its left: what a left turn gives).
   */
  step(dt: number, ground: ArrayLike<number>, aLong: number, aLat: number) {
    dt = Math.min(dt, LONGEST);
    if (!(dt > 0)) return;
    if (!this.started) {
      for (let i = 0; i < 4; i++) this.before[i] = ground[i];
      this.started = true;
    }
    const sp = this.spec;
    const w = 2 * Math.PI * sp.freq;
    // Each corner takes a quarter of the weight, so the four together make the body's `freq`.
    const k = (w * w) / 4;
    const c = (2 * sp.damping * w) / 4;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    const ry2 = sp.pitchRadius * sp.pitchRadius;
    const rx2 = sp.rollRadius * sp.rollRadius;
    for (let s = 0; s < n; s++) {
      let up = 0;
      let nose = 0;
      let left = 0;
      for (let i = 0; i < 4; i++) {
        const p = this.at[i];
        // The wheel's height this substep, and how fast it's rising.
        const g = this.before[i] + ((ground[i] - this.before[i]) * (s + 1)) / n;
        const gPrev = this.before[i] + ((ground[i] - this.before[i]) * s) / n;
        const gv = (g - gPrev) / h;
        const stretch = this.heightAt(p.x, p.z) - g;
        const rate = this.vHeave - p.z * this.vPitch + p.x * this.vRoll - gv;
        let f = -k * stretch - c * rate;
        // The bump stops: hard against either end of the travel.
        if (stretch > sp.travel) f -= 12 * k * (stretch - sp.travel);
        else if (stretch < -sp.travel) f -= 12 * k * (stretch + sp.travel);
        up += f;
        nose += f * p.z;
        left += f * p.x;
      }
      this.vHeave += up * h;
      this.vPitch += ((-nose - aLong * sp.pitchArm) / ry2) * h;
      this.vRoll += ((left + aLat * sp.rollArm) / rx2) * h;
      this.heave += this.vHeave * h;
      this.pitch += this.vPitch * h;
      this.roll += this.vRoll * h;
      // Never further than the body can go.
      if (Math.abs(this.heave) > sp.maxHeave) {
        this.heave = Math.sign(this.heave) * sp.maxHeave;
        if (this.vHeave * this.heave > 0) this.vHeave *= -0.2;
      }
      if (Math.abs(this.pitch) > sp.maxPitch) {
        this.pitch = Math.sign(this.pitch) * sp.maxPitch;
        if (this.vPitch * this.pitch > 0) this.vPitch *= -0.2;
      }
      if (Math.abs(this.roll) > sp.maxRoll) {
        this.roll = Math.sign(this.roll) * sp.maxRoll;
        if (this.vRoll * this.roll > 0) this.vRoll *= -0.2;
      }
    }
    for (let i = 0; i < 4; i++) {
      this.before[i] = ground[i];
      this.ground[i] = ground[i];
    }
  }
}
