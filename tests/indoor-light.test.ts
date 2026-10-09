// The office's indoor light (#118): lamps over every part of the floor, the wall switches finding their
// lamps by the area the room tags them with, and Settings' Indoor lights (world/roomlight.ts setRoomGain).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAX_ROOM_LAMPS, lampCover, lampLightAt, lightRoom, roomGain, roomLevel, roomUniforms, setRoomGain, type RoomLamp } from '../src/client/world/roomlight.js';
import { CEILING_LAMPS, LAMP_Y, pendantLight } from '../src/client/world/office/ceiling-lamps.js';
import { lightSwitches } from '../src/client/features/lights/world.js';
import type { Site } from '../src/client/world/office/fixture.js';
import type { NightParts } from '../src/client/world/outside.js';
import { loadSettings } from '../src/client/state/index.js';
import { FLOOR, MEETING_ROOM, ROOMS_WING, STAIRS } from '../src/shared/layout.js';

const UP = { x: 0, y: 1, z: 0 };

/** A pendant as world/office/props.ts makes it, as far as the switches go: its bulb is child 2. */
function pendant() {
  const lamp = new THREE.Group();
  lamp.add(new THREE.Group(), new THREE.Mesh(), new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshToonMaterial()));
  return lamp;
}

/** The room's ceiling lamps hung as the office hangs them (room.ts's `lamps`), on a bare site for its wall switches. */
function hang() {
  const night = { halos: [], roomLamps: [] as RoomLamp[] } as unknown as NightParts;
  const group = new THREE.Group();
  for (const { x, z, area, reach } of CEILING_LAMPS) {
    const lamp = pendant();
    lamp.position.set(x, LAMP_Y, z);
    lamp.userData.area = area;
    group.add(lamp);
    night.roomLamps.push({ ...pendantLight(x, LAMP_Y, z, reach), area });
  }
  const site = { group, get: () => night, wall: () => {} } as unknown as Site;
  return { night, group, site };
}

test('every ceiling lamp hangs with its switch’s area, and the lamps all fit in the shader with every room built', () => {
  const { night, group } = hang();
  assert.equal(night.roomLamps.length, CEILING_LAMPS.length);
  for (const area of ['lounge', 'desks']) {
    assert.ok(night.roomLamps.some((l) => l.area === area), `${area} has lamps`);
    assert.equal(group.children.filter((o) => o.userData.area === area).length, night.roomLamps.filter((l) => l.area === area).length);
  }
  // The room's, the boss office's, a lamp per back-office row and two per meeting room, all at once.
  assert.ok(CEILING_LAMPS.length + 1 + 2 + 2 * (1 + ROOMS_WING.rooms) <= MAX_ROOM_LAMPS);
});

test('a wall switch dims only the lamps tagged with its area', () => {
  const { night, site } = hang();
  const wingLamp: RoomLamp = { ...night.roomLamps[0], area: undefined, level: 1 };
  night.roomLamps.push(wingLamp);
  const switches = lightSwitches(site).handle!.lightSwitches;
  switches.apply({ lounge: false, desks: true }, true);
  for (const l of night.roomLamps) assert.equal(l.level, l.area === 'lounge' ? 0 : 1, `${l.area} at (${l.x}, ${l.z})`);
  assert.equal(wingLamp.level, 1, 'a lamp no switch has stays on');
});

/** Whether (x, z) is on the floor people stand on downstairs: not in the meeting room or under the stairs. */
const open = (x: number, z: number) =>
  !(x > MEETING_ROOM.minX && z > MEETING_ROOM.minZ) && !(x > STAIRS.fromX && z > STAIRS.minZ);

test('at night no part of the floor is left in the dark: the lamps reach all of it', () => {
  const { night } = hang();
  lightRoom(night.roomLamps, 1);
  let darkest = Infinity;
  let where = '';
  for (let x = FLOOR.minX + 0.5; x < FLOOR.maxX; x += 1) {
    for (let z = FLOOR.minZ + 0.5; z < FLOOR.maxZ; z += 1) {
      if (!open(x, z)) continue;
      const p = { x, y: 0, z };
      const lit = lampLightAt(p, UP, night.roomLamps) + lampCover(p, night.roomLamps);
      if (lit < darkest) [darkest, where] = [lit, `(${x}, ${z})`];
    }
  }
  assert.ok(darkest > 0.35, `the darkest spot ${where} gets ${darkest.toFixed(2)}`);
});

test('Indoor lights turns the lamps’ light up and down, never the base light or the daylight', (t) => {
  t.after(() => setRoomGain(1));
  const { night } = hang();
  const under = { x: -10.5, y: 0, z: -4 };
  const at = (k: number) => {
    setRoomGain(k);
    lightRoom(night.roomLamps, 1);
    return { color: roomUniforms.skyRoomLampColors.value[0].x, sun: roomUniforms.skyLampSun.value.r, level: roomLevel(under, night.roomLamps, 0.1), pool: lampLightAt(under, UP, night.roomLamps) };
  };
  const usual = at(1);
  const bright = at(2);
  const off = at(0);
  assert.ok(bright.color > usual.color && bright.sun > usual.sun && bright.pool > usual.pool);
  assert.ok(Math.abs(bright.color - 2 * usual.color) < 1e-6);
  assert.equal(off.color, 0);
  assert.equal(off.sun, 0);
  assert.ok(off.level >= 0.15, 'with the lamps turned all the way down a corner still gets the base light');
  // The cover (how near a lamp is) doesn't change: it is where the light from overhead comes from.
  assert.equal(roomUniforms.skyRoomLampColors.value[0].w, 1);
  setRoomGain(9);
  assert.equal(roomGain(), 2);
  setRoomGain(-1);
  assert.equal(roomGain(), 0);
  setRoomGain(Number.NaN);
  assert.equal(roomGain(), 1);
});

function stored(t: TestContext, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => (value === undefined ? null : JSON.stringify(value)), setItem: () => {} } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return loadSettings();
}

test('Indoor lights loads as 100% when never set, and is kept within 0–200%', (t) => {
  assert.equal(stored(t, undefined).indoorLight, 1);
  assert.equal(stored(t, { view: 'third' }).indoorLight, 1, 'settings saved before it existed');
  assert.equal(stored(t, { indoorLight: 1.5 }).indoorLight, 1.5);
  assert.equal(stored(t, { indoorLight: 0 }).indoorLight, 0);
  assert.equal(stored(t, { indoorLight: -1 }).indoorLight, 0);
  assert.equal(stored(t, { indoorLight: 9 }).indoorLight, 2);
  assert.equal(stored(t, { indoorLight: 'bright' }).indoorLight, 1);
});
