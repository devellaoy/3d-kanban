// Getting around a floor on a coarse grid, round the furniture: the dog's walks (server/dog.ts), a
// worker's way out when it's sent home, and on a map of its own (see shared/maps), a worker's walks
// about the hall. The office's grid is below; a map builds one from its plan (NavGrid).
// An office floor built out into the back office (see WING) has more of it to get round: the office's
// helpers take how many rows it's built out (`wing`), and each level gets a grid of its own.

import { BALCONY, BALCONY_DOOR, BOOKSHELF, CABINET, DESK_SIZE, ELEVATOR, ELEVATOR_FRONT, EXIT_DOOR, EXIT_STAIRS, FLOOR, GONG, JUKEBOX, KIOSK, LOFT, MEETING_ROOMS, ROOMS_WING, WING_ROOMS, builtMeetingRooms, roomFrame, roomsLevel, PARACHUTE, ROAD, STAIRS, STATIONS, WING, WING_DESKS, deskBuilt, wingLevel, wingMinZ, type DeskDef } from './layout.js';
import { furnitureKey, movableObstacles, type Furniture, type Layout } from './arrange.js';


export type Pt = [number, number];

const CELL = 0.5;
/** Half the width of whoever walks it (the dog, a worker), plus a little room: how far they keep from things. */
const R = 0.3;

export type Rect = [number, number, number, number]; // minX, maxX, minZ, maxZ
export type Circle = [number, number, number]; // x, z, radius
/** What's in the way on a floor. */
export interface Obstacles {
  rects: Rect[];
  circles: Circle[];
}
/** The floor a grid covers. */
export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
/** Whether (x, z) is on the floor, at least `m` in from its walls: for a floor that isn't just its bounds. */
export type Floorplan = (x: number, z: number, m: number) => boolean;

/** A floor that fills its bounds. */
const within =
  (b: Bounds): Floorplan =>
  (x, z, m) =>
    x > b.minX + m && x < b.maxX - m && z > b.minZ + m && z < b.maxZ - m;

/** The desk's own frame: `t` along its width, `s` out toward the side the worker sits on. */
export function deskPoint(d: DeskDef, t: number, s: number): Pt {
  return [d.x + Math.cos(d.rotY) * t + Math.sin(d.rotY) * s, d.z - Math.sin(d.rotY) * t + Math.cos(d.rotY) * s];
}

/**
 * What's in the way on the office floor that stays where it is, with `rooms` meeting rooms built out
 * (the loose furniture, the couch and coffee table among it, is shared/arrange.ts's). The lounge, kitchen and plants are where
 * world/office/room.ts (and world/kitchen.ts) put them.
 */
export function fixedObstacles(rooms: number): Obstacles {
  const rects: Rect[] = [];
  const circles: Circle[] = [];
  rects.push([-17, -10.75, 11.7, 12.7]); // kitchen counter and fridge
  // The loft's posts, the stairs up to it, and the elevator shaft.
  for (const x of [LOFT.minX + 0.15, (LOFT.minX + LOFT.maxX) / 2]) circles.push([x, LOFT.minZ + 0.15, 0.14]);
  rects.push([STAIRS.fromX, STAIRS.toX, STAIRS.minZ - 0.1, STAIRS.maxZ]);
  rects.push([ELEVATOR.x - ELEVATOR.width / 2, ELEVATOR.x + ELEVATOR.width / 2, FLOOR.minZ, ELEVATOR_FRONT]);
  // The gong's frame, as features/gong/world.ts puts it.
  rects.push([GONG.x - GONG.width / 2 - 0.12, GONG.x + GONG.width / 2 + 0.3, GONG.z - 0.3, GONG.z + 0.3]);
  // The jukebox, against the east wall.
  rects.push([JUKEBOX.x - JUKEBOX.depth / 2 - 0.05, FLOOR.maxX, JUKEBOX.z - JUKEBOX.width / 2 - 0.05, JUKEBOX.z + JUKEBOX.width / 2 + 0.05]);
  // The arcade cabinet next to it, as features/cabinet/world.ts puts it (its control panel sticks out a little).
  rects.push([CABINET.x - 0.45, FLOOR.maxX, CABINET.z - CABINET.width / 2 - 0.02, CABINET.z + CABINET.width / 2 + 0.02]);
  // The bookshelf against the south wall, as features/bookshelf/world.ts puts it.
  rects.push([BOOKSHELF.x - BOOKSHELF.width / 2 - 0.04, BOOKSHELF.x + BOOKSHELF.width / 2 + 0.04, BOOKSHELF.z - BOOKSHELF.depth / 2 - 0.03, FLOOR.maxZ]);
  // The board agents' kiosks, and the agent standing behind each one.
  for (const k of STATIONS) {
    const corners = [deskPoint(k, -KIOSK.width / 2, -KIOSK.depth / 2), deskPoint(k, KIOSK.width / 2, -KIOSK.depth / 2), deskPoint(k, -KIOSK.width / 2, KIOSK.stand + 0.35), deskPoint(k, KIOSK.width / 2, KIOSK.stand + 0.35)];
    const xs = corners.map(([x]) => x);
    const zs = corners.map(([, z]) => z);
    rects.push([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]);
  }
  // The meeting rooms that are built: their glass walls, with the doorway in the one the door is in, and
  // the tables with their chairs, as world/office/meeting-room.ts puts them, in each room's own frame
  // (u along its door wall, v in from the door). The first sits under the loft (its east and south sides
  // are the building's walls); the wing's stand out through the west wall, glass on every side but the back.
  const G = 0.06;
  for (const { room, table: t, seats } of builtMeetingRooms(MEETING_ROOMS, rooms)) {
    const f = roomFrame(room);
    /** A box in the room's frame, as the world's [minX, maxX, minZ, maxZ]. */
    const box = (u0: number, u1: number, v0: number, v1: number): Rect => {
      const [ax, az] = f.toWorld(u0, v0);
      const [bx, bz] = f.toWorld(u1, v1);
      return [Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz)];
    };
    const wide = room.style === 'wing';
    rects.push(box(f.u0 - G, f.u0 + G, -G, f.depth + (wide ? G : 0)));
    rects.push(box(f.u0 - G, room.door.u0, -G, G));
    rects.push(box(room.door.u1, f.u1 + (wide ? G : 0), -G, G));
    if (wide) {
      rects.push(box(f.u1 - G, f.u1 + G, -G, f.depth + G));
      rects.push(box(f.u0 - G, f.u1 + G, f.depth - G, f.depth + G));
    }
    rects.push([t.x - t.width / 2, t.x + t.width / 2, t.z - t.depth / 2, t.z + t.depth / 2]);
    // Chairs tucked in at the table, a little smaller than a desk's, so there's a way round behind them.
    for (const d of seats) {
      const [cx, cz] = deskPoint(d, 0, 0.85);
      circles.push([cx, cz, 0.3]);
    }
  }
  return { rects, circles };
}

/**
 * What's in the way on the office floor as `layout` has it: the fixed things, the back office's desks
 * once it's built out, and the loose furniture (desks, bean bags, the couch and poufs, the whiteboard)
 * where the floor has put it. The overflow bean bags are only out while every desk is taken, but they
 * always come out in the same spots, so the dog keeps off those.
 */
function obstacles(wing: number, rooms: number, furniture?: Furniture): Obstacles {
  const { rects, circles } = fixedObstacles(rooms);
  const hw = DESK_SIZE.width / 2;
  const hd = DESK_SIZE.depth / 2;
  for (const d of WING_DESKS) {
    if (!deskBuilt(d, wing)) continue;
    // Desks face ±z, so their tops are axis-aligned.
    rects.push([d.x - hw, d.x + hw, d.z - hd, d.z + hd]);
    const [cx, cz] = deskPoint(d, 0, 0.9);
    circles.push([cx, cz, 0.35]); // the chair
  }
  const loose = movableObstacles(furniture);
  rects.push(...loose.rects);
  circles.push(...loose.circles);
  return { rects, circles };
}

/** Whether (x, z) is too close to anything in the way, or to the walls, to stand in. */
function isBlocked(x: number, z: number, on: Floorplan, o: Obstacles): boolean {
  if (!on(x, z, R)) return true;
  for (const [x0, x1, z0, z1] of o.rects) if (x > x0 - R && x < x1 + R && z > z0 - R && z < z1 + R) return true;
  for (const [cx, cz, r] of o.circles) if (Math.hypot(x - cx, z - cz) < r + R) return true;
  return false;
}

/** A floor on a half-meter grid, with what's in the way marked: where you can walk, and the way round. */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly grid: Uint8Array;

  /** `on`: the floor's shape, when it doesn't fill `bounds` (the office built out into its back office). */
  constructor(
    readonly bounds: Bounds,
    obstacles: Obstacles,
    private readonly on: Floorplan = within(bounds),
  ) {
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / CELL);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / CELL);
    this.grid = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.grid[r * this.cols + c] = isBlocked(bounds.minX + (c + 0.5) * CELL, bounds.minZ + (r + 0.5) * CELL, on, obstacles) ? 1 : 0;
  }

  private colOf(x: number) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.bounds.minX) / CELL)));
  }

  private rowOf(z: number) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.bounds.minZ) / CELL)));
  }

  private centerOf(i: number): Pt {
    return [this.bounds.minX + ((i % this.cols) + 0.5) * CELL, this.bounds.minZ + (Math.floor(i / this.cols) + 0.5) * CELL];
  }

  walkable(x: number, z: number): boolean {
    return this.on(x, z, 0) && !this.grid[this.rowOf(z) * this.cols + this.colOf(x)];
  }

  /** Whether it can trot straight from a to b: every cell the line crosses is clear. */
  clearLine(a: Pt, b: Pt): boolean {
    const { grid, cols, rows } = this;
    let c = this.colOf(a[0]);
    let r = this.rowOf(a[1]);
    const c1 = this.colOf(b[0]);
    const r1 = this.rowOf(b[1]);
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const sc = Math.sign(dx);
    const sr = Math.sign(dz);
    const stepC = sc ? CELL / Math.abs(dx) : Infinity;
    const stepR = sr ? CELL / Math.abs(dz) : Infinity;
    let nextC = sc ? (this.bounds.minX + (c + (sc > 0 ? 1 : 0)) * CELL - a[0]) / dx : Infinity;
    let nextR = sr ? (this.bounds.minZ + (r + (sr > 0 ? 1 : 0)) * CELL - a[1]) / dz : Infinity;
    for (let n = 0; n <= cols + rows; n++) {
      if (grid[r * cols + c]) return false;
      if (c === c1 && r === r1) return true;
      if (Math.abs(nextC - nextR) < 1e-9) {
        // Right through a corner: both cells beside it count.
        if (grid[r * cols + c + sc] || grid[(r + sr) * cols + c]) return false;
        c += sc;
        r += sr;
        nextC += stepC;
        nextR += stepR;
      } else if (nextC < nextR) {
        c += sc;
        nextC += stepC;
      } else {
        r += sr;
        nextR += stepR;
      }
    }
    return false;
  }

  /**
   * Which places can be walked to from `from` (or the nearest cell it can stand in): a flood fill over
   * the grid, going round corners the way the routes do. A place of its own cell that's blocked can't be reached.
   */
  reachFrom(from: Pt): (p: Pt) => boolean {
    const { grid, cols, rows } = this;
    const [sx, sz] = this.nearestWalkable(from);
    const seen = new Uint8Array(grid.length);
    const stack = [this.rowOf(sz) * cols + this.colOf(sx)];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols;
      const r = Math.floor(i / cols);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nc = c + dx;
          const nr = r + dz;
          if ((!dx && !dz) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const n = nr * cols + nc;
          if (grid[n] || seen[n] || (dx && dz && (grid[r * cols + nc] || grid[nr * cols + c]))) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    return (p) => this.walkable(p[0], p[1]) && !!seen[this.rowOf(p[1]) * cols + this.colOf(p[0])];
  }

  /** The middle of the nearest cell it can stand in. */
  nearestWalkable(p: Pt): Pt {
    if (this.walkable(p[0], p[1])) return p;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i]) continue;
      const [x, z] = this.centerOf(i);
      const d = (x - p[0]) ** 2 + (z - p[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? p : this.centerOf(best);
  }

  /** A* over the grid, then pulled tight: the corners of a route from `from` to `to`, both included. */
  route(from: Pt, to: Pt): Pt[] {
    const { grid, cols, rows } = this;
    const goal = this.nearestWalkable(to);
    const start = this.nearestWalkable(from);
    const lead: Pt[] = start === from ? [from] : [from, start];
    if (this.clearLine(start, goal)) return [...lead, goal];
    const s = this.rowOf(start[1]) * cols + this.colOf(start[0]);
    const g = this.rowOf(goal[1]) * cols + this.colOf(goal[0]);
    const cost = new Float64Array(grid.length).fill(Infinity);
    const came = new Int32Array(grid.length).fill(-1);
    const closed = new Uint8Array(grid.length);
    const heap = new Heap();
    const gc = g % cols;
    const gr = Math.floor(g / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc);
      const dz = Math.abs(Math.floor(i / cols) - gr);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    cost[s] = 0;
    heap.push(s, h(s));
    while (heap.size) {
      const i = heap.pop();
      if (i === g) break;
      if (closed[i]) continue;
      closed[i] = 1;
      const c = i % cols;
      const r = Math.floor(i / cols);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nc = c + dx;
          const nr = r + dz;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const n = nr * cols + nc;
          if (grid[n] || closed[n]) continue;
          // No cutting corners past something in the way.
          if (dx && dz && (grid[r * cols + nc] || grid[nr * cols + c])) continue;
          const next = cost[i] + (dx && dz ? Math.SQRT2 : 1);
          if (next >= cost[n]) continue;
          cost[n] = next;
          came[n] = i;
          heap.push(n, next + h(n));
        }
      }
    }
    if (came[g] < 0) return [...lead, goal]; // nowhere to go round; shouldn't happen in one room
    const cells: Pt[] = [];
    for (let i = came[g]; i !== s && i >= 0; i = came[i]) cells.push(this.centerOf(i));
    const pts: Pt[] = [start, ...cells.reverse(), goal];
    // Keep only the corners: from each point, straight on to the farthest one it can see.
    const out: Pt[] = [...lead];
    for (let i = 0; i < pts.length - 1; ) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.clearLine(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /**
   * From beside `seat`, where a worker hops down, round the furniture to `to`. It gets down on
   * whichever side of its chair (its bean bag, its kiosk) is the shorter way.
   */
  wayFrom(seat: DeskDef, to: Pt): Pt[] {
    const ways = [-1, 1].map((side) => {
      // Beside the chair and back from the desk into the aisle, off the bean bag and round behind it, or
      // out from behind the kiosk and round its front, into the room.
      const [down, back] = seat.beanbag
        ? [deskPoint(seat, side * 1.05, 0.1), deskPoint(seat, side * 1.05, 1.25)]
        : seat.station
          ? [deskPoint(seat, side * 0.95, KIOSK.stand), deskPoint(seat, side * 0.95, -1)]
          : seat.wing
            ? // In the back office the chair has its back to a wall or the next row: out to the side of it instead.
              [deskPoint(seat, side * 0.7, 0.95), deskPoint(seat, side * 0.95, 1.25)]
            : // At the meeting table there's less room behind the chair, before the glass.
              [deskPoint(seat, side * 0.7, 0.95), deskPoint(seat, side * 0.7, seat.walkOut ?? (seat.room ? 1.4 : 1.75))];
      // A bean bag or a kiosk can stand with one side up against something (the elevator, by the queue).
      const blocked = !!(seat.beanbag || seat.station) && !this.walkable(down[0], down[1]);
      const pts = [down, ...this.route(back, to)];
      return { pts, cost: (blocked ? 1000 : 0) + pathLength(pts) };
    });
    return ways[0].cost <= ways[1].cost ? ways[0].pts : ways[1].pts;
  }

  /**
   * From `from`, round the furniture to beside `seat`'s chair (the last point), on whichever side is
   * the shorter way, where it hops on.
   */
  wayTo(from: Pt, seat: DeskDef): Pt[] {
    const ways = [-1, 1].map((side) => {
      const pts = [...this.route(from, deskPoint(seat, side * 0.7, seat.room ? 1.65 : 1.75)), deskPoint(seat, side * 0.7, 0.95)];
      return { pts, cost: pathLength(pts) };
    });
    return ways[0].cost <= ways[1].cost ? ways[0].pts : ways[1].pts;
  }
}

/** How far it is along `pts`, corner to corner. */
export const pathLength = (pts: Pt[]) => pts.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** The office floor downstairs (no stairs, no loft, no elevator), built out `wing` rows, made the first time it's needed. */
const OFFICE_NAVS = new Map<string, NavGrid>();

/** A floor's layout from what a caller has to say about it: how many rows the back office is built out and how many meeting rooms (the way it used to be), or a whole layout with its furniture. */
export function layoutOf(wing: number | Layout = 0, rooms = 0): Layout {
  return typeof wing === 'object' ? wing : { wing, rooms };
}

export function officeNav(layout: number | Layout = 0, roomsBuilt = 0): NavGrid {
  const l = layoutOf(layout, roomsBuilt);
  const level = wingLevel(l.wing);
  const built = roomsLevel(l.rooms);
  const key = `${level}:${built}:${furnitureKey(l.furniture)}`;
  const cached = OFFICE_NAVS.get(key);
  if (cached) {
    // Used last: the one to keep when the others are let go.
    OFFICE_NAVS.delete(key);
    OFFICE_NAVS.set(key, cached);
    return cached;
  }
  // Through where the north wall was, into the back office: between its walls, short of its back one.
  // And out through the west wall into each meeting room built, through its doorway: a little way in
  // on the office's side too, so the doorway joins up.
  const wingRooms = WING_ROOMS.slice(0, built);
  const on: Floorplan = (x, z, m) =>
    (x > FLOOR.minX + m && x < FLOOR.maxX - m && z > FLOOR.minZ + m && z < FLOOR.maxZ - m) ||
    (level > 0 && x > WING.minX + m && x < WING.maxX - m && z > wingMinZ(level) + m && z < FLOOR.maxZ - m) ||
    wingRooms.some((r) => x > FLOOR.minX - ROOMS_WING.depth + m && x < FLOOR.minX + 1 && z > r.z0 + m && z < r.z1 - m);
  const grid = new NavGrid({ ...FLOOR, minX: FLOOR.minX - (built ? ROOMS_WING.depth : 0), minZ: wingMinZ(level) }, obstacles(level, built, l.furniture), on);
  // Only the last few arrangements are kept: the floors take turns, and a drag tries many.
  if (OFFICE_NAVS.size >= 24) OFFICE_NAVS.delete(OFFICE_NAVS.keys().next().value!);
  OFFICE_NAVS.set(key, grid);
  return grid;
}

/** The office floor as it is until it's built out. */
export const OFFICE_NAV = officeNav(0);

export function walkable(x: number, z: number, wing: number | Layout = 0, rooms = 0): boolean {
  return officeNav(wing, rooms).walkable(x, z);
}

/** The middle of the nearest cell it can stand in on the office floor. */
export function nearestWalkable(p: Pt, wing: number | Layout = 0, rooms = 0): Pt {
  return officeNav(wing, rooms).nearestWalkable(p);
}

/** A* over the office floor's grid, then pulled tight: the corners of a route from `from` to `to`, both included. */
export function route(from: Pt, to: Pt, wing: number | Layout = 0, rooms = 0): Pt[] {
  return officeNav(wing, rooms).route(from, to);
}

class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }
  pop(): number {
    const { items, keys } = this;
    const top = items[0];
    const item = items.pop()!;
    const key = keys.pop()!;
    if (items.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= items.length) break;
        const m = l + 1 < items.length && keys[l + 1] < keys[l] ? l + 1 : l;
        if (keys[m] >= key) break;
        items[i] = items[m];
        keys[i] = keys[m];
        i = m;
      }
      items[i] = item;
      keys[i] = key;
    }
    return top;
  }
}


// ---- Sent home ----------------------------------------------------------------------------------

/** Just inside the exit door, in the west wall. */
const EXIT: Pt = [FLOOR.minX + 0.45, EXIT_DOOR.u];
/** Just inside the balcony doors, in the south wall. */
const BALCONY_IN: Pt = [BALCONY_DOOR.u, FLOOR.maxZ - 0.45];
/** Down the middle of the steps outside it. */
const STEPS_X = (EXIT_STAIRS.minX + EXIT_STAIRS.maxX) / 2;
/** Along the near sidewalk, between the lot and the trees planted in it. */
const SIDEWALK_Z = ROAD.minZ - 1.7;
/** How far west along the sidewalk they get before they're gone. */
const WALK_OFF_X = -38;

/** Where a worker called to a meeting comes in: out of the elevator. */
const IN_FROM: Pt = [ELEVATOR.x, ELEVATOR_FRONT + 0.5];

/**
 * A worker's walk in to its seat when it's called to a meeting: out of the elevator and round the
 * furniture to beside its chair (the last point), on whichever side is the shorter way, where it hops on.
 */
export function wayIn(seat: DeskDef, wing: number | Layout = 0, rooms = 0): Pt[] {
  return officeNav(wing, rooms).wayTo(IN_FROM, seat);
}

/**
 * A worker's walk out of the building once it's sent home. The first point is where it hops down,
 * beside its chair (or its bean bag) on whichever side is the shorter way out; then round the
 * furniture to the exit door in the west wall, across the landing outside, down the steps to the
 * street and off along the sidewalk.
 */
export function wayHome(seat: DeskDef, wing: number | Layout = 0, rooms = 0): Pt[] {
  const inside = wayTo(seat, EXIT, wing, rooms);
  const { landingZ1, steps, run } = EXIT_STAIRS;
  return [...inside, [STEPS_X, EXIT_DOOR.u], ...walkOff([STEPS_X, landingZ1 + (steps - 1) * run + 0.6])];
}

/**
 * The same walk on a floor above the bottom one, which has no exit door: round the furniture to the
 * balcony doors, out across the balcony and up to its railing (PARACHUTE.jump), where it goes over.
 */
export function wayToBalcony(seat: DeskDef, wing: number | Layout = 0, rooms = 0): Pt[] {
  const inside = wayTo(seat, BALCONY_IN, wing, rooms);
  return [...inside, [BALCONY_DOOR.u, BALCONY.minZ + 0.4], [PARACHUTE.jump.x, PARACHUTE.jump.z]];
}

/** From `from`, down on the street, over to the near sidewalk and off along it to the west, where they're gone. */
export function walkOff(from: Pt): Pt[] {
  return [from, [from[0], SIDEWALK_Z], [WALK_OFF_X, SIDEWALK_Z]];
}

/** From beside `seat`, where it hops down, round the furniture to `door` on the office floor. */
function wayTo(seat: DeskDef, door: Pt, wing: number | Layout, rooms: number): Pt[] {
  return officeNav(wing, rooms).wayFrom(seat, door);
}
