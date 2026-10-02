import { CAMP, LAKE, LOOP_PAVED, STREET_Z } from './scenic.js';

// The ground isn't quite flat: a few speed humps on the quiet stretches of road either side of town, and
// rough ground off the road (moguls in the meadow inside the loop, a washboard farm lane, mounds round the
// campsite). It's all one pure function of (x, z), so every page works out the same height and nothing
// about it is sent anywhere: a car's wheels sample it (see features/cars/suspension.ts), a walking person
// stands on it, and world/scenic/bumps.ts draws it. The height is meters over the flat ground, never below it.

/** The tallest anything here comes up. */
export const BUMP_MAX = 0.45;

/** A speed hump across the road: the middle (x, z), how far it reaches either side along the road, how wide it is across, and how high. */
export interface Hump {
  x: number;
  z: number;
  /** Half its length along the road (m). */
  half: number;
  /** Half its width across the road (m): the asphalt and the gravel shoulders. */
  across: number;
  height: number;
}

const hump = (x: number): Hump => ({ x, z: STREET_Z, half: 1.9, across: LOOP_PAVED + 0.3, height: 0.13 });
/** Two humps either side of town, out on the straight where the loop leaves the street: slow down for the farm, and for the coast. */
export const HUMPS: readonly Hump[] = [hump(122), hump(131), hump(-122), hump(-131)];

/** A patch of rough ground off the road. */
export interface Rough {
  name: string;
  x: number;
  z: number;
  /** Half its size either way (m); it eases out to nothing at its edge. */
  rx: number;
  rz: number;
  kind: 'moguls' | 'washboard';
  /** The tallest a mound or ridge gets (m). */
  amp: number;
  /** Kept flat this close to (cx, cz): the campsite's tents and logs. */
  spare?: { x: number; z: number; r: number };
}

/** The meadow inside the loop, a lane by the farm, and the ground round the campsite. */
export const ROUGH: readonly Rough[] = [
  { name: 'meadow', x: 20, z: 190, rx: 60, rz: 45, kind: 'moguls', amp: 0.4 },
  { name: 'farm lane', x: 95, z: 122, rx: 45, rz: 6.5, kind: 'washboard', amp: 0.12 },
  { name: 'campsite', x: -2, z: 300, rx: 34, rz: 28, kind: 'moguls', amp: 0.3, spare: { x: CAMP.x, z: CAMP.z, r: 14 } },
];

/** Moguls are a mound or so to every square of this many meters. */
export const MOGUL_CELL = 7;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A number between 0 and 1 from three integers, the same everywhere (an integer hash). */
function hash(i: number, j: number, k: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How much of the patch is felt at (x, z): 1 well inside it, easing to 0 at its edge. */
function fade(r: Rough, x: number, z: number): number {
  const u = Math.hypot((x - r.x) / r.rx, (z - r.z) / r.rz);
  if (u >= 1) return 0;
  let f = 1 - smooth(0.55, 1, u);
  // Never into the lake, which lies flat.
  f *= smooth(1, 1.3, Math.hypot((x - LAKE.x) / (LAKE.rx + 3), (z - LAKE.z) / (LAKE.rz + 3)));
  if (r.spare) f *= smooth(r.spare.r, r.spare.r + 5, Math.hypot(x - r.spare.x, z - r.spare.z));
  return f;
}

function rough(r: Rough, seed: number, x: number, z: number): number {
  const f = fade(r, x, z);
  if (f <= 0) return 0;
  if (r.kind === 'washboard') {
    // Ripples across the lane, one every 6 meters.
    const ripple = 0.5 + 0.5 * Math.sin((x / 6) * Math.PI * 2 + z * 0.15);
    return r.amp * f * ripple;
  }
  const ci = Math.floor(x / MOGUL_CELL);
  const cj = Math.floor(z / MOGUL_CELL);
  let h = 0;
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - 1; j <= cj + 1; j++) {
      if (hash(i, j, seed) > 0.72) continue;
      const mx = (i + 0.2 + 0.6 * hash(i, j, seed + 1)) * MOGUL_CELL;
      const mz = (j + 0.2 + 0.6 * hash(i, j, seed + 2)) * MOGUL_CELL;
      const radius = 2.2 + 1.6 * hash(i, j, seed + 3);
      const t = 1 - ((x - mx) ** 2 + (z - mz) ** 2) / (radius * radius);
      if (t > 0) h = Math.max(h, r.amp * (0.45 + 0.55 * hash(i, j, seed + 4)) * t * t);
    }
  }
  return h * f;
}

/** How high the speed hump `h` is at (x, z): a cosine across its length, the same all the way across the road but for a short fall at its ends. */
function humped(h: Hump, x: number, z: number): number {
  const along = Math.abs(x - h.x);
  const across = Math.abs(z - h.z);
  if (along >= h.half || across >= h.across + 0.6) return 0;
  return h.height * (0.5 + 0.5 * Math.cos((along / h.half) * Math.PI)) * (1 - smooth(h.across, h.across + 0.6, across));
}

/** How high the ground is over the flat at (x, z) (m, 0 or more): the speed humps and the rough patches. */
export function bumpHeight(x: number, z: number): number {
  let h = 0;
  // The humps lie along the road, a thin strip; the rough patches are far out in the countryside.
  if (Math.abs(z - STREET_Z) < 8) {
    for (const hp of HUMPS) h = Math.max(h, humped(hp, x, z));
    return h;
  }
  for (let i = 0; i < ROUGH.length; i++) {
    const r = ROUGH[i];
    if (Math.abs(x - r.x) < r.rx && Math.abs(z - r.z) < r.rz) h = Math.max(h, rough(r, 17 + i * 31, x, z));
  }
  return h;
}
