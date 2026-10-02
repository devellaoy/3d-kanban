import test from 'node:test';
import assert from 'node:assert/strict';
import { CAR, CARS, carPoint } from '../src/shared/garage.js';
import { COLUMN, GARAGE_COLUMNS, STREET_LAMPS } from '../src/shared/pillars.js';
import { FLOOR, ROAD, WALL_T } from '../src/shared/layout.js';
import { DOOR, ROOM } from '../src/client/features/gameroom/layout.js';

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
const hit = (a: Rect, b: Rect) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const column = ([x, z]: readonly [number, number]): Rect => ({ minX: x - COLUMN / 2, maxX: x + COLUMN / 2, minZ: z - COLUMN / 2, maxZ: z + COLUMN / 2 });

test('the garage has few columns, none in the aisle, the way out or a stall', () => {
  assert.ok(GARAGE_COLUMNS.length <= 6);
  const aisle = { minX: FLOOR.minX, maxX: FLOOR.maxX, minZ: -6, maxZ: 8 };
  const stalls = CARS.map((c) => {
    const a = carPoint(c, -CAR.width / 2, -CAR.length / 2);
    const b = carPoint(c, CAR.width / 2, CAR.length / 2);
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
  });
  const east = { minX: FLOOR.maxX - 1, maxX: FLOOR.maxX + WALL_T + 1, minZ: -8, maxZ: 8 };
  const south = { minX: FLOOR.minX + 2, maxX: FLOOR.maxX - 2, minZ: FLOOR.maxZ - 1, maxZ: FLOOR.maxZ + WALL_T + 1 };
  for (const p of GARAGE_COLUMNS) {
    const c = column(p);
    assert.ok(!hit(c, aisle), `column ${p} is out of the aisle`);
    assert.ok(!hit(c, east) && !hit(c, south), `column ${p} is clear of the exits`);
    stalls.forEach((s, i) => assert.ok(!hit(c, s), `column ${p} is clear of ${CARS[i].name}`));
  }
});

test('the game room doorway has nothing in front of it', () => {
  const path = { minX: ROOM.maxX, maxX: ROOM.maxX + 4, minZ: DOOR.z - DOOR.width / 2 - 0.5, maxZ: DOOR.z + DOOR.width / 2 + 0.5 };
  for (const p of GARAGE_COLUMNS) assert.ok(!hit(column(p), path), `column ${p} is not at the door`);
});

test('seven street lamps stand at the curbs, alternating, with no dark stretch', () => {
  assert.equal(STREET_LAMPS.length, 7);
  for (const l of STREET_LAMPS) assert.ok(l.z === ROAD.minZ - 0.2 || l.z === ROAD.maxZ + 0.2, 'at the curb, not out on the sidewalk or the road');
  const xs = STREET_LAMPS.map((l) => l.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] <= 14, 'no dark stretch');
});
