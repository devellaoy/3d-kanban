// Where the room's ceiling lamps hang (room.ts hangs them) and the light a pendant throws: no meshes, so
// the tests can light the floor with them without building the room.
import * as THREE from 'three';
import { WALL_HEIGHT } from '../../../shared/layout';
import type { RoomLamp } from '../roomlight';

/** The warm white of the office's lamps. */
export const LAMP_COLOR = new THREE.Color('#ffe2b8');

/**
 * The light from a pendant hung at (x, y, z), over the room round it, on the storey from `floor` up
 * to `top`, as bright as `power` (see world/roomlight.ts). The room's pendants hang close enough
 * together (room.ts) for their pools to meet, so each is a little softer than a lone one.
 */
export function pendantLight(x: number, y: number, z: number, reach = 12, floor = 0, top = WALL_HEIGHT, power = 2.2): RoomLamp {
  return { x, y: y - 0.15, z, reach, color: LAMP_COLOR, power, level: 1, floor, top };
}

/** How high the room's pendants hang. */
export const LAMP_Y = 4.05;

/**
 * The room's ceiling lamps: where each hangs, which wall switch has it (features/lights: the lounge's
 * on the east side, the desks' everywhere else) and, if it's shorter, how far its light reaches. One
 * over each desk pod and the lounge, and the rest (#118) over the walkways, the corners and the
 * kitchen, so no part of the floor is left in the dark. The ones by the loft reach less, so they light
 * the meeting room and the boss office through their walls and floor as little as they can.
 */
export const CEILING_LAMPS: readonly { x: number; z: number; area: 'lounge' | 'desks'; reach?: number }[] = [
  { x: -10.5, z: -4, area: 'desks' },
  { x: -1.5, z: -4, area: 'desks' },
  { x: -10.5, z: 4, area: 'desks' },
  { x: -1.5, z: 4, area: 'desks' },
  { x: 13, z: 0, area: 'lounge' },
  // Along the north wall, and in the corner past the elevator and the gong.
  { x: -14, z: -9.5, area: 'desks' },
  { x: -5, z: -9.5, area: 'desks' },
  { x: 3.5, z: -9.5, area: 'desks' },
  { x: 12.5, z: -9.5, area: 'lounge' },
  // In front of the stairs, and the lounge's corner by the jukebox and the meeting room.
  { x: 6, z: 6, area: 'lounge', reach: 9 },
  { x: 15, z: 5, area: 'lounge', reach: 8 },
  // Along the south wall, by the kitchen and the bookshelf.
  { x: -14, z: 9.5, area: 'desks' },
  { x: -5, z: 9.5, area: 'desks' },
];
