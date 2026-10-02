import * as THREE from 'three';
import { DESK_SIZE } from '../../../shared/layout';
import { canLabel } from '../../../shared/floorplan';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { buildItem, type BuiltItem } from './items';
import { DESK_ITEMS, emptyConfig, type DeskConfig, type DeskItem, type FloorDesks } from './model';

// The small things on the desks. Every desk (that can have a sign over it) gets a felt mat at its front
// left; aim at the mat or at what stands on it and press E to pick (see features/deskstuff). The things
// are only built once somebody picks them, and they are yours alone: nothing here goes to the server.

/** The office's desk things: set what stands on each desk, and light the desk lamps. */
export interface DeskStuff {
  /** Puts exactly `floor`'s things on the desks (every other desk is cleared). */
  apply(floor: FloorDesks): void;
  /** Puts `config` on one desk. */
  set(deskId: string, config: DeskConfig): void;
  /** The things on a desk now. */
  get(deskId: string): DeskConfig;
}

/** Aim at a desk's lamp to switch it (the `decorId` of its interactable), or at the mat to pick things. */
export const LAMP_SPOT = 'lamp';

declare module '../../world/types' {
  interface OfficeHandles {
    /** The small things people put on their desks (features/deskstuff). */
    deskStuff: DeskStuff;
  }
}

interface Spot {
  root: THREE.Group;
  config: DeskConfig;
  items: Map<DeskItem, BuiltItem>;
  /** Eased lamp glow, 0 to 1. */
  glow: number;
  lampIt: Interactable;
}

/** The desk things on every desk that can have a sign over it, a mat each to aim at. */
export const deskStuff: Fixture<'deskStuff'> = (site) => {
  const spots = new Map<string, Spot>();
  const matMat = toon('#6d9dc5');
  // One light for all the lamps, wherever one is on (the nearest-lit rule would need the player, so it
  // sits on the lamp that was switched on last).
  const light = new THREE.PointLight('#ffd08a', 0, 5, 2);
  light.castShadow = false;
  light.visible = false; // an invisible light isn't counted by three: it's on only while a lamp is lit (or fading)
  site.group.add(light);
  let lightOn: Spot | null = null;
  let lightLevel = 0;

  for (const [id, view] of site.desks) {
    if (!canLabel(id)) continue;
    const root = new THREE.Group();
    root.position.set(0, DESK_SIZE.height, 0);
    const mat = mesh(roundedBox(0.78, 0.012, 0.5, 0.01), matMat, -0.7, 0.006, 0.31, false);
    root.add(mat);
    view.group.add(root);
    const tray: Interactable = { kind: 'deskstuff', deskId: id, x: view.def.x, z: view.def.z, radius: 1 };
    root.userData.interact = tray;
    const lampIt: Interactable = { kind: 'deskstuff', deskId: id, decorId: LAMP_SPOT, x: view.def.x, z: view.def.z, radius: 1 };
    spots.set(id, { root, config: emptyConfig(), items: new Map(), glow: 0, lampIt });
  }

  function set(deskId: string, config: DeskConfig) {
    const s = spots.get(deskId);
    if (!s) return;
    const wasOn = s.config.lampOn && s.items.has('lamp');
    for (const item of DESK_ITEMS) {
      const want = config.items.includes(item);
      const have = s.items.get(item);
      if (want && !have) {
        const built = buildItem(item);
        if (built.lamp) built.group.userData.interact = s.lampIt;
        s.root.add(built.group);
        s.items.set(item, built);
      } else if (!want && have) {
        s.root.remove(have.group);
        have.group.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        s.items.delete(item);
      }
    }
    s.config = { items: [...config.items], lampOn: config.lampOn && config.items.includes('lamp') };
    if (s.config.lampOn && !wasOn) lightOn = s;
    else if (!s.config.lampOn && lightOn === s) lightOn = null;
  }

  const handle: DeskStuff = {
    apply(floor) {
      for (const id of spots.keys()) set(id, floor[id] ?? emptyConfig());
    },
    set,
    get: (id) => spots.get(id)?.config ?? emptyConfig(),
  };

  const tmp = new THREE.Vector3();
  return {
    handle: { deskStuff: handle },
    update(_t, dt) {
      const k = 1 - Math.exp(-dt * 8);
      let any: Spot | null = null;
      for (const s of spots.values()) {
        const target = s.config.lampOn ? 1 : 0;
        if (s.glow !== target) {
          s.glow += (target - s.glow) * k;
          if (Math.abs(target - s.glow) < 0.01) s.glow = target;
          s.items.get('lamp')?.lamp?.setGlow(s.glow);
        }
        if (s.config.lampOn) any ??= s;
      }
      // The light sits on the lamp last switched on, or else on any that's lit.
      if (!lightOn || !lightOn.config.lampOn) lightOn = any;
      if (lightOn && lightOn.root.parent) {
        const lamp = lightOn.items.get('lamp')?.lamp;
        if (lamp) {
          lamp.group.localToWorld(tmp.copy(lamp.bulbAt));
          site.group.worldToLocal(tmp);
          light.position.copy(tmp);
        }
      }
      lightLevel += ((lightOn ? 0.35 : 0) - lightLevel) * k;
      if (!lightOn && lightLevel < 0.005) lightLevel = 0;
      light.intensity = lightLevel;
      light.visible = lightLevel > 0 || !!lightOn;
    },
  };
};
