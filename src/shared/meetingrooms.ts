// The office's meeting rooms: where each stands, its table, chairs and board. Built from the floor's
// and the loft's boxes (layout.ts passes them in), so this module needs nothing from layout.ts but
// types, and layout.ts can build its place table (DESK_BY_ID) from the rooms without an import cycle.
//
// There are four. The first is under the boss office and always there. The other three are in the
// meeting wing, built out through the west wall one at a time like the back office is through the north
// one (see ROOMS_WING and FloorPlan.rooms): their doors face the office (east), their boards are on the
// back wall (west). A room's own frame (roomFrame) turns that round, so the room is built, walked and
// checked the same whichever way it faces.

import type { DeskDef } from './layout.js';

/** A room a meeting can be held in: its chairs, in the order a meeting fills them, head of the table first. */
export interface MeetingRoomDef {
  /** Stable: saved with the meetings held there. */
  id: string;
  /** What the room is called, with its icon: "🤝 Meeting room 2". */
  label: string;
  icon: string; // the label's icon alone: "🤝 in meeting room 2"
  place: string; // where someone is in it: "meeting room 2"
  seats: DeskDef[];
  /** 0 for the room under the loft (always there), 1 to 3 for the meeting wing's rooms: there once the floor is built out that far. */
  level?: number;
}
/** A meeting room's glass shell. Its door is in one wall, and its board straight across from it on the far one. */
export interface MeetingRoomBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  /** The doorway along the door wall (x for `north`, z for `east`), from `u0` to `u1`. */
  door: { u0: number; u1: number };
  /** `loft`: under the boss office (its east and south sides are the building's walls). `wing`: out through the west wall. */
  style: 'loft' | 'wing';
  /** Which wall the door is in: `north` (z = minZ, the board on the south wall) or `east` (x = maxX, the board on the west wall). */
  facing: 'north' | 'east';
}
/** A meeting room on the office floor: where it is, its table and its board (see MEETING_ROOMS). */
export interface MeetingRoomPlan extends MeetingRoomDef {
  room: MeetingRoomBox;
  table: { x: number; z: number; width: number; depth: number; height: number };
  board: { x: number; y: number; z: number; width: number; height: number };
}

/**
 * A room's own frame: `u` runs along its door wall, `v` goes from the door into the room. A room that
 * faces north is `north`'s: u is x and v is z - minZ. One that faces east has u as z and v as maxX - x.
 * `rotY` and `at` are where a group built in (u, v) goes in the world: a point (u, y, v) of it lands at
 * `at` turned by `rotY`.
 */
export interface RoomFrame {
  rotY: number;
  at: { x: number; z: number };
  /** The door wall's extent along u, and how deep the room is along v. */
  u0: number;
  u1: number;
  depth: number;
  toWorld(u: number, v: number): [x: number, z: number];
  toLocal(x: number, z: number): [u: number, v: number];
}

export function roomFrame(room: MeetingRoomBox): RoomFrame {
  if (room.facing === 'north') {
    return { rotY: 0, at: { x: 0, z: room.minZ }, u0: room.minX, u1: room.maxX, depth: room.maxZ - room.minZ, toWorld: (u, v) => [u, room.minZ + v], toLocal: (x, z) => [x, z - room.minZ] };
  }
  return { rotY: -Math.PI / 2, at: { x: room.maxX, z: 0 }, u0: room.minZ, u1: room.maxZ, depth: room.maxX - room.minX, toWorld: (u, v) => [room.maxX - v, u], toLocal: (x, z) => [z, room.maxX - x] };
}

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * The meeting wing: three rooms through the west wall, side by side north to south, each `span` wide
 * (along the wall) and `depth` out from it, with a `wall` between them. The first starts `inset` in
 * from the north wall.
 */
export const ROOMS_WING = { rooms: 3, span: 5.2, depth: 3.4, wall: 0.3, inset: 0.8 } as const;

/** How far the meeting wing is built out: a whole number from 0 (no rooms) to ROOMS_WING.rooms. */
export function roomsLevel(level: unknown): number {
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(ROOMS_WING.rooms, Math.floor(level))) : 0;
}

/** Where each of the meeting wing's rooms is along the west wall: its inside, z0 to z1, and its middle. */
export function wingRoomSpans(floor: Rect): { z0: number; z1: number; c: number }[] {
  return Array.from({ length: ROOMS_WING.rooms }, (_, k) => {
    const z0 = floor.minZ + ROOMS_WING.inset + k * (ROOMS_WING.span + ROOMS_WING.wall);
    return { z0, z1: z0 + ROOMS_WING.span, c: z0 + ROOMS_WING.span / 2 };
  });
}

/** The room under the loft: a long table along x, the head of the table at its west end, then two down each side. */
function loftRoom(floor: Rect, loft: Rect & { y: number }): MeetingRoomPlan {
  const door = { u0: loft.minX + 1, u1: loft.minX + 2.4 };
  const room: MeetingRoomBox = { minX: loft.minX + 0.15, maxX: floor.maxX, minZ: loft.minZ + 0.15, maxZ: floor.maxZ, height: loft.y - 0.25, door, style: 'loft', facing: 'north' };
  const table = { x: loft.minX + 5.5, z: loft.minZ + 2.55, width: 3.6, depth: 1.2, height: 0.76 };
  const seats: DeskDef[] = (
    [
      [table.x - table.width / 2 + 0.35, table.z, -Math.PI / 2],
      [table.x - 0.6, table.z - table.depth / 2 + 0.35, Math.PI],
      [table.x - 0.6, table.z + table.depth / 2 - 0.35, 0],
      [table.x + 1.1, table.z - table.depth / 2 + 0.35, Math.PI],
      [table.x + 1.1, table.z + table.depth / 2 - 0.35, 0],
    ] as const
  ).map(([x, z, rotY], i) => ({ id: `meeting-${i + 1}`, x, z, rotY, label: i === 0 ? 'Head of the table' : `Meeting chair ${i + 1}`, room: true }));
  // In line with the door, so standing in the doorway you see the board head-on; the table is east of that line.
  const board = { x: (door.u0 + door.u1) / 2, y: 1.95, z: floor.maxZ - 0.08, width: 3, height: 1 };
  return { id: 'meeting', label: '🤝 Meeting room', icon: '🤝', place: 'the meeting room', seats, room, table, board, level: 0 };
}

/**
 * One of the meeting wing's rooms, `level` 1 to 3 (north to south): a table running out from the door to
 * the board on the line between them, with five chairs down its two sides (three on one, two on the
 * other; the head of the table is the middle one of the three), so nobody sits between the door and the
 * board. Built in its own frame (u along the wall, v out from the door) and put in the world once.
 */
function wingRoom(floor: Rect, level: number, id: string, seatPrefix: string, n: number): MeetingRoomPlan {
  const { z0, z1, c } = wingRoomSpans(floor)[level - 1];
  const D = ROOMS_WING.depth;
  const room: MeetingRoomBox = { minX: floor.minX - D, maxX: floor.minX, minZ: z0, maxZ: z1, height: 2.75, door: { u0: c - 0.7, u1: c + 0.7 }, style: 'wing', facing: 'east' };
  const f = roomFrame(room);
  const len = 1.7;
  const wide = 1.2;
  const mid = 2.05; // the table's middle, out from the door (its near end leaves a walkway across the front of it)
  const [tx, tz] = f.toWorld(c, mid);
  // [lateral offset of its laptop from the table's middle, how far out from the door, the way it faces in the room's frame]
  const seats: DeskDef[] = (
    [
      [-0.35, mid, -Math.PI / 2], // the head: the middle of the three on the -u side
      [0.35, mid - 0.35, Math.PI / 2],
      [0.35, mid + 0.35, Math.PI / 2],
      [-0.35, mid - 0.7, -Math.PI / 2],
      [-0.35, mid + 0.7, -Math.PI / 2],
    ] as const
  ).map(([du, v, rotY], i) => {
    const [x, z] = f.toWorld(c + du, v);
    return { id: `${seatPrefix}-${i + 1}`, x, z, rotY: rotY + f.rotY, label: i === 0 ? `Head of table ${n}` : `Room ${n} chair ${i + 1}`, room: true, walkOut: 1.65 };
  });
  const [bx, bz] = f.toWorld(c, D - 0.08);
  const board = { x: bx, y: 1.95, z: bz, width: 2.4, height: 0.8 };
  return { id, label: `🤝 Meeting room ${n}`, icon: '🤝', place: `meeting room ${n}`, seats, room, table: { x: tx, z: tz, width: len, depth: wide, height: 0.76 }, board, level };
}

/**
 * The office's meeting rooms, the first free one first (a meeting goes to the first free one, see
 * server/meeting-rooms.ts): the one under the loft, then the meeting wing's, north to south. Ids are
 * saved with meetings and workers: `meeting`, `review` (its chairs `review-1..5`: the second room began
 * as a review room), `room-3`, `room-4`.
 */
export function buildMeetingRooms(floor: Rect, loft: Rect & { y: number }): MeetingRoomPlan[] {
  return [loftRoom(floor, loft), wingRoom(floor, 1, 'review', 'review', 2), wingRoom(floor, 2, 'room-3', 'room-3', 3), wingRoom(floor, 3, 'room-4', 'room-4', 4)];
}

/** The rooms there are on a floor built out `level` rooms: the one under the loft, and the wing's first `level`. Another map's rooms have no level and are all there. */
export function builtMeetingRooms<T extends { level?: number }>(rooms: readonly T[], level: number): T[] {
  return rooms.filter((r) => (r.level ?? 0) <= level);
}

/**
 * A floor's building-out as one number, for the lists that carry it for every floor (the tower, the
 * city, the roof): `wing` rows of back office and `rooms` of the meeting wing.
 */
export const annexOf = (wing: number, rooms: number) => wing + 4 * rooms;
export const wingOfAnnex = (annex: number) => annex % 4;
export const roomsOfAnnex = (annex: number) => Math.floor(annex / 4);

/** Whether (x, z) is inside the meeting wing's rooms, with `rooms` of them built out through `floor`'s west wall (and a little way past it, in their doorways). */
export function inWingRooms(floor: Rect, x: number, z: number, rooms: number): boolean {
  return x > floor.minX - ROOMS_WING.depth && x < floor.minX && wingRoomSpans(floor).slice(0, rooms).some((s) => z > s.z0 && z < s.z1);
}
