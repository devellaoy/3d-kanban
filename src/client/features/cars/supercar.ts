import * as THREE from 'three';
import { SEATS, type CarKind } from '../../../shared/garage';
import { CAR } from '../../../shared/garage';
import { mergeByMaterial, mesh, toon } from '../../world/toon';
import type { CarModel } from './world';

// The supercars' model (Lambo and Ferrari): a painted core and two fender pods (higher than the hood, so
// the front wheels never reach up through it), the glass cabin, and small parts laid on the skin a hair
// off it (never coplanar, never half inside) so nothing flickers. Merged by material, like the rest.

export const WIDTH = 1.9;
export const WHEEL_R = 0.36;
export const WHEEL_Y = 0.37;
/** Height of the pivot the body leans about. */
export const PIVOT = 0.45;
/** How far the extruded shapes bulge past their outline (the bevel). */
const BEV = 0.04;
/** The fender pods reach in to this far across, and the core out to this far. */
const POD_IN = 0.56;
const CORE_HALF = 0.6;

type P = [number, number];
/** A spot on the side profile ([along the car, up]) and which way the outline runs there (nose, over the top, to the tail, down). */
interface At {
  p: P;
  d: P;
}
const ln = (a: P, b: P, t: number): At => ({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: [b[0] - a[0], b[1] - a[1]] });
const qd = (a: P, c: P, b: P, t: number): At => {
  const u = 1 - t;
  return {
    p: [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]],
    d: [2 * u * (c[0] - a[0]) + 2 * t * (b[0] - c[0]), 2 * u * (c[1] - a[1]) + 2 * t * (b[1] - c[1])],
  };
};

/** A part `thick` thick lying on the skin at `s`, `x` across, `off` clear of it. */
function skin(geo: THREE.BufferGeometry, mat: THREE.Material, s: At, x: number, thick: number, off = 0.012): THREE.Mesh {
  const l = Math.hypot(s.d[0], s.d[1]);
  const nz = s.d[1] / l;
  const ny = -s.d[0] / l;
  const r = BEV + off + thick / 2;
  const m = mesh(geo, mat, x, s.p[1] + ny * r, s.p[0] + nz * r);
  m.rotation.x = Math.atan2(nz, ny);
  return m;
}
const slab = (w: number, thick: number, len: number) => new THREE.BoxGeometry(w, thick, len);

/** Wheel arches cut up into the bottom of a side profile, rear to front. */
function sill(s: THREE.Shape, rearX: number, frontX: number, axles: number[], bottom = 0.2) {
  const r = 0.46;
  const dx = Math.sqrt(r * r - (WHEEL_Y - bottom) ** 2);
  const a0 = Math.PI + Math.atan2(WHEEL_Y - bottom, dx);
  const a1 = -Math.atan2(WHEEL_Y - bottom, dx);
  s.moveTo(rearX, bottom);
  for (const ax of axles) {
    s.lineTo(ax - dx, bottom);
    s.absarc(ax, WHEEL_Y, r, a0, a1, true);
  }
  s.lineTo(frontX, bottom);
}

interface Profile {
  /** The middle of the body, no arches. */
  core: THREE.Shape;
  /** One side's fender, arches cut in and standing above the hood over the wheels. */
  pod: THREE.Shape;
  cabin: THREE.Shape;
  axle: number;
  /** The windshield that's left of the cabin with the roof off: its foot and how far up. */
  screen: [number, number, number, number];
  /** Where the cabin's flat or curved top runs, for the roof. */
  roof: [number, number];
  lamp: At;
  grille: At;
  hood: (t: number) => At;
  deck: (t: number) => At;
  rear: (t: number) => At;
}

function profile(kind: CarKind): Profile {
  const core = new THREE.Shape();
  const pod = new THREE.Shape();
  const cabin = new THREE.Shape();
  if (kind === 'lambo') {
    // All wedge: a knife-edge nose, a flat hood running straight up into the windshield.
    const axle = 1.42;
    sill(core, -2.22, 2.15, []);
    for (const [x, y] of [[2.32, 0.3], [2.3, 0.44], [0.95, 0.74], [-1.75, 0.86], [-2.3, 0.82], [-2.32, 0.38]]) core.lineTo(x, y);
    core.closePath();
    sill(pod, -2.22, 2.15, [-axle, axle]);
    for (const [x, y] of [[2.3, 0.32], [2.26, 0.5], [1.95, 0.75], [1.6, 0.92], [1.25, 0.92], [1.0, 0.77], [0.5, 0.74], [-0.75, 0.82], [-1.0, 0.9], [-1.9, 0.92], [-2.28, 0.85], [-2.305, 0.4]]) pod.lineTo(x, y);
    pod.closePath();
    cabin.moveTo(1.05, 0.66);
    cabin.lineTo(-0.05, 1.1);
    cabin.lineTo(-0.85, 1.1);
    cabin.lineTo(-2.05, 0.8);
    cabin.lineTo(-2.05, 0.66);
    cabin.closePath();
    return {
      core, pod, cabin, axle, screen: [1.05, 0.66, 0.34, 0.95], roof: [-0.85, -0.05],
      lamp: ln([2.26, 0.5], [1.95, 0.75], 0.45),
      grille: ln([2.32, 0.3], [2.3, 0.44], 0.5),
      hood: (t) => ln([2.3, 0.44], [0.95, 0.74], t),
      deck: (t) => ln([-1.75, 0.86], [-2.3, 0.82], t),
      rear: (t) => ln([-2.3, 0.82], [-2.32, 0.38], t),
    };
  }
  // Curves: a rounded nose, a long hood and big rear haunches.
  const axle = 1.36;
  sill(core, -2.2, 2.12, []);
  core.quadraticCurveTo(2.3, 0.22, 2.28, 0.42);
  core.quadraticCurveTo(1.7, 0.64, 0.55, 0.76);
  core.lineTo(-1.1, 0.84);
  core.quadraticCurveTo(-2.05, 0.96, -2.25, 0.72);
  core.lineTo(-2.26, 0.3);
  core.closePath();
  sill(pod, -2.2, 2.12, [-axle, axle]);
  pod.quadraticCurveTo(2.3, 0.22, 2.27, 0.44);
  pod.quadraticCurveTo(1.95, 0.66, 1.62, 0.9);
  pod.lineTo(1.12, 0.9);
  pod.quadraticCurveTo(0.8, 0.9, 0.5, 0.74);
  pod.lineTo(-0.5, 0.77);
  pod.lineTo(-1.0, 0.92);
  pod.quadraticCurveTo(-1.7, 1.0, -2.1, 0.9);
  pod.quadraticCurveTo(-2.24, 0.86, -2.24, 0.68);
  pod.lineTo(-2.24, 0.3);
  pod.closePath();
  cabin.moveTo(0.65, 0.68);
  cabin.quadraticCurveTo(0.05, 1.16, -0.55, 1.13);
  cabin.quadraticCurveTo(-1.35, 1.1, -1.85, 0.78);
  cabin.lineTo(-1.85, 0.68);
  cabin.closePath();
  return {
    core, pod, cabin, axle, screen: [0.68, 0.68, 0.22, 0.98], roof: [-0.55, 0.05],
    lamp: qd([2.27, 0.44], [1.95, 0.66], [1.62, 0.9], 0.3),
    grille: qd([2.12, 0.2], [2.3, 0.22], [2.28, 0.42], 0.7),
    hood: (t) => qd([2.28, 0.42], [1.7, 0.64], [0.55, 0.76], t),
    deck: (t) => qd([-1.1, 0.84], [-2.05, 0.96], [-2.25, 0.72], t),
    rear: (t) => ln([-2.25, 0.72], [-2.26, 0.3], t),
  };
}

/** Extrudes a side profile `width` across, centered at `cx`, and turns it so the front points to +z. */
function extrude(shape: THREE.Shape, width: number, bevel: number, cx = 0): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 10 });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(-Math.PI / 2);
  geo.translate(cx, 0, 0);
  return geo;
}

/** The roof: a thin cap over the cabin's top between z `lo` and `hi`, following its curve, standing clear of the glass. */
function roofCap(cabin: THREE.Shape, lo: number, hi: number): THREE.BufferGeometry {
  const pts = cabin.getPoints(14).filter((q) => q.x >= lo - 1e-6 && q.x <= hi + 1e-6 && q.y > 0.9);
  const s = new THREE.Shape();
  pts.forEach((q, i) => (i ? s.lineTo(q.x, q.y + 0.03) : s.moveTo(q.x, q.y + 0.03)));
  for (let i = pts.length - 1; i >= 0; i--) s.lineTo(pts[i].x, pts[i].y - 0.07);
  s.closePath();
  return extrude(s, 1.3, 0.02);
}

/** A tyre with a rounded shoulder, around the x axis. */
function tireGeo(): THREE.BufferGeometry {
  const prof: [number, number][] = [[0.2, -0.11], [0.27, -0.135], [0.335, -0.128], [WHEEL_R, -0.09], [WHEEL_R, 0.09], [0.335, 0.128], [0.27, 0.135], [0.2, 0.11]];
  return new THREE.LatheGeometry(prof.map(([r, a]) => new THREE.Vector2(r, a)), 18).rotateZ(-Math.PI / 2);
}
const ringGeo = () => new THREE.LatheGeometry([[0.17, -0.125], [0.215, -0.125], [0.215, 0.125], [0.17, 0.125], [0.17, -0.125]].map(([r, a]) => new THREE.Vector2(r, a)), 18).rotateZ(-Math.PI / 2);

/** The pieces of one wheel (around its own middle), facing outward the way `out` (+1 or -1) says: tyre, rim with spokes, brake disc. */
function wheelParts(kind: CarKind, out: number, tire: THREE.Material, rim: THREE.Material): THREE.Group {
  const w = new THREE.Group();
  const lambo = kind === 'lambo';
  w.add(mesh(tireGeo(), tire));
  w.add(mesh(ringGeo(), rim));
  w.add(mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 14).rotateZ(Math.PI / 2), tire));
  w.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.11, 10).rotateZ(Math.PI / 2), rim, out * 0.055));
  const n = lambo ? 5 : 7;
  for (let i = 0; i < n; i++) {
    const arm = new THREE.Object3D();
    arm.rotation.x = (i / n) * Math.PI * 2;
    arm.add(mesh(new THREE.BoxGeometry(0.03, 0.17, lambo ? 0.065 : 0.04), rim, out * 0.09, 0.115, 0));
    w.add(arm);
  }
  return w;
}

/**
 * A cartoon supercar, nose toward +z, wheels on y = 0. A Lambo is a lime, orange or yellow wedge
 * with a wing; a Ferrari is curvy, with round taillights and a yellow badge and stripes.
 */
export function supercar(kind: CarKind, color: string): CarModel {
  const lambo = kind === 'lambo';
  const g = new THREE.Group();
  const paint = toon(color);
  const glass = toon('#233347');
  const tire = toon('#1f1f26');
  const rim = toon(lambo ? '#e9b949' : '#d9dbe3');
  const lamp = toon('#fff6c9', { emissive: '#b8a960' });
  const tail = toon('#ff2d3f', { emissive: '#a3001a' });
  const dark = toon('#2b2d42');
  const gold = toon('#ffd400');
  const { core, pod, cabin, axle, screen, roof, ...at } = profile(kind);
  const L = CAR.length / 2;
  g.add(mesh(extrude(core, CORE_HALF * 2, BEV), paint));
  const podW = WIDTH / 2 - POD_IN;
  for (const sx of [-1, 1]) g.add(mesh(extrude(pod, podW, BEV, sx * (POD_IN + podW / 2)), paint));

  // Wheels: the back ones go in the body, the front ones steer.
  const wheels: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (WIDTH / 2 - 0.16);
    const back = wheelParts(kind, sx, tire, rim);
    back.position.set(x, WHEEL_Y, -axle);
    g.add(back);
    const front = new THREE.Group();
    front.position.set(x, WHEEL_Y, axle);
    front.add(mergeByMaterial(wheelParts(kind, sx, tire, rim)));
    wheels.push(front);
  }

  const edge = WIDTH / 2;
  for (const sx of [-1, 1]) {
    // Headlamp on the fender's nose, in a dark bezel.
    g.add(skin(slab(0.34, 0.012, 0.2), dark, at.lamp, sx * 0.755, 0.012, 0.004));
    g.add(skin(slab(0.28, 0.02, 0.13), lamp, at.lamp, sx * 0.755, 0.02, 0.016));
    // Door lines, the intake behind the door, and the mirror.
    const door = lambo ? [0.62, -0.5] : [0.5, -0.55];
    for (const z of door) g.add(mesh(new THREE.BoxGeometry(0.008, 0.38, 0.012), dark, sx * (edge + 0.004), 0.5, z));
    g.add(mesh(new THREE.BoxGeometry(0.008, 0.012, door[0] - door[1]), dark, sx * (edge + 0.004), 0.31, (door[0] + door[1]) / 2));
    for (let i = 0; i < 3; i++) g.add(mesh(new THREE.BoxGeometry(0.012, 0.045, 0.34), dark, sx * (edge + 0.006), 0.46 + i * 0.075, -0.74));
    g.add(mesh(new THREE.BoxGeometry(0.1, 0.03, 0.04), dark, sx * 0.88, 0.8, door[0] + 0.05));
    g.add(mesh(new THREE.BoxGeometry(0.15, 0.09, 0.11), paint, sx * 0.95, 0.85, door[0] + 0.05));
    // Side skirt.
    g.add(mesh(new THREE.BoxGeometry(0.04, 0.07, 1.5), dark, sx * (edge + 0.005), 0.22, 0.0));
    if (lambo) {
      g.add(mesh(new THREE.BoxGeometry(0.06, 0.26, 0.06), dark, sx * 0.7, 0.98, -2.0));
      g.add(mesh(new THREE.BoxGeometry(0.03, 0.17, 0.42), paint, sx * 0.96, 1.13, -2.02));
      g.add(skin(slab(0.28, 0.01, 0.22), dark, at.hood(0.55), sx * 0.22, 0.01));
      // Hexagonal-ish tailpipe pair.
      g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 8).rotateX(Math.PI / 2), rim, sx * 0.3, 0.4, -2.39));
      g.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.16, 8).rotateX(Math.PI / 2), dark, sx * 0.3, 0.4, -2.39));
    } else {
      // Round taillights in a ring, and the yellow badge on each flank.
      for (const off of [0.28, 0.62]) {
        const t = at.rear(0.25);
        g.add(skin(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 14), dark, t, sx * off, 0.012, 0.004));
        g.add(skin(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 14), tail, t, sx * off, 0.02, 0.016));
      }
      g.add(mesh(new THREE.BoxGeometry(0.012, 0.12, 0.09), gold, sx * (edge + 0.006), 0.6, 0.9));
      for (const ox of [0.14, 0.34]) {
        g.add(mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10).rotateX(Math.PI / 2), rim, sx * ox, 0.36, -2.3));
        g.add(mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.16, 10).rotateX(Math.PI / 2), dark, sx * ox, 0.36, -2.3));
      }
      // Twin stripes up the hood and over the deck.
      for (const t of [0.12, 0.38, 0.64, 0.88]) g.add(skin(slab(0.08, 0.008, 0.46), gold, at.hood(t), sx * 0.11, 0.008));
      for (const t of [0.2, 0.5, 0.8]) g.add(skin(slab(0.08, 0.008, 0.4), gold, at.deck(t), sx * 0.11, 0.008));
    }
  }
  if (lambo) {
    // The tail-light bar, the rear wing on its struts, a diffuser.
    g.add(skin(slab(1.7, 0.02, 0.08), tail, at.rear(0.2), 0, 0.02, 0.014));
    g.add(mesh(new THREE.BoxGeometry(1.9, 0.05, 0.36), dark, 0, 1.12, -2.02));
    for (const fx of [-0.18, 0, 0.18]) g.add(mesh(new THREE.BoxGeometry(0.02, 0.07, 0.3), dark, fx, 0.19, -2.3));
  } else {
    g.add(skin(slab(0.14, 0.012, 0.1), gold, at.grille, 0, 0.012, 0.016));
    g.add(skin(slab(0.8, 0.012, 0.1), dark, at.grille, 0, 0.012, 0.004));
  }
  // Chin splitter and rear diffuser plate.
  g.add(mesh(new THREE.BoxGeometry(1.6, 0.04, 0.3), dark, 0, 0.14, L + 0.07));
  g.add(mesh(new THREE.BoxGeometry(1.4, 0.04, 0.25), dark, 0, 0.14, -L - 0.03));
  if (lambo) g.add(skin(slab(1.0, 0.012, 0.1), dark, at.grille, 0, 0.012, 0.004));

  // The cabin: glass all round under a painted roof (a carbon one on the Lambo).
  const closed = new THREE.Group();
  closed.add(mesh(extrude(cabin, 1.42, 0.03), glass));
  closed.add(mesh(roofCap(cabin, roof[0], roof[1]), lambo ? dark : paint));

  // Roof off: a windshield up from the hood, bucket seats, and a wheel in front of the driver.
  const open = new THREE.Group();
  const [z0, y0, z1, y1] = screen;
  const pane = mesh(new THREE.BoxGeometry(1.36, 0.04, Math.hypot(z1 - z0, y1 - y0)), glass, 0, (y0 + y1) / 2, (z0 + z1) / 2);
  pane.rotation.x = Math.atan2(y1 - y0, z0 - z1);
  open.add(pane);
  for (const s of Object.values(SEATS)) {
    const back = mesh(new THREE.BoxGeometry(0.5, 0.6, 0.1), dark, s.x, 0.95, s.z - 0.34);
    back.rotation.x = -0.18;
    open.add(back);
  }
  const hoop = mesh(new THREE.TorusGeometry(0.16, 0.028, 6, 18), dark, SEATS.driver.x, 0.98, SEATS.driver.z + 0.5);
  hoop.rotation.x = -0.45;
  open.add(hoop);

  const root = new THREE.Group();
  const top = mergeByMaterial(closed);
  const inside = mergeByMaterial(open);
  inside.visible = false;
  // The body rolls and pitches on a pivot at its middle (see effects.ts), not about the ground.
  const tilt = new THREE.Group();
  tilt.position.y = PIVOT;
  const inner = new THREE.Group();
  inner.position.y = -PIVOT;
  inner.add(mergeByMaterial(g), top, inside, ...wheels);
  tilt.add(inner);
  root.add(tilt);
  return { root, tilt, top, open: inside, wheels };
}
