import * as THREE from 'three';
import { bumpHeight } from '../../../shared/bumps';
import { mulberry32 } from '../../../shared/rng';
import { FOOTHILLS, LAKE, LOOP, LOOP_PAVED, MOUNTAINS, TUNNEL, shoreX } from '../../../shared/scenic';
import { neighbourBoxes } from '../outside';
import { toonUnique, mesh } from '../toon';
import { LEAVES, PINES, boulder, foliage } from './flora';
import { G, beside, box, inBox, nearest, type ScenicKit } from './kit';
import { onSeason } from './seasonal';

// What makes the loop colourful: wildflowers in meadows and along the verges (in a few colours, each
// map square's worth one draw call, gone in winter), bushes and hedges in the trees' seasonal greens,
// and rocks. Nothing here is solid: you drive through flowers and grass. It's laid out from a random
// sequence of its own, so the trees (kit.rand) stay where they were.

/** The wildflowers' colours, from the office's own palette. */
export const BLOOM = ['#ef476f', '#ffd166', '#f8f9fa', '#9b5de5', '#4cc9f0', '#ff9f1c', '#f78c6b'];

const CELL = 300;

/** Wildflowers: collected as they're laid out, then made into one InstancedMesh per square of the map (see finish). */
export class Flowers {
  private list: { x: number; y: number; z: number; s: number; c: number; turn: number }[] = [];
  constructor(private rand: () => number) {}
  get count() {
    return this.list.length;
  }
  /** One flower, `c` an index into BLOOM, standing at height `y` over the street's level (a planter's soil). */
  add(x: number, z: number, s: number, c: number, y = 0) {
    this.list.push({ x, y, z, s, c, turn: this.rand() * 6 });
  }
  /** A bed `r` round (x, z) (a long one, `stretch` times as long as wide, turned `turn`), `n` flowers of the colours in `cols`. */
  bed(x: number, z: number, r: number, n: number, cols: number[], stretch = 1, turn = 0, y = 0) {
    const { rand } = this;
    for (let k = 0; k < n; k++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * r;
      const lx = Math.cos(a) * d * stretch;
      const lz = Math.sin(a) * d;
      this.add(x + lx * Math.cos(turn) + lz * Math.sin(turn), z - lx * Math.sin(turn) + lz * Math.cos(turn), 0.8 + rand() * 0.8, cols[rand() < 0.72 ? 0 : Math.floor(rand() * cols.length)], y);
    }
  }
  /** Makes the meshes: into `root`, each square of the map drawn only when it's near (see ScenicKit.cullable), all of them gone in winter. */
  finish(kit: ScenicKit) {
    const geo = new THREE.OctahedronGeometry(0.11, 0).scale(1, 0.8, 1).translate(0, 0.36, 0);
    const stemGeo = new THREE.CylinderGeometry(0.014, 0.018, 0.34, 3, 1, true).translate(0, 0.17, 0);
    const stemMat = toonUnique('#52b788');
    stemMat.userData.outlineParameters = { visible: false };
    const mat = toonUnique('#ffffff');
    mat.userData.outlineParameters = { visible: false };
    const cells = new Map<string, typeof this.list>();
    for (const f of this.list) {
      const key = `${Math.floor(f.x / CELL)},${Math.floor(f.z / CELL)}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = []));
      c.push(f);
    }
    const meshes: THREE.InstancedMesh[] = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [key, fs] of cells) {
      const [cx, cz] = key.split(',').map(Number);
      const im = new THREE.InstancedMesh(geo, mat, fs.length);
      fs.forEach((f, i) => {
        q.setFromAxisAngle(up, f.turn);
        im.setMatrixAt(i, m4.compose(new THREE.Vector3(f.x, G + f.y, f.z), q, new THREE.Vector3(f.s, f.s, f.s)));
        im.setColorAt(i, new THREE.Color(BLOOM[f.c % BLOOM.length]));
      });
      im.computeBoundingSphere();
      const g = new THREE.Group();
      const stems = new THREE.InstancedMesh(stemGeo, stemMat, fs.length);
      stems.instanceMatrix = im.instanceMatrix;
      stems.computeBoundingSphere();
      im.userData.life = stems.userData.life = true;
      g.add(im, stems);
      kit.root.add(g);
      kit.cullable(g, cx * CELL - 5, (cx + 1) * CELL + 5, cz * CELL - 5, (cz + 1) * CELL + 5, 4, 200);
      meshes.push(im, stems);
    }
    // No flowers under the snow.
    onSeason((season) => meshes.forEach((m) => (m.visible = season !== 'winter')));
  }
}

/** The part of the loop (see Stretch) the ground at (x, z) is in, for putting what stands there into the right square. */
export function partAt(kit: ScenicKit, x: number, z: number): THREE.Group {
  const { parts } = kit;
  switch (nearest(x, z).place) {
    case 'forest':
      return parts.forest;
    case 'mountains':
    case 'tunnel':
      return parts.mountains;
    case 'beach':
    case 'coast':
      return parts.coast;
    case 'farm':
      return parts.farm;
    default:
      return parts.meadow;
  }
}

const NEIGHBOURS = neighbourBoxes();

/** Whether (x, z) is somewhere flat and grassy to put things: not the town, the water, the hills or the sand. */
export function grassy(kit: ScenicKit, x: number, z: number, r: number): boolean {

  if ((Math.abs(x) < 66 && z > -66 && z < 76) || NEIGHBOURS.some((b) => inBox(b, x, z, 6))) return false;
  if (x < shoreX(z) + 34 || z > 345 || z < -230 || x > 330) return false;
  if (Math.hypot((x - LAKE.x) / (LAKE.rx + 8), (z - LAKE.z) / (LAKE.rz + 8)) < 1) return false;
  if (MOUNTAINS.some(([mx, mz, mr]) => Math.hypot(mx - x, mz - z) < mr * 1.1)) return false;
  if (FOOTHILLS.some(([hx, hz, hr]) => Math.hypot(hx - x, hz - z) < hr * 1.2 + r)) return false;
  if (z > TUNNEL.z - 45 && x > TUNNEL.x1 - 30 && x < TUNNEL.x0 + 30) return false;
  return kit.free(x, z, r);
}

/** A bush: a squashed, faceted blob in the trees' own greens (so the seasons recolour it). */
function bush(into: THREE.Group, x: number, z: number, s: number, shade: number, evergreen: boolean) {
  const color = evergreen ? PINES[shade % PINES.length] : LEAVES[shade % LEAVES.length];
  const g = new THREE.Group();
  const leaf = foliage(color);
  for (const [dx, dz, k] of [
    [0, 0, 1],
    [0.7, 0.3, 0.7],
    [-0.5, 0.45, 0.62],
  ])
    g.add(mesh(new THREE.IcosahedronGeometry(0.7 * k, 0).scale(1, 0.78, 1), leaf, dx * s, 0.4 * k * s, dz * s, false));
  g.position.set(x, G, z);
  g.scale.setScalar(s);
  g.rotation.y = x;
  into.add(g);
}

/** A trimmed hedge from (x0, z0) to (x1, z1), in evergreen. */
export function hedge(into: THREE.Group, x0: number, z0: number, x1: number, z1: number) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 2.4));
  const leaf = foliage(PINES[0]);
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    const m = mesh(box(len / n + 0.15, 1.1, 1.0), leaf, x0 + (x1 - x0) * t, G + 0.55, z0 + (z1 - z0) * t, false);
    m.rotation.y = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
    into.add(m);
  }
}

/** Lays out the wildflowers, bushes and rocks. Returns the flowers, for the props to add their own beds to (see props.ts). */
export function buildBlooms(kit: ScenicKit): Flowers {
  const rand = mulberry32(5150);
  const flowers = new Flowers(rand);
  const { place, placed } = kit;
  const rocks = ['#9d99a8', '#8d8a99', '#b5a898', '#a8a5b3'];
  const pick = (n: number) => Math.floor(rand() * n);

  // Meadows full of wildflowers, in patches of a couple of colours.
  let patches = 0;
  for (let tries = 0; tries < 2200 && patches < 260; tries++) {
    const x = -250 + rand() * 580;
    const z = -220 + rand() * 560;
    const r = 3 + rand() * 6;
    if (!grassy(kit, x, z, r)) continue;
    patches++;
    const a = pick(BLOOM.length);
    flowers.bed(x, z, r, Math.round(r * r * 1.5), [a, (a + 1 + pick(BLOOM.length - 1)) % BLOOM.length, 2], 1 + rand() * 0.8, rand() * 3);
    placed.push({ x, z, r });
    if (rand() < 0.35 && kit.free(x + r + 1.2, z, 1)) {
      bush(kit.parts.meadow, x + r + 1.2, z, 0.9 + rand() * 0.5, pick(2), false);
      place(x + r + 1.2, z, 1);
    }
  }

  // Flowers, bushes and the odd rock along both verges of the loop.
  for (let i = 4; i < LOOP.length - 4; i += 3 + pick(3)) {
    const p = LOOP[i];
    if (p.place === 'tunnel') continue;
    const side = rand() < 0.5 ? 1 : -1;
    const off = LOOP_PAVED + 1.8 + rand() * 3.5;
    const at = beside(i, side * off);
    if (!kit.free(at.x, at.z, 1.3) || at.x < shoreX(at.z) + 34) continue;
    const roll = rand();
    if (roll < 0.75) {
      const a = pick(BLOOM.length);
      flowers.bed(at.x, at.z, 1.3 + rand() * 1.4, 12 + pick(14), [a, (a + 2) % BLOOM.length], 1.6 + rand(), Math.atan2(p.tx, p.tz) + Math.PI / 2);
      placed.push({ x: at.x, z: at.z, r: 1.3 });
    } else if (roll < 0.86) {
      const b = beside(i, side * (off + 2 + rand() * 4));
      if (!kit.free(b.x, b.z, 1.4)) continue;
      bush(partAt(kit, b.x, b.z), b.x, b.z, 0.9 + rand() * 0.7, pick(2), rand() < 0.5);
      place(b.x, b.z, 1.2);
    } else {
      const b = beside(i, side * (off + 1 + rand() * 4));
      if (!kit.free(b.x, b.z, 1)) continue;
      const n = 1 + pick(3);
      for (let k = 0; k < n; k++) boulder(partAt(kit, b.x, b.z), b.x + k * 0.9, b.z + (k % 2) * 0.7, 0.3 + rand() * 0.5, rand() * 6, rocks[pick(rocks.length)]);
      place(b.x, b.z, 1.4);
    }
  }

  // Bushes and rocks scattered through the meadows.
  for (let tries = 0, n = 0; tries < 600 && n < 60; tries++) {
    const x = -240 + rand() * 560;
    const z = -200 + rand() * 540;
    if (!grassy(kit, x, z, 1.6)) continue;
    n++;
    if (rand() < 0.55) {
      bush(partAt(kit, x, z), x, z, 0.9 + rand() * 0.8, pick(2), rand() < 0.35);
      place(x, z, 1.3);
    } else {
      const part = partAt(kit, x, z);
      for (let k = 0, m = 2 + pick(3); k < m; k++) boulder(part, x + rand() * 2.4, z + rand() * 2.4, 0.4 + rand() * 0.9, rand() * 6, rocks[pick(rocks.length)]);
      place(x, z, 2);
    }
  }
  return flowers;
}
