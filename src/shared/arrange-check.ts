// Whether the loose furniture (see arrange.ts) may stand where someone wants it: on the floor, off the
// walls, clear of what's fixed and of the other pieces, and without walling anything in. The server
// asks this before it saves a move (server/floorplan.ts); a browser asks it while you carry a piece
// round (client/features/build/fixtures.ts), so the green and the red are the server's own answer.

import { MOVABLES, MOVABLE_BY_ID, atHome, bodyOf, keepOf, nameOf, poseAt, poseOf, rugRect, sentence, type Furniture, type Movable, type Pose, type Spot } from './arrange.js';
import { BALCONY_DOOR, ELEVATOR, ELEVATOR_FRONT, EXIT_DOOR, FLOOR, ROOMS_WING, STAIRS, STATIONS, WING, WING_DESKS, WING_ROOMS } from './layout.js';
import { deskPoint, fixedObstacles, officeNav, type Circle, type Obstacles, type Pt, type Rect } from './nav.js';
import type { DeskDef } from './layout.js';

/** How far from the walls a piece stays. */
export const WALL_MARGIN = 0.3;
const EPS = 1e-6;

export type Why = 'unknown' | 'turn' | 'outside' | 'blocked' | 'furniture' | 'boxed';
export type Verdict = { ok: true } | { ok: false; why: Why; /** What it's in the way of or what's in its way, as the message says it. */ with?: string };

/** The ways in and out that stay clear whatever is moved, however far the floor is built out (see keepOuts). */
const APRONS: Rect[] = [
  // The elevator's doors, and the way out of them.
  [ELEVATOR.x - ELEVATOR.width / 2 - 0.1, ELEVATOR.x + ELEVATOR.width / 2 + 0.1, FLOOR.minZ, ELEVATOR_FRONT + 1.5],
  // The opening into the back office, however many rows of it get built.
  [WING.minX, WING.maxX, FLOOR.minZ, FLOOR.minZ + 1.6],
  // The exit door, the balcony doors and every doorway into the meeting wing, built or not yet.
  [FLOOR.minX, FLOOR.minX + 1, EXIT_DOOR.u - 1, EXIT_DOOR.u + 1],
  [BALCONY_DOOR.u - BALCONY_DOOR.width / 2 - 0.5, BALCONY_DOOR.u + BALCONY_DOOR.width / 2 + 0.5, FLOOR.maxZ - 1.4, FLOOR.maxZ],
  ...WING_ROOMS.map((r): Rect => [FLOOR.minX, FLOOR.minX + 1, r.c - 1, r.c + 1]),
];

let fixed: Obstacles | undefined;
/** What stays where it is and what stays clear: with every meeting room and the whole back office built, so a floor can still be expanded. */
function keepOuts(): Obstacles {
  if (!fixed) {
    const f = fixedObstacles(ROOMS_WING.rooms);
    fixed = { rects: [...f.rects, ...APRONS], circles: f.circles };
  }
  return fixed;
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[1] - EPS && a[1] > b[0] + EPS && a[2] < b[3] - EPS && a[3] > b[2] + EPS;
const hitsCircle = (r: Rect, [cx, cz, cr]: Circle) => Math.hypot(cx - Math.max(r[0], Math.min(r[1], cx)), cz - Math.max(r[2], Math.min(r[3], cz))) < cr - EPS;

/** Whether piece `m`, standing at `pose`, is where it can be, going by what is fixed alone (no other furniture, no walking). */
function onTheFloor(m: Movable, pose: Pose): Verdict {
  const keep = keepOf(m, pose);
  for (const r of keep) {
    if (r[0] < FLOOR.minX + WALL_MARGIN || r[1] > FLOOR.maxX - WALL_MARGIN || r[2] < FLOOR.minZ + WALL_MARGIN || r[3] > FLOOR.maxZ - WALL_MARGIN) return { ok: false, why: 'outside' };
  }
  const o = keepOuts();
  const body = bodyOf(m, pose);
  for (const r of [...keep, ...body.rects]) if (o.rects.some((x) => overlaps(r, x)) || o.circles.some((c) => hitsCircle(r, c))) return { ok: false, why: 'blocked' };
  for (const c of body.circles) if (o.rects.some((x) => hitsCircle(x, [c[0], c[1], c[2]])) || o.circles.some((x) => Math.hypot(x[0] - c[0], x[1] - c[1]) < x[2] + c[2] - EPS)) return { ok: false, why: 'blocked' };
  return { ok: true };
}

/** A rug lies flat under everything: it only has to be on the floor and leave the doors, the elevator and the stairs bare (walking and the other furniture never mind it). */
function rugOnTheFloor(m: Movable, pose: Pose): Verdict {
  const r = rugRect(m, pose)!;
  if (r[0] < FLOOR.minX || r[1] > FLOOR.maxX || r[2] < FLOOR.minZ || r[3] > FLOOR.maxZ) return { ok: false, why: 'outside' };
  const bare: Rect[] = [...APRONS, [ELEVATOR.x - ELEVATOR.width / 2, ELEVATOR.x + ELEVATOR.width / 2, FLOOR.minZ, ELEVATOR_FRONT], [STAIRS.fromX, STAIRS.toX, STAIRS.minZ - 0.1, STAIRS.maxZ]];
  return bare.some((x) => overlaps(r, x)) ? { ok: false, why: 'blocked' } : { ok: true };
}

/** A desk's or bean bag's spot as a seat the walking code understands. */
const seatAt = (pose: Pose) => ({ x: pose.x, z: pose.z, rotY: pose.rotY }) as DeskDef;

/** Where somebody has to be able to get to (any one of `at`), with how to say it. */
interface Goal {
  label: string;
  at: Pt[];
}

/** What has to stay reachable from the elevator: every seat, the doors out, the back office and the meeting wing, and the stairs up. */
function goals(furniture: Furniture): Goal[] {
  const out: Goal[] = [];
  for (const m of MOVABLES) {
    if (m.kind !== 'desk' && m.kind !== 'beanbag') continue;
    const pose = poseOf(m, furniture);
    if (pose) out.push({ label: m.label, at: [-1, 1].map((side) => deskPoint(seatAt(pose), side * 0.7, 1.75)) });
  }
  // (The back office's chairs have its walls behind them, so a worker steps out to the side: see NavGrid.wayFrom.)
  for (const d of WING_DESKS) out.push({ label: d.label, at: [-1, 1].map((side) => deskPoint(d, side * 0.95, 1.25)) });
  for (const k of STATIONS) out.push({ label: k.label, at: [deskPoint(k, 0, -1)] });
  out.push({ label: 'the exit door', at: [[FLOOR.minX + 0.45, EXIT_DOOR.u]] });
  out.push({ label: 'the balcony doors', at: [[BALCONY_DOOR.u, FLOOR.maxZ - 0.45]] });
  out.push({ label: 'the way into the back office', at: [[(WING.minX + WING.maxX) / 2, FLOOR.minZ + 0.8]] });
  WING_ROOMS.forEach((r, i) => out.push({ label: `the meeting room ${i + 2} door`, at: [[FLOOR.minX + 0.6, r.c]] }));
  out.push({ label: 'the stairs up to the loft', at: [[STAIRS.fromX - 0.7, (STAIRS.minZ + STAIRS.maxZ) / 2]] });
  return out;
}

/** What `furniture` shuts off from the elevator's door, as the goals' labels. The floor's own back office and meeting wing are counted as built (they could be). */
export function boxedIn(furniture: Furniture): string[] {
  const nav = officeNav({ wing: WING.rows, rooms: ROOMS_WING.rooms, furniture });
  const reach = nav.reachFrom([ELEVATOR.x, ELEVATOR_FRONT + 0.5]);
  return goals(furniture)
    .filter((g) => !g.at.some(reach))
    .map((g) => g.label);
}

/** `furniture` with `id` put at `spot`: back to coming where it comes if that's where it is. */
export function withSpot(furniture: Furniture, id: string, spot: Spot): Furniture {
  const next = { ...furniture };
  const m = MOVABLE_BY_ID.get(id);
  if (m && atHome(m, spot)) delete next[id];
  else next[id] = spot;
  return next;
}

/**
 * Whether piece `id` may stand at `to` on a floor whose furniture is `furniture`. `walking: false` leaves
 * out the part that works out whether anyone could still get everywhere (the slowest part, for a drag
 * to skip while you carry the piece round); the server always asks it.
 */
export function checkPlace(furniture: Furniture, id: string, to: Spot, opts: { walking?: boolean } = {}): Verdict {
  const m = MOVABLE_BY_ID.get(id);
  if (!m) return { ok: false, why: 'unknown' };
  if (![to.x, to.z, to.r].every(Number.isFinite) || !Number.isInteger(to.r) || to.r < 0 || to.r > 3 || (!m.turns && to.r !== 0)) return { ok: false, why: 'turn' };
  const pose = poseAt(m, to);
  if (m.kind === 'rug') return rugOnTheFloor(m, pose);
  const here = onTheFloor(m, pose);
  if (!here.ok) return here;
  // The other pieces, as they stand.
  const mine = keepOf(m, pose);
  for (const o of MOVABLES) {
    if (o.id === id) continue;
    const op = poseOf(o, furniture);
    if (op && keepOf(o, op).some((r) => mine.some((x) => overlaps(r, x)))) return { ok: false, why: 'furniture', with: nameOf(o) };
  }
  if (opts.walking === false) return { ok: true };
  const next = withSpot(furniture, id, to);
  const boxed = boxedIn(next);
  if (boxed.length) {
    // Only what this move shuts off counts: a floor that was already boxed in somewhere isn't stuck there.
    const before = new Set(boxedIn(furniture));
    const now = boxed.filter((b) => !before.has(b));
    if (now.length) return { ok: false, why: 'boxed', with: now[0] };
  }
  return { ok: true };
}

/** Why a move was refused, in words for whoever tried it. */
export function whyNot(v: Exclude<Verdict, { ok: true }>, what: string): string {
  switch (v.why) {
    case 'unknown':
      return 'There is nothing like that to move';
    case 'turn':
      return `${sentence(what)} can't stand like that`;
    case 'outside':
      return `${sentence(what)} has to stay on the floor, off the walls`;
    case 'blocked':
      return `${sentence(what)} would be in the way of the doors, the walls or something fixed there`;
    case 'furniture':
      return `${sentence(v.with ?? 'something')} is already there`;
    case 'boxed':
      return `That would shut ${v.with ?? 'a way'} off`;
  }
}
