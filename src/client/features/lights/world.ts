import * as THREE from 'three';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { roomLampHour, type RoomLamp } from '../../world/roomlight';
import { AREAS, easeLevel, type AreaId, type LightsState } from './model';

// Light switches on the walls. Each area has its ceiling lamps, the ones the room tags with it
// (room.ts's CEILING_LAMPS): their bulbs (each pendant's bulb gets a material of its own to dim) and the
// light they throw on the room (their RoomLamps in NightParts, see world/roomlight.ts), which the switch
// dims with the bulbs. By day both are turned down, as the sky has the room's lamps (roomLampHour).

interface AreaDef {
  /** Where its switch is: on a wall, at (x, z), facing `rotY`. */
  plate: { x: number; z: number; rotY: number; wall: 'east' | 'west' };
}

const DEF: Record<AreaId, AreaDef> = {
  // East wall between the TV and the Services board.
  lounge: { plate: { x: 17.92, z: -4.2, rotY: -Math.PI / 2, wall: 'east' } },
  // West wall between the last window and the exit door.
  desks: { plate: { x: -17.92, z: 5.15, rotY: Math.PI / 2, wall: 'west' } },
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

export const lightSwitches: Fixture<'lightSwitches'> = (site) => {
  const night = site.get('night');
  const plateMat = toon('#f1ece2');
  const nubMat = toon('#c9c3b6');
  const levels = {} as Record<AreaId, number>;
  const want = {} as Record<AreaId, boolean>;
  const bulbs = {} as Record<AreaId, THREE.MeshToonMaterial[]>;
  const lights = {} as Record<AreaId, RoomLamp[]>;
  const nubs = {} as Record<AreaId, THREE.Mesh>;

  for (const id of AREAS) {
    const def = DEF[id];
    levels[id] = 1;
    want[id] = true;
    bulbs[id] = [];
    lights[id] = night.roomLamps.filter((l) => l.area === id);
    // The lamps over this area: the glowing diffuser in each (child 2) gets a bulb of its own.
    for (const pendant of site.group.children.filter((o) => o.userData.area === id)) {
      const bulb = pendant.children[2] as THREE.Mesh | undefined;
      // No bulb at child 2 means props.ts's pendant() changed shape: fail loudly rather than leave a lamp its switch can't dim.
      if (!bulb?.isMesh) throw new Error(`lights: the ${id} pendant at (${pendant.position.x}, ${pendant.position.z}) has no bulb (child 2)`);
      const own = (bulb.material as THREE.MeshToonMaterial).clone();
      bulb.material = own;
      bulbs[id].push(own);
    }

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

  /** How far up the room's lamps are for the hour (roomLampHour) when the bulbs were last shown: they glow less by day, as their light does. */
  let hour = roomLampHour();
  const show = (id: AreaId) => {
    const lit = levels[id];
    for (const m of bulbs[id]) {
      m.emissiveIntensity = 0.05 + 0.95 * lit * hour;
      m.color.set('#fff7d6').lerp(new THREE.Color('#7d7a70'), 1 - lit);
    }
    for (const l of lights[id]) l.level = lit;
    nubs[id].rotation.x = lit > 0.5 ? -0.35 : 0.35;
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
      const now = roomLampHour();
      if (Math.abs(now - hour) > 0.005) {
        hour = now;
        AREAS.forEach(show);
      }
      for (const id of AREAS) {
        const next = easeLevel(levels[id], want[id], dt);
        if (next === levels[id]) continue;
        levels[id] = next;
        show(id);
      }
    },
  };
};

