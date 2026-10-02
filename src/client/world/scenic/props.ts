import * as THREE from 'three';
import { CAMP, FARM, LAKE, LOOP, LOOP_HALF, VIEWPOINT } from '../../../shared/scenic';
import { mesh, toon } from '../toon';
import { grassy, hedge, type Flowers } from './blooms';
import { signpost } from './road';
import { G, beside, box, indexAt, type ScenicKit } from './kit';

// Things people made along the way, all small enough to drive through: signposts to the places off the
// road, picnic tables, benches and flower boxes along the street, and the farm's fences, hedgerows,
// sunflowers and scarecrow. Nothing here is solid.

const wood = '#a47148';

/** The nearest spot to (x, z) on the grass with room for `r`, looking in rings round it; null if there isn't one. */
function spotNear(kit: ScenicKit, x: number, z: number, r: number): { x: number; z: number } | null {
  for (let ring = 0; ring < 8; ring++) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + ring;
      const sx = x + Math.cos(a) * ring * 2.5;
      const sz = z + Math.sin(a) * ring * 2.5;
      if (grassy(kit, sx, sz, r)) return { x: sx, z: sz };
    }
  }
  return null;
}

function picnicTable(into: THREE.Group, x: number, z: number, turn: number) {
  const g = new THREE.Group();
  const plank = toon(wood);
  g.add(mesh(box(2.2, 0.1, 0.9), plank, 0, 0.8, 0));
  for (const s of [-1, 1]) {
    g.add(mesh(box(2.2, 0.1, 0.34), plank, 0, 0.46, s * 0.82));
    g.add(mesh(box(0.1, 0.8, 1.8), toon('#7f5539'), s * 0.8, 0.4, 0, false));
  }
  g.position.set(x, G, z);
  g.rotation.y = turn;
  into.add(g);
}

function bench(into: THREE.Group, x: number, z: number, turn: number) {
  const g = new THREE.Group();
  const slat = toon(wood);
  const iron = toon('#3d405b');
  g.add(mesh(box(1.8, 0.08, 0.5), slat, 0, 0.5, 0));
  g.add(mesh(box(1.8, 0.4, 0.07), slat, 0, 0.85, -0.25));
  for (const s of [-1, 1]) {
    g.add(mesh(box(0.07, 0.5, 0.5), iron, s * 0.8, 0.25, 0, false));
    g.add(mesh(box(0.07, 0.9, 0.07), iron, s * 0.8, 0.45, -0.25, false));
  }
  g.position.set(x, G, z);
  g.rotation.y = turn;
  into.add(g);
}

/** A wooden flower box, its flowers (colours `cols`) added to the wildflowers. */
function planter(into: THREE.Group, flowers: Flowers, x: number, z: number, cols: number[]) {
  const g = new THREE.Group();
  g.add(mesh(box(1.8, 0.5, 0.6), toon('#8d5b3b'), 0, 0.25, 0));
  g.add(mesh(box(1.6, 0.06, 0.45), toon('#4a3426'), 0, 0.5, 0, false));
  g.position.set(x, G, z);
  into.add(g);
  flowers.bed(x, z, 0.5, 13, cols, 1.6, 0, 0.5);
}

/** A split-rail fence from (x0, z0) to (x1, z1). */
function fence(into: THREE.Group, x0: number, z0: number, x1: number, z1: number) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 3));
  const rail = toon(wood);
  for (let k = 0; k <= n; k++) into.add(mesh(box(0.14, 1.1, 0.14), rail, x0 + ((x1 - x0) * k) / n, G + 0.55, z0 + ((z1 - z0) * k) / n, false));
  for (const y of [0.5, 0.9]) {
    const r = mesh(box(0.06, 0.1, len), rail, (x0 + x1) / 2, G + y, (z0 + z1) / 2, false);
    r.rotation.y = Math.atan2(x1 - x0, z1 - z0);
    into.add(r);
  }
}

function scarecrow(into: THREE.Group, x: number, z: number) {
  const g = new THREE.Group();
  const pole = toon('#6f4e37');
  g.add(mesh(box(0.1, 2.3, 0.1), pole, 0, 1.15, 0));
  g.add(mesh(box(1.7, 0.1, 0.1), pole, 0, 1.75, 0));
  g.add(mesh(box(0.55, 0.75, 0.3), toon('#c44536'), 0, 1.5, 0));
  g.add(mesh(new THREE.SphereGeometry(0.23, 8, 6), toon('#e9c46a'), 0, 2.1, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 10), toon('#5c4033'), 0, 2.3, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.32, 8), toon('#5c4033'), 0, 2.45, 0));
  g.position.set(x, G, z);
  g.rotation.y = 0.6;
  into.add(g);
}

export function buildProps(kit: ScenicKit, flowers: Flowers) {
  const { parts, labels, place, placed } = kit;
  // Signposts to the places off the road (and the start), standing on the side they're on, facing the traffic.
  const used: number[] = [];
  for (const [label, x, z] of [
    ['⛺ Campsite', CAMP.x, CAMP.z],
    ['🎣 Lake dock', LAKE.x - 6, LAKE.z - LAKE.rz - 1],
    ['🔭 Lookout', VIEWPOINT.x, VIEWPOINT.z],
  ] as const) {
    let near = 0;
    let best = Infinity;
    LOOP.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) [best, near] = [d, i];
    });
    // A little before the turn off (they drive clockwise), and not on top of another sign.
    let i = near - 14;
    while (used.some((u) => Math.abs(u - i) < 7)) i -= 7;
    used.push(i);
    const p = LOOP[Math.max(0, i)];
    const left = (x - p.x) * p.tz - (z - p.z) * p.tx > 0;
    const side = left ? 1 : -1;
    const at = beside(i, side * (LOOP_HALF + 3.6));
    const turn = Math.atan2(-p.tx, -p.tz) - 0.25 * side;
    signpost(parts.road, labels, at.x, at.z, turn, `${label} ${left ? '⬅' : '➡'} ${Math.round(best / 10) * 10} m`, 6);
    place(at.x, at.z, 2);
  }
  {
    const i = indexAt(60);
    const p = LOOP[i];
    const at = beside(i, LOOP_HALF + 3.6);
    signpost(parts.road, labels, at.x, at.z, Math.atan2(-p.tx, -p.tz) + 0.25, '🏁 Start / finish ⟳ 1.4 km', 6);
    place(at.x, at.z, 2);
  }

  // Picnic tables by the lake and a lay-by in the pines.
  for (const [x, z, turn] of [
    [106, 296, 0.4],
    [104, 318, 1.2],
    [44, 262, 0.2],
    [156, 130, 0.6],
  ]) {
    const s = spotNear(kit, x, z, 2.2);
    if (!s) continue;
    picnicTable(parts.meadow, s.x, s.z, turn);
    place(s.x, s.z, 2.2);
  }

  // The street: flower boxes along the far sidewalk, benches and beds on the grass behind them (the
  // trees, lamps, billboard and golf fairway keep clear), and flowers on the verges out toward the loop.
  const gaps = (x: number) => ![-40, -34, -22, -12, -4, 8, 14, 26, 36, 42].some((g) => Math.abs(g - x) < 1.6);
  for (const x of [-30, -17, 0, 19, 31, 49, -50]) {
    if (!gaps(x)) continue;
    planter(parts.road, flowers, x, 32.5, x % 2 ? [0, 1, 2] : [3, 5, 2]);
    placed.push({ x, z: 32.5, r: 1 });
  }
  for (const x of [-27, 6, 33]) bench(parts.road, x, 34.3, Math.PI);
  for (let x = -62; x <= 62; x += 7.5) {
    if (!gaps(x) || (x > -15 && x < 4) || (x > 17 && x < 31)) continue;
    const z = 35.5 + (x % 3);
    flowers.bed(x, z, 1.3, 14, [Math.abs(Math.round(x)) % 7, 1, 2], 2.2, 0);
    placed.push({ x, z, r: 2 });
  }
  for (let x = 66; x < 108; x += 6) {
    if (Math.abs(x - 96) < 3.5) continue;
    for (const s of [1, -1]) {
      flowers.bed(s * x, 19.2, 1.2, 10, [Math.round(x) % 7, 5], 2.4, 0);
      flowers.bed(s * x, 35.2, 1.2, 10, [(Math.round(x) + 3) % 7, 2], 2.4, 0);
      placed.push({ x: s * x, z: 19.2, r: 1.5 }, { x: s * x, z: 35.2, r: 1.5 });
    }
  }

  // The farm: fences along the fields next to the road, hedgerows behind them, rows of sunflowers, a scarecrow, and beds by the barn.
  const [wheat, crop] = FARM.fields;
  const f = parts.farm;
  fence(f, wheat.minX, wheat.minZ - 0.5, wheat.maxX, wheat.minZ - 0.5);
  fence(f, crop.minX, crop.maxZ + 0.5, crop.maxX, crop.maxZ + 0.5);
  hedge(f, wheat.minX, wheat.maxZ + 1.5, wheat.maxX, wheat.maxZ + 1.5);
  hedge(f, crop.minX, crop.minZ - 1.5, crop.maxX, crop.minZ - 1.5);
  hedge(f, wheat.maxX + 1.5, wheat.minZ, wheat.maxX + 1.5, wheat.maxZ);
  const stalk = toon('#52b788');
  const disc = new THREE.CylinderGeometry(0.4, 0.4, 0.07, 10);
  for (const z of [crop.minZ + 8, crop.minZ + 11]) {
    for (let x = crop.minX + 6; x < crop.minX + 56; x += 2.3) {
      f.add(mesh(box(0.09, 1.9, 0.09), stalk, x, G + 0.95, z, false));
      const head = mesh(disc, toon('#ffd166'), x, G + 1.95, z + 0.05, false);
      head.rotation.x = 1.2;
      f.add(head);
      const heart = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.09, 8), toon('#5c4033'), x, G + 1.93, z + 0.09, false);
      heart.rotation.x = 1.2;
      f.add(heart);
    }
  }
  scarecrow(f, (wheat.minX + wheat.maxX) / 2, (wheat.minZ + wheat.maxZ) / 2);
  const B = FARM.barn;
  flowers.bed(B.x - 5, B.z - 9.5, 1.5, 16, [0, 1, 3], 2.2, 0);
  flowers.bed(B.x + 5, B.z - 9.8, 1.5, 16, [5, 2, 4], 2.2, 0);
  placed.push({ x: B.x - 5, z: B.z - 9.5, r: 2 }, { x: B.x + 5, z: B.z - 9.8, r: 2 });
}
