import * as THREE from 'three';
import { FLOOR, SLAB, WALL_HEIGHT, WALL_T } from '../../shared/layout';
import type { Collider } from './types';
import type { Fixture } from './office/fixture';
import { mesh, toon } from './toon';

// The floors above and below this one: the floor, the slab under it and the ceiling over it. Every floor
// is built from the same office, so the building looks the same from any of them; you get from one floor
// to another by the elevator or the floor list.

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * A flat surface, facing up (the floor, flip -1) or down (the ceiling, flip 1).
 * Its uvs span `uv` once, like a PlaneGeometry that size would.
 */
function surface(outline: [number, number][], flip: 1 | -1, uv?: Rect): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, flip * z)));
  const geo = new THREE.ShapeGeometry(shape, 24);
  if (uv) {
    const pos = geo.getAttribute('position');
    const uvs = geo.getAttribute('uv');
    const w = uv.maxX - uv.minX;
    const d = uv.maxZ - uv.minZ;
    for (let i = 0; i < pos.count; i++) uvs.setXY(i, (pos.getX(i) - uv.minX) / w, (uv.maxZ - flip * pos.getY(i)) / d);
  }
  geo.rotateX(flip * (Math.PI / 2));
  return geo;
}

function rectOutline(r: Rect): [number, number][] {
  return [
    [r.minX, r.minZ],
    [r.maxX, r.minZ],
    [r.maxX, r.maxZ],
    [r.minX, r.maxZ],
  ];
}

/** Ceiling tiles: a light grid, one tile per repeat. */
function tileTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf7ef';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#e3dccf';
  g.fillRect(0, 0, 128, 5);
  g.fillRect(0, 0, 5, 128);
  // A few speckles, like the mineral fibre in real tiles.
  g.fillStyle = '#efe8dc';
  for (let i = 0; i < 40; i++) g.fillRect(8 + ((i * 53) % 116), 8 + ((i * 97) % 116), 3, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 1.2, 1 / 1.2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface StackState {
  /** Which floor of the building you're on (0 is the bottom one), and how many there are. */
  index: number;
  count: number;
}

export interface Stack {
  group: THREE.Group;
  /** The ceiling's tiles, for the back office's ceiling to match (its uvs are meters, like a ShapeGeometry's). */
  ceiling: THREE.Material;
  /** The floor you're on. */
  set(s: StackState): void;
  state: StackState;
}

/**
 * The floor you walk on (planks from `planks`), the slab under it and the ceiling over it. Their
 * colliders go in `colliders`.
 */
export function buildStack(colliders: Collider[], planks: THREE.Material): Stack {
  const group = new THREE.Group();
  const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T };
  const concrete = toon('#d3d6dd');
  const band = toon('#e8a87c');
  // Big flat surfaces get no cartoon outline, as the floor never has.
  planks.userData.outlineParameters = { visible: false };
  const tiles = toon('#ffffff').clone();
  tiles.userData.outlineParameters = { visible: false };
  tiles.map = tileTexture();
  // Lit from below by the room's lamps, not left in the shade the sun would give it.
  tiles.emissive = new THREE.Color('#6a655d');
  tiles.emissiveMap = tiles.map;
  const ceilingMat = tiles;
  const state: StackState = { index: 0, count: 1 };

  // The floor: planks.
  const floor = new THREE.Mesh(surface(rectOutline(FLOOR), -1, FLOOR), planks);
  floor.receiveShadow = true;
  group.add(floor);

  // The slab under it (the garage's ceiling): concrete underneath, a peach band between the floors outside.
  const slabShape = new THREE.Shape(rectOutline(B).map(([x, z]) => new THREE.Vector2(x, -z)));
  const slabGeo = new THREE.ExtrudeGeometry(slabShape, { depth: SLAB - 0.01, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2).translate(0, -SLAB, 0);
  // Its top and bottom are concrete (group 0); its edges are the band.
  const slab = mesh(slabGeo, concrete);
  slab.material = [concrete, band];
  group.add(slab);
  // What you walk on: the whole building's floor, and the slab under it.
  colliders.push({ ...B, bottom: -SLAB, top: 0 });

  // The ceiling: tiles, WALL_HEIGHT up.
  const ceiling = mesh(surface(rectOutline(FLOOR), 1), ceilingMat, 0, WALL_HEIGHT, 0, false);
  ceiling.receiveShadow = false;
  group.add(ceiling);
  colliders.push({ ...FLOOR, bottom: WALL_HEIGHT, top: WALL_HEIGHT + SLAB });

  return {
    group,
    ceiling: ceilingMat,
    set: (s) => {
      Object.assign(state, s);
    },
    state,
  };
}

declare module './types' {
  interface OfficeHandles {
    /** The ceiling and the floor between the floors of the building. */
    stack: Stack;
  }
}

/** The office floor's floor and ceiling. */
export const stack: Fixture<'stack'> = (site) => {
  const built = buildStack(site.colliders, site.planks);
  built.set({ index: 0, count: 1 });
  return { group: built.group, handle: { stack: built } };
};
