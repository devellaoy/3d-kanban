import * as THREE from 'three';
import { FLOOR, LOFT, WALL_HEIGHT, WING } from '../../../shared/layout';
import { bulb } from '../outside';
import { mergeByMaterial, mesh } from '../toon';
import type { Fixture } from './fixture';

// The office's LED lighting: only glowing things, no light of their own, so none of it counts against the
// room shader's lamps (see MAX_ROOM_LAMPS). Strips along the top of the north, east and south walls (cove
// lighting), under the boss office's front, and along the foot of the north wall; the ceiling lamps are
// linear LED fixtures themselves (pendant in props.ts). Each colour is a bulb of its own
// (see bulb), so they glow a little by day and come up with the lamps at night.

const WARM = '#fff1d6';

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

  return { group: mergeByMaterial(group) };
};
