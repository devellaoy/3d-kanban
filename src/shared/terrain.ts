import { LAKE, PIER, shoreX } from './scenic.js';

// Where a car can't go besides what stands in the way: the sea, the lake and the edge of the world.
// None of them is a wall. Each is a soft zone that gets heavier the further in you are (a car wades,
// slows to a crawl, and is pushed back out), and only well inside it, where a car would be floating
// off the ground, is it somewhere you can't be. One pure rule, which the driver's page and the
// office (src/server/garage.ts) both ask, so they agree on it.

/** The edge of the lawn, every way but west (the sea is there): the grass goes out to 900, past what can be seen through the haze. */
export const WORLD = { minX: -1000, maxX: 880, minZ: -880, maxZ: 880 } as const;
/** How wide the soft zone at the edge of the world is (m), inside WORLD. */
export const EDGE = 80;
/** How deep (m) the water's soft zone is, from the waterline to where a car can't be any more. */
export const WADE = 8;
/** `depth` at which a car can't be: a quarter more than the soft zone's width. */
export const LIMIT = 1.25;

/** A soft zone at (x, z): how far in (0 at its edge, 1 at the far side of its soft zone, LIMIT where a car can't be), and the way out (unit). */
export interface Hazard {
  depth: number;
  nx: number;
  nz: number;
  kind: 'water' | 'edge';
}

/** The pier is a deck over the sea, which cars can drive out along. */
function onPier(x: number, z: number): boolean {
  const s = shoreX(PIER.z);
  return Math.abs(z - PIER.z) <= PIER.width / 2 + 0.3 && x >= s - PIER.length - 0.5 && x <= s + 8;
}

/** The soft zone (x, z) is in, the deepest of them; null on dry land inside the edge. */
export function hazardAt(x: number, z: number): Hazard | null {
  // Allocation-free (it is asked several times per car step): the deepest zone so far lives in locals.
  // Of equal depths the first wins, in the order sea, lake, west, east... as it always did.
  let depth = 0;
  let nx = 0;
  let nz = 0;
  let kind: Hazard['kind'] = 'water';
  // The sea, west of the beach: x below the shore, which the foam line draws.
  if (!onPier(x, z)) {
    const d = (shoreX(z) + 0.5 - x) / WADE;
    if (d > depth) {
      depth = d;
      nx = 1;
    }
  }
  // The lake: an ellipse; its way out is its outward normal.
  const ex = (x - LAKE.x) / LAKE.rx;
  const ez = (z - LAKE.z) / LAKE.rz;
  const e = Math.hypot(ex, ez);
  if (e < 1.04) {
    const d = ((1.04 - e) * Math.min(LAKE.rx, LAKE.rz) * 0.9) / WADE;
    if (d > depth) {
      const gx = ex / LAKE.rx;
      const gz = ez / LAKE.rz;
      const g = Math.hypot(gx, gz) || 1;
      depth = d;
      nx = gx / g;
      nz = gz / g;
      kind = 'water';
    }
  }
  // The edge of the world: the last EDGE meters.
  let d = (x - (WORLD.maxX - EDGE)) / EDGE;
  if (d > depth) {
    depth = d;
    nx = -1;
    nz = 0;
    kind = 'edge';
  }
  d = (WORLD.minX + EDGE - x) / EDGE;
  if (d > depth) {
    depth = d;
    nx = 1;
    nz = 0;
    kind = 'edge';
  }
  d = (z - (WORLD.maxZ - EDGE)) / EDGE;
  if (d > depth) {
    depth = d;
    nx = 0;
    nz = -1;
    kind = 'edge';
  }
  d = (WORLD.minZ + EDGE - z) / EDGE;
  if (d > depth) {
    depth = d;
    nx = 0;
    nz = 1;
    kind = 'edge';
  }
  return depth > 0 ? { depth, nx, nz, kind } : null;
}

/** Whether a car's point can be at (x, z) as far as the sea, the lake and the edge of the world go. */
export function terrainOk(x: number, z: number): boolean {
  // Far past the edge of the world: no need to look at the water.
  if (x > WORLD.maxX - EDGE + EDGE * LIMIT || x < WORLD.minX + EDGE - EDGE * LIMIT || z > WORLD.maxZ - EDGE + EDGE * LIMIT || z < WORLD.minZ + EDGE - EDGE * LIMIT) return false;
  return (hazardAt(x, z)?.depth ?? 0) < LIMIT;
}
