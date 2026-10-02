/**
 * The billiards ball simulation: a hand-written, deterministic 2D model of balls on the table plane, with
 * no three.js and no clock, so it runs the same everywhere (and is tested in tests/game-billiards.test.ts).
 * Fixed substeps, ball against ball as elastic impulses with some restitution, cushions that reflect,
 * rolling friction, and six pockets. Sizes are in meters; `x` runs along the table's length, `y` across it.
 */

/** The playing surface (the cloth between the cushions) and the balls on it. */
export const TABLE = { length: 2.8, width: 1.4, ball: 0.04 } as const;
export const HALF_L = TABLE.length / 2;
export const HALF_W = TABLE.width / 2;
/** A ball's radius, and the speed the hardest shot leaves the cue ball at (m/s). */
export const R = TABLE.ball;
export const MAX_SPEED = 5.5;

/** The step the simulation always takes (s): 240 Hz, so even the hardest shot moves a ball far less than its own width in one. */
export const STEP = 1 / 240;
const RESTITUTION_BALL = 0.96;
const RESTITUTION_CUSHION = 0.72;
/** Cloth: a steady slowing (m/s²) and a little drag on top (1/s). A ball under REST (m/s) has stopped. */
const ROLL = 1.1;
const DRAG = 0.12;
const REST = 0.02;

export interface Pocket {
  x: number;
  y: number;
  /** A ball whose middle comes this close is in. */
  radius: number;
  /** The cushions leave a gap this far round it, which is the pocket's mouth. */
  mouth: number;
}

/** The six pockets: a corner at each end of the table and one in the middle of each long side. */
export const POCKETS: readonly Pocket[] = [
  { x: -HALF_L - 0.02, y: -HALF_W - 0.02, radius: 0.09, mouth: 0.135 },
  { x: HALF_L + 0.02, y: -HALF_W - 0.02, radius: 0.09, mouth: 0.135 },
  { x: -HALF_L - 0.02, y: HALF_W + 0.02, radius: 0.09, mouth: 0.135 },
  { x: HALF_L + 0.02, y: HALF_W + 0.02, radius: 0.09, mouth: 0.135 },
  { x: 0, y: -HALF_W - 0.03, radius: 0.085, mouth: 0.125 },
  { x: 0, y: HALF_W + 0.03, radius: 0.085, mouth: 0.125 },
];

export interface Ball {
  /** 0 is the cue ball, 1–15 the others. */
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Down a pocket (and out of play) until the next rack. */
  potted: boolean;
}

/** Something that happened in a step, for the sound and the score. `speed` is how hard (m/s). */
export type SimEvent =
  | { kind: 'ball'; speed: number; x: number; y: number }
  | { kind: 'cushion'; speed: number; x: number; y: number }
  | { kind: 'pocket'; id: number; pocket: number; x: number; y: number };

/** Where the cue ball starts, and the rack's front ball: a quarter of the table in from either end. */
export const HEAD_SPOT = { x: -HALF_L / 2, y: 0 } as const;
export const FOOT_SPOT = { x: HALF_L / 2, y: 0 } as const;

export function newBall(id: number, x: number, y: number): Ball {
  return { id, x, y, vx: 0, vy: 0, potted: false };
}

/** The cue ball on the head spot and the other fifteen racked in a triangle at the foot, the 8 in the middle. */
export function rack(): Ball[] {
  const balls: Ball[] = [newBall(0, HEAD_SPOT.x, HEAD_SPOT.y)];
  // A hair of room between the balls, so the break doesn't start with them all touching.
  const gap = 2 * R + 0.0006;
  // The order they sit in, row by row; the 8 is the middle of the third row.
  const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
  let i = 0;
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      balls.push(newBall(order[i++], FOOT_SPOT.x + row * gap * Math.cos(Math.PI / 6), (k - row / 2) * gap));
    }
  }
  return balls;
}

/** Whether every ball in play has stopped. */
export function settled(balls: readonly Ball[]): boolean {
  return balls.every((b) => b.potted || (b.vx === 0 && b.vy === 0));
}

/** Hits the cue ball (`balls[0]`) at `angle` (0 is along +x, toward the rack) with `power` 0–1. */
export function strike(balls: Ball[], angle: number, power: number): void {
  const cue = balls[0];
  if (!cue || cue.potted) return;
  const speed = MAX_SPEED * Math.min(1, Math.max(0, power));
  cue.vx = Math.cos(angle) * speed;
  cue.vy = Math.sin(angle) * speed;
}

/** Whether a ball at (x, y) would sit on another ball in play (`but` is left out, the one being placed), or off the cloth. */
export function blocked(balls: readonly Ball[], x: number, y: number, but = -1): boolean {
  if (Math.abs(x) > HALF_L - R || Math.abs(y) > HALF_W - R) return true;
  return balls.some((b) => !b.potted && b.id !== but && Math.hypot(b.x - x, b.y - y) < 2 * R);
}

function nearPocket(x: number, y: number): boolean {
  return POCKETS.some((p) => Math.hypot(p.x - x, p.y - y) < p.mouth);
}

function nearest(x: number, y: number): number {
  let best = 0;
  POCKETS.forEach((p, i) => {
    if (Math.hypot(p.x - x, p.y - y) < Math.hypot(POCKETS[best].x - x, POCKETS[best].y - y)) best = i;
  });
  return best;
}

/**
 * Advances every ball by one STEP: the cloth slows them, they move, a ball against a ball swaps speed
 * along the line between them, a cushion turns them back, and a ball whose middle reaches a pocket is
 * in it. `out` collects what happened.
 */
export function step(balls: Ball[], out?: SimEvent[]): void {
  for (const b of balls) {
    if (b.potted) continue;
    const before = Math.hypot(b.vx, b.vy);
    if (before === 0) continue;
    const speed = Math.max(0, before - (ROLL + DRAG * before) * STEP);
    if (speed < REST) {
      b.vx = 0;
      b.vy = 0;
      continue;
    }
    const k = speed / before;
    b.vx *= k;
    b.vy *= k;
    b.x += b.vx * STEP;
    b.y += b.vy * STEP;
  }
  // Ball against ball, in a fixed order (the lower index first).
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.potted) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const c = balls[j];
      if (c.potted) continue;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 4 * R * R) continue;
      const d = Math.sqrt(d2) || 1e-9;
      const nx = dx / d;
      const ny = dy / d;
      // Push them apart to just touching.
      const push = (2 * R - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      c.x += nx * push;
      c.y += ny * push;
      const vn = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
      if (vn <= 0) continue;
      // Equal masses: each gets (1 + e) / 2 of the closing speed along the line between them.
      const imp = ((1 + RESTITUTION_BALL) / 2) * vn;
      a.vx -= imp * nx;
      a.vy -= imp * ny;
      c.vx += imp * nx;
      c.vy += imp * ny;
      out?.push({ kind: 'ball', speed: vn, x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
    }
  }
  for (const b of balls) {
    if (b.potted) continue;
    // Down a pocket?
    const pocket = POCKETS.findIndex((p) => Math.hypot(p.x - b.x, p.y - b.y) < p.radius);
    // Or out past the cushions where nothing caught it: the nearest pocket gets it.
    const gone = pocket >= 0 ? pocket : Math.abs(b.x) > HALF_L + R || Math.abs(b.y) > HALF_W + R ? nearest(b.x, b.y) : -1;
    if (gone >= 0) {
      b.potted = true;
      b.vx = 0;
      b.vy = 0;
      out?.push({ kind: 'pocket', id: b.id, pocket: gone, x: b.x, y: b.y });
      continue;
    }
    if (nearPocket(b.x, b.y)) continue;
    const speed = Math.hypot(b.vx, b.vy);
    let hit = false;
    if (b.x > HALF_L - R && b.vx > 0) {
      b.x = HALF_L - R;
      b.vx = -b.vx * RESTITUTION_CUSHION;
      hit = true;
    } else if (b.x < -HALF_L + R && b.vx < 0) {
      b.x = -HALF_L + R;
      b.vx = -b.vx * RESTITUTION_CUSHION;
      hit = true;
    }
    if (b.y > HALF_W - R && b.vy > 0) {
      b.y = HALF_W - R;
      b.vy = -b.vy * RESTITUTION_CUSHION;
      hit = true;
    } else if (b.y < -HALF_W + R && b.vy < 0) {
      b.y = -HALF_W + R;
      b.vy = -b.vy * RESTITUTION_CUSHION;
      hit = true;
    }
    if (hit) out?.push({ kind: 'cushion', speed, x: b.x, y: b.y });
  }
}

/** Where the aim guide stops: where the cue ball is when it first touches something, and what. */
export interface AimLine {
  /** The cue ball's middle when it touches a ball (`ball` is its id) or a cushion (`ball` is -1). */
  x: number;
  y: number;
  ball: number;
}

/** Follows the cue ball from where it is along `angle` to the first ball (or cushion) it would touch. */
export function aimLine(balls: readonly Ball[], angle: number): AimLine {
  const cue = balls[0];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let t = Infinity;
  let ball = -1;
  // The cushions (the middle of the cue ball stops R short of them).
  if (dx > 1e-9) t = Math.min(t, (HALF_L - R - cue.x) / dx);
  else if (dx < -1e-9) t = Math.min(t, (-HALF_L + R - cue.x) / dx);
  if (dy > 1e-9) t = Math.min(t, (HALF_W - R - cue.y) / dy);
  else if (dy < -1e-9) t = Math.min(t, (-HALF_W + R - cue.y) / dy);
  for (const b of balls) {
    if (b.id === 0 || b.potted) continue;
    const fx = b.x - cue.x;
    const fy = b.y - cue.y;
    const along = fx * dx + fy * dy;
    if (along <= 0) continue;
    const off2 = fx * fx + fy * fy - along * along;
    if (off2 >= 4 * R * R) continue;
    const hitAt = along - Math.sqrt(4 * R * R - off2);
    if (hitAt >= 0 && hitAt < t) {
      t = hitAt;
      ball = b.id;
    }
  }
  t = Math.max(0, t);
  return { x: cue.x + dx * t, y: cue.y + dy * t, ball };
}
