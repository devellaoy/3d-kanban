import * as THREE from 'three';
import type { CarKind } from '../../../shared/garage';
import { Ride } from './ride';
import { carModel } from './world';
import type { GhostPose } from './ghost';

// The ghost car: a translucent, tinted toon car that replays your best lap. It isn't solid, but it
// rides on its springs like the real ones (see ride.ts), from how it's seen to move.

const TINT = new THREE.Color('#9be7ff');

/** A ghost of a `kind` of car, in the cars' own group (down on the street, `y`). */
export class GhostCar {
  readonly root: THREE.Object3D;
  private wheels: THREE.Object3D[];
  private mats: THREE.Material[] = [];
  private ride: Ride;
  private at = 0;

  constructor(
    readonly kind: CarKind,
    private y: number,
  ) {
    const model = carModel(kind, '#9be7ff');
    this.root = model.root;
    this.wheels = model.wheels;
    this.ride = new Ride(model, kind);
    this.root.visible = false;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // The materials are shared with the real cars (cached): the ghost has its own, see-through.
      const own = (src: THREE.Material) => {
        const c = src.clone() as THREE.MeshToonMaterial;
        c.color?.lerp(TINT, 0.7);
        c.transparent = true;
        c.opacity = Math.min(src.opacity, 0.38);
        c.depthWrite = false;
        this.mats.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
      m.castShadow = false;
      m.receiveShadow = false;
    });
  }

  /** At `pose` (null: hidden). */
  place(pose: GhostPose | null) {
    const now = performance.now();
    const dt = (now - this.at) / 1000;
    this.at = now;
    if (!pose) {
      if (this.root.visible) this.ride.reset();
      this.root.visible = false;
      return;
    }
    // Just appeared, or jumped (a new lap's start): no history to ride on.
    const jumped = !this.root.visible || dt > 0.25;
    this.root.visible = true;
    this.root.position.set(pose.x, this.y, pose.z);
    this.root.rotation.y = pose.rotY;
    for (const w of this.wheels) w.rotation.y = 0;
    if (jumped) this.ride.reset();
    else this.ride.follow(pose, dt);
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.mats) m.dispose();
  }
}
