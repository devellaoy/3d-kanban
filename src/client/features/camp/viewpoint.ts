import * as THREE from 'three';
import { STREET_Y } from '../../../shared/layout';
import { VIEWPOINT } from '../../../shared/scenic';
import { mesh, textPlane, toon } from '../../world/toon';
import type { Collider } from '../../world/types';

const G = STREET_Y;
const DECK = 0.25;
const RAIL = 1.1;

/**
 * The hill lookout: a plank deck at the foot of the hill with a rail along the lake side (north), a
 * bench behind and a pair of binoculars on a post at the rail. Returns the binoculars' group and spot.
 */
export function buildViewpoint(colliders: Collider[]): { group: THREE.Group; standGroup: THREE.Group; stand: { x: number; z: number } } {
  const { x, z, width: w, depth: d } = VIEWPOINT;
  const group = new THREE.Group();
  const wood = toon('#8a5a3b');

  // The deck, laid in planks of two tones.
  const planks = 14;
  for (let i = 0; i < planks; i++) {
    const pw = w / planks;
    group.add(mesh(new THREE.BoxGeometry(pw - 0.02, DECK, d), toon(i % 2 ? '#b08968' : '#c19a6b'), x - w / 2 + pw * (i + 0.5), G + DECK / 2, z, false));
  }
  colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, bottom: G - 1, top: G + DECK });

  // The rail: along the north edge, and a short way back down each side, so you come up onto it from the south.
  const north = z - d / 2 + 0.12;
  const rail = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const bar = mesh(new THREE.BoxGeometry(len, 0.09, 0.09), wood, (x0 + x1) / 2, G + DECK + RAIL, (z0 + z1) / 2, false);
    bar.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    group.add(bar);
    const mid = mesh(new THREE.BoxGeometry(len, 0.06, 0.06), wood, (x0 + x1) / 2, G + DECK + RAIL * 0.55, (z0 + z1) / 2, false);
    mid.rotation.y = bar.rotation.y;
    group.add(mid);
    const posts = Math.max(2, Math.round(len / 1.4) + 1);
    for (let i = 0; i < posts; i++) {
      const k = i / (posts - 1);
      group.add(mesh(new THREE.BoxGeometry(0.12, RAIL, 0.12), wood, x0 + (x1 - x0) * k, G + DECK + RAIL / 2, z0 + (z1 - z0) * k, false));
    }
    colliders.push({ minX: Math.min(x0, x1) - 0.08, maxX: Math.max(x0, x1) + 0.08, minZ: Math.min(z0, z1) - 0.08, maxZ: Math.max(z0, z1) + 0.08, bottom: G, top: G + DECK + RAIL });
  };
  const sideEnd = z + 0.1;
  rail(x - w / 2 + 0.1, north, x + w / 2 - 0.1, north);
  rail(x - w / 2 + 0.1, north, x - w / 2 + 0.1, sideEnd);
  rail(x + w / 2 - 0.1, north, x + w / 2 - 0.1, sideEnd);

  // A bench along the south edge, looking north.
  const bench = new THREE.Group();
  bench.position.set(x, G + DECK, z + d / 2 - 0.55);
  bench.add(mesh(new THREE.BoxGeometry(2.4, 0.07, 0.5), wood, 0, 0.46, 0));
  bench.add(mesh(new THREE.BoxGeometry(2.4, 0.4, 0.06), wood, 0, 0.78, 0.24));
  for (const sx of [-1, 1]) bench.add(mesh(new THREE.BoxGeometry(0.08, 0.46, 0.4), wood, sx * 1.05, 0.23, 0, false));
  group.add(bench);
  colliders.push({ minX: x - 1.2, maxX: x + 1.2, minZ: z + d / 2 - 0.85, maxZ: z + d / 2 - 0.25, bottom: G, top: G + DECK + 0.5 });

  // The binoculars on a post at the middle of the rail.
  const stand = { x, z: north + 0.8 };
  const standGroup = new THREE.Group();
  standGroup.position.set(stand.x, G + DECK, stand.z);
  const steel = toon('#4a4e69');
  standGroup.add(mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.25, 8), steel, 0, 0.62, 0));
  for (const sx of [-0.09, 0.09]) {
    const tube = mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.42, 10), toon('#22223b'), sx, 1.32, -0.12);
    tube.rotation.x = Math.PI / 2 - 0.12;
    standGroup.add(tube);
    const lens = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10), toon('#8ecae6'), sx, 1.31, -0.34, false);
    lens.rotation.x = Math.PI / 2 - 0.12;
    standGroup.add(lens);
  }
  standGroup.add(mesh(new THREE.BoxGeometry(0.3, 0.06, 0.1), steel, 0, 1.26, 0.05, false));
  group.add(standGroup);
  colliders.push({ minX: stand.x - 0.12, maxX: stand.x + 0.12, minZ: stand.z - 0.12, maxZ: stand.z + 0.12, bottom: G, top: G + DECK + 1.3 });

  // A sign at the corner you come up to, seen from the road.
  const sign = new THREE.Group();
  sign.position.set(x + w / 2 + 1.2, G, z - d / 2 - 0.5);
  sign.rotation.y = Math.PI + 0.5;
  sign.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.5, 6), wood, 0, 0.75, 0, false));
  sign.add(mesh(new THREE.BoxGeometry(1.5, 0.5, 0.06), toon('#fffaf3'), 0, 1.5, 0));
  const text = textPlane('⛰️ Hill lookout', { bg: '#fffaf3', size: 44 });
  text.scale.multiplyScalar(0.42);
  text.position.set(0, 1.5, 0.04);
  sign.add(text);
  group.add(sign);

  return { group, standGroup, stand };
}
