/** The furniture of build mode, drawn from toon shapes: each piece stands on y = 0, centered, its front toward +z. */
import * as THREE from 'three';
import { mesh, roundedBox, toon } from '../../world/toon';
import { PIECES, type PieceKind } from './model';

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg);

const WOOD = '#b8814f';
const DARK_WOOD = '#8a5a34';

function chair(g: THREE.Group) {
  const seat = toon('#3b7dd8');
  g.add(mesh(roundedBox(0.5, 0.08, 0.5, 0.04), seat, 0, 0.46, 0));
  g.add(mesh(roundedBox(0.5, 0.5, 0.07, 0.03), seat, 0, 0.74, -0.215));
  for (const [x, z] of [[-0.21, -0.21], [0.21, -0.21], [-0.21, 0.21], [0.21, 0.21]]) g.add(mesh(cyl(0.025, 0.025, 0.42, 8), toon('#2b2d42'), x, 0.21, z));
}

function table(g: THREE.Group) {
  g.add(mesh(roundedBox(1.2, 0.07, 0.8, 0.04), toon(WOOD), 0, 0.715, 0));
  for (const [x, z] of [[-0.52, -0.32], [0.52, -0.32], [-0.52, 0.32], [0.52, 0.32]]) g.add(mesh(box(0.07, 0.68, 0.07), toon(DARK_WOOD), x, 0.34, z));
}

function sofa(g: THREE.Group) {
  const fabric = toon('#d8566a');
  const cushion = toon('#e57587');
  g.add(mesh(roundedBox(2, 0.4, 0.9, 0.08), fabric, 0, 0.3, 0));
  g.add(mesh(roundedBox(2, 0.55, 0.22, 0.08), fabric, 0, 0.58, -0.34));
  for (const x of [-0.8, 0.8]) g.add(mesh(roundedBox(0.2, 0.45, 0.9, 0.07), fabric, x, 0.52, 0));
  for (const x of [-0.36, 0.36]) g.add(mesh(roundedBox(0.66, 0.14, 0.56, 0.06), cushion, x, 0.54, 0.1));
}

function plant(g: THREE.Group) {
  g.add(mesh(cyl(0.2, 0.15, 0.36), toon('#c4623a'), 0, 0.18, 0));
  g.add(mesh(cyl(0.18, 0.18, 0.03), toon('#4a3322'), 0, 0.35, 0));
  const leaf = toon('#3fae5a');
  const dark = toon('#2f8a47');
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const l = mesh(new THREE.SphereGeometry(0.17, 10, 8), i % 2 ? leaf : dark, Math.cos(a) * 0.14, 0.62 + (i % 3) * 0.17, Math.sin(a) * 0.14);
    l.scale.set(1, 1.5, 1);
    g.add(l);
  }
  g.add(mesh(new THREE.SphereGeometry(0.2, 10, 8), leaf, 0, 1.12, 0));
}

function bookshelf(g: THREE.Group) {
  const wood = toon(WOOD);
  g.add(mesh(box(1.2, 2, 0.04), toon(DARK_WOOD), 0, 1, -0.18));
  for (const x of [-0.58, 0.58]) g.add(mesh(box(0.04, 2, 0.4), wood, x, 1, 0));
  const colors = ['#d8566a', '#3b7dd8', '#f2b84b', '#3fae5a', '#8e63ce'];
  for (let s = 0; s < 5; s++) {
    g.add(mesh(box(1.2, 0.04, 0.4), wood, 0, 0.02 + s * 0.495, 0));
    if (s === 4) break;
    let x = -0.5;
    for (let i = 0; i < 8 && x < 0.5; i++) {
      const w = 0.07 + ((i * 7 + s * 3) % 4) * 0.015;
      const hgt = 0.28 + ((i * 5 + s * 2) % 4) * 0.04;
      g.add(mesh(box(w, hgt, 0.26), toon(colors[(i + s) % colors.length]), x + w / 2, 0.04 + s * 0.495 + hgt / 2, 0.02, false));
      x += w + 0.012;
    }
  }
  g.add(mesh(box(1.2, 0.04, 0.4), wood, 0, 1.98, 0));
}

function rug(g: THREE.Group) {
  g.add(mesh(box(2, 0.02, 1.4), toon('#2f6f9f'), 0, 0.01, 0, false));
  g.add(mesh(box(1.7, 0.024, 1.1), toon('#f2e3b8'), 0, 0.012, 0, false));
  g.add(mesh(box(1.4, 0.028, 0.8), toon('#d8566a'), 0, 0.014, 0, false));
}

function lamp(g: THREE.Group) {
  g.add(mesh(cyl(0.17, 0.19, 0.04), toon('#2b2d42'), 0, 0.02, 0));
  g.add(mesh(cyl(0.02, 0.02, 1.35, 8), toon('#2b2d42'), 0, 0.7, 0));
  g.add(mesh(cyl(0.12, 0.2, 0.3), toon('#fff3c2', { emissive: '#7a6a2a' }), 0, 1.55, 0, false));
}

function whiteboard(g: THREE.Group) {
  const frame = toon('#c9ccd6');
  g.add(mesh(box(1.2, 0.9, 0.04), frame, 0, 1.3, 0));
  g.add(mesh(box(1.1, 0.8, 0.045), toon('#ffffff'), 0, 1.3, 0.005));
  for (const x of [-0.5, 0.5]) {
    g.add(mesh(box(0.05, 1.55, 0.05), frame, x, 0.78, -0.03));
    g.add(mesh(box(0.05, 0.05, 0.5), frame, x, 0.03, 0));
  }
  g.add(mesh(box(1, 0.03, 0.08), frame, 0, 0.87, 0.04));
  // a doodle, in the toon style
  g.add(mesh(box(0.5, 0.025, 0.01), toon('#d8566a'), -0.15, 1.45, 0.03, false));
  g.add(mesh(box(0.7, 0.025, 0.01), toon('#3b7dd8'), -0.05, 1.3, 0.03, false));
  g.add(mesh(box(0.35, 0.025, 0.01), toon('#3fae5a'), -0.2, 1.15, 0.03, false));
}

const BUILD: Record<PieceKind, (g: THREE.Group) => void> = { chair, table, sofa, plant, bookshelf, rug, lamp, whiteboard };

/** A piece of `kind`, standing on y = 0 with its front toward +z. */
export function buildPiece(kind: PieceKind): THREE.Group {
  const g = new THREE.Group();
  BUILD[kind](g);
  return g;
}

/** The same piece with every surface the ghost's color, see-through: green where it can go, red where it can't. */
export function buildGhost(kind: PieceKind): THREE.Group {
  const g = buildPiece(kind);
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.castShadow = m.receiveShadow = false;
  });
  return g;
}

const GOOD = () => toon('#59d37a', { opacity: 0.55 });
const BAD = () => toon('#e5484d', { opacity: 0.55 });

/** Paints a ghost green (`ok`) or red. */
export function tintGhost(g: THREE.Object3D, ok: boolean) {
  const mat = ok ? GOOD() : BAD();
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material !== mat) m.material = mat;
  });
}

/** How tall a piece's box is, for the outline round the one you aim at. */
export const heightOf = (kind: PieceKind): number => Math.max(PIECES[kind].h, 0.1);
