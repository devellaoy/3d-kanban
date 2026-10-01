import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../../shared/rng';
import { LAKE } from '../../../shared/scenic';
import { mergeByColor, mesh, toon, toonUnique } from '../toon';
import { grassy } from './blooms';
import { G, box, type ScenicKit } from './kit';
import { onSeason } from './seasonal';

// What lives along the loop: cows and sheep grazing and strolling about, birds circling high up,
// butterflies over the meadows and boats on the lake. Each herd, flock or swarm is one InstancedMesh
// (one draw call, drawn only while you're near it), moved in `update` with matrices alone.

const bx = (w: number, h: number, d: number, x: number, y: number, z: number) => box(w, h, d).translate(x, y, z);

/** One geometry out of coloured parts (the colours kept in its vertices). */
function painted(parts: [THREE.BufferGeometry, string][]): THREE.BufferGeometry {
  const geos = parts.map(([g, c]) => {
    const n = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    const col = new THREE.Color(c);
    const arr = new Float32Array(n.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) arr.set([col.r, col.g, col.b], i);
    n.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return n;
  });
  return mergeGeometries(geos)!;
}

const animalMat = () => new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });

/** A cow, nose along +z. */
function cowGeometry() {
  const legs: [THREE.BufferGeometry, string][] = [[0.35, 0.7], [-0.35, 0.7], [0.35, -0.7], [-0.35, -0.7]].map(([x, z]) => [bx(0.2, 0.75, 0.2, x, 0.37, z), '#f8f9fa']);
  return painted([
    [bx(1.0, 0.85, 1.9, 0, 1.15, 0), '#f8f9fa'],
    [bx(1.02, 0.5, 0.6, 0, 1.25, 0.25), '#22223b'],
    [bx(0.6, 0.4, 0.5, 0.22, 1.35, -0.55), '#22223b'],
    [bx(0.55, 0.55, 0.65, 0, 1.2, 1.3), '#f8f9fa'],
    [bx(0.5, 0.3, 0.2, 0, 1.08, 1.67), '#ffb4a2'],
    [bx(0.08, 0.2, 0.08, -0.2, 1.6, 1.2), '#fefae0'],
    [bx(0.08, 0.2, 0.08, 0.2, 1.6, 1.2), '#fefae0'],
    [bx(0.08, 0.7, 0.08, 0, 1.0, -1.0), '#22223b'],
    ...legs,
  ]);
}

/** A sheep, nose along +z. */
function sheepGeometry() {
  const wool = '#f4f1e6';
  const dark = '#3d3b45';
  const legs: [THREE.BufferGeometry, string][] = [[0.22, 0.38], [-0.22, 0.38], [0.22, -0.38], [-0.22, -0.38]].map(([x, z]) => [bx(0.11, 0.5, 0.11, x, 0.25, z), dark]);
  return painted([
    [new THREE.IcosahedronGeometry(0.55, 1).scale(1, 0.85, 1.3).translate(0, 0.72, 0), wool],
    [new THREE.IcosahedronGeometry(0.34, 0).translate(0, 0.98, 0.4), wool],
    [bx(0.28, 0.3, 0.38, 0, 0.88, 0.82), dark],
    [bx(0.08, 0.14, 0.2, -0.17, 0.96, 0.76), dark],
    [bx(0.08, 0.14, 0.2, 0.17, 0.96, 0.76), dark],
    ...legs,
  ]);
}

/** A pair of wings in a V, flapped by scaling the whole thing up and down. */
function wingsGeometry(span: number, chord: number, lift: number) {
  const v = new Float32Array([0, 0, chord, 0, 0, -chord, -span, lift, 0, 0, 0, chord, 0, 0, -chord, span, lift, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export interface Critters {
  update(t: number): void;
}

interface Beast {
  x: number;
  z: number;
  rot: number;
  phase: number;
}

export function buildCritters(kit: ScenicKit): Critters {
  const { root, around, herd } = kit;
  const rand = mulberry32(8675);
  const tickers: ((t: number) => void)[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qp = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(1, 0, 0);
  const at = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, 1);

  /** A herd or flock strolling about in tiny circles with their heads down, every now and then. */
  const graze = (geo: THREE.BufferGeometry, beasts: Beast[], scale: number, radius: number) => {
    const im = new THREE.InstancedMesh(geo, animalMat(), beasts.length);
    im.castShadow = true;
    im.frustumCulled = false;
    im.userData.life = true;
    root.add(im);
    const cx = beasts.reduce((s, b) => s + b.x, 0) / beasts.length;
    const cz = beasts.reduce((s, b) => s + b.z, 0) / beasts.length;
    const spread = Math.max(...beasts.map((b) => Math.hypot(b.x - cx, b.z - cz))) + radius + 4;
    around(im, cx, cz, spread, 3, 170);
    const sc = new THREE.Vector3(scale, scale, scale);
    tickers.push((t) => {
      if (!im.visible) return; // out of sight (see Scenic.cull): not moved
      beasts.forEach((b, i) => {
        // Round and round a little circle, slowly, and a nod now and then (heads down to the grass).
        const w = (i % 2 ? 0.09 : -0.07) * t + b.phase;
        const nod = Math.max(0, Math.sin(t * 0.35 + b.phase * 3)) ** 2;
        at.set(b.x + Math.cos(w) * radius, G + Math.sin(t * 1.1 + b.phase) * 0.012, b.z + Math.sin(w) * radius);
        const dir = i % 2 ? 1 : -1;
        q.setFromAxisAngle(up, Math.atan2(-Math.sin(w) * dir, Math.cos(w) * dir));
        qp.setFromAxisAngle(right, nod * 0.2);
        im.setMatrixAt(i, m4.compose(at, q.multiply(qp), sc));
      });
      im.instanceMatrix.needsUpdate = true;
    });
  };

  // The cows in the farm's pasture, and another herd on the western meadow.
  const cow = cowGeometry();
  graze(cow, herd.map((h, k) => ({ x: h.x, z: h.z, rot: h.rot, phase: h.rot + k })), 1, 1.1);
  const spots = (cx: number, cz: number, n: number, spread: number, r: number): Beast[] => {
    const out: Beast[] = [];
    for (let tries = 0; tries < 60 && out.length < n; tries++) {
      const x = cx + (rand() - 0.5) * 2 * spread;
      const z = cz + (rand() - 0.5) * 2 * spread;
      if (!grassy(kit, x, z, r) || out.some((o) => Math.hypot(o.x - x, o.z - z) < 3.2)) continue;
      out.push({ x, z, rot: 0, phase: rand() * 6 });
      kit.place(x, z, r);
    }
    return out;
  };
  const west = spots(-105, 130, 5, 14, 2.2);
  if (west.length) graze(cow, west, 1, 1.3);
  // Sheep, in three flocks.
  const sheep = sheepGeometry();
  for (const [x, z, n] of [
    [136, 140, 7],
    [92, 238, 6],
    [-150, 205, 7],
  ]) {
    const flock = spots(x, z, n, 11, 1.6);
    if (flock.length) graze(sheep, flock, 1.15, 0.9);
  }

  // Birds circling: crows over the pines and the farm, gulls over the lake and the coast.
  const birdMat = (color: string) => {
    const m = toonUnique(color);
    m.side = THREE.DoubleSide;
    m.userData.outlineParameters = { visible: false };
    return m;
  };
  const birds = wingsGeometry(0.9, 0.22, 0.28);
  for (const [cx, cz, ring, height, n, color] of [
    [150, 60, 38, 30, 5, '#2b2d42'],
    [185, 160, 48, 38, 6, '#3d405b'],
    [LAKE.x, LAKE.z, 30, 26, 5, '#f8f9fa'],
    [-215, 70, 44, 30, 7, '#f8f9fa'],
  ] as const) {
    const im = new THREE.InstancedMesh(birds, birdMat(color), n);
    im.frustumCulled = false;
    im.userData.life = true;
    root.add(im);
    around(im, cx, cz, ring + 8, height, 380);
    const sc = new THREE.Vector3();
    const phase = Array.from({ length: n }, () => rand() * 6.28);
    tickers.push((t) => {
      if (!im.visible) return;
      for (let i = 0; i < n; i++) {
        const w = t * (0.16 + (i % 3) * 0.012) + phase[i];
        const r = ring * (0.75 + 0.25 * Math.sin(phase[i] * 3));
        at.set(cx + Math.cos(w) * r, G + height + Math.sin(t * 0.5 + phase[i] * 2) * 2.5, cz + Math.sin(w) * r);
        // Banking into the turn, and the wings beating (the V flattening and flipping).
        q.setFromAxisAngle(up, Math.atan2(-Math.sin(w), Math.cos(w)));
        qp.setFromAxisAngle(forward, -0.25);
        const flap = Math.sin(t * 5 + phase[i] * 4);
        im.setMatrixAt(i, m4.compose(at, q.multiply(qp), sc.set(1.5, 1.5 * (0.15 + flap * 0.85), 1.5)));
      }
      im.instanceMatrix.needsUpdate = true;
    });
  }

  // Butterflies over the meadows (not in winter), in colours of their own.
  const flies = new Array<THREE.InstancedMesh>();
  const wings = wingsGeometry(0.2, 0.14, 0.05);
  const fly = new THREE.MeshToonMaterial({ gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap, side: THREE.DoubleSide });
  fly.userData.outlineParameters = { visible: false };
  const colors = ['#ffd166', '#ff9f1c', '#f8f9fa', '#9b5de5', '#4cc9f0', '#ef476f'];
  for (const [cx, cz] of [
    [120, 215],
    [20, 270],
    [-150, 160],
    [215, 70],
    [-120, 70],
  ]) {
    const n = 7;
    const im = new THREE.InstancedMesh(wings, fly, n);
    im.frustumCulled = false;
    im.userData.life = true;
    for (let i = 0; i < n; i++) im.setColorAt(i, new THREE.Color(colors[Math.floor(rand() * colors.length)]));
    root.add(im);
    flies.push(im);
    around(im, cx, cz, 14, 3, 110);
    const seed = Array.from({ length: n }, () => [rand() * 6.28, 0.25 + rand() * 0.3, 4 + rand() * 5] as const);
    const sc = new THREE.Vector3();
    tickers.push((t) => {
      if (!im.visible) return;
      for (let i = 0; i < n; i++) {
        const [p, speed, r] = seed[i];
        const a = t * speed + p;
        at.set(cx + Math.cos(a) * r + Math.sin(a * 2.3) * 1.5, G + 1.0 + Math.sin(a * 1.7) * 0.5 + Math.sin(t * 2 + p) * 0.2, cz + Math.sin(a * 1.3) * r);
        q.setFromAxisAngle(up, a * 1.3 + Math.PI / 2);
        im.setMatrixAt(i, m4.compose(at, q, sc.set(1.3, 1.3 * Math.sin(t * 14 + p * 5), 1.3)));
      }
      im.instanceMatrix.needsUpdate = true;
    });
  }
  onSeason((season) => flies.forEach((f) => (f.visible = season !== 'winter')));

  // Boats on the lake: two rowing boats and a little sailboat, drifting slowly about.
  const boats: { g: THREE.Object3D; cx: number; cz: number; rx: number; rz: number; phase: number }[] = [];
  const rowboat = (color: string) => {
    const g = new THREE.Group();
    g.add(mesh(box(1.2, 0.45, 3.0), toon(color), 0, 0.2, 0));
    g.add(mesh(new THREE.ConeGeometry(0.85, 1.3, 4).rotateX(Math.PI / 2).rotateY(Math.PI / 4).scale(0.7, 0.35, 1), toon(color), 0, 0.2, 2.0));
    g.add(mesh(box(1.0, 0.1, 2.8), toon('#d4a373'), 0, 0.42, 0));
    g.add(mesh(box(1.1, 0.08, 0.35), toon('#8b5e34'), 0, 0.55, 0.3));
    for (const s of [-1, 1]) {
      const oar = mesh(box(0.07, 0.05, 1.8), toon('#6f4e37'), s * 0.85, 0.62, 0.3);
      oar.rotation.y = s * 0.5;
      g.add(oar);
    }
    return g;
  };
  const sailboat = () => {
    const g = rowboat('#fefae0');
    g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), toon('#6f4e37'), 0, 2.2, 0.6));
    const sail = new THREE.Shape();
    sail.moveTo(0, 0);
    sail.lineTo(0, 3.4);
    sail.lineTo(1.6, 0);
    sail.closePath();
    const s = mesh(new THREE.ShapeGeometry(sail), toon('#ef476f'), 0, 0.9, 0.6);
    s.rotation.y = Math.PI / 2;
    g.add(s);
    return g;
  };
  for (const [dx, dz, make, rx, rz] of [
    [16, 4, () => rowboat('#e63946'), 5, 3],
    [-17, 6, () => rowboat('#118ab2'), 4, 4],
    [3, 3, sailboat, 9, 5],
  ] as const) {
    const g = mergeByColor(make());
    g.userData.life = true;
    root.add(g);
    around(g, LAKE.x + dx, LAKE.z + dz, Math.max(rx, rz) + 5, 6);
    boats.push({ g, cx: LAKE.x + dx, cz: LAKE.z + dz, rx, rz, phase: rand() * 6 });
  }
  tickers.push((t) => {
    for (const b of boats) {
      if (!b.g.visible) continue;
      const a = t * 0.07 + b.phase;
      b.g.position.set(b.cx + Math.cos(a) * b.rx, G - 0.16 + Math.sin(t * 1.4 + b.phase) * 0.06, b.cz + Math.sin(a) * b.rz);
      b.g.rotation.set(Math.sin(t * 1.1 + b.phase) * 0.04, Math.atan2(-Math.sin(a) * b.rx, Math.cos(a) * b.rz), Math.sin(t * 0.9 + b.phase) * 0.05, 'YXZ');
    }
  });

  return { update: (t) => tickers.forEach((f) => f(t)) };
}
