import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CAR } from '../src/shared/garage.js';
import { puffVelocity } from '../src/client/features/cars/effects.js';
import { supercar, WHEEL_R, WHEEL_Y } from '../src/client/features/cars/supercar.js';

// The supercars' look (dimensions the driving and seating rely on, a draw-call budget) and where tyre smoke goes.

test('tyre smoke never travels ahead of the car, whichever way it drives and however the dice fall', () => {
  for (const [vx, vz] of [[0, 30], [0, -30], [25, 10], [-18, 22], [3, 0.5]]) {
    const speed = Math.hypot(vx, vz);
    for (const a of [-1, 0, 1]) {
      for (const b of [-1, 0, 1]) {
        const u = puffVelocity(vx, vz, 0.05, 0.6, a, b, 0.7);
        const along = (u.vx * vx + u.vz * vz) / speed;
        assert.ok(along <= speed * 0.1 + 1e-9, `along ${along} for ${vx},${vz} (${a},${b})`);
        assert.equal(u.vy, 0.7);
      }
    }
  }
});

test('tyre smoke from a car standing still just spreads and rises', () => {
  const u = puffVelocity(0, 0, 0.05, 0.6, 1, -1, 0.5);
  assert.deepEqual([u.vx, u.vz], [0.6, -0.6]);
});

for (const kind of ['lambo', 'ferrari'] as const) {
  test(`${kind}: the size, the wheels and the draw calls the driving and the garage count on`, () => {
    const m = supercar(kind, '#8ac926');
    m.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m.root);
    assert.ok(box.max.z - box.min.z < CAR.length + 0.5, 'about as long as the collider');
    assert.ok(box.max.x - box.min.x < CAR.width + 0.1, 'no wider than the collider');
    assert.equal(m.wheels.length, 2);
    for (const w of m.wheels) {
      const p = new THREE.Vector3();
      w.getWorldPosition(p);
      assert.ok(Math.abs(p.y - WHEEL_Y) < 1e-6 && WHEEL_Y - WHEEL_R < 0.02);
    }
    let meshes = 0;
    m.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    assert.ok(meshes <= 20, `${meshes} meshes`);
  });
}
