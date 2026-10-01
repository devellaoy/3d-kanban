import * as THREE from 'three';
import { STREET_Y } from '../../../shared/layout';
import { canvasTexture } from '../../world/texture';
import { mergeByMaterial, mesh, textPlane, toon } from '../../world/toon';
import type { Collider } from '../../world/types';
import type { Fixture, StreetSite } from '../../world/office/fixture';
import { DOOR, ROOM } from './layout';

// The game room in the garage's west end: four walls (the garage's own is the west one) with a doorway
// to the aisle, a carpet, ceiling lights, a sofa, a dartboard poster, a cue rack and neon signs. It's
// built down on the street (see downstairs in world/office/ground.ts), so it goes down with it on a
// floor above the bottom one, and the sky lights it as the garage (world/sky.ts). The billiards table in
// the middle of it is features/billiards/world.ts's.

const G = STREET_Y;
const WALL = 0.2;
const CEILING = ROOM.ceiling;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

/** A dartboard on a square of cork, drawn once. */
function dartboardTexture(): THREE.CanvasTexture {
  const S = 256;
  return canvasTexture(S, S, (g) => {
    g.fillStyle = '#c9a26b';
    g.fillRect(0, 0, S, S);
    const c = S / 2;
    g.fillStyle = '#17171c';
    g.beginPath();
    g.arc(c, c, S * 0.46, 0, Math.PI * 2);
    g.fill();
    // Twenty wedges, alternating, with a red and green double ring and treble ring.
    for (let i = 0; i < 20; i++) {
      const a0 = ((i - 0.5) / 20) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 0.5) / 20) * Math.PI * 2 - Math.PI / 2;
      const [dark, bright] = i % 2 ? ['#17171c', '#d62828'] : ['#f1e6c8', '#2a9d4f'];
      for (const [r0, r1, color] of [
        [0.3, 0.44, i % 2 ? '#17171c' : '#f1e6c8'],
        [0.4, 0.44, bright],
        [0.26, 0.3, bright],
        [0.06, 0.26, dark],
      ] as const) {
        g.fillStyle = color;
        g.beginPath();
        g.arc(c, c, S * r1, a0, a1);
        g.arc(c, c, S * r0, a1, a0, true);
        g.closePath();
        g.fill();
      }
    }
    g.fillStyle = '#2a9d4f';
    g.beginPath();
    g.arc(c, c, S * 0.06, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#d62828';
    g.beginPath();
    g.arc(c, c, S * 0.025, 0, Math.PI * 2);
    g.fill();
  });
}

/** The carpet: a dark blue weave with a lighter border stitched in. */
function carpetTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#2c3252';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 256; i += 8) g.fillRect(i, 0, 4, 256);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 3;
    g.strokeRect(6, 6, 244, 244);
  }, [ (ROOM.maxX - ROOM.minX) / 2, (ROOM.maxZ - ROOM.minZ) / 2 ]);
}

function sofa(parts: THREE.Group, cols: Collider[], x: number, z: number) {
  const base = toon('#2a9d8f');
  const cushion = toon('#35b3a4');
  const wood = toon('#4a2f1b');
  const w = 2.3;
  const d = 0.9;
  // Against the north wall, facing south: the back on the wall side.
  parts.add(mesh(box(w, 0.28, d), base, x, G + 0.34, z));
  parts.add(mesh(box(w - 0.5, 0.14, d - 0.2), cushion, x, G + 0.55, z + 0.08));
  parts.add(mesh(box(w, 0.6, 0.22), base, x, G + 0.78, z - d / 2 + 0.11));
  for (const s of [-1, 1]) parts.add(mesh(box(0.22, 0.5, d), base, x + s * (w / 2 - 0.11), G + 0.6, z));
  for (const s of [-1, 1]) for (const t of [-1, 1]) parts.add(mesh(box(0.1, 0.18, 0.1), wood, x + s * (w / 2 - 0.15), G + 0.09, z + t * (d / 2 - 0.12)));
  cols.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, bottom: G, top: G + 0.6, fence: true });
}

/** A wall rack of cues on the south wall, and a stool beside the doorway. */
function furniture(parts: THREE.Group, cols: Collider[]) {
  const wood = toon('#6b3f22');
  const stickMat = toon('#e8c88a');
  const tipMat = toon('#2b6fb5');
  const rackZ = ROOM.maxZ - 0.07;
  parts.add(mesh(box(1.2, 0.08, 0.1), wood, -15.6, G + 1.0, rackZ));
  parts.add(mesh(box(1.2, 0.08, 0.1), wood, -15.6, G + 2.0, rackZ));
  for (let i = 0; i < 5; i++) {
    const x = -16.1 + i * 0.25;
    parts.add(mesh(new THREE.CylinderGeometry(0.014, 0.011, 1.45, 8), stickMat, x, G + 1.5, rackZ - 0.02));
    parts.add(mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.04, 8), tipMat, x, G + 2.25, rackZ - 0.02));
  }
  // A stool by the door, to put a drink on.
  const sx = ROOM.maxX - 0.7;
  const sz = 2.4;
  parts.add(mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 14), toon('#d1495b'), sx, G + 0.66, sz));
  parts.add(mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.62, 8), toon('#8d99ae'), sx, G + 0.31, sz));
  parts.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 14), toon('#8d99ae'), sx, G + 0.015, sz));
  cols.push({ minX: sx - 0.22, maxX: sx + 0.22, minZ: sz - 0.22, maxZ: sz + 0.22, bottom: G, top: G + 0.7, fence: true });
}

export const gameroom: Fixture<never, StreetSite> = (site) => {
  const { ground, groundColliders } = site;
  const parts = new THREE.Group();
  const wallMat = toon('#43396e');
  const dado = toon('#2b2450');
  const trim = toon('#ffd166');
  const H = CEILING - G;
  const room = new THREE.Group();

  // The carpet, over the garage's concrete.
  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.maxX - ROOM.minX, ROOM.maxZ - ROOM.minZ),
    new THREE.MeshToonMaterial({ map: carpetTexture(), gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap }),
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set((ROOM.minX + ROOM.maxX) / 2, G + 0.012, 0);
  carpet.receiveShadow = true;
  room.add(carpet);

  // A wall: a box from the floor to the ceiling, with a darker panel along the bottom of it and a trim line over that, on the room's side.
  const wall = (x0: number, x1: number, z0: number, z1: number, side: 'north' | 'south' | 'east') => {
    parts.add(mesh(box(x1 - x0, H, z1 - z0), wallMat, (x0 + x1) / 2, G + H / 2, (z0 + z1) / 2));
    const alongX = side !== 'east';
    const px = alongX ? (x0 + x1) / 2 : x0 - 0.02;
    const pz = side === 'north' ? z1 + 0.02 : side === 'south' ? z0 - 0.02 : (z0 + z1) / 2;
    const w = alongX ? x1 - x0 : 0.04;
    const d = alongX ? 0.04 : z1 - z0;
    parts.add(mesh(box(w, 1.0, d), dado, px, G + 0.5, pz, false));
    parts.add(mesh(box(w + (alongX ? 0 : 0.01), 0.06, d + (alongX ? 0.01 : 0)), trim, px, G + 1.03, pz, false));
    groundColliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, bottom: G, top: CEILING });
  };
  const doorZ0 = DOOR.z - DOOR.width / 2;
  const doorZ1 = DOOR.z + DOOR.width / 2;
  wall(ROOM.minX, ROOM.maxX + WALL, ROOM.minZ - WALL, ROOM.minZ, 'north');
  wall(ROOM.minX, ROOM.maxX + WALL, ROOM.maxZ, ROOM.maxZ + WALL, 'south');
  wall(ROOM.maxX, ROOM.maxX + WALL, ROOM.minZ, doorZ0, 'east');
  wall(ROOM.maxX, ROOM.maxX + WALL, doorZ1, ROOM.maxZ, 'east');
  // Over the doorway, and a frame round it.
  const above = CEILING - (G + DOOR.height);
  parts.add(mesh(box(WALL, above, DOOR.width), wallMat, ROOM.maxX + WALL / 2, CEILING - above / 2, DOOR.z));
  for (const z of [doorZ0, doorZ1]) parts.add(mesh(box(WALL + 0.06, DOOR.height, 0.08), trim, ROOM.maxX + WALL / 2, G + DOOR.height / 2, z, false));
  parts.add(mesh(box(WALL + 0.06, 0.08, DOOR.width + 0.08), trim, ROOM.maxX + WALL / 2, G + DOOR.height, DOOR.z, false));
  groundColliders.push({ minX: ROOM.maxX, maxX: ROOM.maxX + WALL, minZ: doorZ0, maxZ: doorZ1, bottom: G + DOOR.height, top: CEILING });

  // Ceiling lights: two long panels.
  const lamp = toon('#ffffff', { emissive: '#ffe9b8' });
  for (const x of [-16.2, -12.8]) parts.add(mesh(box(0.3, 0.06, 4.2), lamp, x, CEILING - 0.035, 0, false));

  sofa(parts, groundColliders, -14.6, ROOM.minZ + 0.6);
  furniture(parts, groundColliders);
  room.add(mergeByMaterial(parts));

  // The dartboard over the sofa, and the neon signs: one inside on the west wall, one outside over the doorway.
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: dartboardTexture() }));
  board.position.set(-14.6, G + 1.95, ROOM.minZ + 0.02);
  room.add(board);
  const neon = textPlane('🎱  BILLIARDS', { bg: 'rgba(0,0,0,0)', color: '#ff4fa3', size: 80, border: '#ff4fa3' });
  neon.scale.multiplyScalar(1.1);
  neon.rotation.y = Math.PI / 2;
  neon.position.set(ROOM.minX + 0.03, G + 2.2, -1.4);
  room.add(neon);
  const door = textPlane('🎱  GAME ROOM', { bg: '#2b2d42', color: '#4cc9f0', size: 64, border: '#4cc9f0' });
  door.scale.multiplyScalar(0.8);
  door.rotation.y = Math.PI / 2;
  door.position.set(ROOM.maxX + WALL + 0.02, G + DOOR.height + 0.4, DOOR.z);
  room.add(door);

  ground.add(room);
  return {};
};
