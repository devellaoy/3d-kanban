import { LAKE, PIER, shoreX } from '../../../shared/scenic';
import type { Water } from './catch';

// Where you can fish: the end of the beach pier and the end of the lake's little dock, both down on the
// scenic loop (shared/scenic.ts). All of it is relative to the street (y = 0 is the street, which drops
// as floors stack: see streetBelow), and it's pure, so a cast can be worked out without a scene.

export interface Spot {
  id: string;
  water: Water;
  /** What the hint calls it. */
  name: string;
  /** Where you stand to fish, and which way the water is (a heading: the direction is sin, cos). */
  x: number;
  z: number;
  heading: number;
  /** The planks you stand on and the water's surface, above the street (m). */
  deck: number;
  surface: number;
  /** The signpost you use to start: beside where you stand. */
  post: { x: number; z: number; rotY: number };
}

/** The lake's dock, as world/scenic/water.ts builds it (it isn't exported from there): 2.4 m wide, 9 m long, off the north shore. */
const DOCK = { x: LAKE.x - 6, z: LAKE.z - LAKE.rz - 1, width: 2.4, from: -1, to: 8 } as const;
/** The dock's end, where the planks stop. */
const DOCK_END = DOCK.z + DOCK.to;
/** The red rowing boat tied up beside it. */
const BOAT = { minX: DOCK.x + 2.0, maxX: DOCK.x + 3.2, minZ: DOCK.z + 5.1, maxZ: DOCK.z + 7.9 };
/** Where the beach pier stops (x), and where it starts. */
const pierEnd = () => shoreX(PIER.z) - PIER.length;
const pierStart = () => shoreX(PIER.z) + 8;

export const SPOTS: readonly Spot[] = [
  {
    id: 'lake',
    water: 'lake',
    name: 'Lake dock',
    x: DOCK.x,
    z: DOCK_END - 0.7,
    heading: 0,
    deck: 0.35,
    surface: -0.018,
    post: { x: DOCK.x + 0.8, z: DOCK_END - 1.6, rotY: -Math.PI / 2 },
  },
  {
    id: 'sea',
    water: 'sea',
    name: 'Beach pier',
    x: pierEnd() + 1.2,
    z: PIER.z,
    heading: -Math.PI / 2,
    deck: 0.28,
    surface: -0.15,
    post: { x: pierEnd() + 2.2, z: PIER.z + 1.5, rotY: Math.PI },
  },
];

/** Whether the point is open water of `water`, clear of the planks and the boat (the bobber won't land on those). */
export function isWater(water: Water, x: number, z: number): boolean {
  if (water === 'sea') {
    if (x > shoreX(z) - 1.5) return false;
    return !(x > pierEnd() - 0.6 && x < pierStart() && Math.abs(z - PIER.z) < PIER.width / 2 + 0.6);
  }
  const k = ((x - LAKE.x) / (LAKE.rx - 1.2)) ** 2 + ((z - LAKE.z) / (LAKE.rz - 1.2)) ** 2;
  if (k >= 1) return false;
  if (Math.abs(x - DOCK.x) < DOCK.width / 2 + 0.5 && z < DOCK_END + 0.6) return false;
  return !(x > BOAT.minX - 0.5 && x < BOAT.maxX + 0.5 && z > BOAT.minZ - 0.5 && z < BOAT.maxZ + 0.5);
}

export interface Landing {
  x: number;
  z: number;
  /** How far from where it was cast from (m). */
  distance: number;
}

/**
 * Where a cast of `distance` from (x, z) towards `heading` comes down: that far if it's water there,
 * else as far as there is (it comes in a step at a time from the throw), or null when there's none
 * within a few meters.
 */
export function landing(water: Water, x: number, z: number, heading: number, distance: number): Landing | null {
  const dx = Math.sin(heading);
  const dz = Math.cos(heading);
  for (let d = distance; d >= 2.5; d -= 0.5) {
    const px = x + dx * d;
    const pz = z + dz * d;
    if (isWater(water, px, pz)) return { x: px, z: pz, distance: d };
  }
  return null;
}

/** The nearest spot to (x, z) within `radius`, if any. */
export function spotNear(x: number, z: number, radius: number): Spot | undefined {
  let best: Spot | undefined;
  let bestD = radius;
  for (const s of SPOTS) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** `heading` held to within `limit` radians of `around` (so a cast cannot go back at the pier). */
export function clampHeading(heading: number, around: number, limit: number): number {
  const diff = Math.atan2(Math.sin(heading - around), Math.cos(heading - around));
  return around + Math.max(-limit, Math.min(limit, diff));
}
