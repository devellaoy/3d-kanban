import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CARS, drive, driveOf, steerLimit, type CarPose, type Pedals } from '../src/shared/garage.js';
import { Garage } from '../src/server/garage.js';
import { Suspension, suspensionOf } from '../src/client/features/cars/suspension.js';
import { Ride } from '../src/client/features/cars/ride.js';

const FRAME = 1 / 60;

/** All four wheels over a bump `height` high for `width` seconds, from t = 0, then flat; the body's heave every frame for `seconds`. */
function pulse(s: Suspension, height: number, width: number, seconds: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += FRAME) {
    const g = t < width ? height : 0;
    s.step(FRAME, [g, g, g, g], 0, 0);
    out.push(s.heave);
  }
  return out;
}

const crossings = (xs: number[], dead = 0.002) => {
  let n = 0;
  let last = 0;
  for (const x of xs) {
    if (Math.abs(x) < dead) continue;
    const sign = Math.sign(x);
    if (last && sign !== last) n++;
    last = sign;
  }
  return n;
};

const peak = (xs: number[]) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/** How long until the heave stays inside +-`band`. */
const settled = (xs: number[], band: number) => {
  for (let i = xs.length - 1; i >= 0; i--) if (Math.abs(xs[i]) > band) return (i + 1) * FRAME;
  return 0;
};

test('a bump excites an oscillation in the body that dies away', () => {
  for (const kind of ['offroad', 'lambo'] as const) {
    const heave = pulse(new Suspension(suspensionOf(kind)), 0.1, 0.12, 8);
    assert.ok(peak(heave) > 0.005, `${kind} is lifted by the bump`);
    const first = peak(heave.slice(0, 120));
    const last = peak(heave.slice(-120));
    assert.ok(last < first * 0.1, `${kind} settles (${first.toFixed(3)} then ${last.toFixed(4)})`);
    assert.ok(Number.isFinite(heave.at(-1)));
  }
});

test('the 4x4 rides a little softer than a supercar, but settles about as quickly and does not keep rocking', () => {
  const firm = pulse(new Suspension(suspensionOf('offroad')), 0.1, 0.12, 8);
  const stiff = pulse(new Suspension(suspensionOf('lambo')), 0.1, 0.12, 8);
  assert.ok(crossings(firm) <= 3, `the 4x4 swings back and forth only ${crossings(firm)} times`);
  assert.ok(settled(firm, 0.004) < 1, `it is still within 4 mm of rest after ${settled(firm, 0.004).toFixed(2)} s`);
  assert.ok(settled(firm, 0.004) < settled(stiff, 0.004) * 3, `about as soon as the stiff one (${settled(stiff, 0.004).toFixed(2)} s)`);
  // After a mound (a bump 0.3 s long) it is soon back at rest too.
  const mound = pulse(new Suspension(suspensionOf('offroad')), 0.2, 0.3, 6);
  assert.ok(settled(mound, 0.004) < 1.5, `back at rest ${settled(mound, 0.004).toFixed(2)} s after the mound`);
  assert.ok(peak(mound) > peak(pulse(new Suspension(suspensionOf('lambo')), 0.2, 0.3, 6)), 'and its longer travel lets the body rise further than a supercar');
});

test('a bump under the front wheels alone lifts the nose, and rocks the body back and forth in pitch', () => {
  const s = new Suspension(suspensionOf('offroad'));
  const pitch: number[] = [];
  for (let t = 0; t < 3; t += FRAME) {
    const g = t < 0.15 ? 0.15 : 0;
    s.step(FRAME, [g, g, 0, 0], 0, 0);
    pitch.push(s.pitch);
  }
  assert.ok(Math.min(...pitch) < -0.02, 'nose up as the front rises');
  assert.ok(Math.max(...pitch) > 0.005, 'and the rebound pitches it the other way');
});

test('cornering roll grows with lateral acceleration, leaning out of the turn, a little more on the 4x4', () => {
  const lean = (kind: 'offroad' | 'lambo', aLat: number) => {
    const s = new Suspension(suspensionOf(kind));
    for (let t = 0; t < 4; t += FRAME) s.step(FRAME, [0, 0, 0, 0], 0, aLat);
    return s.roll;
  };
  for (const kind of ['offroad', 'lambo'] as const) {
    const [a, b, c] = [4, 10, 18].map((x) => lean(kind, x));
    assert.ok(a > 0 && b > a && c > b, `${kind} leans more the harder it turns (${a.toFixed(3)}, ${b.toFixed(3)}, ${c.toFixed(3)})`);
    assert.ok(lean(kind, -10) < 0, `and the other way in a right turn`);
  }
  assert.ok(lean('offroad', 12) > lean('lambo', 12) * 1.2, 'the 4x4 leans further');
  assert.ok(lean('offroad', 12) < lean('lambo', 12) * 2, 'but not much further');
  assert.ok(lean('offroad', 18) < suspensionOf('offroad').maxRoll, 'nor onto its stops in a hard turn');
});

test('under the throttle the tail squats, on the brakes the nose dives', () => {
  const settle = (aLong: number) => {
    const s = new Suspension(suspensionOf('offroad'));
    for (let t = 0; t < 4; t += FRAME) s.step(FRAME, [0, 0, 0, 0], aLong, 0);
    return s.pitch;
  };
  assert.ok(settle(8) < -0.01, 'nose up on the gas');
  assert.ok(settle(-25) > 0.03, 'nose down on the brakes');
  assert.ok(settle(-25) < suspensionOf('offroad').maxPitch, 'but short of its stops even braking hard');
  assert.ok(settle(-25) > settle(-10), 'more the harder');
});

test('long frames and wild inputs never blow it up or throw the body past its stops', () => {
  const spec = suspensionOf('offroad');
  const s = new Suspension(spec);
  for (let i = 0; i < 200; i++) s.step(i % 7 === 0 ? 1 : FRAME, [Math.sin(i), 0.4, -0.2, Math.cos(i)], 80 * Math.sin(i), -90 * Math.cos(i));
  assert.ok([s.heave, s.pitch, s.roll].every(Number.isFinite));
  assert.ok(Math.abs(s.heave) <= spec.maxHeave + 1e-9 && Math.abs(s.pitch) <= spec.maxPitch + 1e-9 && Math.abs(s.roll) <= spec.maxRoll + 1e-9);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(s.push(i)) <= spec.travel);
});

test('a Ride puts the springs on the model: the body rises over a hump and the wheels follow the ground', () => {
  const tilt = new THREE.Group();
  tilt.position.y = 0.7;
  const wheel = (x: number, z: number) => {
    const w = new THREE.Group();
    w.position.set(x, 0.52, z);
    return w;
  };
  const wheels = [wheel(0.96, 1.4), wheel(-0.96, 1.4)];
  const rear = [wheel(0.96, -1.4), wheel(-0.96, -1.4)];
  const ride = new Ride({ tilt, wheels, rear }, 'offroad');
  // Driving east along the street's east end over the speed humps at x = 122 and 131 (z = 27).
  const heave: number[] = [];
  const lower: number[] = [];
  for (let x = 110; x < 150; x += 12 * FRAME) {
    ride.follow({ x, z: 27, rotY: Math.PI / 2 }, FRAME);
    heave.push(tilt.position.y - 0.7);
    lower.push(wheels[0].position.y - 0.52);
  }
  assert.ok(Math.max(...heave) > 0.02, `the body rises over the humps (${Math.max(...heave).toFixed(3)})`);
  assert.ok(Math.min(...heave) < -0.005, 'and drops back past rest');
  assert.ok(Math.max(...lower) > 0.01 || Math.min(...lower) < -0.01, 'the wheels move against the body');
  assert.ok(Math.abs(tilt.rotation.x) < 0.15 && Math.abs(tilt.rotation.z) < 0.22);
  // Standing still on flat ground it is at rest.
  const still = new Ride({ tilt: new THREE.Group(), wheels: [wheel(1, 1), wheel(-1, 1)] }, 'lambo');
  for (let i = 0; i < 60; i++) still.follow({ x: 0, z: 40, rotY: 0 }, FRAME);
  assert.equal(still.susp.heave, 0);
});

test('the 4x4 drives like one: slower than the supercars, softer to steer, and grass hardly slows it', () => {
  const GAS: Pedals = { gas: 1, turn: 0, brake: false };
  const run = (kind: 'lambo' | 'offroad', rough: number, seconds: number) => {
    let p: CarPose = { x: 0, z: 0, rotY: 0, speed: 0, steer: 0 };
    for (let t = 0; t < seconds; t += FRAME) p = drive(p, GAS, FRAME, rough, kind);
    return p;
  };
  assert.ok(driveOf('offroad').top < driveOf('lambo').top / 1.3 && driveOf('offroad').boostTop < driveOf('lambo').boostTop);
  assert.equal(run('offroad', 0, 20).speed, driveOf('offroad').top);
  const road = run('offroad', 0, 6).speed;
  const grass = run('offroad', 1, 6).speed;
  const lamboRoad = run('lambo', 0, 6).speed;
  const lamboGrass = run('lambo', 1, 6).speed;
  assert.ok(grass / road > 0.9, `the 4x4 keeps ${(100 * grass) / road}% of its speed on grass`);
  assert.ok(lamboGrass / lamboRoad < 0.8 && grass / road > lamboGrass / lamboRoad, 'a supercar loses much more');
  assert.ok(steerLimit(20, 'offroad') < steerLimit(20, 'lambo'), 'less lock at speed');
  assert.ok(driveOf('offroad').steerRate < driveOf('lambo').steerRate, 'and slower to turn the wheel');
  // The supercars' numbers are where they were.
  assert.equal(driveOf('lambo').top, 48);
  assert.equal(driveOf('ferrari'), driveOf('lambo'));
});

test('the garage has two 4x4s, and their driver is held to the 4x4s limits, not the supercars', () => {
  const i = CARS.findIndex((c) => c.name === 'Green Ranger');
  assert.ok(i >= 0 && CARS[i].kind === 'offroad');
  assert.equal(CARS.filter((c) => c.kind === 'offroad').length, 2);
  const g = new Garage();
  assert.ok(g.enter('a', i, 'driver'));
  const at = CARS[i];
  const told = g.drive('a', i, { x: at.x, z: at.z, rotY: at.rotY, speed: 99, steer: 1 });
  assert.equal(told?.speed, driveOf('offroad').boostTop);
  assert.equal(told?.steer, driveOf('offroad').steer);
  const l = CARS.findIndex((c) => c.kind === 'lambo');
  assert.ok(g.enter('b', l, 'driver'));
  assert.equal(g.drive('b', l, { x: CARS[l].x, z: CARS[l].z, rotY: CARS[l].rotY, speed: 99, steer: 1 })?.speed, driveOf('lambo').boostTop);
});
