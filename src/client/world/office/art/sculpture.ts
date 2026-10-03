import * as THREE from 'three';
import { SCULPTURE } from '../../../../shared/art';
import { bulb } from '../../outside';
import { mesh, toon } from '../../toon';
import type { Collider } from '../../types';
import type { Fixture } from '../fixture';

// The sculpture: three twisting slabs stacked on a white plinth, a ring turning round them, and a glowing
// core that comes up with the lamps at night. Everyone walks round it (shared/art.ts has its footprint).

export const sculpture: Fixture = (site) => {
  const { x, z, plinth, height } = SCULPTURE;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const base = 0.9;
  group.add(mesh(new THREE.BoxGeometry(plinth, base, plinth), toon('#f4f1ea'), 0, base / 2, 0));
  group.add(mesh(new THREE.BoxGeometry(plinth + 0.08, 0.05, plinth + 0.08), toon('#2b2d42'), 0, base + 0.025, 0, false));
  const piece = new THREE.Group();
  piece.position.y = base + 0.05;
  group.add(piece);
  const colors = ['#ef476f', '#ffd166', '#06d6a0'];
  const slabs = colors.map((c, i) => {
    const slab = mesh(new THREE.BoxGeometry(0.5 - i * 0.07, 0.3, 0.5 - i * 0.07), toon(c), 0, 0.2 + i * 0.34, 0);
    slab.rotation.y = i * 0.6;
    piece.add(slab);
    return slab;
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), bulb(site.get('night'), '#9ad7ff', 0.35));
  core.position.y = 1.35;
  piece.add(core);
  const ring = mesh(new THREE.TorusGeometry(0.42, 0.03, 8, 40), toon('#aab4be'), 0, 1.35, 0, false);
  ring.rotation.x = Math.PI / 2.6;
  piece.add(ring);
  site.group.add(group);
  const half = plinth / 2;
  const collider: Collider = { minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half, top: height };
  return {
    colliders: [collider],
    update: (t) => {
      slabs.forEach((s, i) => (s.rotation.y = i * 0.6 + Math.sin(t * 0.4 + i) * 0.5 + t * 0.15));
      ring.rotation.z = t * 0.5;
      core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.06);
    },
  };
};
