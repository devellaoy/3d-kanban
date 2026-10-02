import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE, LIMIT, WADE, WORLD, hazardAt, terrainOk, type Hazard } from '../src/shared/terrain.js';
import { LAKE, PIER, shoreX } from '../src/shared/scenic.js';

/** The rule as it was before it was made allocation-free: collect every zone, sort by depth. */
function reference(x: number, z: number): Hazard | null {
  const found: Hazard[] = [];
  const add = (depth: number, nx: number, nz: number, kind: Hazard['kind']) => {
    if (depth > 0) found.push({ depth, nx, nz, kind });
  };
  const s = shoreX(PIER.z);
  const onPier = Math.abs(z - PIER.z) <= PIER.width / 2 + 0.3 && x >= s - PIER.length - 0.5 && x <= s + 8;
  if (!onPier) add((shoreX(z) + 0.5 - x) / WADE, 1, 0, 'water');
  const ex = (x - LAKE.x) / LAKE.rx;
  const ez = (z - LAKE.z) / LAKE.rz;
  const e = Math.hypot(ex, ez);
  if (e < 1.04) {
    const gx = ex / LAKE.rx;
    const gz = ez / LAKE.rz;
    const g = Math.hypot(gx, gz) || 1;
    add(((1.04 - e) * Math.min(LAKE.rx, LAKE.rz) * 0.9) / WADE, gx / g, gz / g, 'water');
  }
  add((x - (WORLD.maxX - EDGE)) / EDGE, -1, 0, 'edge');
  add((WORLD.minX + EDGE - x) / EDGE, 1, 0, 'edge');
  add((z - (WORLD.maxZ - EDGE)) / EDGE, 0, -1, 'edge');
  add((WORLD.minZ + EDGE - z) / EDGE, 0, 1, 'edge');
  return found.sort((a, b) => b.depth - a.depth)[0] ?? null;
}

test('hazardAt and terrainOk give what the sorting version did, everywhere', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let hits = 0;
  for (let i = 0; i < 40000; i++) {
    // Mostly the interesting parts: around the shore, the lake, the corners of the world.
    const x = i % 4 === 0 ? WORLD.minX - 60 + rand() * 300 : i % 4 === 1 ? LAKE.x + (rand() - 0.5) * LAKE.rx * 3 : WORLD.minX - 100 + rand() * (WORLD.maxX - WORLD.minX + 200);
    const z = i % 4 === 1 ? LAKE.z + (rand() - 0.5) * LAKE.rz * 3 : WORLD.minZ - 100 + rand() * (WORLD.maxZ - WORLD.minZ + 200);
    const want = reference(x, z);
    assert.deepEqual(hazardAt(x, z), want, `at ${x}, ${z}`);
    assert.equal(terrainOk(x, z), (want?.depth ?? 0) < LIMIT, `terrainOk at ${x}, ${z}`);
    if (want) hits++;
  }
  assert.ok(hits > 5000, 'the sample covers the soft zones');
});
