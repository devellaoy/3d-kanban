import * as THREE from 'three';
import { STOREY, STREET_Y } from '../../../shared/layout';
import { mulberry32 } from '../../../shared/rng';
import { CAMP, VIEWPOINT } from '../../../shared/scenic';
import { bulb } from '../../world/outside';
import { mesh, textPlane, toon, toonUnique } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { Embers, Fire } from './fire';
import { buildViewpoint } from './viewpoint';

// Two places off the scenic loop (see shared/scenic.ts), built down on the street: the campsite on the
// lake's west shore (tents, log seats and a campfire that flickers and throws embers, and lights the
// ground round it at night) and the lookout at the foot of the hill south of the lake.

const G = STREET_Y;

export interface Camp {
  group: THREE.Group;
  fire: Fire;
  /** The fire to stoke, and the binoculars at the lookout: walk up and press E. */
  campfire: Interactable;
  binoculars: Interactable;
  /** Draws it only when you're near enough to see (x, z: where you are). */
  cull(x: number, z: number): void;
}

/** Tents are a triangular prism along z, the door at the +z end. */
function tent(color: string): THREE.Group {
  const g = new THREE.Group();
  const R = 1.15;
  const length = 2.4;
  g.add(mesh(new THREE.CylinderGeometry(R, R, length, 3).rotateX(-Math.PI / 2), toon(color), 0, R / 2, 0));
  const door = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.42, 0, length / 2 + 0.02), new THREE.Vector3(0.42, 0, length / 2 + 0.02), new THREE.Vector3(0, 0.95, length / 2 + 0.02)]);
  door.computeVertexNormals();
  g.add(mesh(door, toon('#2b2d42'), 0, 0.02, 0, false));
  g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), toon('#c9ada7'), 0.9, 0.45, length / 2 + 0.7, false));
  return g;
}

function buildFire(fire: Fire, night: Parameters<typeof bulb>[0]) {
  const root = new THREE.Group();
  root.position.set(CAMP.x, G, CAMP.z);
  const stone = toon('#8d8a99');
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const s = mesh(new THREE.IcosahedronGeometry(0.2, 0), stone, Math.cos(a) * 0.82, 0.1, Math.sin(a) * 0.82);
    s.scale.set(1.1, 0.8, 1);
    s.rotation.y = a * 3;
    root.add(s);
  }
  const wood = toon('#6b4a2f');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI;
    const log = mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.95, 6), wood, 0, 0.17, 0, false);
    log.rotation.set(Math.PI / 2 + 0.2, 0, 0);
    const pivot = new THREE.Group();
    pivot.rotation.y = a;
    pivot.add(log);
    root.add(pivot);
  }
  root.add(mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.06, 12), toon('#2b2118'), 0, 0.03, 0, false));

  // The flames: three cones, one inside the next, each flickering on its own.
  const tongues = [
    { r: 0.36, h: 1.05, color: '#ff8a1f', seed: 0 },
    { r: 0.26, h: 0.82, color: '#ffc233', seed: 2.1 },
    { r: 0.14, h: 0.55, color: '#fff3b0', seed: 4.2 },
  ].map((t) => {
    const mat = toonUnique(t.color);
    mat.emissive.set(t.color);
    mat.emissiveIntensity = 1;
    const m = mesh(new THREE.ConeGeometry(t.r, t.h, 7, 1, true), mat, 0, 0.18 + t.h / 2, 0, false);
    root.add(m);
    return { m, ...t };
  });

  // Embers drifting up, fading to nothing.
  const embers = new Embers(36, mulberry32(77));
  const geo = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(embers.count * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(new Float32Array(embers.count * 3), 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', positions);
  geo.setAttribute('color', colors);
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  points.frustumCulled = false;
  root.add(points);

  // At night its light pools on the ground round it, and a halo hangs over it.
  const lamp = { x: CAMP.x, y: G + 1.1, z: CAMP.z, reach: 15, color: '#ff9a4a', power: 3, ground: true };
  night.lamps.push(lamp);
  night.halos.push({ at: new THREE.Vector3(CAMP.x, G + 0.9, CAMP.z), size: 3.4, color: '#ffb066', ground: true });

  const ember = new THREE.Color();
  function update(t: number, dt: number) {
    fire.update(dt);
    const h = fire.height;
    for (const f of tongues) {
      const k = 1 + 0.16 * Math.sin(t * 11 + f.seed) + 0.1 * Math.sin(t * 19 + f.seed * 1.7);
      f.m.scale.set(1 + 0.08 * Math.sin(t * 7 + f.seed) + (h - 1) * 0.3, h * k, 1 + 0.08 * Math.cos(t * 8 + f.seed) + (h - 1) * 0.3);
      f.m.position.y = 0.18 + (f.h * h * k) / 2;
      f.m.rotation.y = t * 1.5 + f.seed;
    }
    lamp.power = 3 * fire.glow(t);
    embers.update(dt, fire.flare);
    for (let i = 0; i < embers.count; i++) {
      positions.setXYZ(i, embers.pos[i * 3], embers.pos[i * 3 + 1], embers.pos[i * 3 + 2]);
      const life = 1 - embers.fade(i);
      colors.setXYZ(i, ...ember.setRGB(1, 0.5 + 0.3 * life, 0.15).multiplyScalar(life).toArray() as [number, number, number]);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
  }
  return { root, update };
}

function buildCampsite(night: Parameters<typeof bulb>[0], colliders: Collider[])  {
  const group = new THREE.Group();
  const fire = new Fire();
  const f = buildFire(fire, night);
  group.add(f.root);
  const box = (x: number, z: number, r: number, h: number) => colliders.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, bottom: G, top: G + h });
  box(CAMP.x, CAMP.z, 0.8, 0.35);

  // Logs to sit on round the fire, the open side toward the lake (east).
  const bark = toon('#7b5638');
  for (const a of [Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    const x = CAMP.x + Math.cos(a) * 2.3;
    const z = CAMP.z + Math.sin(a) * 2.3;
    const seat = new THREE.Group();
    seat.position.set(x, G + 0.24, z);
    seat.rotation.y = -(a + Math.PI / 2);
    const log = mesh(new THREE.CylinderGeometry(0.24, 0.24, 2, 8), bark, 0, 0, 0);
    log.rotation.z = Math.PI / 2;
    seat.add(log);
    seat.add(mesh(new THREE.CircleGeometry(0.18, 8), toon('#d9b889'), 1.003, 0, 0, false).rotateY(Math.PI / 2));
    group.add(seat);
    box(x, z, 0.95, 0.46);
  }

  // Two tents behind the fire, their doors toward it, and the cooler and a lantern on a stump.
  for (const [dx, dz, color] of [
    [-7.4, -3.6, '#e76f51'],
    [-7.1, 3.9, '#2a9d8f'],
  ] as const) {
    const t = tent(color);
    t.position.set(CAMP.x + dx, G, CAMP.z + dz);
    t.rotation.y = Math.atan2(-dx, -dz);
    group.add(t);
    box(CAMP.x + dx, CAMP.z + dz, 1.3, 1.1);
  }
  const stump = mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.45, 8), bark, CAMP.x + 3.1, G + 0.22, CAMP.z + 1.5);
  group.add(stump);
  const glass = bulb(night, '#ffd37a', 0.35);
  group.add(mesh(new THREE.BoxGeometry(0.18, 0.26, 0.18), glass, CAMP.x + 3.1, G + 0.58, CAMP.z + 1.5, false));
  group.add(mesh(new THREE.BoxGeometry(0.24, 0.04, 0.24), toon('#2b2d42'), CAMP.x + 3.1, G + 0.73, CAMP.z + 1.5, false));
  box(CAMP.x + 3.1, CAMP.z + 1.5, 0.3, 0.45);
  const cooler = new THREE.Group();
  cooler.add(mesh(new THREE.BoxGeometry(0.8, 0.45, 0.5), toon('#3a86c8'), 0, 0.225, 0));
  cooler.add(mesh(new THREE.BoxGeometry(0.84, 0.08, 0.54), toon('#f1f1f1'), 0, 0.49, 0));
  cooler.position.set(CAMP.x - 4.2, G, CAMP.z + 0.6);
  cooler.rotation.y = 0.4;
  group.add(cooler);
  box(CAMP.x - 4.2, CAMP.z + 0.6, 0.5, 0.5);

  // A sign by the shore, facing the lake.
  const sign = new THREE.Group();
  sign.position.set(CAMP.x + 5.5, G, CAMP.z + 5.5);
  sign.rotation.y = Math.PI / 2;
  sign.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.4, 6), bark, 0, 0.7, 0));
  sign.add(mesh(new THREE.BoxGeometry(1.5, 0.5, 0.06), toon('#fffaf3'), 0, 1.4, 0));
  const text = textPlane('🏕️ Lakeside camp', { bg: '#fffaf3', size: 44 });
  text.scale.multiplyScalar(0.42);
  text.position.set(0, 1.4, 0.04);
  sign.add(text);
  group.add(sign);
  box(CAMP.x + 5.5, CAMP.z + 5.5, 0.15, 1.5);

  return { group, flames: f.root, update: f.update, fire };
}

/** The campsite and the lookout, down on the street (it goes down with the street on a floor above the bottom one). */
export const camp: Fixture<'camp'> = (site) => {
  const night = site.get('night');
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const site1 = buildCampsite(night, colliders);
  const look = buildViewpoint(colliders);
  group.add(site1.group, look.group);

  const campfire: Interactable = { kind: 'campfire', x: CAMP.x, z: CAMP.z, radius: 4.5 };
  const binoculars: Interactable = { kind: 'viewpoint', x: look.stand.x, z: look.stand.z, radius: 3.5 };
  // Clicking the fire or the binoculars uses them.
  site1.flames.userData.interact = campfire;
  look.standGroup.userData.interact = binoculars;

  const base = colliders.map((c) => ({ c, top: c.top, bottom: c.bottom ?? 0 }));
  const built: Camp = {
    group,
    fire: site1.fire,
    campfire,
    binoculars,
    cull(x, z) {
      const near = Math.min(Math.hypot(x - CAMP.x, z - CAMP.z), Math.hypot(x - VIEWPOINT.x, z - VIEWPOINT.z)) < 300;
      site1.group.visible = Math.hypot(x - CAMP.x, z - CAMP.z) < 300;
      look.group.visible = Math.hypot(x - VIEWPOINT.x, z - VIEWPOINT.z) < 300;
      group.visible = near;
    },
  };
  return {
    group,
    colliders,
    interactables: [campfire, binoculars],
    handle: { camp: built },
    update: (t, dt) => {
      if (site1.group.visible) site1.update(t, dt);
    },
    setLevel: (index) => {
      const drop = index * STOREY;
      group.position.y = -drop;
      for (const g of base) {
        g.c.top = g.top - drop;
        g.c.bottom = g.bottom - drop;
      }
    },
  };
};

declare module '../../world/types' {
  interface OfficeHandles {
    /** The campsite and the hill lookout off the scenic loop. */
    camp: Camp;
  }
}
