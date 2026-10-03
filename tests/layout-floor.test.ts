import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEANBAGS, BOARDS, BOOKSHELF, CABINET, DESKS, DESK_SIZE, ELEVATOR, ELEVATOR_FRONT, FLOOR, GONG, JUKEBOX, KIOSK, LOFT, MEETING_ROOMS, ROOMS_WING, SEATS, STAIRS, STATIONS, TV, WHITEBOARD, WING, WING_DESKS,
  builtMeetingRooms, deskSeat, wingMinZ, type DeskDef,
} from '../src/shared/layout.js';
import { deskPoint, officeNav, wayIn } from '../src/shared/nav.js';
import { ART_OBSTACLES } from '../src/shared/art.js';

type Box = [number, number, number, number]; // minX, maxX, minZ, maxZ
/** Whether two footprints overlap by more than a hair (desks standing back to back touch). */
const hit = (a: Box, b: Box, e = 0.03) => a[0] < b[1] - e && a[1] > b[0] + e && a[2] < b[3] - e && a[3] > b[2] + e;

interface Thing {
  name: string;
  /** Things of one group may touch (a desk and its chair, a room and its own table). */
  group: string;
  box: Box;
  wing?: number;
}

/** Everything that stands on the office floor, as a footprint, with the meeting wing's rooms built out `rooms`. */
function things(rooms: number): Thing[] {
  const out: Thing[] = [];
  const hw = DESK_SIZE.width / 2;
  const hd = DESK_SIZE.depth / 2;
  for (const d of [...DESKS, ...WING_DESKS]) {
    out.push({ name: d.id, group: `desk ${d.id}`, box: [d.x - hw, d.x + hw, d.z - hd, d.z + hd], wing: d.wing });
    const [cx, cz] = deskPoint(d, 0, 0.9);
    out.push({ name: `${d.id} chair`, group: `desk ${d.id}`, box: [cx - 0.3, cx + 0.3, cz - 0.3, cz + 0.3], wing: d.wing });
  }
  for (const b of BEANBAGS) out.push({ name: b.id, group: b.id, box: [b.x - 0.6, b.x + 0.6, b.z - 0.6, b.z + 0.6] });
  for (const k of STATIONS) out.push({ name: k.id, group: k.id, box: [k.x - KIOSK.width / 2, k.x + KIOSK.width / 2, k.z - 0.4, k.z + 0.4] });
  out.push({ name: 'couch', group: 'lounge', box: [10, 11, -2.2, 2.2] });
  out.push({ name: 'coffee table', group: 'lounge', box: [12.2, 13.8, -0.8, 0.8] });
  for (const [i, [x, z]] of [[12.5, 3.5], [14.5, -3.4]].entries()) out.push({ name: `pouf ${i + 1}`, group: 'lounge', box: [x - 0.5, x + 0.5, z - 0.5, z + 0.5] });
  out.push({ name: 'kitchen', group: 'kitchen', box: [-17, -10.75, 11.7, 12.7] });
  out.push({ name: 'whiteboard', group: 'whiteboard', box: [WHITEBOARD.x - WHITEBOARD.width / 2, WHITEBOARD.x + WHITEBOARD.width / 2, WHITEBOARD.z - 0.5, WHITEBOARD.z + 0.5] });
  out.push({ name: 'elevator', group: 'elevator', box: [ELEVATOR.x - ELEVATOR.width / 2, ELEVATOR.x + ELEVATOR.width / 2, FLOOR.minZ, ELEVATOR_FRONT] });
  out.push({ name: 'gong', group: 'gong', box: [GONG.x - GONG.width / 2, GONG.x + GONG.width / 2, GONG.z - 0.4, GONG.z + 0.4] });
  out.push({ name: 'jukebox', group: 'jukebox', box: [JUKEBOX.x - JUKEBOX.depth / 2, FLOOR.maxX, JUKEBOX.z - JUKEBOX.width / 2, JUKEBOX.z + JUKEBOX.width / 2] });
  out.push({ name: 'cabinet', group: 'cabinet', box: [CABINET.x - 0.45, FLOOR.maxX, CABINET.z - CABINET.width / 2, CABINET.z + CABINET.width / 2] });
  out.push({ name: 'bookshelf', group: 'bookshelf', box: [BOOKSHELF.x - BOOKSHELF.width / 2, BOOKSHELF.x + BOOKSHELF.width / 2, BOOKSHELF.z - BOOKSHELF.depth / 2, FLOOR.maxZ] });
  out.push({ name: 'stairs', group: 'stairs', box: [STAIRS.fromX, STAIRS.toX, STAIRS.minZ, STAIRS.maxZ] });
  // The loft is over the first meeting room (its group), on posts.
  out.push({ name: 'loft', group: 'meeting', box: [LOFT.minX, LOFT.maxX, LOFT.minZ, LOFT.maxZ] });
  for (const r of builtMeetingRooms(MEETING_ROOMS, rooms)) out.push({ name: `room ${r.id}`, group: r.id, box: [r.room.minX, r.room.maxX, r.room.minZ, r.room.maxZ] });
  for (const a of ART_OBSTACLES) out.push({ name: a.name, group: a.name, box: [a.minX, a.maxX, a.minZ, a.maxZ] });
  return out;
}

test('everything stands inside the floor (the back office’s desks inside the back office, the wing’s rooms inside the wing) and nothing overlaps anything else', () => {
  for (const rooms of [0, ROOMS_WING.rooms]) {
    const all = things(rooms);
    for (const t of all) {
      const west = t.group.match(/^(review|room-\d)$/) ? FLOOR.minX - ROOMS_WING.depth : FLOOR.minX;
      const minZ = t.wing ? wingMinZ(t.wing) : FLOOR.minZ;
      assert.ok(t.box[0] >= west - 1e-6 && t.box[1] <= FLOOR.maxX + 1e-6 && t.box[2] >= minZ - 1e-6 && t.box[3] <= FLOOR.maxZ + 1e-6, `${t.name} is inside the walls (${rooms} rooms)`);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[i].group === all[j].group) continue;
        assert.ok(!hit(all[i].box, all[j].box), `${all[i].name} overlaps ${all[j].name} (${rooms} rooms)`);
      }
    }
  }
  for (const [key, b] of Object.entries(BOARDS)) {
    const along = Math.abs(Math.cos(b.rotY)) > 0.5 ? [b.x - b.width / 2, b.x + b.width / 2, FLOOR.minX, FLOOR.maxX] : [b.z - b.width / 2, b.z + b.width / 2, FLOOR.minZ, FLOOR.maxZ];
    assert.ok(along[0] >= along[2] && along[1] <= along[3], `the ${key} board fits its wall`);
  }
  assert.ok(TV.z - TV.width / 2 >= FLOOR.minZ && TV.z + TV.width / 2 <= LOFT.minZ, 'the TV is on the wall above the lounge, clear of the loft');
});

test('every bean bag has room to walk round it: a bean bag and its lap desk keep 0.8 m from the next piece of furniture', () => {
  const all = things(ROOMS_WING.rooms);
  for (const b of BEANBAGS) {
    const box: Box = [b.x - 1.1, b.x + 1.1, b.z - 1.1, b.z + 1.1];
    for (const t of all) {
      if (t.group === b.id || t.name.startsWith('beanbag') || t.group === 'meeting') continue;
      assert.ok(!hit(box, t.box, 0.2), `${b.id} crowds the ${t.name}`);
    }
  }
});

test('every seat (desks, the back office, bean bags, kiosks, the chairs of all four meeting rooms) is connected to the elevator, whatever is built out', () => {
  for (const [wing, rooms] of [[0, 0], [WING.rows, 0], [0, ROOMS_WING.rooms], [WING.rows, ROOMS_WING.rooms]]) {
    const nav = officeNav(wing, rooms);
    const seats: DeskDef[] = [...SEATS, ...STATIONS, ...builtMeetingRooms(MEETING_ROOMS, rooms).flatMap((r) => r.seats)].filter((d) => !d.wing || d.wing <= wing);
    for (const d of seats) {
      const way = wayIn(d, wing, rooms);
      assert.ok(way.length > 1, `${d.id} has a way in (${wing} rows, ${rooms} rooms)`);
      for (const [x, z] of way.slice(0, -1)) assert.ok(nav.walkable(x, z), `${d.id}'s way is on open floor at ${x.toFixed(2)}, ${z.toFixed(2)} (${wing} rows, ${rooms} rooms)`);
      const [ex, ez] = way[way.length - 1];
      const at = deskSeat(d, 0.85);
      assert.ok(Math.hypot(ex - d.x, ez - d.z) < 1.9 || Math.hypot(ex - at.x, ez - at.z) < 1.9, `${d.id} ends beside its seat`);
    }
  }
});
