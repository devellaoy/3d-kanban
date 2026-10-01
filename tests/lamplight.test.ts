import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ticks } from '../src/client/core/registry.js';
import { installLamplight } from '../src/client/features/lamplight/index.js';

/** The office's lamplight on its own: the sky lights the sun each frame (as Sky.update does), then the env tick runs. */
function rig() {
  const ticks = new Ticks();
  const sun = new THREE.DirectionalLight();
  const wall = new THREE.Mesh();
  wall.userData.wall = true;
  wall.receiveShadow = true;
  const group = new THREE.Group().add(wall);
  const at = { office: true };
  const ctx = { ticks, sky: { lampsOn: 1 }, office: { group }, inOffice: () => at.office, upTop: () => false };
  installLamplight(ctx as never, { stage: { sun }, place: { indoors: () => true } } as never);
  let t = 0;
  /** A night sky's dim, low sun from the side, then the frame's ticks. */
  const frame = () => {
    sun.position.set(40, 10, 0);
    sun.intensity = 0.16;
    sun.color.set('#8899ff');
    t += 1 / 60;
    ticks.run({ delta: 1 / 60, dt: 1 / 60, t, now: t * 1000 });
  };
  return { sun, wall, at, frame };
}

test('indoors at night the lamps light the room from overhead, and the walls take no shadows', () => {
  const { sun, wall, frame } = rig();
  for (let i = 0; i < 120; i++) frame();
  assert.ok(sun.intensity > 0.6, `lamp-bright, got ${sun.intensity}`);
  assert.ok(sun.position.y > Math.abs(sun.position.x) * 3, 'from nearly overhead');
  assert.ok(sun.shadow.intensity < 0.75);
  assert.equal(wall.receiveShadow, false);
});

test('a map of its own lights itself from the first frame after the switch: the office’s lamplight lets go at once', () => {
  const { sun, wall, at, frame } = rig();
  for (let i = 0; i < 120; i++) frame();
  at.office = false;
  for (let i = 0; i < 3; i++) {
    frame();
    assert.equal(sun.intensity, 0.16);
    assert.deepEqual(sun.position.toArray(), [40, 10, 0]);
    assert.equal(sun.color.getHexString(), new THREE.Color('#8899ff').getHexString());
    assert.equal(sun.shadow.intensity, 1);
    assert.equal(wall.receiveShadow, true);
  }
  // Back in the office it eases in again from outdoors.
  at.office = true;
  frame();
  assert.ok(sun.intensity < 0.6, `eased in, not snapped: ${sun.intensity}`);
});
