import * as THREE from 'three';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { AREAS, easeLevel, type AreaId, type LightsState } from './model';

// Light switches on the walls. Each area has its ceiling lamps' bulbs (found among the pendants the
// room hangs: each gets a bulb material of its own to dim), a soft dark pool on the floor that fades in
// when the lights go off, and, in the lounge, one warm point light. Per-fixture emissive only: the sky
// and its lamp array are not touched.

/** The pendants the room hangs (room.ts), by (x, z) at LAMP_Y. */
const LAMP_Y = 4.05;

interface AreaDef {
  /** The ceiling lamps it switches. */
  lamps: readonly (readonly [x: number, z: number])[];
  /** The floor it darkens: the middle and how far it goes. */
  pool: { x: number; z: number; w: number; d: number };
  /** Where its switch is: on a wall, at (x, z), facing `rotY`. */
  plate: { x: number; z: number; rotY: number; wall: 'east' | 'west' };
  /** The one point light it has, if any. */
  light?: { x: number; y: number; z: number };
}

const DEF: Record<AreaId, AreaDef> = {
  // East wall between the TV and the Services board.
  lounge: { lamps: [[13, 0]], pool: { x: 13.4, z: 0, w: 10, d: 15 }, plate: { x: 17.92, z: -4.2, rotY: -Math.PI / 2, wall: 'east' }, light: { x: 13, y: 3.4, z: 0 } },
  // West wall between the last window and the exit door.
  desks: {
    lamps: [
      [-10.5, -4],
      [-1.5, -4],
      [-10.5, 4],
      [-1.5, 4],
    ],
    pool: { x: -6, z: 0, w: 19, d: 14 },
    plate: { x: -17.92, z: 5.15, rotY: Math.PI / 2, wall: 'west' },
  },
};

export interface LightSwitches {
  /** Sets which areas are lit (they fade to it). `snap` jumps there at once. */
  apply(state: LightsState, snap?: boolean): void;
}

declare module '../../world/types' {
  interface OfficeHandles {
    /** The wall switches for the ceiling lamps (features/lights). */
    lightSwitches: LightSwitches;
  }
}

/** A soft round shadow, black in the middle and clear at the edge. */
function poolTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(10,12,30,0.85)');
  grad.addColorStop(0.65, 'rgba(10,12,30,0.6)');
  grad.addColorStop(1, 'rgba(10,12,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export const lightSwitches: Fixture<'lightSwitches'> = (site) => {
  const tex = poolTexture();
  const plateMat = toon('#f1ece2');
  const nubMat = toon('#c9c3b6');
  const levels = {} as Record<AreaId, number>;
  const want = {} as Record<AreaId, boolean>;
  const bulbs = {} as Record<AreaId, THREE.MeshToonMaterial[]>;
  const pools = {} as Record<AreaId, THREE.Mesh>;
  const nubs = {} as Record<AreaId, THREE.Mesh>;
  const light = new THREE.PointLight('#ffd9a0', 0, 12, 2);
  light.castShadow = false;
  site.group.add(light);
  const spot = DEF.lounge.light!;
  light.position.set(spot.x, spot.y, spot.z);

  for (const id of AREAS) {
    const def = DEF[id];
    levels[id] = 1;
    want[id] = true;
    bulbs[id] = [];
    // The pendants over this area: the sphere in each (child 2) gets a bulb of its own.
    for (const [x, z] of def.lamps) {
      const pendant = site.group.children.find((o) => o.type === 'Group' && Math.abs(o.position.x - x) < 0.01 && Math.abs(o.position.z - z) < 0.01 && Math.abs(o.position.y - LAMP_Y) < 0.01);
      const bulb = pendant?.children[2] as THREE.Mesh | undefined;
      if (!bulb) continue;
      const own = (bulb.material as THREE.MeshToonMaterial).clone();
      bulb.material = own;
      bulbs[id].push(own);
    }
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(def.pool.w, def.pool.d),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(def.pool.x, 0.035, def.pool.z);
    pool.visible = false;
    pool.renderOrder = 2;
    site.group.add(pool);
    pools[id] = pool;

    // The switch: a plate with a rocker, on the wall at about hand height.
    const { plate } = def;
    const g = new THREE.Group();
    g.position.set(plate.x, 1.3, plate.z);
    g.rotation.y = plate.rotY;
    g.add(mesh(roundedBox(0.16, 0.24, 0.03, 0.02), plateMat, 0, 0, 0.012, false));
    const nub = mesh(roundedBox(0.06, 0.1, 0.03, 0.015), nubMat, 0, 0.03, 0.035, false);
    g.add(nub);
    nubs[id] = nub;
    const nx = Math.sin(plate.rotY);
    const it: Interactable = { kind: 'lightswitch', decorId: id, x: plate.x + nx * 0.8, z: plate.z, radius: 1.5 };
    g.userData.interact = it;
    // A big invisible-ish target so the thing is easy to hit with the crosshair.
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.2), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.z = 0.1;
    g.add(hit);
    site.group.add(g);
    site.wall(plate.wall, plate.z, 1.3, 0.4, 0.5);
  }

  const show = (id: AreaId) => {
    const lit = levels[id];
    for (const m of bulbs[id]) {
      m.emissiveIntensity = 0.05 + 0.95 * lit;
      m.color.set('#fff7d6').lerp(new THREE.Color('#7d7a70'), 1 - lit);
    }
    const pool = pools[id];
    (pool.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - lit);
    pool.visible = lit < 0.995;
    nubs[id].rotation.x = lit > 0.5 ? -0.35 : 0.35;
    if (id === 'lounge') {
      light.intensity = 5 * lit;
      // An invisible light isn't counted by three, so the lit fragments don't pay for it while the lounge is dark.
      light.visible = lit > 0.001;
    }
  };
  AREAS.forEach(show);

  const handle: LightSwitches = {
    apply(state, snap = false) {
      for (const id of AREAS) {
        want[id] = state[id];
        if (snap) {
          levels[id] = state[id] ? 1 : 0;
          show(id);
        }
      }
    },
  };

  return {
    handle: { lightSwitches: handle },
    update(_t, dt) {
      for (const id of AREAS) {
        const next = easeLevel(levels[id], want[id], dt);
        if (next === levels[id]) continue;
        levels[id] = next;
        show(id);
      }
    },
  };
};

