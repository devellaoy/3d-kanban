import * as THREE from 'three';
import { mesh, toon, toonUnique } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { MAX_STAGE } from './model';

// The merge plant: a potted plant in the lounge that grows a stage for every merge (see model.ts) and
// goes limp when a week passes without one. Seven stages, from a sprout to a flowering bush.

/** In the lounge's north-west corner, clear of the couch and the elevator. */
export const MERGE_PLANT = { x: 10, z: -5.6 } as const;

export interface MergePlant {
  /** Sets the stage (0 to MAX_STAGE) and how limp it is (0 perky to 1 drooping). `snap` skips the growing. */
  set(stage: number, droop: number, snap?: boolean): void;
  /** A little shiver and sparkle when a merge feeds it. */
  perk(): void;
  readonly interactable: Interactable;
}

declare module '../../world/types' {
  interface OfficeHandles {
    /** The plant in the lounge that grows from merges (features/mergeplant). */
    mergePlant: MergePlant;
  }
}

const HEIGHT_AT = (stage: number) => 0.35 + stage * 0.2;

export const mergePlant: Fixture<'mergePlant'> = (site) => {
  const { x, z } = MERGE_PLANT;
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  // The pot.
  root.add(mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.45, 14), toon('#c8553d'), 0, 0.225, 0));
  root.add(mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.07, 14), toon('#b04832'), 0, 0.46, 0));
  root.add(mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.02, 14), toon('#4a3326'), 0, 0.49, 0, false));

  const sway = new THREE.Group();
  sway.position.y = 0.5;
  root.add(sway);
  const stem = mesh(new THREE.CylinderGeometry(0.025, 0.04, 1, 7), toon('#4a8f4f'), 0, 0.5, 0, false);
  sway.add(stem);

  // Leaves in tiers up the stem; tier `t` is there from stage `t`. Each tier is two or three leaves.
  const fresh = new THREE.Color('#3fae5e');
  const limp = new THREE.Color('#a39a4c');
  interface Leaf {
    m: THREE.Mesh;
    mat: THREE.MeshToonMaterial;
    tier: number;
    tilt: number;
    yaw: number;
    scale: number;
  }
  const leaves: Leaf[] = [];
  for (let t = 0; t < MAX_STAGE; t++) {
    const count = t === 0 ? 2 : 3;
    for (let k = 0; k < count; k++) {
      const mat = toonUnique(fresh);
      const m = mesh(new THREE.SphereGeometry(0.13, 10, 8), mat, 0, 0, 0, false);
      m.scale.set(1.5, 0.28, 0.8);
      const yaw = (k / count) * Math.PI * 2 + t * 1.1;
      leaves.push({ m, mat, tier: t, tilt: 0.25 + (t % 2) * 0.12, yaw, scale: 0 });
      sway.add(m);
    }
  }
  // Blooms on the top from stage 5 on, a big one at 6.
  const bloomMat = toon('#ff7aa8');
  const blooms: THREE.Mesh[] = [];
  for (let k = 0; k < 4; k++) {
    const b = mesh(new THREE.SphereGeometry(0.075, 8, 6), bloomMat, 0, 0, 0, false);
    b.visible = false;
    sway.add(b);
    blooms.push(b);
  }
  const heart = mesh(new THREE.SphereGeometry(0.11, 10, 8), toon('#ffd166'), 0, 0, 0, false);
  heart.visible = false;
  sway.add(heart);

  let stage = 0;
  let droop = 0;
  let height = HEIGHT_AT(0);
  let wiggle = 0;
  let sparkle = 0;
  const sparkMat = new THREE.MeshBasicMaterial({ color: '#fff3a3', transparent: true, opacity: 0, depthWrite: false });
  const spark = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 24), sparkMat);
  spark.rotation.x = -Math.PI / 2;
  spark.position.y = 0.55;
  spark.visible = false;
  root.add(spark);

  const interactable: Interactable = { kind: 'mergeplant', x: x + 0.7, z: z + 0.7, radius: 1.8 };
  root.userData.interact = interactable;
  const collider: Collider = { minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4, top: 0.5 };

  function layout(h: number, t: number) {
    stem.scale.y = h;
    stem.position.y = h / 2;
    // The stem leans over as it wilts.
    sway.rotation.z = droop * 0.35 + Math.sin(t * 1.2) * 0.012 * (1 - droop) + Math.sin(t * 28) * 0.02 * wiggle;
    sway.rotation.x = Math.sin(t * 0.9) * 0.01 + Math.cos(t * 31) * 0.02 * wiggle;
    for (const l of leaves) {
      const y = l.tier === 0 ? h * 0.7 : (h * (0.25 + 0.75 * (l.tier / (MAX_STAGE - 1)))) * 0.95;
      const r = 0.1 + 0.1 * Math.min(1, l.scale);
      l.m.position.set(Math.sin(l.yaw) * r, y, Math.cos(l.yaw) * r);
      l.m.rotation.set(0, l.yaw - Math.PI / 2, 0);
      // Pitch: leaves rise at first and hang more and more as it droops.
      l.m.rotateZ(l.tilt - droop * 1.25);
      l.m.scale.set(1.5 * l.scale, 0.28 * l.scale, 0.8 * l.scale);
      l.m.visible = l.scale > 0.02;
      l.mat.color.copy(fresh).lerp(limp, droop);
    }
    const top = h + 0.05;
    blooms.forEach((b, k) => {
      const a = (k / blooms.length) * Math.PI * 2;
      b.position.set(Math.sin(a) * 0.14, top - droop * 0.2, Math.cos(a) * 0.14);
      b.visible = stage >= 5 && droop < 0.7;
    });
    heart.position.set(0, top + 0.03 - droop * 0.2, 0);
    heart.visible = stage >= MAX_STAGE && droop < 0.7;
  }
  layout(height, 0);

  let time = 0;
  return {
    handle: {
      mergePlant: {
        interactable,
        set(s, d, snap = false) {
          stage = Math.max(0, Math.min(MAX_STAGE, Math.floor(s)));
          droop = Math.max(0, Math.min(1, d));
          if (snap) {
            height = HEIGHT_AT(stage);
            for (const l of leaves) l.scale = l.tier < stage ? 1 : 0;
          }
          layout(height, time);
        },
        perk() {
          wiggle = 1;
          sparkle = 1;
        },
      },
    },
    group: root,
    colliders: [collider],
    interactables: [interactable],
    update(t, dt) {
      time = t;
      const k = 1 - Math.exp(-dt * 2.5);
      height += (HEIGHT_AT(stage) - height) * k;
      for (const l of leaves) l.scale += ((l.tier < stage ? 1 : 0) - l.scale) * k;
      wiggle *= Math.exp(-dt * 3);
      if (sparkle > 0.01) {
        sparkle *= Math.exp(-dt * 1.6);
        spark.visible = true;
        spark.scale.setScalar(1 + (1 - sparkle) * 2.2);
        sparkMat.opacity = sparkle * 0.6;
      } else if (spark.visible) spark.visible = false;
      layout(height, t);
    },
  };
};
