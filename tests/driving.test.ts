import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/client/player/index.js';
import { Driver } from '../src/client/features/cars/controller.js';
import { Fleet } from '../src/client/features/cars/world.js';
import type { Collider, Interactable } from '../src/client/world/types.js';
import { CAR, SEATS, carPoint, drive, inBounds, type CarPose } from '../src/shared/garage.js';
import { EDGE, WORLD } from '../src/shared/terrain.js';
import { ROAD, STREET_Y } from '../src/shared/layout.js';
import { CHECKPOINTS, LAKE, LOOP, LOOP_LENGTH, STREET_END, STREET_Z, nearLoop, shoreX } from '../src/shared/scenic.js';
import { LapTimer } from '../src/client/features/cars/laps.js';

const G = STREET_Y;
const ROAD_Z = (ROAD.minZ + ROAD.maxZ) / 2;
/** The Blue Lambo, moved out onto the road for these. */
const BLUE = 8;

/** The street to stand and drive on, whatever else is there, and a driver in a car on it heading east. */
function street(t: TestContext, solids: Collider[] = []) {
  const win = new EventTarget();
  for (const [name, value] of [['window', win], ['document', new EventTarget()]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const colliders: Collider[] = [{ minX: -200, maxX: 200, minZ: -200, maxZ: 200, bottom: G - 1, top: G }, ...solids];
  const fleet = new Fleet(colliders, [] as Interactable[]);
  const player = new PlayerController(new THREE.PerspectiveCamera(), new EventTarget() as unknown as HTMLElement, colliders);
  player.view = 'third';
  const sent: CarPose[] = [];
  const bumps: number[] = [];
  const driver = new Driver(player, fleet, { moved: (_car, p) => sent.push({ ...p }), bump: (_at, speed) => bumps.push(speed) });
  fleet.place(BLUE, { x: 0, z: ROAD_Z, rotY: Math.PI / 2, speed: 0, steer: 0 });
  const keys = (...codes: string[]) => {
    player.clearKeys();
    for (const code of codes) {
      const e = new Event('keydown');
      Object.defineProperty(e, 'code', { value: code });
      win.dispatchEvent(e);
    }
  };
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) player.update(1 / 60);
  };
  return { fleet, player, driver, sent, bumps, keys, frames, car: () => fleet.cars[BLUE].pose };
}

const box = (x: number, z: number, w: number, d: number): Collider => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, bottom: G, top: G + 3 });

test('behind the wheel, W drives off down the road, with you in your seat and the office told where', (t) => {
  const s = street(t);
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW');
  s.frames(90);
  const car = s.car();
  assert.ok(car.x > 5 && Math.abs(car.z - ROAD_Z) < 1e-6, `east along the road (x ${car.x.toFixed(1)})`);
  const seat = carPoint(car, SEATS.driver.x, SEATS.driver.z);
  assert.ok(Math.hypot(s.player.pos.x - seat.x, s.player.pos.z - seat.z) < 1e-6 && s.player.pos.y === G, 'sitting in it');
  assert.ok(s.sent.length > 5 && s.sent.length < 30, `a few times a second, not every frame (${s.sent.length} in 1.5 s)`);
});

test('a column in the way stops the car short with a crunch, and it backs away from it', (t) => {
  const s = street(t, [box(12, ROAD_Z, 0.5, 0.5)]);
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW');
  s.frames(240);
  assert.ok(s.car().x + CAR.length / 2 <= 11.75 + 1e-6, `stopped at the column (nose at ${(s.car().x + CAR.length / 2).toFixed(2)})`);
  assert.ok(s.bumps.length >= 1 && s.bumps[0] > 5, `a crunch at ${s.bumps[0]?.toFixed(1)} m/s`);
  s.keys('KeyS');
  s.frames(60);
  assert.ok(s.car().x < 8, 'reversing out of it');
});

test('at an angle into a wall, the car slides along it rather than stopping dead', (t) => {
  // A wall along the road's north edge; the car heads east, veering into it.
  const wall = { minX: -80, maxX: 80, minZ: ROAD.minZ - 1, maxZ: ROAD.minZ + 0.3, bottom: G, top: G + 3 };
  const s = street(t, [wall]);
  s.fleet.place(BLUE, { x: 0, z: ROAD.minZ + 2.5, rotY: Math.PI / 2 + 0.35, speed: 12, steer: 0 });
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW');
  s.frames(60);
  const car = s.car();
  assert.ok(car.x > 10 && car.speed > 10, `on along the wall (x ${car.x.toFixed(1)}, ${car.speed.toFixed(1)} m/s)`);
  assert.ok(Math.abs(car.rotY - Math.PI / 2) < 0.05, 'turned to run along it');
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const c = carPoint(car, (sx * CAR.width) / 2, (sz * CAR.length) / 2);
    assert.ok(c.z >= wall.maxZ - 1e-6, 'not into it');
  }
});

test('E gets you out by your door, the car stopped; with no room anywhere round it, you stay in', (t) => {
  const s = street(t);
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW');
  s.frames(30);
  s.keys();
  assert.ok(s.driver.leave());
  assert.equal(s.driver.active, false);
  assert.equal(s.player.rig, null);
  assert.equal(s.sent.at(-1)?.speed, 0, 'parked where you left it');
  // The driver's side is the car's left: north, heading east.
  assert.ok(s.player.pos.z < s.car().z - CAR.width / 2 - 0.3, 'out on the driver’s side');
  // Hemmed in on every side.
  const c = s.car();
  const walls = [box(c.x, c.z - 1.85, 8, 0.6), box(c.x, c.z + 1.85, 8, 0.6), box(c.x - 3, c.z, 0.6, 4), box(c.x + 3, c.z, 0.6, 4)];
  s.player.colliders.push(...walls);
  s.driver.enter(BLUE, 'driver');
  assert.equal(s.driver.leave(), false, 'no room to open a door');
  assert.ok(s.driver.active);
  assert.ok(s.driver.leave(true), 'unless you have to (another floor, a desk)');
});

test("beside the driver, you ride along but don't drive", (t) => {
  const s = street(t);
  s.driver.enter(BLUE, 'passenger');
  s.keys('KeyW', 'KeyA');
  s.frames(60);
  assert.equal(s.car().x, 0);
  assert.equal(s.sent.length, 0);
  // Someone else drives it on: you go with it.
  s.fleet.place(BLUE, { ...s.car(), x: 10 });
  s.frames(1);
  const seat = carPoint(s.car(), SEATS.passenger.x, SEATS.passenger.z);
  assert.ok(Math.hypot(s.player.pos.x - seat.x, s.player.pos.z - seat.z) < 1e-6);
});

/** Where a driver steering by the road aims: a point ahead on the loop (or along the street, where the loop isn't). */
function aim(car: CarPose): { x: number; z: number } {
  const at = nearLoop(car.x, car.z);
  if (!at || at.d < 0 || at.d > LOOP_LENGTH - 25) return { x: car.x + 30, z: ROAD_Z };
  return LOOP.find((q) => q.d >= at.d + 22) ?? { x: car.x + 30, z: ROAD_Z };
}

test('steering by the road, the car goes all the way round the scenic loop, and the lap is timed', (t) => {
  const s = street(t);
  s.fleet.place(BLUE, { x: -20, z: ROAD_Z, rotY: Math.PI / 2, speed: 0, steer: 0 });
  s.driver.enter(BLUE, 'driver');
  const laps = new LapTimer();
  let lap: number | null = null;
  let furthest = 0;
  let straying = 0;
  for (let frame = 0; frame < 60 * 140 && lap === null; frame++) {
    const car = s.car();
    const to = aim(car);
    const err = Math.atan2(Math.sin(Math.atan2(to.x - car.x, to.z - car.z) - car.rotY), Math.cos(Math.atan2(to.x - car.x, to.z - car.z) - car.rotY));
    // Cruising at 20 m/s, steering toward the point ahead.
    s.keys(...(car.speed < 20 ? ['KeyW'] : []), ...(err > 0.02 ? ['KeyA'] : err < -0.02 ? ['KeyD'] : []));
    s.frames(1);
    const now = s.car();
    lap = laps.update(now.x, now.z, frame / 60);
    const at = nearLoop(now.x, now.z);
    if (at && Math.abs(now.x) > STREET_END) {
      furthest = Math.max(furthest, at.d);
      straying = Math.max(straying, at.off);
    }
  }
  assert.ok(furthest > LOOP_LENGTH - 20, `all the way round (${furthest.toFixed(0)} of ${LOOP_LENGTH.toFixed(0)} m)`);
  assert.ok(straying < 8, `kept to the road (${straying.toFixed(1)} m off at worst)`);
  assert.ok(lap !== null && lap > 50 && lap < 140, `a lap in ${lap?.toFixed(1)} s`);
});

test('nothing stops a car at the edge of the road: it drives on across the grass at speed, with nobody bumping into anything', (t) => {
  const s = street(t);
  // South off the street, over the sidewalk and away across the fields inside the loop.
  s.fleet.place(BLUE, { x: 30, z: ROAD_Z, rotY: 0, speed: 0, steer: 0 });
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW');
  s.frames(60 * 6);
  const car = s.car();
  assert.ok(car.z > ROAD.maxZ + 100, `well off the road (z ${car.z.toFixed(0)})`);
  assert.ok(car.speed > 25, `still quick on the grass (${car.speed.toFixed(1)} m/s)`);
  assert.deepEqual(s.bumps, [], 'not one crunch');
  assert.equal(nearLoop(car.x, car.z), null, 'far enough off the loop that it has no say');
  // And the lap timer, the race and the ghost don't mind it: no road there at all.
  const laps = new LapTimer();
  assert.equal(laps.update(car.x, car.z, 1), null);
  assert.equal(laps.update(car.x + 1, car.z, 1.1), null);
  assert.equal(laps.running(2), null);
});

test('a lap that leaves the road a long way behind does not count', () => {
  const laps = new LapTimer();
  const z = STREET_Z;
  laps.update(-1, z, 0);
  laps.update(1, z, 0.1);
  for (const d of CHECKPOINTS) {
    const p = LOOP.find((q) => q.d >= d)!;
    laps.update(p.x, p.z, 10);
  }
  // Cut across the middle of the loop, then the line from the west.
  assert.equal(laps.update(0, 200, 30), null);
  assert.equal(laps.update(-30, z, 58), null);
  assert.equal(laps.update(-1, z, 59), null);
  assert.equal(laps.update(1, z, 60.5), null);
  assert.equal(laps.thrownOut, 60.5, 'thrown out');
  assert.equal(laps.best, null);
  assert.equal(laps.done, null);
  // The next one, kept to the road, counts.
  for (const d of CHECKPOINTS) {
    const p = LOOP.find((q) => q.d >= d)!;
    laps.update(p.x, p.z, 70);
  }
  laps.update(-1, z, 100);
  assert.ok(laps.update(1, z, 100.5) !== null, 'a lap');
});

test('the sea is soft: a car at speed slows right down in the shallows, never ends up out of bounds, and backs out', (t) => {
  const s = street(t);
  const z = 100;
  s.fleet.place(BLUE, { x: shoreX(z) + 60, z, rotY: -Math.PI / 2, speed: 40, steer: 0 });
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW', 'ShiftLeft');
  let furthest = Infinity;
  for (let i = 0; i < 60 * 8; i++) {
    s.frames(1);
    assert.ok(inBounds(s.car()), `never out of bounds (x ${s.car().x.toFixed(1)})`);
    furthest = Math.min(furthest, s.car().x - shoreX(z));
  }
  assert.ok(furthest < -1 && furthest > -11, `waded in a little way (${furthest.toFixed(1)} m past the waterline)`);
  assert.ok(Math.abs(s.car().speed) < 6, `crawling (${s.car().speed.toFixed(1)} m/s)`);
  // Backing out (the water pushes too).
  s.keys('KeyS');
  s.frames(60 * 6);
  assert.ok(s.car().x - shoreX(z) > furthest + 3, 'out of the water again');
});

test('the lake is soft too, and so is the edge of the world', (t) => {
  const s = street(t);
  s.fleet.place(BLUE, { x: LAKE.x - LAKE.rx - 30, z: LAKE.z, rotY: Math.PI / 2, speed: 30, steer: 0 });
  s.driver.enter(BLUE, 'driver');
  s.keys('KeyW');
  s.frames(60 * 6);
  assert.ok(inBounds(s.car()) && s.car().x < LAKE.x - 4, `stopped in the shallows (x ${s.car().x.toFixed(0)})`);
  s.keys();
  s.fleet.place(BLUE, { x: WORLD.maxX - 400, z: 300, rotY: Math.PI / 2, speed: 40, steer: 0 });
  s.keys('KeyW', 'ShiftLeft');
  s.frames(60 * 14);
  assert.ok(inBounds(s.car()) && s.car().x < WORLD.maxX, `held at the edge (x ${s.car().x.toFixed(0)})`);
  assert.ok(s.car().x > WORLD.maxX - EDGE - 5, 'having driven right out to it');
});

test('in third person the camera stays where you put it while you drive, rather than swinging back behind the car', (t) => {
  const s = street(t);
  s.driver.enter(BLUE, 'driver');
  const offset = Math.PI + 0.8;
  s.player.camYaw = s.car().rotY + offset;
  s.keys('KeyW', 'KeyA');
  s.frames(90);
  const turned = s.car().rotY;
  assert.ok(Math.abs(turned) > 0.3, 'the car has turned');
  const off = Math.atan2(Math.sin(s.player.camYaw - turned), Math.cos(s.player.camYaw - turned));
  const want = Math.atan2(Math.sin(offset), Math.cos(offset));
  assert.ok(Math.abs(off - want) < 1e-6, `same view from the car (${off.toFixed(3)} against ${want.toFixed(3)})`);
});

test('a car at full tilt leans into a corner and nose-dives on the brakes (the same for every car on the floor)', async () => {
  const { DriveEffects } = await import('../src/client/features/cars/effects.js');
  const colliders: Collider[] = [];
  const fleet = new Fleet(colliders, [] as Interactable[]);
  const fx = new DriveEffects();
  const v = fleet.cars[BLUE];
  let pose: CarPose = { x: 0, z: ROAD_Z, rotY: Math.PI / 2, speed: 40, steer: 0 };
  // Turning left at 40 m/s.
  for (let i = 0; i < 90; i++) {
    pose = drive(pose, { gas: 0.5, turn: 1, brake: false }, 1 / 60);
    fleet.place(BLUE, pose);
    fx.update(1 / 60, fleet.cars, null);
  }
  assert.ok(v.tilt.rotation.z > 0.02, `rolled out of the turn (${v.tilt.rotation.z.toFixed(3)})`);
  for (let i = 0; i < 60; i++) {
    pose = drive(pose, { gas: -1, turn: 0, brake: false }, 1 / 60);
    fleet.place(BLUE, pose);
    fx.update(1 / 60, fleet.cars, null);
  }
  assert.ok(v.tilt.rotation.x > 0.01, `nose down (${v.tilt.rotation.x.toFixed(3)})`);
  assert.ok(Math.abs(v.tilt.rotation.z) <= 0.071 && Math.abs(v.tilt.rotation.x) <= 0.051, 'but not far');
});
