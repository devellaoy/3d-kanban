import * as THREE from 'three';
import { CAR, SEATS } from '../../../shared/garage';
import { mergeByMaterial, mesh, toon } from '../../world/toon';
import type { CarModel } from './world';

// The off-road 4x4, a chunky cartoon one: high off the ground on big knobbly tyres, wheel-arch flares, a
// bull bar and a spare wheel at the back, a roof rack. Nose toward +z, wheels on y = 0, like supercar() in
// world.ts, and the same parts: its roof (and the rack on it) comes off for whoever's in it, and the
// two seats are where SEATS puts them. All four wheels hang from the body on their own so the
// suspension can move them (see ride.ts): the front pair, which steer, are `wheels`, the rear `rear`.

const WHEEL_R = 0.52;
/** Height of the pivot the body leans about: about where its weight is. */
const PIVOT = 0.7;
/** The wheels: across (x, to each side) and along (z, front and rear). */
const TRACK = 0.96;
const AXLE = 1.4;
/** The body's half width, and the tyres' width. */
const HALF = 0.78;
const TYRE = 0.34;

/** A knobbly tyre on a rim, in a group of its own (merged, so a wheel is a few draw calls). */
function wheel(x: number, z: number): THREE.Object3D {
  const tire = toon('#1c1c21');
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, TYRE, 20).rotateZ(Math.PI / 2), tire));
  // Tread blocks round the tyre.
  const block = new THREE.BoxGeometry(TYRE + 0.02, 0.09, 0.15);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const b = mesh(block, tire, 0, Math.sin(a) * (WHEEL_R + 0.02), Math.cos(a) * (WHEEL_R + 0.02));
    b.rotation.x = Math.PI / 2 - a;
    g.add(b);
  }
  g.add(mesh(new THREE.CylinderGeometry(WHEEL_R * 0.6, WHEEL_R * 0.6, TYRE + 0.03, 12).rotateZ(Math.PI / 2), toon('#c9ccd6')));
  g.add(mesh(new THREE.CylinderGeometry(WHEEL_R * 0.26, WHEEL_R * 0.26, TYRE + 0.07, 8).rotateZ(Math.PI / 2), toon('#3b3e4b')));
  const merged = mergeByMaterial(g);
  merged.position.set(x, WHEEL_R, z);
  return merged;
}

/** A 4x4 in `color`, on its springs' resting height. */
export function offroad(color: string): CarModel {
  const g = new THREE.Group();
  const paint = toon(color);
  const trim = toon('#2a2c38');
  const glass = toon('#2c4254');
  const chrome = toon('#b9bfcc');
  const lamp = toon('#fff6c9', { emissive: '#b8a960' });
  const tail = toon('#ff2d3f', { emissive: '#a3001a' });
  const L = CAR.length / 2;
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const tube = (r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'y' | 'z') => {
    const geo = new THREE.CylinderGeometry(r, r, len, 8);
    if (axis === 'x') geo.rotateZ(Math.PI / 2);
    else if (axis === 'z') geo.rotateX(Math.PI / 2);
    return mesh(geo, mat, x, y, z);
  };

  // Underneath: the chassis rails, two axles with their diffs, and the floor.
  for (const sx of [-1, 1]) g.add(box(0.12, 0.14, 4.0, trim, sx * 0.4, 0.42, 0));
  g.add(box(1.5, 0.08, 4.0, trim, 0, 0.5, 0));
  for (const z of [-AXLE, AXLE]) {
    g.add(tube(0.07, TRACK * 2, trim, 0, WHEEL_R, z, 'x'));
    g.add(mesh(new THREE.SphereGeometry(0.2, 8, 6), trim, 0, WHEEL_R - 0.03, z));
  }
  // The body: the tub's sides and tail round an open floor, and the hood over the engine.
  for (const sx of [-1, 1]) g.add(box(0.12, 0.6, 3.6, paint, sx * (HALF - 0.06), 0.8, -0.15));
  g.add(box(HALF * 2, 0.64, 0.12, paint, 0, 0.82, -1.95));
  g.add(box(HALF * 2, 0.56, 1.5, paint, 0, 0.8, 1.5));
  g.add(box(HALF * 2 - 0.1, 0.1, 1.3, paint, 0, 1.12, 1.5));
  g.add(box(0.5, 0.09, 0.6, trim, 0, 1.2, 1.35));
  // The dash, behind the windshield's foot.
  g.add(box(HALF * 2 - 0.1, 0.3, 0.3, trim, 0, 1.0, 0.62));
  // Grille, round headlamps, the bull bar in front of them, mirrors, tail lamps and running boards.
  g.add(box(1.3, 0.3, 0.06, trim, 0, 0.82, L - 0.02));
  for (const sx of [-1, 1]) {
    g.add(tube(0.15, 0.1, lamp, sx * 0.55, 0.9, L, 'z'));
    g.add(tube(0.045, 0.62, chrome, sx * 0.55, 0.76, L + 0.14, 'y'));
    g.add(box(0.07, 0.17, 0.2, trim, sx * (HALF + 0.1), 1.28, 0.7));
    g.add(box(0.2, 0.2, 0.05, tail, sx * 0.62, 0.92, -2.04));
    g.add(box(0.14, 0.05, 1.7, trim, sx * (HALF + 0.06), 0.42, 0));
  }
  g.add(tube(0.05, 1.3, chrome, 0, 1.05, L + 0.14, 'x'));
  g.add(tube(0.05, 1.5, chrome, 0, 0.5, L + 0.14, 'x'));
  g.add(box(0.9, 0.22, 0.08, trim, 0, 0.38, L + 0.1));
  // The rear bumper, and the spare wheel on its carrier.
  g.add(box(HALF * 2 + 0.1, 0.18, 0.18, trim, 0, 0.52, -2.2));
  g.add(mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.26, 16).rotateX(Math.PI / 2), toon('#1c1c21'), 0.18, 1.0, -2.2));
  g.add(mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.28, 10).rotateX(Math.PI / 2), paint, 0.18, 1.0, -2.2));
  g.add(box(0.14, 0.7, 0.1, trim, 0.18, 0.78, -2.02));
  // Flares over all four wheels, standing out from the sides.
  for (const sx of [-1, 1]) {
    for (const z of [-AXLE, AXLE]) {
      g.add(mesh(new THREE.TorusGeometry(WHEEL_R + 0.08, 0.06, 6, 14, Math.PI).rotateY(Math.PI / 2), trim, sx * (TRACK + TYRE / 2 + 0.02), WHEEL_R, z));
      g.add(box(TYRE + 0.14, 0.07, 1.3, trim, sx * TRACK, WHEEL_R * 2 + 0.1, z));
    }
  }
  // A snorkel up the right-hand pillar.
  g.add(tube(0.05, 1.2, trim, -0.84, 1.55, 0.7, 'y'));

  // The cabin: glass between pillars, a painted roof, and a rack with a light bar on top.
  const closed = new THREE.Group();
  closed.add(box(HALF * 2 - 0.1, 0.64, 2.5, glass, 0, 1.38, -0.55));
  for (const sx of [-1, 1]) {
    for (const z of [-1.8, 0.7]) closed.add(box(0.1, 0.68, 0.1, paint, sx * (HALF - 0.04), 1.39, z));
  }
  closed.add(box(HALF * 2 + 0.1, 0.09, 2.8, paint, 0, 1.76, -0.55));
  for (const sx of [-1, 1]) closed.add(box(0.05, 0.07, 2.5, trim, sx * 0.66, 1.89, -0.6));
  for (let i = 0; i < 5; i++) closed.add(box(1.4, 0.05, 0.06, trim, 0, 1.9, -1.8 + i * 0.5));
  closed.add(box(1.0, 0.28, 0.5, toon('#4a4e5c'), 0, 2.05, -1.2));
  closed.add(box(1.3, 0.1, 0.16, trim, 0, 1.97, 0.38));
  for (const x of [-0.45, -0.15, 0.15, 0.45]) closed.add(tube(0.06, 0.08, lamp, x, 1.97, 0.48, 'z'));

  // Roof off: the windshield, a roll bar over the seats, the seats and the wheel.
  const open = new THREE.Group();
  const pane = box(HALF * 2 - 0.1, 0.04, 0.82, glass, 0, 1.4, 0.6);
  pane.rotation.x = 0.55;
  open.add(pane);
  for (const sx of [-1, 1]) {
    const post = box(0.07, 0.07, 0.9, trim, sx * (HALF - 0.04), 1.4, 0.6);
    post.rotation.x = 0.55;
    open.add(post);
  }
  open.add(mesh(new THREE.TorusGeometry(HALF - 0.02, 0.045, 6, 16, Math.PI), trim, 0, 1.0, -1.25));
  open.add(tube(0.04, 1.8, trim, 0, 1.8, -0.45, 'z'));
  for (const s of Object.values(SEATS)) {
    const back = box(0.5, 0.62, 0.1, trim, s.x, 0.95, s.z - 0.34);
    back.rotation.x = -0.12;
    open.add(back);
    open.add(box(0.5, 0.12, 0.5, trim, s.x, 0.56, s.z));
  }
  const hoop = mesh(new THREE.TorusGeometry(0.17, 0.03, 6, 18), trim, SEATS.driver.x, 1.02, SEATS.driver.z + 0.5);
  hoop.rotation.x = -0.5;
  open.add(hoop);

  const wheels: THREE.Object3D[] = [wheel(TRACK, AXLE), wheel(-TRACK, AXLE)];
  const rear: THREE.Object3D[] = [wheel(TRACK, -AXLE), wheel(-TRACK, -AXLE)];

  const root = new THREE.Group();
  const top = mergeByMaterial(closed);
  const inside = mergeByMaterial(open);
  inside.visible = false;
  const tilt = new THREE.Group();
  tilt.position.y = PIVOT;
  const inner = new THREE.Group();
  inner.position.y = -PIVOT;
  inner.add(mergeByMaterial(g), top, inside, ...wheels, ...rear);
  tilt.add(inner);
  root.add(tilt);
  return { root, tilt, top, open: inside, wheels, rear };
}
