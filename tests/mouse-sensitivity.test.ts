// ⚙️ Settings → You → Mouse sensitivity (docs/controls.md).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/client/player/index.js';
import { loadSettings } from '../src/client/state/index.js';
import type { Collider } from '../src/client/world/office.js';
import { FLOOR, SLAB } from '../src/shared/layout.js';

const officeFloor: Collider = { ...FLOOR, bottom: -SLAB, top: 0 };
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function globals(t: TestContext, values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

function stored(t: TestContext, value: unknown) {
  globals(t, { localStorage: { getItem: () => (value === undefined ? null : JSON.stringify(value)), setItem: () => {} } });
  return loadSettings();
}

test('mouse sensitivity loads as 100% when never set, and is kept within 25–200%', (t) => {
  assert.equal(stored(t, undefined).mouseSensitivity, 1);
  assert.equal(stored(t, { view: 'third', volume: 0.3 }).mouseSensitivity, 1, 'settings saved before it existed');
  assert.equal(stored(t, { mouseSensitivity: 1.5 }).mouseSensitivity, 1.5);
  assert.equal(stored(t, { mouseSensitivity: 0.1 }).mouseSensitivity, 0.25);
  assert.equal(stored(t, { mouseSensitivity: 9 }).mouseSensitivity, 2);
  assert.equal(stored(t, { mouseSensitivity: 'fast' }).mouseSensitivity, 1);
  assert.equal(stored(t, { mouseSensitivity: null }).mouseSensitivity, 1);
});

function controller(t: TestContext) {
  const win = new EventTarget();
  const doc = new EventTarget();
  globals(t, { window: win, document: doc });
  const dom = new EventTarget();
  const player = new PlayerController(new THREE.PerspectiveCamera(), dom as unknown as HTMLElement, [officeFloor]);
  const fire = (target: EventTarget, type: string, props: Record<string, unknown>) => {
    const e = new Event(type);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  return { player, win, doc, dom, fire };
}

test('with the mouse captured, sensitivity scales how far it turns you; 100% is the upstream 0.0022 rad per pixel', (t) => {
  const { player, win, doc, dom, fire } = controller(t);
  Object.defineProperty(doc, 'pointerLockElement', { configurable: true, value: dom });
  const turn = (sensitivity: number) => {
    player.setMouseSensitivity(sensitivity);
    const yaw = player.camYaw;
    const pitch = player.lookPitch;
    fire(win, 'pointermove', { clientX: 0, clientY: 0, movementX: 50, movementY: 10 });
    return [yaw - player.camYaw, pitch - player.lookPitch];
  };
  const [yaw1, pitch1] = turn(1);
  close(yaw1, 50 * 0.0022);
  close(pitch1, 10 * 0.0022);
  const [yaw2, pitch2] = turn(2);
  close(yaw2, 2 * yaw1);
  close(pitch2, 2 * pitch1);
  close(turn(0.25)[0], yaw1 / 4);
  // Out of range or not a number: clamped, or left as it was.
  player.setMouseSensitivity(5);
  close(turn(Number.NaN)[0], 2 * yaw1);
});

test('dragging to look with a mouse (the mouse free) is scaled the same way; a finger on a touch screen is not', (t) => {
  const { player, win, dom, fire } = controller(t);
  player.setView('third');
  const drag = (sensitivity: number, pointerType = 'mouse') => {
    player.setMouseSensitivity(sensitivity);
    fire(dom, 'pointerdown', { pointerType, clientX: 100, clientY: 100, button: 0 });
    const yaw = player.camYaw;
    fire(win, 'pointermove', { pointerType, clientX: 120, clientY: 100, movementX: 20, movementY: 0 });
    fire(win, 'pointerup', { pointerType, clientX: 120, clientY: 100, button: 0 });
    return yaw - player.camYaw;
  };
  const base = drag(1);
  close(base, 20 * 0.005);
  close(drag(1.5), 1.5 * base);
  close(drag(0.25), base / 4);
  close(drag(2, 'touch'), base);
});

test('sensitivity leaves walking and the wheel alone', (t) => {
  const walked = (sensitivity: number) => {
    const { player, win, dom, fire } = controller(t);
    player.setMouseSensitivity(sensitivity);
    player.setView('third');
    fire(dom, 'wheel', { deltaY: 100, preventDefault: () => {} });
    fire(win, 'keydown', { code: 'KeyW' });
    for (let i = 0; i < 30; i++) player.update(1 / 60);
    return [player.pos.x, player.pos.z, player.camDist];
  };
  const usual = walked(1);
  assert.ok(Math.hypot(usual[0], usual[1]) > 0, 'W walks');
  for (const other of [walked(0.25), walked(2)]) usual.forEach((v, i) => close(other[i], v));
});
