import test from 'node:test';
import assert from 'node:assert/strict';
import { discBoxes } from '../src/shared/footprint.js';
import { FOOTHILLS, LOOP, MOUNTAINS } from '../src/shared/scenic.js';
import { Fleet } from '../src/client/features/cars/world.js';
import { STREET_Y } from '../src/shared/layout.js';
import type { Collider, Interactable } from '../src/client/world/types.js';

test('a disc of boxes fills the circle without reaching outside it', () => {
  const [x, z, r] = [100, -50, 60];
  const boxes = discBoxes(x, z, r, 5);
  let area = 0;
  for (const b of boxes) {
    area += (b.maxX - b.minX) * (b.maxZ - b.minZ);
    for (const [px, pz] of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]]) assert.ok(Math.hypot(px - x, pz - z) <= r + 1e-6, 'inside');
  }
  assert.ok(area > Math.PI * r * r * 0.9, `most of the circle (${area.toFixed(0)} of ${(Math.PI * r * r).toFixed(0)})`);
});

test('the mountains and foothills are solid to their base, and the road never runs into them', () => {
  for (const [x, z, r] of [...MOUNTAINS, ...FOOTHILLS]) {
    const boxes = discBoxes(x, z, r * 0.95, 3);
    for (const p of LOOP) {
      const hit = boxes.some((b) => p.x > b.minX - 3 && p.x < b.maxX + 3 && p.z > b.minZ - 3 && p.z < b.maxZ + 3);
      assert.ok(!hit, `the road at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) runs into the hill at (${x}, ${z})`);
    }
    // A point just inside the foot is in a box.
    const inside = boxes.some((b) => x + r * 0.9 * Math.cos(0.3) > b.minX && x + r * 0.9 * Math.cos(0.3) < b.maxX && z + r * 0.9 * Math.sin(0.3) > b.minZ && z + r * 0.9 * Math.sin(0.3) < b.maxZ);
    assert.ok(inside, 'the slope is solid');
  }
});

test('the fleet reports a far-off trunk as a solid once a car is near enough, and not before', () => {
  const trunk: Collider = { minX: 80, maxX: 80.5, minZ: 40, maxZ: 40.5, bottom: STREET_Y, top: STREET_Y + 2 };
  const fleet = new Fleet([trunk], [] as Interactable[]);
  assert.ok(!fleet.solids(-1, { x: 0, z: 0, r: 30 }).includes(trunk));
  assert.ok(fleet.solids(-1, { x: 70, z: 35, r: 30 }).includes(trunk));
});
