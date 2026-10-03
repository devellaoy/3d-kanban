import * as THREE from 'three';
import { bumpHeight } from '../../shared/bumps';
import { FLOOR, ROOMS_WING, SLAB, STREET_Y, WING, WING_ROOMS, inRooms, inWing, wingMinZ } from '../../shared/layout';
import type { ViewMode } from '../state';
import type { Collider } from '../world/types';
import { armFraction, easeArm } from './arm';
import { ceilingAt, groundAt } from './collide';
import { THIRD_TARGET, orbitOffset, shoulderOffset } from './shoulder';
import type { OrbitEase } from './camera3d';

// The camera: your eyes in first person, or following you round in third without going through the
// walls, and the view trembling after too much coffee or rolling after too much to drink.

/** Camera height above your feet in first person (the Person's eyes). */
export const EYE_HEIGHT = 1.4;

/** The room the camera keeps to (see PlayerController.room). */
export interface Room {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  wall: number;
  enclosed: boolean;
  vault?: { minX: number; maxX: number; minZ: number; maxZ: number; top: number };
}

/** What the camera follows you by: where you are and look, and the room you're in (see PlayerController). */
export interface Followed {
  view: ViewMode;
  pos: THREE.Vector3;
  lookPitch: number;
  camYaw: number;
  camPitch: number;
  camDist: number;
  stepOffset: number;
  room: Room;
  wing: number;
  rooms: number;
  rig: ((dt: number) => void) | null;
  riding: boolean;
  colliders: Collider[];
  /** Colliders the camera's arm passes through: the car you're in (taller than the supercars, the 4x4's body would block it). */
  armSkip: readonly Collider[];
  street: number;
  /** The third-person camera's easing state. */
  ease: OrbitEase;
}

/**
 * Puts the camera where you see from: at your eyes in first person (bobbing `bob` as you walk, and
 * `lift` up or down while you sit), or round behind you in third, where it eases over unless `snap`.
 */
export function aimCamera(camera: THREE.PerspectiveCamera, p: Followed, bob: number, lift: number, snap: boolean, dt = 0) {
  if (p.view === 'first') {
    p.ease.sync(p.camYaw, p.camPitch, p.camDist);
    camera.position.set(p.pos.x, p.pos.y + EYE_HEIGHT + bob + p.stepOffset + lift, p.pos.z);
    camera.rotation.set(p.lookPitch, p.camYaw, 0);
    return;
  }
  const shown = p.ease.orbit(p.camYaw, p.camPitch, p.camDist, snap, dt); // gaps ease out, the mouse doesn't lag
  const moved = p.ease.movedBy(camera, snap);
  const target = new THREE.Vector3(p.pos.x, p.pos.y + p.stepOffset + lift + THIRD_TARGET, p.pos.z);
  target.add(shoulderOffset(shown.yaw)); // over your shoulder
  const off = orbitOffset(shown.yaw, shown.pitch, shown.dist);
  const ideal = target.clone().add(off);
  const cam = ideal.clone();
  // Keep the camera on your side of the outside walls, so they never block the view: inside the
  // room while you're in the office, out of the building while you're outside or on the balcony.
  // And under the loft, its roof or the garage ceiling.
  const m = 0.4;
  const R = p.room;
  // Held by a rig (at the tee or a table, not in a car), you're indoors anywhere over the room.
  const rigged = !!p.rig && !p.riding;
  const under = p.pos.x > R.minX && p.pos.x < R.maxX && p.pos.z > R.minZ && p.pos.z < R.maxZ;
  // In the office's back office, between its walls, and out through where the north wall was into the room.
  const back = !R.enclosed && p.pos.y > -SLAB - 0.5 && inWing(p.pos.x, p.pos.z, p.wing);
  // In one of the meeting wing's rooms, out through the west wall: the camera keeps in that room (and the office beside it).
  const annex = !R.enclosed && p.pos.y > -SLAB - 0.5 && inRooms(p.pos.x, p.pos.z, p.rooms) ? WING_ROOMS.find((s) => p.pos.z > s.z0 && p.pos.z < s.z1) : undefined;
  const indoors = ((rigged || p.pos.y > -SLAB - 0.5) && under) || back || !!annex;
  // Down in a room under the floor (the castle's dungeon): the camera keeps inside that.
  const V = R.vault;
  if (V && p.pos.y < V.top - 0.5 && p.pos.x > V.minX && p.pos.x < V.maxX && p.pos.z > V.minZ && p.pos.z < V.maxZ) {
    cam.x = THREE.MathUtils.clamp(cam.x, V.minX + m, V.maxX - m);
    cam.z = THREE.MathUtils.clamp(cam.z, V.minZ + m, V.maxZ - m);
  } else if (back) {
    cam.x = THREE.MathUtils.clamp(cam.x, WING.minX + m, WING.maxX - m);
    cam.z = THREE.MathUtils.clamp(cam.z, wingMinZ(p.wing) + m, FLOOR.maxZ - m);
  } else if (annex) {
    cam.x = THREE.MathUtils.clamp(cam.x, FLOOR.minX - ROOMS_WING.depth + m, R.maxX - m);
    cam.z = THREE.MathUtils.clamp(cam.z, cam.x < FLOOR.minX ? annex.z0 + m : R.minZ + m, cam.x < FLOOR.minX ? annex.z1 - m : R.maxZ - m);
  } else if (indoors) {
    cam.x = THREE.MathUtils.clamp(cam.x, R.minX + m, R.maxX - m);
    cam.z = THREE.MathUtils.clamp(cam.z, R.minZ + m, R.maxZ - m);
  }
  // (The meadow's moguls and the speed humps lift the ground under you, and under the camera: see shared/bumps.ts.)
  const bump = Math.max(bumpHeight(p.pos.x, p.pos.z), bumpHeight(cam.x, cam.z));
  const floorY = rigged ? 0 : Math.max(groundAt(p.colliders, p.pos.x, p.pos.z, p.pos.y), p.street + bump);
  const roof = ceilingAt(p.colliders, cam.x, cam.z, floorY) - 0.3;
  cam.y = THREE.MathUtils.clamp(cam.y, floorY + 0.6, Math.max(floorY + 0.6, Math.min(floorY + 3.5, roof)));
  // Down on the street, stay under the garage ceiling so its edge never cuts across the view; in the
  // garage, on this side of its back and west walls too (the elevator comes down in the back one).
  const garage = p.street - STREET_Y - SLAB;
  if (!R.enclosed && p.pos.y < garage - 1 && !rigged) {
    cam.y = Math.min(cam.y, Math.max(floorY + 0.6, garage - 0.3));
    if (under) {
      cam.x = Math.max(cam.x, R.minX + m);
      cam.z = Math.max(cam.z, R.minZ + m);
    }
  }
  // How far you are out past each outside wall (west, east, north, south), and how far inside them the camera is.
  const e = R.wall + m;
  const out = [R.minX - R.wall - p.pos.x, p.pos.x - R.maxX - R.wall, R.minZ - R.wall - p.pos.z, p.pos.z - R.maxZ - R.wall];
  const side = out.indexOf(Math.max(...out));
  const camIn = Math.min(cam.x - (R.minX - e), R.maxX + e - cam.x, cam.z - (R.minZ - e), R.maxZ + e - cam.z) > 0;
  // Outside, back the camera out through the wall you're standing beyond: above the garage always,
  // and down in it where it's walled in (the west and north sides).
  if (!indoors && out[side] > 0 && camIn && (R.enclosed || cam.y > garage || side === 0 || side === 2)) {
    if (side === 0) cam.x = R.minX - e;
    else if (side === 1) cam.x = R.maxX + e;
    else if (side === 2) cam.z = R.minZ - e;
    else cam.z = R.maxZ + e;
  }
  p.ease.place(camera, ideal, cam, snap, moved, dt); // on the orbit, moved by the walls (was: lerp 0.25)
  // The camera is part of your body: the arm from your head to it stops short of anything solid in between.
  const head = armHead.set(p.pos.x, p.pos.y + p.stepOffset + lift + THIRD_TARGET, p.pos.z);
  const arm = (p.ease.arm = easeArm(p.ease.arm, armFraction(head, camera.position, p.colliders, p.pos.y, undefined, undefined, p.armSkip), dt, snap));
  if (arm < 1) {
    camera.position.sub(head).multiplyScalar(arm).add(head);
    p.ease.lastShown.copy(camera.position);
  }
  camera.lookAt(target);
}

const armHead = new THREE.Vector3();

/** The jitters: the view trembles a little, on top of wherever you're looking. Drunk, it rolls and sways. `t` is the jitters' clock. */
export function shakeCamera(camera: THREE.PerspectiveCamera, t: number, drunk: number, jitter: number) {
  if (drunk > 0) {
    const d = drunk;
    camera.rotation.z += d * (0.07 * Math.sin(t * 0.9) + 0.025 * Math.sin(t * 2.3 + 1));
    camera.rotation.x += d * 0.03 * Math.sin(t * 0.7 + 2);
    camera.rotation.y += d * 0.04 * Math.sin(t * 0.55 + 4);
  }
  if (jitter <= 0) return;
  const a = jitter * 0.01;
  camera.rotation.x += a * (Math.sin(t * 71) + 0.6 * Math.sin(t * 131 + 1));
  camera.rotation.y += a * (Math.sin(t * 89 + 2) + 0.6 * Math.sin(t * 157));
  camera.rotation.z += a * Math.sin(t * 113 + 3);
}
