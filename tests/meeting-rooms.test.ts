import test from 'node:test';
import assert from 'node:assert/strict';
import { BEANBAGS, BOOKSHELF, CABINET, DESKS, DESK_SIZE, ELEVATOR, ELEVATOR_FRONT, EXIT_STAIRS, FLOOR, GONG, JUKEBOX, LOFT, MEETING_ROOMS, ROOMS_WING, STAIRS, STATIONS, WALL_T, WHITEBOARD, WING_DESKS, WING_ROOMS, builtMeetingRooms, deskSeat, roomFrame, type DeskDef } from '../src/shared/layout.js';
import { deskPoint, walkable, wayIn } from '../src/shared/nav.js';

type Box = [number, number, number, number]; // minX, maxX, minZ, maxZ
const hit = (a: Box, b: Box) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];
const outline = (r: { minX: number; maxX: number; minZ: number; maxZ: number }): Box => [r.minX, r.maxX, r.minZ, r.maxZ];
const LEVELS = Array.from({ length: ROOMS_WING.rooms + 1 }, (_, i) => i);

/** The rest of the office floor, as boxes with some air round them (the walkway they leave is checked separately). */
function furniture(): [string, Box][] {
  const hw = DESK_SIZE.width / 2;
  const hd = DESK_SIZE.depth / 2;
  const out: [string, Box][] = [];
  for (const d of [...DESKS, ...WING_DESKS]) {
    out.push([d.id, [d.x - hw, d.x + hw, d.z - hd, d.z + hd]]);
    const [cx, cz] = deskPoint(d, 0, 0.9);
    out.push([`${d.id} chair`, [cx - 0.4, cx + 0.4, cz - 0.4, cz + 0.4]]);
  }
  for (const b of BEANBAGS) out.push([b.id, [b.x - 1.1, b.x + 1.1, b.z - 1.1, b.z + 1.1]]);
  for (const k of STATIONS) out.push([k.id, [k.x - 1, k.x + 1, k.z - 1, k.z + 1]]);
  out.push(['couch', [10, 11, -2.2, 2.2]], ['coffee table', [12.2, 13.8, -0.8, 0.8]], ['kitchen', [-17, -10.75, 11.7, 12.7]]);
  out.push(['loft', outline(LOFT)], ['stairs', [STAIRS.fromX, STAIRS.toX, STAIRS.minZ, STAIRS.maxZ]]);
  out.push(['elevator', [ELEVATOR.x - ELEVATOR.width / 2, ELEVATOR.x + ELEVATOR.width / 2, FLOOR.minZ, ELEVATOR_FRONT + 0.5]]);
  out.push(['gong', [GONG.x - GONG.width / 2, GONG.x + GONG.width / 2, GONG.z - 0.5, GONG.z + 0.5]]);
  out.push(['whiteboard', [WHITEBOARD.x - WHITEBOARD.width / 2, WHITEBOARD.x + WHITEBOARD.width / 2, WHITEBOARD.z - 0.5, WHITEBOARD.z + 0.5]]);
  out.push(['jukebox', [JUKEBOX.x - 1, FLOOR.maxX, JUKEBOX.z - 0.9, JUKEBOX.z + 0.9]], ['cabinet', [CABINET.x - 1, FLOOR.maxX, CABINET.z - 0.6, CABINET.z + 0.6]]);
  out.push(['bookshelf', [BOOKSHELF.x - 1, BOOKSHELF.x + 1, BOOKSHELF.z - 1, FLOOR.maxZ]]);
  return out;
}

test('there are four rooms: the first keeps its id, the second the old review room’s (so saved meetings and workers still find their chairs)', () => {
  assert.deepEqual(MEETING_ROOMS.map((r) => r.id), ['meeting', 'review', 'room-3', 'room-4']);
  assert.deepEqual(MEETING_ROOMS[1].seats.map((d) => d.id), ['review-1', 'review-2', 'review-3', 'review-4', 'review-5']);
  assert.deepEqual(MEETING_ROOMS[0].seats.map((d) => d.id), ['meeting-1', 'meeting-2', 'meeting-3', 'meeting-4', 'meeting-5']);
  for (const r of MEETING_ROOMS) assert.ok(!/review/i.test(r.label + r.place), `${r.id} isn’t called a review room`);
  // Out of the box a floor has the room under the loft only; the rest come with the meeting wing, a room at a time.
  assert.deepEqual(builtMeetingRooms(MEETING_ROOMS, 0).map((r) => r.id), ['meeting']);
  assert.deepEqual(builtMeetingRooms(MEETING_ROOMS, 2).map((r) => r.id), ['meeting', 'review', 'room-3']);
  assert.deepEqual(builtMeetingRooms(MEETING_ROOMS, 99).map((r) => r.id), MEETING_ROOMS.map((r) => r.id));
});

test('the room under the loft is the identity case of a room’s frame, and the wing’s rooms face east', () => {
  const first = roomFrame(MEETING_ROOMS[0].room);
  assert.deepEqual(first.toWorld(5, 2), [5, MEETING_ROOMS[0].room.minZ + 2]);
  for (const { room } of MEETING_ROOMS.slice(1)) {
    const f = roomFrame(room);
    assert.equal(room.facing, 'east');
    const [x, z] = f.toWorld(room.door.u0, 1);
    assert.deepEqual(f.toLocal(x, z).map((n) => +n.toFixed(6)), [+room.door.u0.toFixed(6), 1]);
    assert.ok(Math.abs(x - (room.maxX - 1)) < 1e-9 && Math.abs(z - room.door.u0) < 1e-9, 'v goes west from the door, u runs south along the wall');
  }
});

test('the meeting wing fits: its rooms are out through the west wall, clear of each other, the exit door and its landing, and the street', () => {
  const spans = WING_ROOMS;
  assert.equal(spans.length, ROOMS_WING.rooms);
  spans.forEach((s, i) => {
    if (i) assert.ok(Math.abs(s.z0 - spans[i - 1].z1 - ROOMS_WING.wall) < 1e-9, 'a wall’s width between two rooms');
  });
  const south = spans[spans.length - 1].z1 + WALL_T;
  assert.ok(spans[0].z0 - WALL_T > FLOOR.minZ, 'short of the north wall');
  assert.ok(south < EXIT_STAIRS.landingZ0 - 1, `${south} leaves a metre and more to the exit landing at ${EXIT_STAIRS.landingZ0}`);
  // The outside of the wing is on the lawn, short of the sidewalk (x -22 where the street's block starts).
  assert.ok(FLOOR.minX - ROOMS_WING.depth - WALL_T > -22, 'short of the sidewalk');
  for (const r of MEETING_ROOMS.filter((m) => m.room.style === 'wing')) {
    // Nothing stands in front of its door, nor are the west bean bags in the way of any door.
    const front: Box = [r.room.maxX, r.room.maxX + 1.4, r.room.door.u0 - 0.4, r.room.door.u1 + 0.4];
    for (const [what, box] of furniture()) assert.ok(!hit(front, box), `${r.id}: the ${what} is in front of its door`);
  }
});

test('the meeting rooms fit the floor: not on each other, nor on any furniture, and inside the walls', () => {
  const rooms = MEETING_ROOMS.map((r) => r.room);
  rooms.forEach((a, i) => {
    const wing = a.style === 'wing';
    assert.ok((wing ? a.minX >= FLOOR.minX - ROOMS_WING.depth : a.minX >= FLOOR.minX) && a.maxX <= FLOOR.maxX && a.minZ >= FLOOR.minZ && a.maxZ <= FLOOR.maxZ, `${MEETING_ROOMS[i].id} is on the floor`);
    for (const b of rooms.slice(i + 1)) assert.ok(!hit(outline(a), outline(b)), 'two rooms overlap');
    // The first room is under the loft on purpose; the wing's are outside the floor, with their own check above.
    if (a.style !== 'wing') return;
    for (const [what, box] of furniture()) assert.ok(!hit(outline(a), box), `${MEETING_ROOMS[i].id} room is in the way of the ${what}`);
  });
});

test('a meeting room’s chairs fit inside it, its table clear of the walls, and its door leads in to open floor', () => {
  for (const { id, room, table, board, seats, level } of MEETING_ROOMS) {
    const f = roomFrame(room);
    const [tu, tv] = f.toLocal(table.x, table.z);
    const east = room.facing === 'east';
    const eu = (east ? table.depth : table.width) / 2;
    const ev = (east ? table.width : table.depth) / 2;
    assert.ok(tu - eu > f.u0 + 0.6 && tu + eu < f.u1 - 0.6 && tv - ev > 0.3 && tv + ev < f.depth - 0.3, `${id}: a way round the table`);
    for (const d of seats) {
      const c = deskSeat(d, 0.85);
      const [u, v] = f.toLocal(c.x, c.z);
      assert.ok(u > f.u0 + 0.3 && u < f.u1 - 0.3 && v > 0.3 && v < f.depth - 0.3, `${d.id} is inside ${id}`);
    }
    // A way in: the doorway and the floor just outside and inside it are open (with the room built out).
    const du = (room.door.u0 + room.door.u1) / 2;
    for (const dv of [-0.6, 0, 0.4]) {
      const [x, z] = f.toWorld(du, dv);
      assert.ok(walkable(x, z, 0, level ?? 0), `${id}: the doorway is open (${dv})`);
    }
    // The board faces the door head-on, and nobody’s chair is on the line between them.
    const [bu, bv] = f.toLocal(board.x, board.z);
    assert.ok(Math.abs(bu - du) < 0.01, `${id}: the board is straight across from the door`);
    assert.ok(bv > tv, `${id}: the board is on the far wall`);
    for (const d of seats) {
      const c = deskSeat(d, 0.85);
      assert.ok(Math.abs(f.toLocal(c.x, c.z)[0] - du) > 0.7, `${d.id} isn’t in the line from the door to the board`);
    }
  }
});

test('every chair in every room can be reached from the elevator, at every build-out, and has its own place', () => {
  const ids = new Set<string>();
  for (const level of LEVELS) {
    for (const { seats } of builtMeetingRooms(MEETING_ROOMS, level)) {
      assert.ok(seats.length >= 3 && seats.length <= 5, 'three to five chairs');
      for (const d of seats as DeskDef[]) {
        if (!level) {
          assert.ok(!ids.has(d.id), `${d.id} is unique`);
          ids.add(d.id);
        }
        const way = wayIn(d, 0, level);
        assert.ok(way.length > 1, `${d.id} has a way in (${level} rooms built)`);
        assert.ok(way.slice(0, -1).every(([x, z]) => walkable(x, z, 0, level)), `${d.id}'s way is on open floor (${level} rooms built)`);
        const [ex, ez] = way[way.length - 1];
        assert.ok(Math.hypot(ex - d.x, ez - d.z) < 1.3, `${d.id} ends beside its chair`);
      }
    }
  }
  // The rooms of the wing are ids of their own: no two chairs anywhere share one.
  const all = MEETING_ROOMS.flatMap((r) => r.seats.map((d) => d.id));
  assert.equal(new Set(all).size, all.length);
});
