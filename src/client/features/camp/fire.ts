// The campfire's behaviour, as pure numbers: how bright it flickers, how it flares when you stoke it,
// and where its embers are. The 3D side (world.ts) only draws what this says.

/** Three sines that don't line up make a flicker that doesn't look like a loop; 0.75-1.25 at `t` seconds. */
export function flicker(t: number, seed = 0): number {
  return 1 + 0.12 * Math.sin(t * 9.1 + seed) + 0.08 * Math.sin(t * 15.7 + seed * 2.3) + 0.05 * Math.sin(t * 3.3 + seed * 0.7);
}

/** How long a stoked fire takes to settle back down (s). */
export const FLARE_SECONDS = 4;

/** A fire's state: `flare` is 1 the moment it's stoked and dies away to 0. */
export class Fire {
  flare = 0;

  stoke() {
    this.flare = 1;
  }

  update(dt: number) {
    this.flare = Math.max(0, this.flare - dt / FLARE_SECONDS);
  }

  /** How tall the flames stand against a calm fire: 1 normally, up to 1.7 just after stoking. */
  get height(): number {
    return 1 + 0.7 * this.flare * this.flare;
  }

  /** How bright the firelight is, 0-1+ (see flicker). */
  glow(t: number): number {
    return flicker(t) * (1 + 0.6 * this.flare);
  }
}

/** Embers rising off the fire: flat arrays (x, y, z, speed, age, life) per ember, so the whole swarm is a handful of numbers. */
export class Embers {
  readonly count: number;
  readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;

  constructor(
    count: number,
    private rand: () => number,
  ) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.spawn(i);
      this.age[i] = this.rand() * this.life[i];
      this.pos[i * 3] += this.vel[i * 3] * this.age[i];
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * this.age[i];
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * this.age[i];
    }
  }

  private spawn(i: number) {
    const a = this.rand() * Math.PI * 2;
    const r = this.rand() * 0.35;
    this.pos.set([Math.cos(a) * r, 0.3 + this.rand() * 0.3, Math.sin(a) * r], i * 3);
    this.vel.set([(this.rand() - 0.5) * 0.4, 0.5 + this.rand() * 0.9, (this.rand() - 0.5) * 0.4], i * 3);
    this.age[i] = 0;
    this.life[i] = 1.6 + this.rand() * 2.2;
  }

  /** Moves them on `dt` seconds; a stoked fire (`flare` 0-1) throws them up harder. Anything past its life starts over at the fire. */
  update(dt: number, flare = 0) {
    const lift = 1 + flare * 1.4;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] > this.life[i]) {
        this.spawn(i);
        continue;
      }
      this.pos[i * 3] += this.vel[i * 3] * dt + Math.sin(this.age[i] * 5 + i) * 0.004;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt * lift;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
  }

  /** How far through its life ember `i` is, 0 (new) to 1 (gone out). */
  fade(i: number): number {
    return this.age[i] / this.life[i];
  }
}
