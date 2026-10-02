// Third person plays like first person, only the camera is behind you (docs/controls.md).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EYE_HEIGHT, PlayerController, SHOULDER, THIRD_PITCH_MAX, THIRD_PITCH_MIN, alongRay, eyeSees, orbitOffset, shoulderOffset, tapNdc, withinReach } from '../src/client/player/index.js';
import type { Collider } from '../src/client/world/office.js';
import { FLOOR, SLAB } from '../src/shared/layout.js';

const officeFloor: Collider = { ...FLOOR, bottom: -SLAB, top: 0 };
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function controller(t: TestContext, dom: EventTarget = new EventTarget()) {
  const win = new EventTarget();
  const doc = new EventTarget();
  for (const [name, value] of [['window', win], ['document', doc]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, dom as unknown as HTMLElement, [officeFloor]);
  player.camYaw = 0;
  const fire = (target: EventTarget, type: string, props: Record<string, unknown>) => {
    const e = new Event(type);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  const keys = (...codes: string[]) => {
    player.clearKeys();
    for (const code of codes) fire(win, 'keydown', { code });
  };
  const frames = (count: number, dt = 1 / 60) => {
    for (let i = 0; i < count; i++) player.update(dt);
  };
  return { player, camera, win, doc, dom, fire, keys, frames };
}

test('the orbit offset follows heading, tilt and distance', () => {
  const behind = orbitOffset(0, 0, 5);
  close(behind.x, 0);
  close(behind.y, 0);
  close(behind.z, 5);
  const above = orbitOffset(1.1, Math.PI / 2, 4);
  close(above.y, 4);
  close(Math.hypot(above.x, above.z), 0);
  const tipped = orbitOffset(Math.PI / 2, 0.4, 7.5);
  close(tipped.length(), 7.5);
  close(tipped.y, Math.sin(0.4) * 7.5);
  assert.ok(tipped.x > 0 && Math.abs(tipped.z) < 1e-6);
});

test("the shoulder offset is to the camera's right, whichever way it faces", () => {
  const cam = new THREE.PerspectiveCamera();
  cam.rotation.order = 'YXZ';
  for (const yaw of [0, 0.7, Math.PI / 2, 2.5, -1.9]) {
    cam.rotation.set(0, yaw, 0);
    cam.updateMatrixWorld();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(SHOULDER);
    const off = shoulderOffset(yaw);
    close(off.x, right.x);
    close(off.y, 0);
    close(off.z, right.z);
  }
});

test('alongRay: how far along the camera ray you are, and nothing before the camera', () => {
  const origin = new THREE.Vector3(0, 2, 5);
  const dir = new THREE.Vector3(0, 0, -1);
  close(alongRay(origin, dir, new THREE.Vector3(0.5, 1.4, 0)), 5);
  close(alongRay(origin, dir, new THREE.Vector3(0, 0, 9)), 0);
});

test('reach counts from your eyes, not from the camera behind you', () => {
  const eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
  // A desk 4 m in front of you is in reach (4.5 m), even though it's 11 m from a camera 7 m behind you.
  assert.ok(withinReach(new THREE.Vector3(0, 0.8, -4), eye, 4.5));
  assert.ok(!withinReach(new THREE.Vector3(0, 0.8, -6), eye, 4.5));
});

test('third person: the camera sits behind you over your right shoulder, and its centre ray passes you by', (t) => {
  const { player, camera } = controller(t);
  player.pos.set(0, 0, 0);
  player.setView('third');
  player.camYaw = 0;
  player.camPitch = 0.3;
  player.camDist = 4;
  player.updateCamera(true);
  // Behind you (the camera looks along -z at yaw 0), up and to the right.
  assert.ok(camera.position.z > 3, `camera z ${camera.position.z}`);
  assert.ok(camera.position.x > 0.4, `camera x ${camera.position.x}`);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  close(dir.x, 0, 1e-3);
  close(Math.asin(dir.y), -0.3, 1e-3);
  // The ray through the crosshair goes by your head at the shoulder offset, not through it.
  const eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
  const along = alongRay(camera.position, dir, eye);
  const closest = camera.position.clone().addScaledVector(dir, along);
  assert.ok(closest.distanceTo(eye) > SHOULDER * 0.8, `ray passes ${closest.distanceTo(eye)} m from your eyes`);
  assert.ok(along > 3, 'what the ray meets before it gets to you is ignored');
});

test('third person looks around with the mouse like first person: yaw, and the camera tips within its range', (t) => {
  const { player, win, dom, fire } = controller(t);
  player.setView('third');
  const yaw0 = player.camYaw;
  const pitch0 = player.camPitch;
  const look0 = player.lookPitch;
  // No pointer lock here (as on a touch screen): a drag looks around, it doesn't orbit.
  fire(dom, 'pointerdown', { pointerType: 'mouse', clientX: 100, clientY: 100, button: 0 });
  fire(win, 'pointermove', { clientX: 140, clientY: 120, movementX: 40, movementY: 20 });
  assert.ok(player.camYaw < yaw0, 'moving right turns you right');
  assert.ok(player.camPitch > pitch0, 'moving down tips the camera up over you, looking down');
  assert.equal(player.lookPitch, look0, "first person's pitch is left alone");
  fire(win, 'pointermove', { clientX: 140, clientY: 5000, movementX: 0, movementY: 4880 });
  close(player.camPitch, THIRD_PITCH_MAX);
  fire(win, 'pointermove', { clientX: 140, clientY: -9000, movementX: 0, movementY: -14000 });
  close(player.camPitch, THIRD_PITCH_MIN);
});

test('a click in third person with the mouse captured is a click at the crosshair', (t) => {
  const dom = Object.assign(new EventTarget(), { requestPointerLock: () => undefined });
  const { player, doc, dom: canvas, fire } = controller(t, dom);
  Object.defineProperty(doc, 'pointerLockElement', { configurable: true, value: canvas });
  player.setView('third');
  const clicks: THREE.Vector2[] = [];
  player.onClick = (ndc) => clicks.push(ndc.clone());
  fire(canvas, 'pointerdown', { pointerType: 'mouse', clientX: 900, clientY: 100, button: 0 });
  assert.equal(clicks.length, 1);
  assert.deepEqual([clicks[0].x, clicks[0].y], [0, 0]);
});

test('tapNdc: where a tap lands on the canvas, in normalized device coordinates', () => {
  const rect = { left: 10, top: 20, width: 1000, height: 500 };
  const at = tapNdc(910, 120, rect);
  close(at.x, 0.8);
  close(at.y, 0.6);
  const mid = tapNdc(510, 270, rect);
  close(mid.x, 0);
  close(mid.y, 0);
});

test('with the mouse free (a touch screen), a tap in third person is where you tapped, in first the crosshair', (t) => {
  const dom = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }) });
  const { player, win, fire } = controller(t, dom);
  player.setView('third');
  const clicks: THREE.Vector2[] = [];
  player.onClick = (ndc) => clicks.push(ndc.clone());
  const tap = () => {
    fire(dom, 'pointerdown', { pointerType: 'touch', clientX: 900, clientY: 100, button: 0 });
    fire(win, 'pointerup', { target: dom, clientX: 900, clientY: 100, button: 0 });
  };
  tap();
  assert.equal(clicks.length, 1);
  close(clicks[0].x, 0.8);
  close(clicks[0].y, 0.6);
  // A drag looks around instead, and isn't a tap on anything.
  fire(dom, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100, button: 0 });
  fire(win, 'pointermove', { clientX: 200, clientY: 100, movementX: 100, movementY: 0 });
  fire(win, 'pointerup', { target: dom, clientX: 200, clientY: 100, button: 0 });
  assert.equal(clicks.length, 1);
  player.setView('first');
  tap();
  assert.equal(clicks.length, 2);
  assert.deepEqual([clicks[1].x, clicks[1].y], [0, 0]);
});

/** A box from (x0, y0, z0) to (x1, y1, z1), named. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0));
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.name = name;
  return m;
}

/** What the third-person crosshair's ray meets first past you, as aimedAt casts it, and your eyes. */
function thirdPersonAim(scene: THREE.Object3D, yaw = 0, pitch = 0.35, dist = 7.5) {
  scene.updateMatrixWorld(true);
  const target = new THREE.Vector3(0, 1.3, 0).add(shoulderOffset(yaw));
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(target).add(orbitOffset(yaw, pitch, dist));
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(0, 0), cam);
  const eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
  rc.near = alongRay(rc.ray.origin, rc.ray.direction, eye);
  return { hit: rc.intersectObject(scene, true)[0], eye, cam };
}

test("third person: the camera over your shoulder doesn't let you use what's behind the wall beside you", () => {
  // The devil's advocate's case: an interior wall 0.3 m to your right, running the way you face,
  // and a desk in the next room that the camera, 0.75 m right of you, sees past its end.
  const scene = new THREE.Group();
  const wall = box(0.3, 0.45, 0, 3, -10, 10, 'wall');
  const desk = box(0.6, 1.6, 0, 0.8, -3.5, -2, 'desk-next-room');
  scene.add(wall, desk);
  const { hit, eye, cam } = thirdPersonAim(scene);
  // The camera's ray does land on the desk next door, and within a desk's reach of your eyes…
  assert.equal(hit?.object.name, 'desk-next-room');
  assert.ok(withinReach(hit.point, eye, 4.5));
  // …but your eyes don't see it: the wall is in the way.
  const pickables = [scene];
  assert.ok(!eyeSees(eye, hit.point, pickables, (h) => h.object !== hit.object, cam));
  // With no wall there, they do.
  scene.remove(wall);
  scene.updateMatrixWorld(true);
  assert.ok(eyeSees(eye, hit.point, pickables, (h) => h.object !== hit.object, cam));
});

test("eyeSees: the surface that was hit, and what doesn't block, aren't in the way", () => {
  const scene = new THREE.Group();
  const desk = box(-0.5, 0.5, 0, 0.8, -3, -2, 'desk');
  scene.add(desk);
  scene.updateMatrixWorld(true);
  const eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
  const top = new THREE.Vector3(0, 0.8, -2.5);
  const cam = new THREE.PerspectiveCamera();
  // Even counting everything as in the way, the desk top the ray ends on isn't in its own way.
  assert.ok(eyeSees(eye, top, [scene], () => true, cam));
  // A pane of glass between you and it is.
  const glass = box(-1, 1, 0, 3, -1.05, -1, 'glass');
  scene.add(glass);
  scene.updateMatrixWorld(true);
  const blocks = (h: THREE.Intersection) => h.object.visible && h.object !== desk;
  assert.ok(!eyeSees(eye, top, [scene], blocks, cam));
  // Hidden, it isn't.
  glass.visible = false;
  assert.ok(eyeSees(eye, top, [scene], blocks, cam));
  // And anything past the point doesn't count either.
  glass.visible = true;
  glass.position.z = -5;
  scene.updateMatrixWorld(true);
  assert.ok(eyeSees(eye, top, [scene], blocks, cam));
});

test('eyeSees with a sprite among what it looks through (a name tag, a sign): no throw, and it can be in the way', () => {
  // The freeze in third person: a ray set by hand has no camera, and three.js throws on the first
  // sprite it meets, anywhere in the scene. Thrown from the frame loop, nothing moved again.
  const scene = new THREE.Group();
  const desk = box(-0.5, 0.5, 0, 0.8, -3, -2, 'desk');
  const tag = new THREE.Sprite(new THREE.SpriteMaterial());
  tag.name = 'name-tag';
  tag.position.set(8, 2, 8);
  scene.add(desk, tag);
  scene.updateMatrixWorld(true);
  const eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
  const top = new THREE.Vector3(0, 0.8, -2.5);
  const bare = new THREE.Raycaster();
  bare.set(eye, top.clone().sub(eye).normalize());
  assert.throws(() => bare.intersectObjects([scene], true), /matrixWorld/);
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0.75, 3, 7);
  cam.lookAt(0, 1.3, 0);
  cam.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  const blocks = (h: THREE.Intersection) => h.object !== desk;
  // Off to one side, the tag isn't in the way, and the same raycaster keeps working frame after frame.
  for (let i = 0; i < 3; i++) assert.ok(eyeSees(eye, top, [scene], blocks, cam, rc));
  // Right between your eyes and the desk, it is.
  tag.position.set(0, 1.1, -1.25);
  scene.updateMatrixWorld(true);
  assert.ok(!eyeSees(eye, top, [scene], blocks, cam, rc));
});

test('third person captures the mouse like first person does', (t) => {
  const dom = Object.assign(new EventTarget(), { requestPointerLock: () => undefined });
  const { player } = controller(t, dom);
  assert.ok(player.canLock);
  player.setView('third');
  assert.ok(player.canLock, 'clicking the office captures the mouse in third person too');
});

test('walking in third person faces where the camera looks, and W goes that way', (t) => {
  const { player, keys, frames } = controller(t);
  player.pos.set(0, 0, 0);
  player.setView('third');
  player.camYaw = 0.8;
  player.facing = 0;
  keys('KeyD');
  frames(60);
  const want = player.camYaw + Math.PI;
  close(Math.atan2(Math.sin(player.facing - want), Math.cos(player.facing - want)), 0, 1e-3);
  // Strafing doesn't turn you sideways.
  keys('KeyW');
  const from = player.pos.clone();
  frames(20);
  const step = player.pos.clone().sub(from);
  close(Math.atan2(step.x, step.z), Math.atan2(-Math.sin(player.camYaw), -Math.cos(player.camYaw)), 1e-3);
});

/** How far `facing` is from `want`, the short way round. */
const turnLeft = (facing: number, want: number) => Math.abs(Math.atan2(Math.sin(want - facing), Math.cos(want - facing)));

test('standing still in third person, you turn (smoothly) to where the camera looks, as in first person', (t) => {
  const { player, keys, frames } = controller(t);
  player.pos.set(0, 0, 0);
  player.setView('third');
  keys();
  player.camYaw = 1.2;
  player.facing = 0;
  const want = player.camYaw + Math.PI;
  const before = turnLeft(player.facing, want);
  frames(1);
  const after = turnLeft(player.facing, want);
  assert.ok(after < before && after > 0.1, `a frame turns you part of the way (${before} → ${after})`);
  frames(60);
  close(turnLeft(player.facing, want), 0, 1e-3);
  // So what aims by where you face (dropping the ball) goes where the crosshair points.
  const f = player.forward();
  close(Math.atan2(f.x, f.y), Math.atan2(-Math.sin(player.camYaw), -Math.cos(player.camYaw)), 1e-3);
  assert.ok(!player.moving);
});

test("third person: what has hold of you (golf, the throwing line) and a seat keep their own facing", (t) => {
  const { player, keys, frames } = controller(t);
  player.pos.set(0, 0, 0);
  player.setView('third');
  keys();
  player.camYaw = 1.2;
  player.facing = 0.3;
  player.rig = () => undefined;
  frames(30);
  close(player.facing, 0.3);
  player.rig = null;
  player.sit({ key: 'chair:0', seatId: 'chair', x: 0, y: 0, z: 0, rotY: 2, hips: 0.45, out: 0.6 });
  frames(30);
  close(player.facing, 2);
});

test('on a walk of its own in third person, you face the way you walk, not the camera', (t) => {
  const { player, keys, frames } = controller(t);
  player.pos.set(0, 0, 0);
  player.setView('third');
  keys();
  player.camYaw = 0;
  player.facing = Math.PI;
  player.walkPath([{ x: 20, z: 0 }]);
  frames(40);
  assert.ok(player.pos.x > 2 && player.pos.x < 19, `still on the way (${player.pos.x})`);
  close(turnLeft(player.facing, Math.PI / 2), 0, 0.02);
});

// Third person's camera follows the mouse with no lag, and eases anything else (wheel, vehicles) the same at any frame rate.
function thirdPerson(t: TestContext, dom?: EventTarget) {
  const c = controller(t, dom);
  c.player.pos.set(0, 0, 0);
  c.player.setView('third');
  c.player.camYaw = 0.3;
  c.player.camPitch = 0.3;
  c.player.camDist = 3;
  c.player.updateCamera(true);
  const targetOf = (yaw: number) => new THREE.Vector3(0, THIRD_TARGET_Y, 0).add(shoulderOffset(yaw));
  return { ...c, targetOf };
}
const THIRD_TARGET_Y = 1.3;
/** Third person with the mouse captured, so a move turns the camera by its movementX/Y. */
function thirdPersonLocked(t: TestContext) {
  const c = thirdPerson(t, Object.assign(new EventTarget(), { requestPointerLock: () => undefined }));
  Object.defineProperty(c.doc, 'pointerLockElement', { configurable: true, value: c.dom });
  return c;
}
/** Pixels of mouse movement that turn the view by `rad` (LOOK_SPEED in player.ts). */
const px = (rad: number) => rad / 0.0022;

test('third person: mouse look shows at once, the camera stays on its orbit', (t) => {
  const { player, camera, win, dom, fire, frames, targetOf } = thirdPerson(t);
  fire(dom, 'pointerdown', { pointerType: 'mouse', clientX: 100, clientY: 100, button: 0 });
  fire(win, 'pointermove', { clientX: 200, clientY: 130, movementX: 100, movementY: 30 });
  frames(1);
  const target = targetOf(player.camYaw);
  const off = camera.position.clone().sub(target);
  close(off.length(), player.camDist, 1e-6);
  const want = orbitOffset(player.camYaw, player.camPitch, player.camDist);
  close(off.x, want.x, 1e-6);
  close(off.y, want.y, 1e-6);
  close(off.z, want.z, 1e-6);
});

test('third person: an outside change of yaw or distance settles to the same place at 60 and 144 Hz', (t) => {
  const settle = (steps: number, dt: number) => {
    const { player, camera, frames } = thirdPerson(t);
    player.camYaw = 1.4;
    player.camDist = 5;
    frames(steps, dt);
    return camera.position.clone();
  };
  const a = settle(30, 1 / 60);
  const b = settle(72, 1 / 144);
  assert.ok(a.distanceTo(b) < 1e-3, `${a.toArray()} vs ${b.toArray()}`);
});

test('third person: an outside distance change glides, then arrives', (t) => {
  const { player, camera, frames, targetOf } = thirdPerson(t);
  player.camDist = 6;
  frames(1);
  const d1 = camera.position.distanceTo(targetOf(player.camYaw));
  assert.ok(d1 > 3.05 && d1 < 5.95, `after one frame ${d1}`);
  frames(120);
  close(camera.position.distanceTo(targetOf(player.camYaw)), 6, 1e-3);
});

test('third person: turning against a wall keeps the camera in the room, on the clamped orbit every frame', (t) => {
  const { player, camera, win, fire, frames, targetOf } = thirdPersonLocked(t);
  player.pos.set(0, 0, FLOOR.maxZ - 1);
  player.camYaw = 0;
  player.updateCamera(true);
  for (let i = 0; i < 40; i++) {
    const yaw = player.camYaw;
    fire(win, 'pointermove', { clientX: 100, clientY: 100, movementX: px(0.05), movementY: 0 });
    close(player.camYaw, yaw - 0.05, 1e-9);
    frames(1);
    const ideal = targetOf(player.camYaw).add(new THREE.Vector3(0, 0, FLOOR.maxZ - 1)).add(orbitOffset(player.camYaw, player.camPitch, player.camDist));
    const x = THREE.MathUtils.clamp(ideal.x, FLOOR.minX + 0.4, FLOOR.maxX - 0.4);
    const z = THREE.MathUtils.clamp(ideal.z, FLOOR.minZ + 0.4, FLOOR.maxZ - 0.4);
    close(camera.position.x, x, 1e-6);
    close(camera.position.z, z, 1e-6);
  }
});

test('third person: a camera moved by someone else (golf, throwing) eases back to the orbit', (t) => {
  const { player, camera, frames, targetOf } = thirdPerson(t);
  const orbit = () => targetOf(player.camYaw).add(orbitOffset(player.camYaw, player.camPitch, player.camDist));
  camera.position.add(new THREE.Vector3(4, 2, -3));
  frames(1);
  assert.ok(camera.position.distanceTo(orbit()) > 1, 'it glides, not cuts');
  frames(60);
  assert.ok(camera.position.distanceTo(orbit()) < 0.01);
});

test('third person: a smoothly turning camYaw (a car) is followed with no lag', (t) => {
  const { player, camera, frames, targetOf } = thirdPerson(t);
  for (let i = 0; i < 60; i++) {
    player.camYaw += 0.02;
    frames(1);
    const want = targetOf(player.camYaw).add(orbitOffset(player.camYaw, player.camPitch, player.camDist));
    assert.ok(camera.position.distanceTo(want) < 1e-6);
  }
});

test('third person: a 3 m distance jump glides', (t) => {
  const { player, camera, frames, targetOf } = thirdPerson(t);
  player.camDist += 3;
  frames(1);
  const d = camera.position.distanceTo(targetOf(player.camYaw));
  assert.ok(d > 3.05 && d < 5.95, `${d}`);
});

test('third person: the mouse keeps the shown tilt within its limits while an outside tilt change eases out', (t) => {
  const { player, camera, win, fire, frames, targetOf } = thirdPersonLocked(t);
  player.camPitch = THIRD_PITCH_MAX;
  player.updateCamera(true);
  player.camPitch = 0.32; // a car's
  frames(1);
  fire(win, 'pointermove', { clientX: 0, clientY: 0, movementX: 0, movementY: px(2) });
  for (let i = 0; i < 30; i++) {
    frames(1);
    const off = camera.position.clone().sub(targetOf(player.camYaw));
    assert.ok(Math.asin(off.y / off.length()) <= THIRD_PITCH_MAX + 1e-6, `tilt ${Math.asin(off.y / off.length())}`);
    // Still behind you: the camera's heading points the way camYaw does, not over the top to the other side.
    assert.ok(off.x * Math.sin(player.camYaw) + off.z * Math.cos(player.camYaw) > 0, 'behind you');
  }
});

test('third person: a small wheel step glides too, then arrives', (t) => {
  const { player, camera, dom, fire, frames, targetOf } = thirdPerson(t);
  fire(dom, 'wheel', { deltaY: 20 });
  close(player.camDist, 3.2);
  frames(1);
  const d1 = camera.position.distanceTo(targetOf(player.camYaw));
  assert.ok(d1 > 3.001 && d1 < 3.199, `after one frame ${d1}`);
  frames(120);
  close(camera.position.distanceTo(targetOf(player.camYaw)), 3.2, 1e-3);
});

test('third person: the shown tilt stays within its limits when an outside change and a mouse move land in the same frame', (t) => {
  const { player, camera, win, fire, frames, targetOf } = thirdPersonLocked(t);
  player.camPitch = THIRD_PITCH_MAX;
  player.updateCamera(true);
  player.camPitch = 0.32; // a car's, with no frame before the mouse
  fire(win, 'pointermove', { clientX: 0, clientY: 0, movementX: 0, movementY: 250 });
  for (let i = 0; i < 30; i++) {
    frames(1);
    const off = camera.position.clone().sub(targetOf(player.camYaw));
    assert.ok(Math.asin(off.y / off.length()) <= THIRD_PITCH_MAX + 1e-6, `tilt ${Math.asin(off.y / off.length())}`);
    assert.ok(off.x * Math.sin(player.camYaw) + off.z * Math.cos(player.camYaw) > 0, 'behind you');
  }
});
