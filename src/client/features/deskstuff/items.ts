import * as THREE from 'three';
import { mesh, roundedBox, toon, toonUnique } from '../../world/toon';
import type { DeskItem } from './model';

// The small things that go on a desk, each built at its own spot on the desk's front left, in the
// desk's frame at the height of its top (+z is toward the chair). Procedural toon shapes only.

/** Where each one stands, clear of the laptop in the middle and of the dancing spot on the right. */
const SLOT: Record<DeskItem, [x: number, z: number]> = {
  plant: [-0.93, 0.2],
  lamp: [-0.58, 0.18],
  mug: [-0.95, 0.42],
  frame: [-0.7, 0.44],
  duck: [-0.46, 0.42],
};

/** The desk lamp is the one that does something: its bulb and glow follow `on`. */
export interface LampParts {
  group: THREE.Group;
  /** Eased glow, 0 (off) to 1 (on); call each frame with the lamp's `lit` target. */
  setGlow(level: number): void;
  /** Where its light shines from, in the group's frame. */
  readonly bulbAt: THREE.Vector3;
}

function plantItem(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.09, 10), toon('#e07a5f'), 0, 0.045, 0, false));
  g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 10), toon('#5a3d2b'), 0, 0.092, 0, false));
  const leaf = toon('#4caf6a');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const l = mesh(new THREE.SphereGeometry(0.04, 8, 6), leaf, Math.sin(a) * 0.035, 0.15, Math.cos(a) * 0.035, false);
    l.scale.set(0.6, 1.5, 0.6);
    l.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5);
    g.add(l);
  }
  g.add(mesh(new THREE.SphereGeometry(0.03, 8, 6), toon('#66cc88'), 0, 0.19, 0, false));
  return g;
}

function mugItem(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.09, 12), toon('#f4a261'), 0, 0.045, 0, false));
  g.add(mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.006, 12), toon('#6b4226'), 0, 0.088, 0, false));
  const handle = mesh(new THREE.TorusGeometry(0.025, 0.007, 6, 10), toon('#f4a261'), 0.047, 0.047, 0, false);
  g.add(handle);
  return g;
}

function frameItem(): THREE.Group {
  const g = new THREE.Group();
  const frame = mesh(roundedBox(0.15, 0.12, 0.012, 0.01), toon('#8a5a3b'), 0, 0.065, 0, false);
  frame.rotation.x = -0.18;
  g.add(frame);
  // The photo: sky, a sun and a green hill.
  const photo = new THREE.Group();
  photo.add(mesh(new THREE.PlaneGeometry(0.12, 0.09), new THREE.MeshBasicMaterial({ color: '#8ecae6' }), 0, 0, 0, false));
  photo.add(mesh(new THREE.CircleGeometry(0.014, 10), new THREE.MeshBasicMaterial({ color: '#ffd166' }), 0.03, 0.02, 0.001, false));
  const hill = mesh(new THREE.CircleGeometry(0.07, 14, 0, Math.PI), new THREE.MeshBasicMaterial({ color: '#6bbf6a' }), -0.01, -0.045, 0.001, false);
  photo.add(hill);
  photo.position.set(0, 0.065, 0.008);
  photo.rotation.x = -0.18;
  g.add(photo);
  const leg = mesh(new THREE.BoxGeometry(0.012, 0.09, 0.008), toon('#6b4226'), 0, 0.04, -0.03, false);
  leg.rotation.x = 0.55;
  g.add(leg);
  g.rotation.y = 0.25;
  return g;
}

function duckItem(): THREE.Group {
  const g = new THREE.Group();
  const yellow = toon('#ffd23f');
  const body = mesh(new THREE.SphereGeometry(0.05, 12, 10), yellow, 0, 0.045, 0, false);
  body.scale.set(1, 0.8, 1.2);
  g.add(body);
  g.add(mesh(new THREE.SphereGeometry(0.032, 10, 8), yellow, 0, 0.105, 0.03, false));
  const beak = mesh(new THREE.ConeGeometry(0.013, 0.03, 6), toon('#ff8c42'), 0, 0.1, 0.066, false);
  beak.rotation.x = Math.PI / 2;
  g.add(beak);
  for (const sx of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.006, 6, 5), toon('#2b2d42'), sx * 0.015, 0.115, 0.055, false));
  g.add(mesh(new THREE.SphereGeometry(0.02, 8, 6), yellow, 0, 0.07, -0.055, false));
  g.rotation.y = 0.5;
  return g;
}

function lampItem(): LampParts {
  const g = new THREE.Group();
  const ink = toon('#2b2d42');
  g.add(mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.02, 14), ink, 0, 0.01, 0, false));
  // Two arm segments, folded up and over.
  const lower = mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.28, 6), ink, 0.02, 0.15, 0, false);
  lower.rotation.z = -0.15;
  g.add(lower);
  const upper = mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.22, 6), ink, 0.07, 0.3, 0, false);
  upper.rotation.z = 1.1;
  g.add(upper);
  const shade = mesh(new THREE.ConeGeometry(0.075, 0.1, 14, 1, true), toon('#e63946'), 0.14, 0.34, 0, false);
  shade.rotation.z = Math.PI;
  g.add(shade);
  const bulbMat = toonUnique('#fff7d6');
  bulbMat.emissive.set('#ffe08a');
  bulbMat.emissiveIntensity = 0;
  g.add(mesh(new THREE.SphereGeometry(0.03, 10, 8), bulbMat, 0.14, 0.3, 0, false));
  // A warm pool of light on the desk under it.
  const poolMat = new THREE.MeshBasicMaterial({ color: '#ffd98a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const pool = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0.14, 0.004, 0);
  pool.visible = false;
  g.add(pool);
  return {
    group: g,
    bulbAt: new THREE.Vector3(0.14, 0.28, 0),
    setGlow(level) {
      bulbMat.emissiveIntensity = level * 1.2;
      poolMat.opacity = level * 0.35;
      pool.visible = level > 0.01;
    },
  };
}

export interface BuiltItem {
  group: THREE.Group;
  lamp?: LampParts;
}

/** `item`, built and standing at its spot. */
export function buildItem(item: DeskItem): BuiltItem {
  let built: BuiltItem;
  if (item === 'lamp') {
    const lamp = lampItem();
    built = { group: lamp.group, lamp };
  } else {
    built = { group: { plant: plantItem, mug: mugItem, frame: frameItem, duck: duckItem }[item]() };
  }
  built.group.position.set(SLOT[item][0], 0, SLOT[item][1]);
  return built;
}
