import * as THREE from 'three';
import { HUMPS, ROUGH, bumpHeight, type Hump, type Rough } from '../../../shared/bumps';
import { mesh, toon } from '../toon';
import { G, type ScenicKit } from './kit';

// What the ground's bumps look like (see shared/bumps.ts, which says how high it is anywhere): low toon
// mounds on the meadow, ripples on the farm lane, mounds round the campsite, and yellow-and-black speed
// humps across the road. Each is a skin laid over the flat ground that follows the height there, built
// once in squares (so the merge and the haze culling see small pieces) and merged with the rest of the
// scenery by buildScenic. Nothing about them is sent anywhere: every page works the same heights out.

/** How far apart the skin's points are (m), and how big a square of it is. */
const STEP = 1;
const SQUARE = 30;

/** The lawn's color (see seasonal.ts, which tints the material it makes). */
const LAWN = '#a7d98b';
const STRIPE = ['#ffd166', '#2b2d42'] as const;

/**
 * A skin over [x0, x1] x [z0, z1] at height `bumpHeight` (plus `lift`, to sit over what's under it),
 * `step` meters between points, one geometry per color `colorOf` gives each little square. Squares
 * where the ground is flat aren't drawn.
 */
function skin(x0: number, x1: number, z0: number, z1: number, step: number, lift: number, colorOf: (x: number, z: number, h: number) => string): Map<string, THREE.BufferGeometry> {
  const nx = Math.max(1, Math.ceil((x1 - x0) / step));
  const nz = Math.max(1, Math.ceil((z1 - z0) / step));
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const sx = (x1 - x0) / nx;
  const sz = (z1 - z0) / nz;
  const h: number[] = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) h.push(bumpHeight(x0 + i * sx, z0 + j * sz));
  const at = (i: number, j: number) => h[j * (nx + 1) + i];
  const pos = new Map<string, number[]>();
  const vertex = (out: number[], i: number, j: number) => out.push(x0 + i * sx - cx, G + lift + at(i, j), z0 + j * sz - cz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const tall = Math.max(at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
      if (tall < 0.004) continue;
      const color = colorOf(x0 + (i + 0.5) * sx, z0 + (j + 0.5) * sz, tall);
      let out = pos.get(color);
      if (!out) pos.set(color, (out = []));
      // Two triangles, facing up.
      for (const [a, b] of [[i, j], [i, j + 1], [i + 1, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) vertex(out, a, b);
    }
  }
  const geos = new Map<string, THREE.BufferGeometry>();
  for (const [color, p] of pos) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.computeVertexNormals();
    geos.set(color, geo);
  }
  return geos;
}

/** Puts a skin's pieces in `into`, each a mesh at the middle of its square (so the scenery's merge sorts it into the right tile of the map). */
function lay(into: THREE.Group, geos: Map<string, THREE.BufferGeometry>, x: number, z: number) {
  for (const [color, geo] of geos) into.add(mesh(geo, toon(color), x, 0, z, false));
}

function rough(kit: ScenicKit, r: Rough) {
  // Made of the lawn's own material (not merged into the scenery's), so the seasons tint the mounds with the grass.
  const lawn = toon(LAWN);
  const x0 = r.x - r.rx;
  const z0 = r.z - r.rz;
  const nx = Math.ceil((r.rx * 2) / SQUARE);
  const nz = Math.ceil((r.rz * 2) / SQUARE);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const sx0 = x0 + (i * r.rx * 2) / nx;
      const sx1 = x0 + ((i + 1) * r.rx * 2) / nx;
      const sz0 = z0 + (j * r.rz * 2) / nz;
      const sz1 = z0 + ((j + 1) * r.rz * 2) / nz;
      for (const geo of skin(sx0, sx1, sz0, sz1, STEP, 0.01, () => 'lawn').values()) {
        const m = mesh(geo, lawn, (sx0 + sx1) / 2, 0, (sz0 + sz1) / 2, false);
        kit.root.add(m);
        kit.cullable(m, sx0, sx1, sz0, sz1, 2);
      }
    }
  }
}

function speedHump(into: THREE.Group, h: Hump) {
  const x0 = h.x - h.half;
  const x1 = h.x + h.half;
  const z0 = h.z - h.across - 0.6;
  const z1 = h.z + h.across + 0.6;
  // Bands across it, alternately yellow and black.
  const geos = skin(x0, x1, z0, z1, 0.32, 0.014, (x) => STRIPE[Math.floor((x - x0) / 0.38) % 2]);
  lay(into, geos, h.x, h.z);
}

/** Lays the bumps over the scenery (see shared/bumps.ts), into the meadow's group, which the scenery merges. */
export function buildBumps(kit: ScenicKit) {
  const into = kit.parts.meadow;
  for (const r of ROUGH) rough(kit, r);
  for (const h of HUMPS) speedHump(into, h);
}
