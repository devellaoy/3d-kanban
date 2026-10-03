import test from 'node:test';
import assert from 'node:assert/strict';
import { BALCONY, BALCONY_DOOR, ELEVATOR, ELEVATOR_FRONT, EXIT_DOOR, EXIT_STAIRS, FLOOR, MEETING_ROOMS, PARACHUTE, ROAD, ROOMS_WING, SEATS, STATIONS, WING, builtMeetingRooms, deskBuilt, roomFrame, wingMinZ, type DeskDef } from '../src/shared/layout.js';
import { route, walkable, wayHome, wayIn, wayToBalcony, type Pt } from '../src/shared/nav.js';

/** Every place a worker can be on a floor built out `wing` rows and `rooms` meeting rooms, at the build-outs there are (none, the back office's, the wing's, both). */
const everywhere = (): [DeskDef, number, number][] =>
  [[0, 0], [WING.rows, 0], [0, ROOMS_WING.rooms], [WING.rows, ROOMS_WING.rooms]].flatMap(([wing, rooms]) =>
    [...SEATS, ...STATIONS, ...builtMeetingRooms(MEETING_ROOMS, rooms).flatMap((r) => r.seats)].filter((d) => deskBuilt(d, wing)).map((d): [DeskDef, number, number] => [d, wing, rooms]),
  );

test('a worker sent home walks round the furniture, out the exit door and off along the sidewalk', () => {
  for (const [seat, wing, rooms] of everywhere()) {
    const way = wayHome(seat, wing, rooms);
    // It hops down right beside where it sat.
    assert.ok(Math.hypot(way[0][0] - seat.x, way[0][1] - seat.z) < 1.2, `${seat.id} hops down beside its seat`);
    const out = way.findIndex(([x, z]) => x < FLOOR.minX && z > EXIT_DOOR.u - 1);
    assert.ok(out > 1, `${seat.id} leaves by the exit`);
    // From the aisle to the door, every step is on open floor.
    for (let i = 2; i < out; i++) {
      const [x0, z0] = way[i - 1];
      const [x1, z1] = way[i];
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.2);
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        assert.ok(walkable(x, z, wing, rooms), `${seat.id} (built out ${wing}, ${rooms} rooms) walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
    // Through the doorway, not the wall beside it.
    for (const [, z] of [way[out - 1], way[out]]) assert.ok(Math.abs(z - EXIT_DOOR.u) < EXIT_DOOR.width / 2 - 0.2, `${seat.id} goes through the door`);
    // Down the steps outside, then away along the sidewalk.
    assert.ok(way.slice(out).every(([x, z]) => x < EXIT_STAIRS.minX + 1 || z > ROAD.minZ - 2.1), `${seat.id} stays off the building`);
    const [ex, ez] = way[way.length - 1];
    assert.ok(ez > ROAD.minZ - 2 && ez < ROAD.minZ && ex < EXIT_STAIRS.minX - 10, `${seat.id} ends up down the sidewalk`);
  }
});

/** Every step from a to b is on open floor. */
function clear(a: Pt, b: Pt, what: string, rooms = 0) {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2);
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n;
    const z = a[1] + ((b[1] - a[1]) * k) / n;
    assert.ok(walkable(x, z, 0, rooms), `${what} walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
}

test('a worker called to a meeting walks from the elevator, in through its meeting room door, to beside its chair', () => {
  for (const rooms of [0, ROOMS_WING.rooms]) for (const { room, seats } of builtMeetingRooms(MEETING_ROOMS, rooms)) for (const seat of seats) {
    const f = roomFrame(room);
    const way = wayIn(seat, 0, rooms);
    const [x0, z0] = way[0];
    assert.ok(Math.abs(x0 - ELEVATOR.x) < 0.6 && z0 > ELEVATOR_FRONT && z0 < ELEVATOR_FRONT + 1.2, `${seat.id} steps out of the elevator`);
    // It ends beside its chair, and gets there on open floor.
    const [ex, ez] = way[way.length - 1];
    assert.ok(Math.hypot(ex - seat.x, ez - seat.z) < 1.3, `${seat.id} ends beside its chair`);
    for (let i = 1; i < way.length - 1; i++) clear(way[i - 1], way[i], seat.id, rooms);
    // Into the room through its doorway, not the glass: in the room's own frame, across v = 0 between the door's edges.
    const crossing = way.findIndex(([x, z], i) => i > 0 && f.toLocal(way[i - 1][0], way[i - 1][1])[1] < 0 && f.toLocal(x, z)[1] >= 0);
    assert.ok(crossing > 0, `${seat.id} goes into the room`);
    const [[au, av], [bu, bv]] = [f.toLocal(...way[crossing - 1]), f.toLocal(...way[crossing])];
    const u = au + ((bu - au) * (0 - av)) / (bv - av);
    assert.ok(u > room.door.u0 && u < room.door.u1, `${seat.id} goes in by the door (u ${u.toFixed(2)})`);
  }
});

test('upstairs, with no exit door, a worker sent home walks out onto the balcony to the railing', () => {
  for (const [seat, wing, rooms] of everywhere()) {
    const way = wayToBalcony(seat, wing, rooms);
    assert.ok(Math.hypot(way[0][0] - seat.x, way[0][1] - seat.z) < 1.2, `${seat.id} hops down beside its seat`);
    const out = way.findIndex(([, z]) => z > FLOOR.maxZ);
    assert.ok(out > 1, `${seat.id} goes out onto the balcony`);
    for (let i = 2; i < out; i++) {
      const [x0, z0] = way[i - 1];
      const [x1, z1] = way[i];
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.2);
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        assert.ok(walkable(x, z, wing, rooms), `${seat.id} (built out ${wing}, ${rooms} rooms) walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
    // Through the balcony doors, then straight across to the railing.
    for (const [x] of way.slice(out - 1)) assert.ok(Math.abs(x - BALCONY_DOOR.u) < BALCONY_DOOR.width / 2 - 0.3, `${seat.id} goes through the balcony doors`);
    const [jx, jz] = way[way.length - 1];
    assert.deepEqual([jx, jz], [PARACHUTE.jump.x, PARACHUTE.jump.z]);
    assert.ok(jz < BALCONY.maxZ && jz > BALCONY.maxZ - 0.6, `${seat.id} ends up at the railing`);
  }
});

test('the back office is only floor once it is built out, and only as far as it goes', () => {
  const inside: Pt = [(WING.minX + WING.maxX) / 2 + 1.7, FLOOR.minZ - 1];
  assert.equal(walkable(inside[0], inside[1], 0), false, 'behind the north wall there is nothing');
  for (let wing = 1; wing <= WING.rows; wing++) {
    assert.ok(walkable(inside[0], inside[1], wing), `built out ${wing}, its first row is open floor`);
    assert.equal(walkable(inside[0], wingMinZ(wing) - 0.5, wing), false, `built out ${wing}, past its back wall is not`);
    // And there's a way from the room to the back of it.
    const back: Pt = [WING.minX + 0.6, wingMinZ(wing) + 0.6];
    const way = route([0, 0], back, wing);
    const [ex, ez] = way[way.length - 1];
    assert.ok(Math.hypot(ex - back[0], ez - back[1]) < 0.6, `built out ${wing}, the route gets to the back of it`);
  }
  // Nowhere else through the north wall.
  assert.equal(walkable(0, FLOOR.minZ - 1, WING.rows), false);
});
