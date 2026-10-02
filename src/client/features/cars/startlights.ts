import * as THREE from 'three';
import { ROAD } from '../../../shared/layout';
import { LIGHTS } from './race';
import { mergeByMaterial, mesh, toon, toonUnique } from '../../world/toon';

// The start line across the street: a chequered strip on the asphalt and a gantry over it with five red
// lights (and a green bar for the go), the way a grand prix starts. Drawn in the cars' own group, down on
// the street, and it's only scenery: nothing in it is solid.

/** The lights over the line, as drawn. */
export interface StartLights {
  group: THREE.Group;
  /** The first `n` red lights lit (0 for none), and the green bar. */
  show(n: number, green?: boolean): void;
}

export function startLights(): StartLights {
  const group = new THREE.Group();
  const mid = (ROAD.minZ + ROAD.maxZ) / 2;
  const half = (ROAD.maxZ - ROAD.minZ) / 2;
  const fixed = new THREE.Group();

  // The chequered strip: two columns of squares across the road.
  const white = toon('#f4f4f4');
  const black = toon('#202026');
  const squares = Math.round(half * 2);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < squares; i++) {
      fixed.add(mesh(new THREE.BoxGeometry(0.6, 0.02, (half * 2) / squares), (i + c) % 2 ? white : black, (c - 0.5) * 0.6, 0.07, ROAD.minZ + ((i + 0.5) * half * 2) / squares, false));
    }
  }

  // The gantry: a post each side of the road and a beam across, with a lamp box for each light.
  const steel = toon('#3a3d52');
  const reach = half + 1.2;
  for (const s of [-1, 1]) fixed.add(mesh(new THREE.BoxGeometry(0.3, 6, 0.3), steel, 0, 3, mid + s * reach));
  fixed.add(mesh(new THREE.BoxGeometry(0.5, 0.5, reach * 2 + 0.3), steel, 0, 6.1, mid));
  const lamps: THREE.MeshToonMaterial[] = [];
  const pitch = (half * 2 - 1) / LIGHTS;
  for (let i = 0; i < LIGHTS; i++) {
    const z = mid + (i - (LIGHTS - 1) / 2) * pitch;
    fixed.add(mesh(new THREE.BoxGeometry(0.34, 0.9, pitch - 0.1), toon('#15161f'), 0.28, 5.55, z));
    const m = toonUnique('#3b0b10');
    lamps.push(m);
    const lamp = mesh(new THREE.SphereGeometry(Math.min(0.5, pitch / 2 - 0.15), 14, 10), m, 0.5, 5.55, z, false);
    lamp.scale.x = 0.35;
    group.add(lamp);
  }
  const green = toonUnique('#0b3b17');
  group.add(mesh(new THREE.BoxGeometry(0.12, 0.2, half * 2 - 0.6), green, 0.5, 6.1, mid, false));
  group.add(mergeByMaterial(fixed));

  return {
    group,
    show(n, on = false) {
      lamps.forEach((m, i) => {
        const lit = i < n;
        m.color.set(lit ? '#ff2a2a' : '#3b0b10');
        m.emissive.set(lit ? '#ff1a1a' : '#000000');
      });
      green.color.set(on ? '#3dff6b' : '#0b3b17');
      green.emissive.set(on ? '#22dd44' : '#000000');
    },
  };
}
