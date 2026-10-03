import * as THREE from 'three';
import { BOARDS, FLOOR, LOFT, TV, WALL_HEIGHT, WING } from '../../../shared/layout';
import { bulb } from '../outside';
import { mergeByMaterial, mesh } from '../toon';
import type { Fixture } from './fixture';

// The office's LED lighting: only glowing things, no light of their own, so none of it counts against the
// room shader's lamps (see MAX_ROOM_LAMPS). Strips along the top of the north, east and south walls (cove
// lighting), under the boss office's front, behind each board and the TV, and along the foot of the north
// wall; and a pair of bars hung over each pod. Each colour is a bulb of its own (see bulb), so they glow
// a little by day and come up with the lamps at night.

const WARM = '#fff1d6';
const COOL = '#e8f4ff';

export const ledLights: Fixture = (site) => {
  const night = site.get('night');
  const group = new THREE.Group();
  /** A glowing box, `w` along x, `h` up, `d` along z, its middle at (x, y, z). */
  const strip = (color: string, day: number, w: number, h: number, d: number, x: number, y: number, z: number) => group.add(mesh(new THREE.BoxGeometry(w, h, d), bulb(night, color, day), x, y, z, false));
  const top = WALL_HEIGHT - 0.14;
  const inset = 0.06;

  // Cove lighting round the top of the walls: the north wall as far as the back office, the east and the south.
  const northLen = WING.minX - 0.2 - (FLOOR.minX + 0.1);
  strip(WARM, 0.25, northLen, 0.07, 0.1, (WING.minX - 0.2 + FLOOR.minX + 0.1) / 2, top, FLOOR.minZ + inset);
  strip(WARM, 0.25, 0.1, 0.07, FLOOR.maxZ - FLOOR.minZ - 0.2, FLOOR.maxX - inset, top, (FLOOR.minZ + FLOOR.maxZ) / 2);
  strip(WARM, 0.25, FLOOR.maxX - FLOOR.minX - 0.2, 0.07, 0.1, 0, top, FLOOR.maxZ - inset);
  // The foot of the north wall under the boards, in two runs either side of the elevator.
  strip('#2ec4b6', 0.3, 7.1 - (FLOOR.minX + 0.2), 0.035, 0.05, (7.1 + FLOOR.minX + 0.2) / 2, 0.3, FLOOR.minZ + 0.04);
  strip('#2ec4b6', 0.3, WING.minX - 0.15 - 9.9, 0.035, 0.05, (WING.minX - 0.15 + 9.9) / 2, 0.3, FLOOR.minZ + 0.04);
  // Under the boss office's front edge, where its floor slab is.
  strip('#4cc9f0', 0.4, LOFT.maxX - LOFT.minX - 0.4, 0.05, 0.06, (LOFT.minX + LOFT.maxX) / 2, LOFT.y - 0.12, LOFT.minZ - 0.04);

  // A frame of colour behind each board and the TV, on the wall: a halo round it.
  const halos: [string, number][] = [['#ef476f', 0], ['#ffd166', 1], ['#118ab2', 2], ['#06d6a0', 3]];
  const keys = Object.keys(BOARDS) as (keyof typeof BOARDS)[];
  keys.forEach((key, i) => {
    const b = BOARDS[key];
    const nx = Math.sin(b.rotY);
    const nz = Math.cos(b.rotY);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(b.width + 0.6, b.height + 0.6), bulb(night, halos[i % halos.length][0], 0.35));
    plate.position.set(b.x - nx * 0.06, b.y, b.z - nz * 0.06);
    plate.rotation.y = b.rotY;
    group.add(plate);
  });
  const tvPlate = new THREE.Mesh(new THREE.PlaneGeometry(TV.width + 0.8, TV.height + 0.8), bulb(night, '#9b5de5', 0.35));
  tvPlate.position.set(FLOOR.maxX - 0.02, TV.y, TV.z);
  tvPlate.rotation.y = -Math.PI / 2;
  group.add(tvPlate);

  // Two bars over each pod, hung from the ceiling on fine wires either side of the round pendant's cord, up above its shade.
  const barMat = bulb(night, COOL, 0.4);
  const wire = new THREE.MeshBasicMaterial({ color: '#8d99ae' });
  for (const [px, pz] of [[-10.5, -4], [-1.5, -4], [-10.5, 4], [-1.5, 4]]) {
    for (const dz of [-1.2, 1.2]) {
      group.add(mesh(new THREE.BoxGeometry(4.2, 0.06, 0.08), barMat, px, 4.75, pz + dz, false));
      for (const dx of [-1.9, 1.9]) group.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, WALL_HEIGHT - 4.75, 4), wire, px + dx, 4.75 + (WALL_HEIGHT - 4.75) / 2, pz + dz, false));
    }
  }
  return { group: mergeByMaterial(group) };
};
