import type * as THREE from 'three';
import { carPoint, type CarKind } from '../../../shared/garage';
import { bumpHeight } from '../../../shared/bumps';
import { Suspension, suspensionOf } from './suspension';

// A car riding on its springs, as it's drawn: worked out from how the car is seen to move (so it's the
// same for yours, for everyone else's and for your ghost car, and nothing is sent anywhere), over the
// bumps in the ground (shared/bumps.ts). The body's lean and rise go on the model's `tilt` group and
// its wheels follow the ground under them.

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The parts of a car model that ride (see CarModel in world.ts). */
export interface Rideable {
  /** The body's group: it rolls, pitches and rises on the springs. */
  tilt: THREE.Object3D;
  /** The wheels that hang from the body on their own (the front pair, which steer) and any other that does. */
  wheels: THREE.Object3D[];
  rear?: THREE.Object3D[];
}

/** One wheel that moves against the body: which corner it is, and where it sits when the car's at rest. */
interface Hub {
  obj: THREE.Object3D;
  corner: number;
  y: number;
}

export class Ride {
  readonly susp: Suspension;
  private hubs: Hub[] = [];
  private baseY: number;
  private seen: { x: number; z: number; rotY: number; long: number } | null = null;
  private aLong = 0;
  private aLat = 0;
  private ground = [0, 0, 0, 0];

  constructor(
    private model: Rideable,
    kind: CarKind,
  ) {
    this.susp = new Suspension(suspensionOf(kind));
    // Remembered on the model itself, so a second Ride on it (a car that was reset) starts from the same place.
    this.baseY = (model.tilt.userData.rideY ??= model.tilt.position.y) as number;
    for (const obj of [...model.wheels, ...(model.rear ?? [])]) {
      obj.userData.rideY ??= obj.position.y;
      this.hubs.push({ obj, corner: (obj.position.z > 0 ? 0 : 2) + (obj.position.x > 0 ? 0 : 1), y: obj.userData.rideY as number });
    }
  }

  /** How high the body is over where it sits at rest, at (lx, lz) of the car's frame (where someone sitting in it is). */
  lift(lx: number, lz: number): number {
    return this.susp.heightAt(lx, lz);
  }

  /** The car is somewhere else, with no history: let the body settle. */
  reset() {
    this.seen = null;
    this.aLong = this.aLat = 0;
    this.susp.reset();
    this.apply();
  }

  /** The car's now at `p`, `dt` seconds after it was last seen: work out how it's moving, then ride the ground it's on. */
  follow(p: { x: number; z: number; rotY: number }, dt: number) {
    // A pose or a step with a NaN in it (a car that was never placed): nothing to ride on, so rest, and forget it.
    if (!Number.isFinite(p.x + p.z + p.rotY + dt)) return this.reset();
    const last = this.seen;
    const sin = Math.sin(p.rotY);
    const cos = Math.cos(p.rotY);
    let long = 0;
    if (last && dt > 0) {
      long = ((p.x - last.x) * sin + (p.z - last.z) * cos) / dt;
      const yawRate = wrap(p.rotY - last.rotY) / dt;
      this.aLong += (clampAcc((long - last.long) / dt) - this.aLong) * Math.min(1, dt * 10);
      this.aLat += (clampAcc(long * yawRate) - this.aLat) * Math.min(1, dt * 12);
    }
    this.seen = { x: p.x, z: p.z, rotY: p.rotY, long };
    const at = this.susp.at;
    for (let i = 0; i < 4; i++) {
      const w = carPoint(p, at[i].x, at[i].z);
      const g = bumpHeight(w.x, w.z);
      this.ground[i] = Number.isFinite(g) ? g : 0;
    }
    this.susp.step(dt, this.ground, this.aLong, this.aLat);
    this.apply();
  }

  private apply() {
    const s = this.susp;
    // Never a NaN in the model's transforms: it would leave the car invisible until the next reset().
    if (!Number.isFinite(s.pitch + s.roll + s.heave)) s.reset();
    this.model.tilt.rotation.set(s.pitch, 0, s.roll);
    this.model.tilt.position.y = this.baseY + s.heave;
    for (const h of this.hubs) {
      const push = s.push(h.corner);
      h.obj.position.y = h.y + (Number.isFinite(push) ? push : 0);
    }
  }
}

/** No car feels more than this (m/s²) sideways or along: a teleport, or a frame's noise, doesn't throw the body about. */
function clampAcc(a: number): number {
  return Math.min(60, Math.max(-60, a));
}
