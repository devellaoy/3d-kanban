import test from 'node:test';
import assert from 'node:assert/strict';
import { BEANBAGS, BOOKSHELF, CABINET, DESKS, DESK_SIZE, ELEVATOR, ELEVATOR_FRONT, FLOOR, GONG, JUKEBOX, LOFT, MEETING_ROOMS, STAIRS, STATIONS, WHITEBOARD, WING_DESKS, deskSeat, type DeskDef } from '../src/shared/layout.js';
import { deskPoint, walkable, wayIn } from '../src/shared/nav.js';

type Box = [number, number, number, number]; // minX, maxX, minZ, maxZ
const hit = (a: Box, b: Box) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];
const outline = (r: { minX: number; maxX: number; minZ: number; maxZ: number }): Box => [r.minX, r.maxX, r.minZ, r.maxZ];

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

test('the meeting rooms fit the floor: not on each other, nor on any furniture, and inside the walls', () => {
  const rooms = MEETING_ROOMS.map((r) => r.room);
  rooms.forEach((a, i) => {
    assert.ok(a.minX >= FLOOR.minX && a.maxX <= FLOOR.maxX && a.minZ >= FLOOR.minZ && a.maxZ <= FLOOR.maxZ, `${MEETING_ROOMS[i].id} is on the floor`);
    for (const b of rooms.slice(i + 1)) assert.ok(!hit(outline(a), outline(b)), 'two rooms overlap');
    // The first room is under the loft on purpose; a room that stands free keeps clear of everything, with walkway round it.
    if (!a.free) return;
    for (const [what, box] of furniture()) assert.ok(!hit([a.minX - 0.8, a.maxX + 0.8, a.minZ - 0.8, a.maxZ + 0.8], box), `${MEETING_ROOMS[i].id} room is in the way of the ${what}`);
  });
});

test('a meeting room’s chairs fit inside it, its table clear of the walls, and its door leads in to open floor', () => {
  for (const { id, room, table, board, seats } of MEETING_ROOMS) {
    assert.ok(table.x - table.width / 2 > room.minX + 0.6 && table.x + table.width / 2 < room.maxX - 0.6 && table.z - table.depth / 2 > room.minZ + 0.6 && table.z + table.depth / 2 < room.maxZ - 0.6, `${id}: a way round the table`);
    for (const d of seats) {
      const c = deskSeat(d, 0.85);
      assert.ok(c.x > room.minX + 0.3 && c.x < room.maxX - 0.3 && c.z > room.minZ + 0.3 && c.z < room.maxZ - 0.3, `${d.id} is inside ${id}`);
    }
    // A way in: the doorway and the floor just outside and inside it are open.
    const dx = (room.door.x0 + room.door.x1) / 2;
    for (const dz of [-0.6, 0, 0.4]) assert.ok(walkable(dx, room.minZ + dz), `${id}: the doorway is open (${dz})`);
    // The board faces the door head-on, and nobody’s chair is on the line between them.
    assert.ok(Math.abs(board.x - dx) < 0.01, `${id}: the board is straight across from the door`);
    assert.ok(board.z > table.z, `${id}: the board is on the far wall`);
    for (const d of seats) assert.ok(Math.abs(deskSeat(d, 0.85).x - dx) > 0.7, `${d.id} isn’t in the line from the door to the board`);
  }
});

test('every chair in every room can be reached from the elevator, and has its own place', () => {
  const ids = new Set<string>();
  for (const { seats } of MEETING_ROOMS) {
    assert.ok(seats.length >= 3 && seats.length <= 5, 'three to five chairs');
    for (const d of seats as DeskDef[]) {
      assert.ok(!ids.has(d.id), `${d.id} is unique`);
      ids.add(d.id);
      const way = wayIn(d);
      assert.ok(way.length > 1, `${d.id} has a way in`);
      assert.ok(way.slice(0, -1).every(([x, z]) => walkable(x, z)), `${d.id}'s way is on open floor`);
      const [ex, ez] = way[way.length - 1];
      assert.ok(Math.hypot(ex - d.x, ez - d.z) < 1.3, `${d.id} ends beside its chair`);
    }
  }
});
