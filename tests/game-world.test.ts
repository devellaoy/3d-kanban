import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { paved } from '../src/shared/garage.js';
import { LOOP_PAVED, nearLoop } from '../src/shared/scenic.js';

// The scenic loop is built in a browser (canvas textures); a canvas that draws nothing is all it needs here.
const noop: unknown = new Proxy(() => noop, { get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 10 : noop), set: () => true });
(globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop }) };

const { buildScenic } = await import('../src/client/world/scenic/index.js');

function build() {
  const night = { bulbs: [], halos: [], lamps: [], street: 0, windows: [], glows: [], clouds: null, wetGlass: null } as never;
  const colliders: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  const group = new THREE.Group();
  return { scenic: buildScenic(group, colliders as never, night), colliders, group };
}

/** Whether (x, z), `margin` m round, touches paved ground. */
function onPaving(x: number, z: number, margin: number) {
  for (let a = 0; a < 8; a++) if (paved(x + Math.cos((a * Math.PI) / 4) * margin, z + Math.sin((a * Math.PI) / 4) * margin)) return true;
  return paved(x, z);
}

test('nothing is planted or put out on paved ground, the streets east and west of town included', () => {
  const { scenic } = build();
  assert.ok(scenic.placed.length > 500, 'trees and the rest were placed');
  const bad = scenic.placed.filter((p) => onPaving(p.x, p.z, 1.2));
  assert.deepEqual(bad.map((p) => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`), []);
});

test('no solid scenery stands in the road lanes', () => {
  const { colliders } = build();
  const bad = colliders.filter((c) => {
    const x = (c.minX + c.maxX) / 2;
    const z = (c.minZ + c.maxZ) / 2;
    if (c.maxX - c.minX > 40 || c.maxZ - c.minZ > 40) return false;
    const at = nearLoop(x, z);
    return !!at && at.off < LOOP_PAVED - 1.5 && Math.abs(x) > 64;
  });
  assert.deepEqual(bad.map((c) => `(${c.minX.toFixed(1)}, ${c.minZ.toFixed(1)})`), []);
});
