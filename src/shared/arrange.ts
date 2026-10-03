// The office's loose furniture: the desks, the bean bags, the lounge's couch and poufs and the
// whiteboard, which anyone on a floor can move, turn or take out in build mode (see FloorPlan.furniture).
// This is the pure part: what there is, where each stands as the office comes (its home), where it
// stands on a floor that has rearranged it, what's in its way, and the seats that follow from that.
// Whether a spot is allowed is arrange-check.ts. Everything here is the office's own map: another map
// (the castle) has its own seats and never reads any of it.

import { BEANBAGS, DESKS, DESK_SIZE, SEATING, TV, WHITEBOARD, watchSpots, type DeskDef, type SeatDef } from './layout.js';
import type { MapPlan } from './maps/types.js';
import type { Circle, Rect } from './nav.js';

/** Where a piece of furniture stands once it has been moved: its middle, and turned a quarter turn `r` times (0-3) from how it comes. */
export interface Spot {
  x: number;
  z: number;
  r: number;
}
/** Moved to a spot, or taken out of the floor. */
export type Placement = Spot | { removed: true };
/** What a floor has rearranged, by furniture id (see MOVABLES): what isn't there stands where it comes. */
export type Furniture = Record<string, Placement>;

/** What a floor's furniture is, with its back office and meeting wing: the one thing the walking grid and the seats are made from. */
export interface Layout {
  wing: number;
  rooms: number;
  furniture?: Furniture;
}

export type MovableKind = 'desk' | 'beanbag' | 'couch' | 'pouf' | 'whiteboard' | 'rug';

export interface Movable {
  id: string;
  kind: MovableKind;
  label: string;
  /** Where it stands as the office comes. */
  home: { x: number; z: number; rotY: number };
  /** Whether it can be turned a quarter turn at a time (a pouf turns to face the TV by itself). */
  turns: boolean;
  /** A rug's size, in its own frame (u across, v along): it lies flat, so it's in nobody's way and anything may stand on it. */
  extent?: Local;
}

/** A piece of furniture standing somewhere: its middle and the way it faces (see DeskDef.rotY), `r` quarter turns from home. */
export interface Pose {
  x: number;
  z: number;
  rotY: number;
  r: number;
}

const QUARTER = Math.PI / 2;
/** What can be rearranged. */
const MOVED_ID = /^(desk-\d+|beanbag-\d+|couch|lounge-beanbag-\d+|whiteboard|rug-[0-9]+|rug-lounge)$/;

/** Where each rug of the main room lies as the office comes, and how big it is: x, z, width, depth. The pods', then the lounge's. */
export const ROOM_RUGS: readonly (readonly [number, number, number, number])[] = [
  [-10.5, -4, 6.2, 4.6],
  [-1.5, -4, 6.2, 4.6],
  [-10.5, 4, 6.2, 4.6],
  [-1.5, 4, 6.2, 4.6],
  [13.4, 0, 7, 7],
];

const SEAT = (id: string) => SEATING.find((s) => s.id === id)!;
const POUF_IDS = SEATING.filter((s) => /^lounge-beanbag-/.test(s.id)).map((s) => s.id);

export const MOVABLES: Movable[] = [
  ...DESKS.map((d): Movable => ({ id: d.id, kind: 'desk', label: d.label, home: { x: d.x, z: d.z, rotY: d.rotY }, turns: true })),
  ...BEANBAGS.map((d): Movable => ({ id: d.id, kind: 'beanbag', label: d.label, home: { x: d.x, z: d.z, rotY: d.rotY }, turns: true })),
  { id: 'couch', kind: 'couch', label: 'Couch', home: { x: SEAT('couch').x, z: SEAT('couch').z, rotY: SEAT('couch').rotY }, turns: true },
  ...POUF_IDS.map((id, i): Movable => ({ id, kind: 'pouf', label: `Lounge pouf ${i + 1}`, home: { x: SEAT(id).x, z: SEAT(id).z, rotY: SEAT(id).rotY }, turns: false })),
  { id: 'whiteboard', kind: 'whiteboard', label: 'Whiteboard', home: { x: WHITEBOARD.x, z: WHITEBOARD.z, rotY: 0 }, turns: true },
  // The rugs under the four pods (see world/office/room.ts), and the lounge's under the couch.
  ...ROOM_RUGS.map(([x, z, w, d], i): Movable => ({ id: i < 4 ? `rug-${i + 1}` : 'rug-lounge', kind: 'rug', label: i < 4 ? `Rug ${i + 1}` : 'Lounge rug', home: { x, z, rotY: 0 }, turns: true, extent: [-w / 2, w / 2, -d / 2, d / 2] })),
];
export const MOVABLE_BY_ID = new Map(MOVABLES.map((m) => [m.id, m]));

/** A bean bag's footprint, with the lap desk in front of it (-z), in its own frame. */
export const BEANBAG_BOX = { minX: -0.62, maxX: 0.62, minZ: -1.1, maxZ: 0.64, top: 0.62 } as const;

/** Local [minU, maxU, minV, maxV]: u along the piece's width, v out toward the way it faces (see deskPoint). */
export type Local = [number, number, number, number];
interface Shape {
  /** What stands in the way of walking (the nav grid). */
  body: { rects: Local[]; circles: Circle[] };
  /** What it takes up, with room to use it: another piece keeps out of it (a desk's chair). */
  keep: Local[];
}
const hw = DESK_SIZE.width / 2;
const hd = DESK_SIZE.depth / 2;
const SHAPES: Record<MovableKind, Shape> = {
  desk: { body: { rects: [[-hw, hw, -hd, hd]], circles: [[0, 0.9, 0.35]] }, keep: [[-hw, hw, -hd, hd], [-0.35, 0.35, hd, 1.25]] },
  beanbag: { body: { rects: [[BEANBAG_BOX.minX, BEANBAG_BOX.maxX, BEANBAG_BOX.minZ, BEANBAG_BOX.maxZ]], circles: [] }, keep: [[BEANBAG_BOX.minX, BEANBAG_BOX.maxX, BEANBAG_BOX.minZ, BEANBAG_BOX.maxZ]] },
  couch: { body: { rects: [[-2.2, 2.2, -0.5, 0.5]], circles: [] }, keep: [[-2.2, 2.2, -0.5, 1]] },
  pouf: { body: { rects: [], circles: [[0, 0, 0.5]] }, keep: [[-0.55, 0.55, -0.55, 0.55]] },
  rug: { body: { rects: [], circles: [] }, keep: [] },
  whiteboard: { body: { rects: [[-WHITEBOARD.width / 2 - 0.2, WHITEBOARD.width / 2 + 0.2, -0.48, 0.48]], circles: [] }, keep: [[-WHITEBOARD.width / 2 - 0.2, WHITEBOARD.width / 2 + 0.2, -0.48, 0.48]] },
};

/** The way a pouf sits: turned to the TV, like whoever's on it. */
const facingTv = (x: number, z: number) => Math.atan2(TV.x - x, TV.z - z);

/** Where (u, v) of a piece's own frame is in the world. */
function toWorld(p: { x: number; z: number; rotY: number }, u: number, v: number): [number, number] {
  return [p.x + Math.cos(p.rotY) * u + Math.sin(p.rotY) * v, p.z - Math.sin(p.rotY) * u + Math.cos(p.rotY) * v];
}

/** `local` ([minU, maxU, minV, maxV] in a piece's own frame) in the world: the box round its four corners, which is the box itself for a piece turned in quarter turns. */
export function worldRect(p: { x: number; z: number; rotY: number }, local: Local): Rect {
  // Quarter turns only: the shapes that don't turn that way (the pouf) are the same turned any way.
  const q = { x: p.x, z: p.z, rotY: Math.round(p.rotY / QUARTER) * QUARTER };
  const xs: number[] = [];
  const zs: number[] = [];
  for (const u of [local[0], local[1]]) {
    for (const v of [local[2], local[3]]) {
      const [x, z] = toWorld(q, u, v);
      xs.push(x);
      zs.push(z);
    }
  }
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}

/** Where a piece of furniture stands on a floor, or null when its floor has taken it out. */
export function poseOf(m: Movable, furniture: Furniture | undefined): Pose | null {
  const f = furniture?.[m.id];
  if (f && 'removed' in f) return null;
  const x = f ? f.x : m.home.x;
  const z = f ? f.z : m.home.z;
  const r = f && m.turns ? f.r : 0;
  return { x, z, r, rotY: m.kind === 'pouf' ? facingTv(x, z) : m.home.rotY + r * QUARTER };
}

/** The pose a piece would have at `spot` (a preview, or what a request asks for). */
export function poseAt(m: Movable, spot: Spot): Pose {
  return poseOf(m, { [m.id]: spot })!;
}

/** What a piece standing at `pose` is in the way of for anyone walking, in the world. */
export function bodyOf(m: Movable, pose: Pose): { rects: Rect[]; circles: Circle[] } {
  const s = SHAPES[m.kind].body;
  return { rects: s.rects.map((r) => worldRect(pose, r)), circles: s.circles.map(([u, v, r]) => [...toWorld(pose, u, v), r] as Circle) };
}

/** The ground a rug covers at `pose`, in the world. */
export function rugRect(m: Movable, pose: Pose): Rect | null {
  return m.extent ? worldRect(pose, m.extent) : null;
}

/** What a piece at `pose` takes up, with room to use it, in the world. */
export function keepOf(m: Movable, pose: Pose): Rect[] {
  return SHAPES[m.kind].keep.map((r) => worldRect(pose, r));
}

/** Everything the loose furniture puts in the way on a floor: for the walking grid. */
export function movableObstacles(furniture: Furniture | undefined): { rects: Rect[]; circles: Circle[] } {
  const rects: Rect[] = [];
  const circles: Circle[] = [];
  for (const m of MOVABLES) {
    const pose = poseOf(m, furniture);
    if (!pose) continue;
    const b = bodyOf(m, pose);
    rects.push(...b.rects);
    circles.push(...b.circles);
  }
  return { rects, circles };
}

// ---- Keeping it ---------------------------------------------------------------------------------------

const round = (v: number) => Math.round(v * 100) / 100;

/** Whether `p` is where `m` comes. */
export function atHome(m: Movable, p: Placement): boolean {
  return !('removed' in p) && Math.abs(p.x - m.home.x) < 0.005 && Math.abs(p.z - m.home.z) < 0.005 && (!m.turns || p.r === 0);
}

/** What's valid of a floor's rearranged furniture, read back from disk (or off the wire): nothing unknown, and nothing where it already stands. */
export function cleanFurniture(raw: unknown): Furniture {
  const out: Furniture = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    const m = MOVABLE_BY_ID.get(id);
    if (!m || !MOVED_ID.test(id) || !p || typeof p !== 'object') continue;
    const s = p as Record<string, unknown>;
    const spot: Placement | null =
      s.removed === true
        ? { removed: true }
        : typeof s.x === 'number' && typeof s.z === 'number' && Number.isFinite(s.x) && Number.isFinite(s.z) && Math.abs(s.x) < 100 && Math.abs(s.z) < 100
          ? { x: round(s.x), z: round(s.z), r: m.turns && typeof s.r === 'number' && Number.isFinite(s.r) ? ((Math.trunc(s.r) % 4) + 4) % 4 : 0 }
          : null;
    if (spot && !atHome(m, spot)) out[id] = spot;
  }
  return out;
}

const keys = new WeakMap<object, string>();

/** A stable name for a furniture arrangement: the same one for the same furniture, however it was made. */
export function furnitureKey(furniture: Furniture | undefined): string {
  if (!furniture) return '';
  let key = keys.get(furniture);
  if (key === undefined) {
    key = Object.keys(furniture)
      .sort()
      .map((id) => {
        const p = furniture[id];
        return 'removed' in p ? `${id}:x` : `${id}:${p.x},${p.z},${p.r}`;
      })
      .join(';');
    keys.set(furniture, key);
  }
  return key;
}

/** The ids of the seats a floor has taken out (desks and bean bags), for the places that hire into seats. */
export function removedSeats(furniture: Furniture | undefined): Set<string> {
  const out = new Set<string>();
  if (furniture) for (const [id, p] of Object.entries(furniture)) if ('removed' in p && /^(desk|beanbag)-/.test(id)) out.add(id);
  return out;
}

/** What nothing is taken out of. */
export const NONE_REMOVED: ReadonlySet<string> = new Set();

// ---- The seats, as arranged ---------------------------------------------------------------------------

/** A desk or bean bag where a floor has put it. */
function seatAt(def: DeskDef, furniture: Furniture | undefined): DeskDef {
  const m = MOVABLE_BY_ID.get(def.id);
  const pose = m && poseOf(m, furniture);
  return pose ? { ...def, x: pose.x, z: pose.z, rotY: pose.rotY } : def;
}

/** Whether sitting on the couch there still puts the TV up (see SeatDef.tv): it faces the TV, give or take. */
export function facesTv(s: { x: number; z: number; rotY: number }): boolean {
  const dx = TV.x - s.x;
  const dz = TV.z - s.z;
  const len = Math.hypot(dx, dz);
  return len > 0 && (Math.sin(s.rotY) * dx + Math.cos(s.rotY) * dz) / len > 0.5;
}

/** A couch or pouf where a floor has put it. */
function seatingAt(seat: SeatDef, furniture: Furniture | undefined): SeatDef | null {
  const m = MOVABLE_BY_ID.get(seat.id);
  if (!m) return seat;
  const pose = poseOf(m, furniture);
  if (!pose) return null;
  const moved = { ...seat, x: pose.x, z: pose.z, rotY: pose.rotY };
  return seat.tv && !facesTv(moved) ? { ...moved, tv: false } : moved;
}

const arranged = new Map<string, MapPlan>();
const ofFurniture = new WeakMap<object, MapPlan>();

/**
 * The office's plan as a floor has arranged its furniture: the desks and bean bags (and the spots
 * behind them) where they stand, the couch and poufs where they stand and without the ones taken out.
 * The plan itself when there's nothing arranged or it isn't the office's. Made once for each arrangement
 * (`base` is always the office's own plan).
 */
export function arrangedPlan(base: MapPlan, furniture: Furniture | undefined): MapPlan {
  if (base.style !== 'office' || !furniture) return base;
  const hit = ofFurniture.get(furniture);
  if (hit) return hit;
  const key = furnitureKey(furniture);
  let plan = key ? arranged.get(key) : base;
  if (!plan) {
    const desks = base.desks.map((d) => seatAt(d, furniture));
    const overflow = base.overflow.map((d) => seatAt(d, furniture));
    const byId = new Map(base.byId);
    for (const d of [...desks, ...overflow, ...watchSpots([...desks, ...overflow])]) byId.set(d.id, d);
    const seating = base.seating.flatMap((s) => seatingAt(s, furniture) ?? []);
    plan = { ...base, desks, overflow, byId, seating, seatingById: new Map(seating.map((s) => [s.id, s])), furniture, removed: removedSeats(furniture) };
    if (arranged.size > 16) arranged.delete(arranged.keys().next().value!);
    arranged.set(key, plan);
  }
  ofFurniture.set(furniture, plan);
  return plan;
}

/** The couch, a pouf or the whiteboard where a floor has put it, or null when it's gone. */
export function whereIs(id: string, furniture: Furniture | undefined): Pose | null {
  const m = MOVABLE_BY_ID.get(id);
  return m ? poseOf(m, furniture) : null;
}

/** The couch's and the poufs' seats, as arranged (a seat that's been taken out isn't there). */
export function arrangedSeating(furniture: Furniture | undefined): SeatDef[] {
  return SEATING.flatMap((s) => seatingAt(s, furniture) ?? []);
}

/** The seat places ("couch:0") of the couch and poufs a floor has taken out: nobody sits there, and no figure either. */
export function removedPlaces(furniture: Furniture | undefined): string[] {
  const out: string[] = [];
  for (const s of SEATING) {
    const p = furniture?.[s.id];
    if (p && 'removed' in p && MOVABLE_BY_ID.has(s.id)) s.places.forEach((_, i) => out.push(`${s.id}:${i}`));
  }
  return out;
}

/** What a piece is called in a sentence: its label ("Desk 3", "Bean bag 2", "Lounge pouf 1"), or "the couch" and "the whiteboard". */
export function nameOf(m: Movable): string {
  return m.kind === 'couch' || m.kind === 'whiteboard' ? `the ${m.label.toLowerCase()}` : m.label;
}

/** `text` with a capital to start a sentence. */
export const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
