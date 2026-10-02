import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// kit.ts builds textures when it loads; a canvas that draws nothing is all it needs here.
const noop: unknown = new Proxy(() => noop, { get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 10 : noop), set: () => true });
(globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop }) };
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { armFraction } = await import('../src/client/player/arm.js');
const { CARS, DRIVE, GEARS, carClass, carHeight, driveOf, gearOf, gearSpan, seatHips, SEAT_HIPS } = await import('../src/shared/garage.js');
const { bumpHeight, ROUGH, HUMPS } = await import('../src/shared/bumps.js');
const { carModel } = await import('../src/client/features/cars/world.js');
const { Ride } = await import('../src/client/features/cars/ride.js');
const { classBestsOf, parseClassBests, parseResults, resultsOf, withClass, addResult, classOfResult } = await import('../src/client/features/cars/records.js');
const racestore = await import('../src/client/features/cars/racestore.js');
const { encodePath } = await import('../src/client/features/cars/ghost.js');
const { makeKit, G } = await import('../src/client/world/scenic/kit.js');
const { layOut } = await import('../src/client/world/scenic/index.js');
const { liftOnBumps } = await import('../src/client/world/scenic/bumps.js');

test('the camera arm passes through the car you are in, whose body is taller than the supercars', () => {
  // The 4x4's body slices, 1.25 high, behind the head at the seat.
  const body = [0, 1, 2].map((i) => ({ minX: -1, maxX: 1, minZ: -3 + i * 1.5 - 0.7, maxZ: -3 + i * 1.5 + 0.7, bottom: 0, top: carHeight('offroad').body }));
  const head = { x: 0, y: 1.3, z: -0.5 };
  const cam = { x: 0, y: 4, z: -9 };
  assert.ok(armFraction(head, cam, body, 0) < 1, 'an ordinary collider that high blocks it');
  assert.equal(armFraction(head, cam, body, 0, undefined, undefined, body), 1, 'but not the car you are in');
  const wall = { minX: -5, maxX: 5, minZ: -7, maxZ: -6.5, bottom: 0, top: 3 };
  assert.ok(armFraction(head, cam, [...body, wall], 0, undefined, undefined, body) < 1, 'a wall behind it still does');
});

test('seat height, gears and classes go by the kind of car', () => {
  assert.equal(seatHips('lambo'), SEAT_HIPS);
  assert.equal(seatHips('ferrari'), SEAT_HIPS);
  assert.ok(seatHips('offroad') >= 0.6, 'the 4x4 seat cushion is at 0.62');
  assert.deepEqual(CARS.map((c) => carClass(c.kind)).filter((c) => c === 'offroad').length, 2);
  assert.ok(gearSpan('offroad') < gearSpan('lambo'));
  assert.equal(gearOf(driveOf('offroad').top, 'offroad'), gearOf(DRIVE.top, 'lambo'), 'both are in top gear at their top speed');
  assert.equal(gearOf(driveOf('offroad').top * 0.99, 'offroad'), GEARS - 0, 'the 4x4 revs through all six gears');
  assert.ok(gearOf(driveOf('offroad').top, 'lambo') < GEARS, 'a supercar at the 4x4 top speed is not yet in top gear');
});

test('records are kept apart by class of car, and old data is the supercars', () => {
  const old = JSON.stringify([{ at: 5, laps: [60, 61, 62], penalty: 0, total: 183 }]);
  const parsed = parseResults(old);
  assert.equal(classOfResult(parsed[0]), 'supercar', 'a result from before the classes');
  const bests = classBestsOf(parsed, parseClassBests('{"total":180,"lap":59}'));
  assert.deepEqual(bests.supercar, { total: 180, lap: 59 }, 'the old single bests are the supercars');
  assert.deepEqual(bests.offroad, { total: null, lap: null });
  assert.deepEqual(parseClassBests(JSON.stringify(bests)), bests, 'and the new form round-trips');
  // A 4x4 race neither beats nor lands in the supercars' records.
  const run = (cls: 'supercar' | 'offroad', total: number, at: number) => ({ at, laps: [total / 3, total / 3, total / 3], penalty: 0, total, cls });
  let all = parsed;
  let b = bests;
  const r = addResult(resultsOf(all, 'offroad'), run('offroad', 300, 10), b.offroad);
  assert.ok(r.record, 'the first 4x4 race is a record of its own');
  all = withClass(all, 'offroad', r.list);
  b = { ...b, offroad: r.next };
  assert.equal(resultsOf(all, 'supercar').length, 1);
  assert.equal(resultsOf(all, 'offroad').length, 1);
  assert.equal(b.supercar.total, 180, 'the supercars best is untouched');
  assert.deepEqual(all.map((x) => x.at), [10, 5], 'newest first overall');
  for (let i = 0; i < 15; i++) all = withClass(all, 'offroad', addResult(resultsOf(all, 'offroad'), run('offroad', 400 + i, 20 + i)).list);
  assert.equal(resultsOf(all, 'offroad').length, 10, 'the 4x4 list is capped');
  assert.equal(resultsOf(all, 'supercar').length, 1, 'without pushing the supercars out');
  assert.equal(parseResults(JSON.stringify(all)).length, 11);
});

test('the ghost and best lap are stored per class, the old keys being the supercars', () => {
  store.clear();
  const path = { time: 30, pts: [{ x: 0, z: 0, rotY: 0 }, { x: 1, z: 1, rotY: 0 }] };
  // Saved by the version before the classes.
  store.set('office.game.race.ghost', encodePath(path));
  store.set('agent-office.bestLap2', '31.5');
  assert.equal(racestore.loadGhost('supercar')?.time, 30);
  assert.equal(racestore.loadGhost('offroad'), null, 'a supercar lap is not the 4x4 ghost');
  assert.equal(racestore.loadLapBest('supercar'), 31.5);
  assert.equal(racestore.loadLapBest('offroad'), null);
  racestore.saveGhost('offroad', { ...path, time: 44 });
  racestore.saveLapBest('offroad', 45);
  assert.equal(racestore.loadGhost('offroad')?.time, 44);
  assert.equal(racestore.loadGhost('supercar')?.time, 30);
  assert.equal(racestore.loadLapBest('supercar'), 31.5);
  assert.equal(racestore.loadLapBest('offroad'), 45);
});

test('cars of a kind share their geometry and keep their own paint', () => {
  const a = carModel('lambo', '#ff0000');
  const b = carModel('lambo', '#00ff00');
  const c = carModel('offroad', '#2f8f4e');
  const d = carModel('offroad', '#d9a441');
  const geos = (m: { root: THREE.Object3D }) => {
    const out: THREE.BufferGeometry[] = [];
    m.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) out.push((o as THREE.Mesh).geometry);
    });
    return out;
  };
  for (const [x, y] of [[a, b], [c, d]] as const) {
    const gx = geos(x);
    const gy = geos(y);
    assert.equal(gx.length, gy.length);
    assert.ok(gx.length > 5);
    gx.forEach((g, i) => assert.equal(g, gy[i], 'the same geometry'));
    assert.notEqual(x.root, y.root);
    assert.notEqual(x.tilt, y.tilt);
    assert.equal(x.wheels.length, y.wheels.length);
    x.wheels.forEach((w, i) => assert.notEqual(w, y.wheels[i]));
    assert.equal(x.top.visible, true);
    assert.equal(x.open.visible, false);
  }
  assert.equal(c.rear?.length, 2);
  assert.equal(a.rear, undefined);
  const colors = (m: { root: THREE.Object3D }) => {
    const s = new Set<string>();
    m.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshToonMaterial | undefined;
      if (mat?.color) s.add(mat.color.getHexString());
    });
    return s;
  };
  assert.ok(colors(a).has('ff0000') && !colors(a).has('00ff00'));
  assert.ok(colors(b).has('00ff00') && !colors(b).has('ff0000'));
  assert.ok(!colors(a).has('fe00ef') && !colors(c).has('fe00ef'), 'none keeps the template paint');
  assert.ok(c.wheels[0].parent !== null && c.tilt.parent !== null);
});

test('a NaN pose cannot leave a car invisible', () => {
  for (const kind of ['lambo', 'offroad'] as const) {
    const m = carModel(kind, '#ffffff');
    const ride = new Ride(m, kind);
    const finite = () => [m.tilt.rotation.x, m.tilt.rotation.z, m.tilt.position.y, ...m.wheels.map((w) => w.position.y), ...(m.rear ?? []).map((w) => w.position.y)].every(Number.isFinite);
    for (let i = 0; i < 20; i++) ride.follow({ x: i, z: 0, rotY: 0 }, 0.016);
    ride.follow({ x: Number.NaN, z: 1, rotY: 0 }, 0.016);
    ride.follow({ x: 3, z: 1, rotY: Number.NaN }, 0.016);
    ride.follow({ x: 3, z: 1, rotY: 0 }, Number.NaN);
    assert.ok(finite(), `${kind}: still finite`);
    for (let i = 0; i < 20; i++) ride.follow({ x: 20 + i, z: 190, rotY: 0 }, 0.016);
    assert.ok(finite(), `${kind}: and riding again after`);
    // Even a NaN that gets into the springs themselves is shaken out.
    ride.susp.heave = Number.NaN;
    ride.follow({ x: 41, z: 190, rotY: 0 }, 0.016);
    assert.ok(finite(), `${kind}: poisoned springs`);
  }
});

test('whatever stands on the bumps is lifted onto them', () => {
  const parts = { a: new THREE.Group(), b: new THREE.Group() };
  const hump = HUMPS[0];
  const rough = ROUGH[0];
  const at = [
    [hump.x, hump.z],
    [rough.x, rough.z],
    [0, 0],
  ];
  const kids = at.map(([x, z]) => {
    const o = new THREE.Object3D();
    o.position.set(x, G, z);
    parts.a.add(o);
    return o;
  });
  const lifted = liftOnBumps(parts);
  assert.ok(lifted >= 1);
  at.forEach(([x, z], i) => assert.ok(Math.abs(kids[i].position.y - (G + bumpHeight(x, z))) < 1e-9));
  assert.equal(kids[2].position.y, G, 'flat ground is left alone');
});

test('nothing laid out on the loop sits below the ground it stands on', () => {
  const cols: never[] = [];
  const night = new Proxy({}, { get: () => [] }) as never;
  const { kit } = makeKit(new THREE.Group(), cols, night);
  layOut(kit);
  let checked = 0;
  for (const part of Object.values(kit.parts)) {
    for (const o of part.children) {
      const h = bumpHeight(o.position.x, o.position.z);
      if (h < 0.02) continue;
      checked++;
      assert.ok(o.position.y >= G + h - 1e-9, `${o.type} at (${o.position.x.toFixed(1)}, ${o.position.z.toFixed(1)}) is ${(o.position.y - G).toFixed(2)} over the flat, the ground is ${h.toFixed(2)}`);
    }
  }
  assert.ok(checked > 5, `${checked} things stand on the bumps`);
});
