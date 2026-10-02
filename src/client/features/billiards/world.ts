import * as THREE from 'three';
import { STREET_Y, streetBelow } from '../../../shared/layout';
import { canvasTexture } from '../../world/texture';
import { mergeByMaterial, mesh, toon } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture, StreetSite } from '../../world/office/fixture';
import { bulb, type NightParts } from '../../world/outside';
import { TABLE_AT } from '../gameroom/layout';
import { HALF_L, HALF_W, POCKETS, R } from './sim';

// The billiards table in the game room: a wooden frame on four legs with green cloth, cushions and six
// pockets, a lamp hanging over it, and the balls (made here, moved by controller.ts). The table's own
// plane is (x along its length, y across it) in sim.ts; here that's (z, x) in the room, so the long side
// runs north to south and the foot end is south.

const G = STREET_Y;
const CLOTH = TABLE_AT.cloth;
const RAIL = 0.22;
const RAIL_TOP = CLOTH + 0.075;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

/** The table plane's (x, y) as a point in the room, on the street's level (add `street` for y). */
export function toRoom(x: number, y: number): { x: number; z: number } {
  return { x: TABLE_AT.x + y, z: TABLE_AT.z + x };
}

const COLORS = ['#f4f1e8', '#f2c230', '#2f6fd1', '#d63a2f', '#6b3fa0', '#f08a24', '#2f9e55', '#8c2f39', '#18181c'];

/** A ball's skin: its color (solid, or a stripe round the middle on a white ball), and its number on a white disc. */
function ballTexture(id: number): THREE.CanvasTexture {
  return canvasTexture(128, 64, (g) => {
    const color = COLORS[id === 0 ? 0 : ((id - 1) % 8) + 1];
    g.fillStyle = id > 8 ? '#f4f1e8' : color;
    g.fillRect(0, 0, 128, 64);
    if (id > 8) {
      g.fillStyle = color;
      g.fillRect(0, 16, 128, 32);
    }
    if (id > 0) {
      // Two discs, a quarter of the way round each way, so one is facing you whichever way it came to rest.
      for (const cx of [32, 96]) {
        g.fillStyle = '#f4f1e8';
        g.beginPath();
        g.arc(cx, 32, 12, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#18181c';
        g.font = 'bold 15px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(id), cx, 33);
      }
    }
  });
}

const ballGeo = new THREE.SphereGeometry(R, 20, 14);

/** A ball by its number (0 is the cue ball). */
export function ballMesh(id: number): THREE.Mesh {
  const mat = new THREE.MeshToonMaterial({ map: ballTexture(id), gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  const m = new THREE.Mesh(ballGeo, mat);
  m.castShadow = true;
  return m;
}

/** The cue: a tapering stick lying along +z from its tip, so the controller can place and turn it. */
export function cueStick(): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.CylinderGeometry(0.0075, 0.0135, 1.4, 8);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, 0.72);
  g.add(mesh(shaft, toon('#e8c88a'), 0, 0, 0, false));
  const butt = new THREE.CylinderGeometry(0.0135, 0.017, 0.5, 8);
  butt.rotateX(Math.PI / 2);
  butt.translate(0, 0, 1.65);
  g.add(mesh(butt, toon('#3a2414'), 0, 0, 0, false));
  const tip = new THREE.CylinderGeometry(0.0075, 0.0075, 0.012, 8);
  tip.rotateX(Math.PI / 2);
  g.add(mesh(tip, toon('#2b6fb5'), 0, 0, 0, false));
  return g;
}

export interface TableView {
  group: THREE.Group;
  /** The balls go in here, positioned in the room (x, z) and at the cloth's height above the street. */
  balls: THREE.Group;
  interactable: Interactable;
}

/** The table, its lamp, and what to use it by. */
function buildTable(colliders: Collider[], night: NightParts): TableView {
  const group = new THREE.Group();
  group.name = 'billiards-table';
  const parts = new THREE.Group();
  const wood = toon('#6b3f22');
  const darkWood = toon('#4a2b17');
  const cloth = toon('#2b8a57');
  const cushion = toon('#1f6e44');
  const x0 = TABLE_AT.x;
  const z0 = TABLE_AT.z;
  const gap = 0.1;

  // Cloth over the slate, and the frame's underside.
  parts.add(mesh(box(2 * HALF_W + 2 * RAIL, 0.14, 2 * HALF_L + 2 * RAIL), darkWood, x0, G + CLOTH - 0.1, z0));
  parts.add(mesh(box(2 * HALF_W, 0.03, 2 * HALF_L), cloth, x0, G + CLOTH - 0.015, z0));
  // The rails (wood), the cushions (rubber, inside them) and their gaps at the pockets.
  const strip = (lx0: number, lx1: number, ly0: number, ly1: number, mat: THREE.Material, top: number, bottom: number) =>
    parts.add(mesh(box(ly1 - ly0, top - bottom, lx1 - lx0), mat, x0 + (ly0 + ly1) / 2, G + (top + bottom) / 2, z0 + (lx0 + lx1) / 2, false));
  for (const side of [-1, 1]) {
    for (const [a, b] of [
      [-HALF_L + gap, -gap],
      [gap, HALF_L - gap],
    ]) {
      // A long side: from the corner pocket to the middle one, and from the middle one on.
      const [y0, y1] = side < 0 ? [-HALF_W - RAIL, -HALF_W] : [HALF_W, HALF_W + RAIL];
      strip(a, b, y0, y1, wood, RAIL_TOP, CLOTH - 0.16);
      const [c0, c1] = side < 0 ? [-HALF_W, -HALF_W + 0.05] : [HALF_W - 0.05, HALF_W];
      strip(a, b, c0, c1, cushion, CLOTH + 0.045, CLOTH);
    }
    // A short side, between its corner pockets.
    const [l0, l1] = side < 0 ? [-HALF_L - RAIL, -HALF_L] : [HALF_L, HALF_L + RAIL];
    strip(l0, l1, -HALF_W + gap, HALF_W - gap, wood, RAIL_TOP, CLOTH - 0.16);
    const [e0, e1] = side < 0 ? [-HALF_L, -HALF_L + 0.05] : [HALF_L - 0.05, HALF_L];
    strip(e0, e1, -HALF_W + gap, HALF_W - gap, cushion, CLOTH + 0.045, CLOTH);
    // And a solid block of wood round each corner, behind its pocket (outside the cloth, so the hole stays open to it).
    for (const end of [-1, 1]) {
      const [cl0, cl1] = end < 0 ? [-HALF_L - RAIL, -HALF_L] : [HALF_L, HALF_L + RAIL];
      const [cy0, cy1] = side < 0 ? [-HALF_W - RAIL, -HALF_W + gap] : [HALF_W - gap, HALF_W + RAIL];
      strip(cl0, cl1, cy0, cy1, wood, RAIL_TOP, CLOTH - 0.16);
      const [dl0, dl1] = end < 0 ? [-HALF_L, -HALF_L + gap] : [HALF_L - gap, HALF_L];
      const [dy0, dy1] = side < 0 ? [-HALF_W - RAIL, -HALF_W] : [HALF_W, HALF_W + RAIL];
      strip(dl0, dl1, dy0, dy1, wood, RAIL_TOP, CLOTH - 0.16);
    }
  }
  // The pockets: dark discs on the cloth, where the rails leave their openings.
  const hole = toon('#101014');
  for (const p of POCKETS) {
    const at = toRoom(p.x, p.y);
    const disc = new THREE.CylinderGeometry(p.radius * 0.95, p.radius * 0.95, 0.012, 20);
    parts.add(mesh(disc, hole, at.x, G + CLOTH + 0.004, at.z, false));
  }
  // Four legs, with feet.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = x0 + sx * (HALF_W + RAIL - 0.14);
      const lz = z0 + sz * (HALF_L + RAIL - 0.2);
      parts.add(mesh(box(0.2, CLOTH - 0.17, 0.2), wood, lx, G + (CLOTH - 0.17) / 2, lz));
      parts.add(mesh(box(0.26, 0.04, 0.26), darkWood, lx, G + 0.02, lz));
    }
  }
  // The diamonds on the rails.
  const pearl = toon('#f4f1e8');
  for (const sd of [-1, 1]) {
    for (const lx of [-HALF_L * 0.75, -HALF_L * 0.5, -HALF_L * 0.25, HALF_L * 0.25, HALF_L * 0.5, HALF_L * 0.75]) {
      parts.add(mesh(box(0.025, 0.004, 0.025), pearl, x0 + sd * (HALF_W + RAIL / 2), G + RAIL_TOP + 0.002, z0 + lx, false));
    }
  }
  group.add(mergeByMaterial(parts));

  // The lamp over it: a long shade on two cords, a glowing bar under it.
  const lamp = new THREE.Group();
  const shade = toon('#1e5e3a');
  lamp.add(mesh(box(1.0, 0.16, 2.3), shade, x0, G + 2.35, z0, false));
  lamp.add(mesh(box(0.84, 0.03, 2.14), bulb(night, '#fff1c4', 0.9), x0, G + 2.26, z0, false));
  for (const lz of [-0.9, 0.9]) lamp.add(mesh(box(0.02, 0.95, 0.02), toon('#222'), x0, G + 2.83, z0 + lz, false));
  group.add(lamp);

  const balls = new THREE.Group();
  balls.name = 'billiards-balls';
  group.add(balls);
  colliders.push({
    minX: x0 - HALF_W - RAIL,
    maxX: x0 + HALF_W + RAIL,
    minZ: z0 - HALF_L - RAIL,
    maxZ: z0 + HALF_L + RAIL,
    bottom: G,
    top: G + RAIL_TOP,
    fence: true,
  });
  const interactable: Interactable = { kind: 'billiards', x: x0, z: z0, y: G, radius: 3.4 };
  group.traverse((o) => (o.userData.interact = interactable));
  return { group, balls, interactable };
}

/** The table in the game room, down on the street: it goes down with it on a floor above the bottom one. */
export const billiardsTable: Fixture<never, StreetSite> = (site) => {
  const view = buildTable(site.groundColliders, site.get('night'));
  site.ground.add(view.group);
  site.interactables.push(view.interactable);
  return { setLevel: (index) => void (view.interactable.y = streetBelow(index)) };
};

/** The table in a floor's group, if it has one (it's on the bottom floor's street, and every floor's). */
export function findTable(root: THREE.Object3D): TableView | null {
  const group = root.getObjectByName('billiards-table') as THREE.Group | undefined;
  if (!group) return null;
  return { group, balls: group.getObjectByName('billiards-balls') as THREE.Group, interactable: group.userData.interact as Interactable };
}
