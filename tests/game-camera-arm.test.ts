// The third-person camera is part of your body: the spring arm stops short of walls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARM_RADIUS, armFraction, easeArm } from '../src/client/player/arm.js';
import type { Collider } from '../src/client/world/types.js';

const head = { x: 0, y: 1.3, z: 0 };
const wall: Collider = { minX: -5, maxX: 5, minZ: 3, maxZ: 3.2, top: 99 };

test('nothing in the way leaves the arm whole', () => {
  assert.equal(armFraction(head, { x: 0, y: 3, z: 6 }, [], 0), 1);
  assert.equal(armFraction(head, { x: 0, y: 3, z: 6 }, [{ ...wall, minZ: -9, maxZ: -8 }], 0), 1);
});

test('a wall behind you pulls the camera in to just in front of it', () => {
  const cam = { x: 0, y: 1.3, z: 6 };
  const f = armFraction(head, cam, [wall], 0);
  assert.ok(Math.abs(f * 6 - (3 - ARM_RADIUS)) < 1e-9, `${f * 6}`);
});

test('the glass room (a wall) and the ceiling above count; low furniture and fences do not', () => {
  const cam = { x: 0, y: 3, z: 0.1 };
  assert.ok(armFraction(head, cam, [{ minX: -2, maxX: 2, minZ: -2, maxZ: 2, bottom: 2.2, top: 2.5 }], 0) < 1);
  const far = { x: 0, y: 1.3, z: 6 };
  assert.equal(armFraction(head, far, [{ ...wall, top: 0.75 }], 0), 1, 'a desk');
  assert.equal(armFraction(head, far, [{ ...wall, fence: true }], 0), 1, 'a fence');
  assert.equal(armFraction(head, far, [{ ...wall, top: 1.5 }], 1), 1, 'standing on a stage, its edge is below you');
});

test('a collider the head is inside of is ignored, and a wall close to the head pulls the camera in to short of it, not through it', () => {
  const cam = { x: 0, y: 1.3, z: 6 };
  assert.equal(armFraction(head, cam, [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1, top: 99 }], 0), 1);
  const touching: Collider = { ...wall, minZ: 0.4, maxZ: 0.6 };
  const f = armFraction(head, cam, [touching], 0);
  assert.ok(Math.abs(f * 6 - (0.4 - ARM_RADIUS)) < 1e-9, `the camera stops at ${f * 6} m, short of the wall at 0.4`);});

test('the nearest of several walls wins; a wall to the side does not block', () => {
  const cam = { x: 0, y: 1.3, z: 8 };
  const near: Collider = { ...wall, minZ: 2, maxZ: 2.2 };
  assert.ok(Math.abs(armFraction(head, cam, [wall, near], 0) * 8 - (2 - ARM_RADIUS)) < 1e-9);
  assert.equal(armFraction(head, cam, [{ minX: 1, maxX: 2, minZ: -9, maxZ: 9, top: 99 }], 0), 1);
});

test('the arm goes in at once and comes out slowly', () => {
  assert.equal(easeArm(1, 0.4, 0.016), 0.4);
  const out = easeArm(0.4, 1, 0.016);
  assert.ok(out > 0.4 && out < 0.5, `${out}`);
  let v = 0.4;
  for (let i = 0; i < 300; i++) v = easeArm(v, 1, 1 / 60);
  assert.ok(v > 0.99);
  assert.equal(easeArm(0.4, 1, 0.016, true), 1);
});
