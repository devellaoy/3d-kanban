// The office's indoor light (#118): lamps over every part of the floor, the wall switches finding their
// lamps by the area the room tags them with, and Settings' Indoor lights (world/roomlight.ts setRoomGain).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAX_ROOM_LAMPS, ROOM_LIGHT_PARS, lampLightAt, lightRoom, roomGain, roomLevel, roomUniforms, setRoomGain, type RoomLamp } from '../src/client/world/roomlight.js';
import { CEILING_LAMPS, LAMP_Y, ceilingLight, pendantLight } from '../src/client/world/office/ceiling-lamps.js';
import { lightSwitches } from '../src/client/features/lights/world.js';
import type { Site } from '../src/client/world/office/fixture.js';
import type { NightParts } from '../src/client/world/outside.js';
import { loadSettings } from '../src/client/state/index.js';
import { DESK_SIZE, FLOOR, MEETING_ROOM, ROOMS_WING, STAIRS } from '../src/shared/layout.js';

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
  for (const def of CEILING_LAMPS) {
    const lamp = pendant();
    lamp.position.set(def.x, LAMP_Y, def.z);
    lamp.userData.area = def.area;
    group.add(lamp);
    night.roomLamps.push(ceilingLight(def));
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

/** The room's light from its lamps at every metre of the floor, at the floor and at desk height, with the lamps up for the hour (`lampsOn`, 1 at night). */
function floorLight(lamps: RoomLamp[], lampsOn: number): { at: string; lamps: number }[] {
  lightRoom(lamps, lampsOn);
  const out: { at: string; lamps: number }[] = [];
  for (let x = FLOOR.minX + 0.5; x < FLOOR.maxX; x += 1) {
    for (let z = FLOOR.minZ + 0.5; z < FLOOR.maxZ; z += 1) {
      if (!open(x, z)) continue;
      for (const y of [0, DESK_SIZE.height]) out.push({ at: `(${x}, ${y}, ${z})`, lamps: lampLightAt({ x, y, z }, UP, lamps) });
    }
  }
  return out;
}

/** The room's ceiling lamps as they hung before #118: the four over the pods and the lounge's, as strong as now, reaching 11. */
const BEFORE: RoomLamp[] = [
  [-10.5, -4],
  [-1.5, -4],
  [-10.5, 4],
  [-1.5, 4],
  [13, 0],
].map(([x, z]) => pendantLight(x, LAMP_Y, z));

/** The base light's level (BASE in roomlight.ts, what a corner no lamp reaches gets): its color's average. */
const base = () => {
  const c = roomUniforms.skyRoomBase.value;
  return (c.r + c.g + c.b) / 3;
};

test('at night every part of the floor is lit by a lamp, not left to the base light, as the five lamps before #118 left it', () => {
  // A spot is lit by the lamps when they add at least 40% to the base light there (lampLightAt + base ≥ 1.4 × base):
  // the five lamps before #118 left the corners at the base light alone (0 from the lamps); the room's lamps now
  // put about two thirds of the base light (0.13) into the darkest spot, the nook between the stairs and the meeting room.
  const enough = 0.4 * base();
  const darkest = (lamps: RoomLamp[]) => floorLight(lamps, 1).reduce((a, b) => (b.lamps < a.lamps ? b : a));
  const before = darkest(BEFORE);
  assert.ok(before.lamps < enough, `before #118 the darkest spot ${before.at} got ${before.lamps.toFixed(3)} from the lamps`);
  const { night } = hang();
  const now = darkest(night.roomLamps);
  assert.ok(now.lamps >= enough, `the darkest spot ${now.at} gets ${now.lamps.toFixed(3)} from the lamps, under ${enough.toFixed(3)}`);
});

test('nowhere on the floor is darker than before #118, by day or by night: the old lamps are as strong as ever', () => {
  const { night } = hang();
  for (const lampsOn of [0, 1]) {
    const before = floorLight(BEFORE, lampsOn);
    const now = floorLight(night.roomLamps, lampsOn);
    now.forEach((spot, i) => assert.ok(spot.lamps >= before[i].lamps - 1e-9, `${spot.at} ${lampsOn ? 'at night' : 'by day'}: ${before[i].lamps.toFixed(3)} → ${spot.lamps.toFixed(3)}`));
  }
});

test('the room light keeps to the shader’s 24 lamps: their uniforms fit the fragment budget every WebGL 2 device has', () => {
  // MAX_ROOM_LAMPS is not raised for the new lamps (see the test above that they all fit in it). Each lamp takes three
  // uniform vectors and each pane two; WebGL 2 promises at least 224 fragment uniform vectors, which three.js's lights
  // and the sky's lamps share with these, so the room light must keep well under half of them.
  assert.equal(MAX_ROOM_LAMPS, 24);
  const vectors = [...ROOM_LIGHT_PARS.matchAll(/uniform (?:vec[234]|float|int) \w+(?:\[ (\d+) \])?;/g)].reduce((n, m) => n + Number(m[1] ?? 1), 0);
  assert.ok(vectors <= 112, `the room light takes ${vectors} uniform vectors`);
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
