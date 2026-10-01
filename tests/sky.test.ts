import test from 'node:test';
import assert from 'node:assert/strict';
import { HAZE_MAX, WALL_TOP, hazeAt, hazeReach, indoorAt, roomAt, wingRoom } from '../src/client/world/sky.js';
import { BALCONY, DESKS, FLOOR, STREET_Y, WALL_HEIGHT, WING, roofDrop } from '../src/shared/layout.js';

// The haze over the weather outside (see HAZE in client/world/sky.ts): how far off it reaches, how it
// thins as you climb away from the street, and how much of it is left indoors, where the fog is the
// weather seen through a window rather than the weather you are standing in.

/** The foggiest the sky ever gets, down on the street with nothing else coming down: pea soup. */
const THICK = { near: 3, far: 28 };
/** And a clear day, which is what the office is in most of the time. */
const CLEAR = { near: 40, far: 90 };
/** Your eye on the bottom floor, the lowest you can stand and so the thickest of it over the street. */
const BOTTOM = 1.7 - STREET_Y;
/** The room's far corner from the near one: the longest sightline in the office to lose. */
const ACROSS = Math.hypot(FLOOR.maxX - FLOOR.minX, FLOOR.maxZ - FLOOR.minZ);
/** And the same on the roof of a six-floor building, the highest the office's haze is worked out for. */
const TOP = roofDrop(6) + 1.7;

test('a foggy afternoon outside leaves the far end of the office clear', () => {
  // Out of doors that sightline is simply gone: the haze runs from 3 m to 28 m.
  const street = hazeAt(ACROSS, THICK.near, THICK.far, BOTTOM, 0);
  assert.ok(street > 0.99, `${ACROSS.toFixed(0)} m away, out in it (${street.toFixed(2)})`);
  // Indoors it is a tenth of that, which is as much as a room this size needs to read as one.
  const room = hazeAt(ACROSS, THICK.near, THICK.far, BOTTOM, 1);
  assert.ok(room > 0 && room < 0.12, `inside the office (${room.toFixed(3)})`);
  // And at every distance across the room, for indoors to be the room rather than the weather.
  for (let at = 2; at <= ACROSS; at += 2) {
    const out = hazeAt(at, THICK.near, THICK.far, BOTTOM, 0);
    const inside = hazeAt(at, THICK.near, THICK.far, BOTTOM, 1);
    assert.ok(inside <= out * 0.1 + 1e-9, `at ${at} m: ${inside.toFixed(3)} inside against ${out.toFixed(2)} out`);
    assert.ok(inside <= 0.1 + 1e-9, `at ${at} m: ${inside.toFixed(3)} inside`);
  }
});

test('a clear day leaves the room much as it was', () => {
  // In the clear the room is barely inside the fog at all, so there is little either way to take off.
  assert.ok(hazeAt(ACROSS, CLEAR.near, CLEAR.far, BOTTOM, 0) < 0.03, 'outdoors');
  assert.ok(hazeAt(ACROSS, CLEAR.near, CLEAR.far, BOTTOM, 1) < 0.005, 'indoors');
});

test('outdoors the haze still thins as you climb, and still stops at HAZE_MAX', () => {
  // From the roof of six floors you see nearly three and a half times as far as from the street
  // (see HAZE_ABOVE), and the same distance in the fog clears from a different window.
  assert.ok(hazeReach(TOP, CLEAR.far) > hazeReach(0, CLEAR.far) * 3.3, `${hazeReach(0, CLEAR.far).toFixed(0)} m to ${hazeReach(TOP, CLEAR.far).toFixed(0)} m`);
  assert.ok(hazeAt(60, THICK.near, THICK.far, TOP) < hazeAt(60, THICK.near, THICK.far, 0), 'clearer up high');
  // Past HAZE_MAX there is nothing built to see, whatever the height and whatever the weather.
  assert.equal(hazeAt(HAZE_MAX, THICK.near, THICK.far, 0, 0), 1);
  assert.equal(hazeAt(HAZE_MAX * 2, THICK.near, THICK.far, TOP, 0), 1);
});

// Which room a point is in (skyInsideOf in the shader, roomAt here), and that the fog is
// only kept off it when you're in there too (skyInRoom, indoorAt).

/** Your eye at a desk, and the far corner of the room from it. */
const DESK = { x: DESKS[0].x, y: 1.7, z: DESKS[0].z };
const CORNER = { x: FLOOR.maxX - 0.5, y: 1, z: FLOOR.minZ + 0.5 };
/** Out of doors, all of it on the floor's own coordinates (the street is STREET_Y under it). */
const OUT = {
  balcony: { x: (BALCONY.minX + BALCONY.maxX) / 2, y: 1, z: (BALCONY.minZ + BALCONY.maxZ) / 2 },
  roofDeck: { x: 0, y: WALL_HEIGHT + 0.5, z: 0 },
  garage: { x: 0, y: -2, z: 0 },
  street: { x: 0, y: STREET_Y + 1.7, z: BALCONY.maxZ + 12 },
};

test('the room is the office up to its walls, and the back office once there is one', () => {
  assert.equal(roomAt(DESK, WALL_TOP, null), 1);
  assert.equal(roomAt(CORNER, WALL_TOP, null), 1);
  for (const [name, p] of Object.entries(OUT)) assert.equal(roomAt(p, WALL_TOP, null), 0, name);
  // The shaft up through the open top is the lamplight's (skyInOffice), not the haze's.
  assert.equal(roomAt(OUT.roofDeck, 40, null), 1);
  const back = { x: (WING.minX + WING.maxX) / 2, y: 1.7, z: FLOOR.minZ - WING.row / 2 };
  assert.equal(roomAt(back, WALL_TOP, null), 0, 'not built out');
  assert.equal(roomAt(back, WALL_TOP, wingRoom(1)), 1, 'built out a row');
  assert.equal(roomAt({ ...back, y: WALL_TOP + 0.5 }, WALL_TOP, wingRoom(1)), 0, 'its roof');
});

test('the fog is kept off the room only from inside it', () => {
  assert.equal(indoorAt(DESK, CORNER), 1);
  // From the street or the balcony, the office through its windows is as foggy as the rest.
  assert.equal(indoorAt(OUT.street, DESK), 0);
  assert.equal(indoorAt(OUT.balcony, DESK), 0);
  // And from inside, the street through the windows still is.
  assert.equal(indoorAt(DESK, OUT.street), 0);
  const far = Math.hypot(OUT.street.x - DESK.x, OUT.street.z - DESK.z);
  assert.ok(hazeAt(far, THICK.near, THICK.far, BOTTOM, indoorAt(OUT.street, DESK)) > 0.99, 'the office from the street');
});
