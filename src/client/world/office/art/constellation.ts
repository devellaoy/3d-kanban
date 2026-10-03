import * as THREE from 'three';
import { CONSTELLATION } from '../../../../shared/art';
import { WALL_HEIGHT } from '../../../../shared/layout';
import { mulberry32 } from '../../../../shared/rng';
import { bulb } from '../../outside';
import { mesh, toon } from '../../toon';
import type { Fixture } from '../fixture';

// The light installation: nine glowing spheres on fine wires from the ceiling, hung at different heights
// over the plaza (none below CONSTELLATION.lowest, so you walk under them), drifting a little. Three
// colours, each its own bulb material, which come up with the lamps at night.

export const constellation: Fixture = (site) => {
  const { x, z, spread, spheres, lowest } = CONSTELLATION;
  const night = site.get('night');
  const mats = ['#ffd166', '#9ad7ff', '#ff9fb2'].map((c) => bulb(night, c, 0.3));
  const wire = toon('#8d99ae');
  const r = mulberry32(11);
  const group = new THREE.Group();
  const hung: { ball: THREE.Mesh; y: number; phase: number }[] = [];
  for (let i = 0; i < spheres; i++) {
    const a = (i / spheres) * Math.PI * 2 + r() * 0.5;
    const d = 0.5 + r() * spread;
    const px = x + Math.cos(a) * d;
    const pz = z + Math.sin(a) * d * 0.7;
    const y = lowest + r() * 1.5;
    const ball = mesh(new THREE.SphereGeometry(0.12 + r() * 0.08, 14, 10), mats[i % mats.length], px, y, pz, false);
    const line = mesh(new THREE.CylinderGeometry(0.006, 0.006, WALL_HEIGHT - y, 4), wire, px, y + (WALL_HEIGHT - y) / 2, pz, false);
    group.add(ball, line);
    hung.push({ ball, y, phase: r() * 6 });
  }
  site.group.add(group);
  return {
    update: (t) => {
      for (const h of hung) h.ball.position.y = h.y + Math.sin(t * 0.7 + h.phase) * 0.06;
    },
  };
};
