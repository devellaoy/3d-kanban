import * as THREE from 'three';
import { FLOOR, ROOMS_WING, WALL_T, WING_ROOMS } from '../../shared/layout';

// The meeting wing's built rooms, for the sky: the office's room goes on out through the west wall over
// just their stretch of it (not the exit landing south of them, nor the lawn), lit as the office and out of the rain.

/** The built rooms as the shader holds them: minX, minZ, maxZ. Empty (minZ past maxZ) without. */
export const skyWest = new THREE.Vector3(1, 1, 0);

/** Sets how many rooms of the wing are built. */
export function setSkyRooms(rooms: number, give: number) {
  const built = WING_ROOMS.slice(0, rooms);
  skyWest.set(FLOOR.minX - ROOMS_WING.depth - give, built.length ? built[0].z0 : 1, built.length ? built[built.length - 1].z1 : 0);
}

/** How far `p` is outside the built rooms, up to `top` (GLSL's length( max( a, 0.0 ) )): 0 inside them, Infinity without any. */
export function annexOutside(p: { x: number; y: number; z: number }, top: number, floor: number): number {
  if (skyWest.y >= skyWest.z) return Infinity;
  return Math.hypot(Math.max(0, skyWest.x - p.x, p.x - FLOOR.minX), Math.max(0, floor - p.y, p.y - top), Math.max(0, skyWest.y - p.z, p.z - skyWest.z));
}

/** Whether (x, z) is under the built rooms' roof, walls included. */
export const annexSheltered = (x: number, z: number) => skyWest.y < skyWest.z && x > skyWest.x - WALL_T && x < FLOOR.minX && z > skyWest.y - WALL_T && z < skyWest.z + WALL_T;
