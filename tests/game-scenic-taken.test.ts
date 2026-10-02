import test from 'node:test';
import assert from 'node:assert/strict';

// kit.ts builds textures when it loads; a canvas that draws nothing is all it needs here.
const noop: unknown = new Proxy(() => noop, { get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 10 : noop), set: () => true });
(globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop }) };

const { takenIndex, pavedNear } = await import('../src/client/world/scenic/kit.js');

test('the indexed free() answers exactly what looking at every taken spot does, as spots are added', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const taken: { x: number; z: number; r: number }[] = [];
  const index = takenIndex(taken, (x, z, r) => pavedNear(x, z, r + 0.5));
  const slow = (x: number, z: number, r: number) => !pavedNear(x, z, r + 0.5) && taken.every((t) => Math.hypot(t.x - x, t.z - z) > t.r + r);
  let freeCount = 0;
  let total = 0;
  for (let round = 0; round < 8; round++) {
    // Some of everything: trees, a few big places (a farm, a mountain), pushed straight on like the parts do.
    for (let i = 0; i < 300; i++) taken.push({ x: -300 + rand() * 600, z: -300 + rand() * 600, r: i % 40 === 0 ? 6 + rand() * 30 : 0.3 + rand() * 5 });
    for (let i = 0; i < 1500; i++) {
      const x = -320 + rand() * 640;
      const z = -320 + rand() * 640;
      const r = 0.5 + rand() * 4;
      const want = slow(x, z, r);
      assert.equal(index(x, z, r), want, `(${x.toFixed(1)}, ${z.toFixed(1)}) r ${r.toFixed(1)}`);
      total++;
      if (want) freeCount++;
    }
  }
  assert.ok(freeCount > 100 && freeCount < total - 100, `both answers come up (${freeCount} free of ${total})`);
});
