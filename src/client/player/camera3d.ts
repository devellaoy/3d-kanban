import * as THREE from 'three';
import { THIRD_PITCH_MAX, THIRD_PITCH_MIN } from './shoulder';

/**
 * The third-person camera follows camYaw/camPitch/camDist rigidly (the mouse, a turning car), except that a
 * jump in one (a seat, golf) or any zoom is left as a gap that eases out. last* are the values at the previous frame.
 * The walls' move of the camera off its orbit is eased the same way when it jumps. State and easing of player/camera.ts.
 */
export class OrbitEase {
  yawGap = 0;
  pitchGap = 0;
  distGap = 0;
  lastYaw = Math.PI * 0.15;
  lastPitch = 0.42;
  lastDist = 7.5;
  /** Where aimCamera last put the camera: if it's elsewhere, golf or throwing moved it and it eases back. */
  lastShown = new THREE.Vector3();
  /** How far the walls moved the camera off its ideal spot, as last shown and as last measured. */
  shownCorr = new THREE.Vector3();
  rawCorr = new THREE.Vector3();
  lastIdeal = new THREE.Vector3();
  corrEasing = false;
  corrKnown = false;

  /** First person: keep the third-person values in step, so switching views starts from where you look. */
  sync(yaw: number, pitch: number, dist: number) {
    this.yawGap = this.pitchGap = this.distGap = 0;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.lastDist = dist;
    this.corrKnown = false;
  }

  /** The mouse is never a jump, so it shows at once. */
  lookYaw(dx: number) {
    this.lastYaw -= dx;
  }

  lookPitch(change: number) {
    this.lastPitch += change;
  }

  /**
   * A jump in yaw, pitch or distance becomes a gap that eases out (same at any frame rate); smaller,
   * continuous changes (the mouse, a car turning, a rig) are followed as they are. Returns the heading, tilt and distance to show.
   */
  orbit(yaw: number, pitch: number, dist: number, snap: boolean, dt: number) {
    const dYaw = Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw));
    if (snap) this.yawGap = this.pitchGap = this.distGap = 0;
    else {
      if (Math.abs(dYaw) > 0.15) this.yawGap += dYaw;
      if (Math.abs(pitch - this.lastPitch) > 0.15) this.pitchGap += pitch - this.lastPitch;
      this.distGap += dist - this.lastDist; // zoom always glides, however small the step
      const k = Math.exp(-dt * 12);
      this.yawGap *= k;
      this.pitchGap *= k;
      this.distGap *= k;
      // What's shown stays within the tilt limits (or wherever camPitch itself is), however the mouse and an
      // outside change landed this frame: past them the camera would tip over you to your front.
      this.pitchGap = pitch - THREE.MathUtils.clamp(pitch - this.pitchGap, Math.min(THIRD_PITCH_MIN, pitch), Math.max(THIRD_PITCH_MAX, pitch));
    }
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.lastDist = dist;
    return { yaw: yaw - this.yawGap, pitch: pitch - this.pitchGap, dist: dist - this.distGap };
  }

  /** Whether someone else (golf, throwing) has moved the camera since aimCamera last put it somewhere. */
  movedBy(camera: THREE.PerspectiveCamera, snap: boolean) {
    return !snap && this.corrKnown && camera.position.distanceTo(this.lastShown) > 0.01;
  }

  /**
   * The camera sits exactly on the orbit (`ideal`), moved by the walls to `cam`. Sliding along a wall follows it rigidly; a jump
   * in the move (inside to outside, the vault, the garage, the roof) is eased in instead of cutting.
   */
  place(camera: THREE.PerspectiveCamera, ideal: THREE.Vector3, cam: THREE.Vector3, snap: boolean, moved: boolean, dt: number) {
    const corr = cam.sub(ideal);
    if (snap || !this.corrKnown) {
      this.shownCorr.copy(corr);
      this.corrEasing = false;
    } else if (moved) {
      // Someone else (golf, throwing) put the camera there: ease from it back to the orbit.
      this.shownCorr.copy(camera.position).sub(ideal);
      this.corrEasing = true;
    }
    if (!snap && this.corrKnown) {
      // The walls' move changes at most twice as much as the orbit spot moved (turning fast past a wall): more is a jump.
      if (corr.distanceTo(this.rawCorr) > 0.5 + 2 * ideal.distanceTo(this.lastIdeal)) this.corrEasing = true;
      if (this.corrEasing) {
        this.shownCorr.lerp(corr, 1 - Math.exp(-dt * 20));
        if (this.shownCorr.distanceTo(corr) < 0.01) this.corrEasing = false;
      }
      if (!this.corrEasing) this.shownCorr.copy(corr);
    }
    this.rawCorr.copy(corr);
    this.lastIdeal.copy(ideal);
    this.corrKnown = true;
    camera.position.copy(ideal).add(this.shownCorr);
    this.lastShown.copy(camera.position);
  }
}
