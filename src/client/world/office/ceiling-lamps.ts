// Where the room's ceiling lamps hang (room.ts hangs them) and the light a pendant throws: no meshes, so
// the tests can light the floor with them without building the room.
import * as THREE from 'three';
import { WALL_HEIGHT } from '../../../shared/layout';
import type { RoomLamp } from '../roomlight';

/** The warm white of the office's lamps. */
export const LAMP_COLOR = new THREE.Color('#ffe2b8');

/**
 * The light from a pendant hung at (x, y, z), over the room round it, on the storey from `floor` up
 * to `top`, as bright as `power` (see world/roomlight.ts).
 */
export function pendantLight(x: number, y: number, z: number, reach = 11, floor = 0, top = WALL_HEIGHT, power = 3.2): RoomLamp {
  return { x, y: y - 0.15, z, reach, color: LAMP_COLOR, power, level: 1, floor, top };
}

/** How high the room's pendants hang. */
export const LAMP_Y = 4.05;

/** A room's ceiling lamp: where it hangs, its wall switch's area, and its reach and strength if they aren't the usual. */
export interface CeilingLamp {
  x: number;
  z: number;
  area: 'lounge' | 'desks';
  reach?: number;
  power?: number;
}

/** How far a room's ceiling lamp reaches, unless it says otherwise: a little further than a lone pendant, so their pools meet. */
const ROOM_REACH = 12;
/** How bright the lamps hung to fill the room between the pods and the lounge are (#118): softer than those, which stay as bright as ever. */
const FILL_POWER = 2.2;

/**
 * The room's ceiling lamps: where each hangs and which wall switch has it (features/lights: the
 * lounge's over the lounge, the corner by the elevator and the gong and the walkway in front of the
 * stairs, the desks' everywhere else). One over each desk pod and the lounge, as bright as ever, and
 * softer ones (#118) over the walkways, the corners and the kitchen, so no part of the floor is left in
 * the dark and nowhere is darker than it was. The ones by the loft reach less, so they light the
 * meeting room and the boss office through their walls and floor as little as they can.
 */
export const CEILING_LAMPS: readonly CeilingLamp[] = [
  { x: -10.5, z: -4, area: 'desks' },
  { x: -1.5, z: -4, area: 'desks' },
  { x: -10.5, z: 4, area: 'desks' },
  { x: -1.5, z: 4, area: 'desks' },
  { x: 13, z: 0, area: 'lounge' },
  // Along the north wall, and in the corner past the elevator and the gong.
  { x: -14, z: -9.5, area: 'desks', power: FILL_POWER },
  { x: -5, z: -9.5, area: 'desks', power: FILL_POWER },
  { x: 3.5, z: -9.5, area: 'desks', power: FILL_POWER },
  { x: 12.5, z: -9.5, area: 'lounge', power: FILL_POWER },
  // In front of the stairs, and the lounge's corner by the jukebox and the meeting room.
  { x: 6, z: 6, area: 'lounge', reach: 9, power: FILL_POWER },
  { x: 15, z: 5, area: 'lounge', reach: 8, power: FILL_POWER },
  // Along the south wall, by the kitchen and the bookshelf.
  { x: -14, z: 9.5, area: 'desks', power: FILL_POWER },
  { x: -5, z: 9.5, area: 'desks', power: FILL_POWER },
];

/** The light a room's ceiling lamp throws, tagged with its switch's area. */
export const ceilingLight = ({ x, z, area, reach = ROOM_REACH, power }: CeilingLamp): RoomLamp => ({ ...pendantLight(x, LAMP_Y, z, reach, 0, WALL_HEIGHT, power), area });
