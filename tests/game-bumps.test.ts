import test from 'node:test';
import assert from 'node:assert/strict';
import { BUMP_MAX, HUMPS, ROUGH, bumpHeight } from '../src/shared/bumps.js';
import { paved } from '../src/shared/garage.js';
import { FLOOR, ROAD } from '../src/shared/layout.js';
import { LAKE, LOOP, LOOP_PAVED, STREET_END, STREET_Z, nearLoop } from '../src/shared/scenic.js';

/** Every point on a grid over [x0, x1] x [z0, z1], `step` meters apart. */
function grid(x0: number, x1: number, z0: number, z1: number, step: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) out.push({ x, z });
  return out;
}

test('speed humps lie across the road on the straights either side of town: a cosine to 13 cm, nothing past their ends', () => {
  assert.ok(HUMPS.length >= 2);
  for (const h of HUMPS) {
    assert.ok(Math.abs(h.x) > STREET_END, 'out on the loop, not in the street');
    assert.ok(Math.abs(bumpHeight(h.x, h.z) - h.height) < 1e-9, 'full height in the middle');
    assert.ok(bumpHeight(h.x + h.half * 0.5, h.z) < h.height && bumpHeight(h.x + h.half * 0.5, h.z) > 0, 'sloping off to either side');
    assert.equal(bumpHeight(h.x + h.half + 0.01, h.z), 0);
    assert.equal(bumpHeight(h.x, h.z + h.across + 0.7), 0, 'and off the road');
    // Right across the road and its shoulders.
    for (const off of [-LOOP_PAVED, -2, 2, LOOP_PAVED]) assert.ok(bumpHeight(h.x, h.z + off) > h.height * 0.9, `across at ${off}`);
  }
});

test('no bumps on the loop road but its speed humps, and none in the street, the lots, the garage or the town', () => {
  const onHump = (x: number, z: number) => HUMPS.some((h) => Math.abs(x - h.x) < h.half + 0.5 && Math.abs(z - h.z) < h.across + 1);
  for (const p of LOOP) {
    for (const off of [-LOOP_PAVED, 0, LOOP_PAVED]) {
      const x = p.x + p.tz * off;
      const z = p.z - p.tx * off;
      if (!onHump(x, z)) assert.equal(bumpHeight(x, z), 0, `flat road at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    }
  }
  for (const p of grid(-STREET_END, STREET_END, ROAD.minZ - 4, ROAD.maxZ + 4, 2)) assert.equal(bumpHeight(p.x, p.z), 0, 'the street');
  for (const p of grid(FLOOR.minX - 40, FLOOR.maxX + 40, FLOOR.minZ - 40, 22, 2)) assert.equal(bumpHeight(p.x, p.z), 0, 'the garage, the lots and the town round the office');
});

test('rough ground: moguls in the meadow, a washboard lane by the farm, mounds round the campsite, all low and never below the flat', () => {
  assert.deepEqual(ROUGH.map((r) => r.name).sort(), ['campsite', 'farm lane', 'meadow']);
  for (const r of ROUGH) {
    const samples = grid(r.x - r.rx, r.x + r.rx, r.z - r.rz, r.z + r.rz, 0.5).map((p) => bumpHeight(p.x, p.z));
    assert.ok(samples.every((h) => h >= 0 && h <= BUMP_MAX && Number.isFinite(h)), `${r.name} stays between 0 and ${BUMP_MAX}`);
    const high = Math.max(...samples);
    assert.ok(high > r.amp * 0.5, `${r.name} has real bumps (up to ${high.toFixed(2)} m)`);
    assert.ok(samples.filter((h) => h > 0.03).length > samples.length * 0.05, `${r.name} is bumpy over a good part of it`);
    // The edge is flat, so there is no step.
    assert.equal(bumpHeight(r.x + r.rx, r.z), 0);
    assert.equal(bumpHeight(r.x, r.z - r.rz), 0);
  }
});

test('the rough ground is off the road and clear of the lake and the campsite, and it is the same wherever it is asked', () => {
  for (const r of ROUGH) {
    for (const p of grid(r.x - r.rx, r.x + r.rx, r.z - r.rz, r.z + r.rz, 1)) {
      if (bumpHeight(p.x, p.z) === 0) continue;
      assert.ok(!paved(p.x, p.z), `${r.name} is not on the pavement at (${p.x}, ${p.z})`);
      const loop = nearLoop(p.x, p.z);
      assert.ok(!loop || loop.off > LOOP_PAVED + 6, `${r.name} keeps well off the loop at (${p.x}, ${p.z})`);
      assert.ok(Math.hypot((p.x - LAKE.x) / LAKE.rx, (p.z - LAKE.z) / LAKE.rz) > 1, `${r.name} stays out of the lake`);
      if (r.spare) assert.ok(Math.hypot(p.x - r.spare.x, p.z - r.spare.z) >= r.spare.r, 'and off the camp itself');
      assert.equal(bumpHeight(p.x, p.z), bumpHeight(p.x, p.z));
    }
  }
  assert.equal(bumpHeight(STREET_END - 1, STREET_Z), 0);
});

test('the ground is gentle: no step or cliff anywhere you can drive or walk', () => {
  let steepest = 0;
  for (const r of ROUGH) {
    for (const p of grid(r.x - r.rx, r.x + r.rx, r.z - r.rz, r.z + r.rz, 0.25)) {
      const h = bumpHeight(p.x, p.z);
      steepest = Math.max(steepest, Math.abs(bumpHeight(p.x + 0.25, p.z) - h) / 0.25, Math.abs(bumpHeight(p.x, p.z + 0.25) - h) / 0.25);
    }
  }
  for (const h of HUMPS) for (let x = h.x - 3; x < h.x + 3; x += 0.1) steepest = Math.max(steepest, Math.abs(bumpHeight(x + 0.1, h.z) - bumpHeight(x, h.z)) / 0.1);
  assert.ok(steepest < 0.45, `the steepest slope is ${steepest.toFixed(2)}`);
});
