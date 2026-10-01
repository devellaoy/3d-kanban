import type { Collider } from '../world/types';

// The third-person camera is part of your body: a spring arm from your head out to where the camera
// wants to be, pulled in short of anything solid on the way (walls, the glass room, a storey's floor
// or ceiling, a tall cupboard), so it never ends up inside one. Pure geometry, no scene needed.

/** How far from a wall the camera stops, so its near plane doesn't clip into it. */
export const ARM_RADIUS = 0.22;
/** The camera never comes closer to your head than this. */
export const ARM_MIN = 0.45;
/** Only what stands this far above your feet blocks the arm: curbs, stairs, tables and sofas don't. */
export const ARM_CLEARANCE = 1.0;
/** Closer to your head than this, your body is hidden so the camera never shows its inside (see core/loop.ts). */
export const HIDE_BODY_WITHIN = 1.5;

interface Point {
  x: number;
  y: number;
  z: number;
}

const span = { in: 0, out: 1 };

/** Narrows `span` to where the ray (origin `o`, step `d`) is between `lo` and `hi` on one axis; false if it never is. */
function clip(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
  const a = (lo - o) / d;
  const b = (hi - o) / d;
  span.in = Math.max(span.in, Math.min(a, b));
  span.out = Math.min(span.out, Math.max(a, b));
  return span.in <= span.out;
}

/**
 * How far along `from` -> `to` (0..1) the camera can go before it meets a collider, kept `radius` short
 * of it and at least `min` meters from `from`. Colliders whose top is within `clearance` of `feet`, fences,
 * and ones `from` is already inside don't count. 1 when nothing is in the way.
 */
export function armFraction(
  from: Point,
  to: Point,
  colliders: readonly Collider[],
  feet: number,
  radius = ARM_RADIUS,
  min = ARM_MIN,
  clearance = ARM_CLEARANCE,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 1;
  let best = 1;
  // Broad phase: only what overlaps the arm's own bounding box can be hit, whatever the number of colliders.
  const loX = Math.min(from.x, to.x) - radius;
  const hiX = Math.max(from.x, to.x) + radius;
  const loZ = Math.min(from.z, to.z) - radius;
  const hiZ = Math.max(from.z, to.z) + radius;
  for (const c of colliders) {
    if (c.minX > hiX || c.maxX < loX || c.minZ > hiZ || c.maxZ < loZ || c.fence || c.top < feet + clearance) continue;
    const x0 = c.minX - radius;
    const x1 = c.maxX + radius;
    const y0 = (c.bottom ?? 0) - radius;
    const y1 = c.top + radius;
    const z0 = c.minZ - radius;
    const z1 = c.maxZ + radius;
    // Already inside (spawned or seated in it): that one doesn't count.
    if (from.x > x0 && from.x < x1 && from.y > y0 && from.y < y1 && from.z > z0 && from.z < z1) continue;
    span.in = 0;
    span.out = best;
    if (clip(from.x, dx, x0, x1) && clip(from.y, dy, y0, y1) && clip(from.z, dz, z0, z1) && span.in < best) best = span.in;
  }
  return Math.min(1, Math.max(best, min / len));
}

/**
 * The arm's length as shown: in at once (never through a wall), out slowly (no flicker at corners).
 * `want` is the fraction the geometry allows now, `shown` what was shown last frame.
 */
export function easeArm(shown: number, want: number, dt: number, snap = false): number {
  if (snap || want <= shown) return want;
  return shown + (want - shown) * (1 - Math.exp(-dt * 4));
}
