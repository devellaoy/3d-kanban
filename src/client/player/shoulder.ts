import * as THREE from 'three';

// Third person looks around like first person (see docs/controls.md): the mouse turns
// the camera, which sits behind you and over your right shoulder, so the crosshair isn't on you.
/** How far right of your head the third-person camera looks past, in meters. */
export const SHOULDER = 0.75;
/** How far the third-person camera tips: a little from below you, up to looking well down on you. */
export const THIRD_PITCH_MIN = -0.3;
export const THIRD_PITCH_MAX = 1.3;
/** Where the third-person camera's tip rests, looking a little down onto you. */
export const THIRD_PITCH_REST = 0.42;
/** Height of the point the third-person camera looks at, above your feet. */
export const THIRD_TARGET = 1.3;

/** Where the third-person camera sits from the point it looks at, for its heading, tilt and distance. */
export function orbitOffset(yaw: number, pitch: number, dist: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
}

/** `side` meters to the right of a camera with heading `yaw` (it looks along -sin, -cos). */
export function shoulderOffset(yaw: number, side = SHOULDER, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.cos(yaw) * side, 0, -Math.sin(yaw) * side);
}

/**
 * How far along a ray (unit `dir` from `origin`) `at` is: from the third-person camera,
 * what the crosshair's ray meets before it gets to you is behind you (or you), and doesn't count.
 */
export function alongRay(origin: THREE.Vector3, dir: THREE.Vector3, at: THREE.Vector3): number {
  return Math.max(0, (at.x - origin.x) * dir.x + (at.y - origin.y) * dir.y + (at.z - origin.z) * dir.z);
}

/** Whether something the crosshair's ray hit at `point` is within `reach` of your eyes (not the camera). */
export function withinReach(point: THREE.Vector3, eye: THREE.Vector3, reach: number): boolean {
  return point.distanceTo(eye) <= reach;
}

/**
 * Whether your eyes see `point`, not just the camera over your shoulder: nothing among
 * `objects` that `blocks` (a wall, say, not the thing itself) is on the way to it from `eye`.
 * `camera` is the one the scene is drawn with: a sprite (a name tag, a sign) faces it, and
 * three.js throws on a ray without one that meets a sprite, which stopped every frame after it.
 */
export function eyeSees(eye: THREE.Vector3, point: THREE.Vector3, objects: THREE.Object3D[], blocks: (hit: THREE.Intersection) => boolean, camera: THREE.Camera, rc = new THREE.Raycaster()): boolean {
  const dist = eye.distanceTo(point);
  // Short of the point itself, so the surface that was hit doesn't count as in the way of itself.
  if (dist < 0.03) return true;
  rc.set(eye, point.clone().sub(eye).divideScalar(dist));
  rc.camera = camera;
  rc.near = 0;
  rc.far = dist - 0.02;
  return !rc.intersectObjects(objects, true).some(blocks);
}

/** A tap or click at (clientX, clientY) on `rect`, in normalized device coordinates. */
export function tapNdc(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, out = new THREE.Vector2()): THREE.Vector2 {
  return out.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
}
