import * as THREE from 'three';
import { mesh, toon } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import { PLANTERS, stageOf, thirsty, type Planter, type PlantKind, type Stage } from './model';

// The roof garden's planters: wooden boxes in a block by the bar, a different plant in each, which grow
// as they are watered (see model.ts). Added to the roof once it's built (see index.ts).

/** Where the planters stand on the roof: their middles (x, z). */
const SPOTS: readonly (readonly [number, number])[] = [
  [13.6, 7.2],
  [16.1, 7.2],
  [13.6, 9.8],
  [16.1, 9.8],
];
const BOX = { w: 2.0, d: 0.8, h: 0.5 } as const;

const wood = toon('#9c6644');
const soil = toon('#4a3425');
const stemGreen = toon('#4f9d4f');
const leafGreen = toon('#6fcf6a');
const dry = toon('#b5a642');

export interface PlanterView {
  interactable: Interactable;
  /** Draws what's growing for `p` (only when its stage or thirst has changed). */
  show(p: Planter, now: number): void;
  /** A splash of water over it. */
  splash(): void;
}

export interface GardenView {
  group: THREE.Group;
  colliders: Collider[];
  planters: PlanterView[];
  update(dt: number): void;
}

function leaf(x: number, y: number, z: number, s: number, turn: number, droop: number, mat: THREE.Material): THREE.Mesh {
  const m = mesh(new THREE.SphereGeometry(0.1, 6, 5), mat, x, y, z, false);
  m.scale.set(s * 1.8, s * 0.35, s);
  m.rotation.set(0, turn, droop);
  return m;
}

/** One plant, `height` tall, with `leaves` leaves on it: stem, leaves, and (`flower`) its bloom or fruit. */
function plant(kind: PlantKind, stage: Stage, wilting: boolean): THREE.Group {
  const g = new THREE.Group();
  const tall = { tomato: 0.8, sunflower: 1.3, tulip: 0.55, basil: 0.5 }[kind];
  const grown = { empty: 0, seed: 0, sprout: 0.18, leafy: 0.5, budding: 0.8, bloom: 1 }[stage];
  const height = Math.max(0.05, tall * grown);
  const green = wilting ? dry : stemGreen;
  const leafMat = wilting ? dry : leafGreen;
  if (stage === 'seed') {
    g.add(mesh(new THREE.SphereGeometry(0.07, 6, 5), toon('#8a6a3d'), 0, 0.04, 0, false));
    return g;
  }
  g.add(mesh(new THREE.CylinderGeometry(0.025, 0.04, height, 5), green, 0, height / 2, 0, false));
  const pairs = stage === 'sprout' ? 1 : stage === 'leafy' ? 2 : 3;
  for (let i = 0; i < pairs; i++) {
    const y = height * (0.35 + (i / Math.max(1, pairs)) * 0.55);
    const droop = wilting ? -0.9 : -0.25;
    g.add(leaf(0.1, y, 0, 1.2 - i * 0.15, i * 1.1, droop, leafMat));
    g.add(leaf(-0.1, y + 0.03, 0, 1.2 - i * 0.15, Math.PI + i * 1.1, -droop, leafMat));
  }
  if (stage === 'budding') {
    const bud = { tomato: '#9bd18b', sunflower: '#8fbf5f', tulip: '#d77a9a', basil: '#7bc47f' }[kind];
    g.add(mesh(new THREE.SphereGeometry(0.06, 6, 5), toon(bud), 0, height + 0.04, 0, false));
  }
  if (stage === 'bloom') {
    const top = height + 0.04;
    if (kind === 'tomato') {
      for (const [x, y, z] of [[0.12, -0.25, 0.04], [-0.1, -0.12, -0.05], [0.04, -0.4, -0.1]]) g.add(mesh(new THREE.SphereGeometry(0.09, 8, 6), toon('#e63946'), x, top + y, z, false));
    } else if (kind === 'sunflower') {
      const head = new THREE.Group();
      head.position.set(0, top, 0.06);
      head.rotation.x = 0.35;
      head.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 12).rotateX(Math.PI / 2), toon('#5b3a1e'), 0, 0, 0, false));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const petal = mesh(new THREE.SphereGeometry(0.07, 6, 5), toon('#ffc300'), Math.cos(a) * 0.22, Math.sin(a) * 0.22, -0.01, false);
        petal.scale.set(1, 1.5, 0.4);
        petal.rotation.z = a;
        head.add(petal);
      }
      g.add(head);
    } else if (kind === 'tulip') {
      g.add(mesh(new THREE.ConeGeometry(0.1, 0.22, 6).rotateX(Math.PI), toon('#ef476f'), 0, top + 0.05, 0, false));
    } else {
      g.add(mesh(new THREE.SphereGeometry(0.16, 8, 6), toon('#2d8f4e'), 0, top, 0, false));
    }
  }
  return g;
}

export function buildGarden(): GardenView {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const splashes: { drops: THREE.Mesh[]; age: number; root: THREE.Group }[] = [];
  const dropMat = toon('#7ec8f2');

  const planters = SPOTS.map(([x, z], i): PlanterView => {
    const kind = PLANTERS[i];
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    root.add(mesh(new THREE.BoxGeometry(BOX.w, BOX.h, BOX.d), wood, 0, BOX.h / 2, 0));
    root.add(mesh(new THREE.BoxGeometry(BOX.w - 0.14, 0.04, BOX.d - 0.14), soil, 0, BOX.h + 0.01, 0, false));
    const growing = new THREE.Group();
    growing.position.y = BOX.h;
    root.add(growing);
    group.add(root);
    colliders.push({ minX: x - BOX.w / 2, maxX: x + BOX.w / 2, minZ: z - BOX.d / 2, maxZ: z + BOX.d / 2, top: BOX.h });
    const interactable: Interactable = { kind: 'planter', x, z, radius: 2.2, decorId: `planter-${i}` };
    root.userData.interact = interactable;

    const drops = Array.from({ length: 8 }, (_, k) => {
      const d = mesh(new THREE.SphereGeometry(0.035, 5, 4), dropMat, (k - 3.5) * 0.2, 0, ((k * 7) % 3) * 0.1 - 0.1, false);
      d.visible = false;
      root.add(d);
      return d;
    });
    const splash = { drops, age: 99, root };
    splashes.push(splash);

    let shown = '';
    return {
      interactable,
      show(p, now) {
        const stage = stageOf(p);
        const wilting = thirsty(p, now);
        const key = `${stage}${wilting}`;
        if (key === shown) return;
        shown = key;
        growing.clear();
        if (stage === 'empty') return;
        for (let k = 0; k < 3; k++) {
          const one = plant(kind, stage, wilting);
          one.position.set((k - 1) * 0.6, 0, ((k * 5) % 3) * 0.1 - 0.1);
          one.rotation.y = k * 2.1;
          growing.add(one);
        }
      },
      splash() {
        splash.age = 0;
      },
    };
  });

  return {
    group,
    colliders,
    planters,
    update(dt) {
      for (const s of splashes) {
        if (s.age > 1) continue;
        s.age += dt;
        s.drops.forEach((d, k) => {
          d.visible = s.age <= 0.9;
          d.position.y = 1.6 - (s.age * (1.6 - BOX.h)) / 0.9 - Math.sin(k) * 0.05;
        });
      }
    },
  };
}
