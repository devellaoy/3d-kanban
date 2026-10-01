import * as THREE from 'three';
import type { CarKind } from '../../../shared/garage';
import { supercar } from './world';
import type { GhostPose } from './ghost';

// The ghost car: a translucent, tinted toon supercar that replays your best lap. It isn't solid.

const TINT = new THREE.Color('#9be7ff');

/** A ghost of a `kind` of car, in the cars' own group (down on the street, `y`). */
export class GhostCar {
  readonly root: THREE.Object3D;
  private wheels: THREE.Object3D[];
  private mats: THREE.Material[] = [];

  constructor(
    readonly kind: CarKind,
    private y: number,
  ) {
    const model = supercar(kind, '#9be7ff');
    this.root = model.root;
    this.wheels = model.wheels;
    this.root.visible = false;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // The materials are shared with the real cars (cached): the ghost has its own, see-through.
      const own = (src: THREE.Material) => {
        const c = src.clone() as THREE.MeshToonMaterial;
        c.color?.lerp(TINT, 0.7);
        c.transparent = true;
        c.opacity = 0.38;
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
    this.root.visible = pose !== null;
    if (!pose) return;
    this.root.position.set(pose.x, this.y, pose.z);
    this.root.rotation.y = pose.rotY;
    for (const w of this.wheels) w.rotation.y = 0;
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.mats) m.dispose();
  }
}
