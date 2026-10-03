import * as THREE from 'three';
import { MEETING_ROOMS, deskSeat, type DeskDef, type MeetingRoomPlan } from '../../../shared/layout';
import type { NightParts } from '../outside';
import { mesh, roundedBox, textPlane, toon } from '../toon';
import type { Collider, DeskView, Interactable, MeetingScreen } from '../types';
import type { Fixture } from './fixture';
import { PALETTE, box, glassPane } from './materials';
import { LAMP_COLOR, wallBoard } from './props';
import { chair } from './seats';
import type { Door } from './shell';

/** A chair at a meeting table, with its laptop on the table in front of it. */
function buildMeetingSeat(def: DeskDef, index: number, tableHeight: number): DeskView {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, tableHeight, 0);
  laptopAnchor.scale.setScalar(1.15);
  group.add(laptopAnchor);
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.4, 0.85);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  group.add(seatAnchor);
  const ch = chair(['#2b2d42', '#ef476f', '#118ab2', '#06d6a0', '#ffd166'][index % 5]);
  ch.position.set(0, 0, 0.85);
  group.add(ch);
  // A merge's dance party: up on its chair rather than the table, where the laptops are close together.
  const stage = new THREE.Object3D();
  stage.position.set(0, 0.48, 0.85);
  group.add(stage);
  // Nobody is hired here from the floor, so there's no '+' over a free chair: a meeting fills them.
  const vacancy = new THREE.Group();
  group.add(vacancy);
  return { def, group, laptopAnchor, seatAnchor, stage, chair: ch, vacancy, vacancyY: 0 };
}

/**
 * A meeting room (see MEETING_ROOMS): glass walls with a sliding glass door in the north one, a table
 * with its chairs, a board on the south wall, in line with the door, for the meeting's output and a
 * sign by the door for how it's going. The first room is under the loft, between the loft's posts
 * and the outside walls; one that stands free (the review room) has glass on its east side too, a
 * solid south wall for the board, and a roof.
 */
export function buildMeetingRoom(plan: MeetingRoomPlan, group: THREE.Group, colliders: Collider[], interactables: Interactable[], desks: Map<string, DeskView>, doors: Door[], night: NightParts): MeetingScreen {
  const R = plan.room;
  const H = R.height;
  const T = 0.1;
  const frameMat = toon('#ffffff');
  const walls = new THREE.Group();
  const bar = (w: number, h: number, d: number, x: number, y: number, z: number) => walls.add(mesh(box(w, h, d), frameMat, x, y, z, false));
  /** A run of glass along x (north wall) or z (west wall), from a to b, in panes about `pane` wide. */
  const run = (axis: 'x' | 'z', a: number, b: number, at: number, pane = 2.2) => {
    const len = b - a;
    const n = Math.max(1, Math.round(len / pane));
    for (let i = 0; i < n; i++) {
      const g = glassPane(len / n, H);
      const u = a + (i + 0.5) * (len / n);
      if (axis === 'x') g.position.set(u, H / 2, at);
      else {
        g.position.set(at, H / 2, u);
        g.rotation.y = Math.PI / 2;
      }
      walls.add(g);
    }
    for (let i = 0; i <= n; i++) {
      const u = a + i * (len / n);
      if (axis === 'x') bar(0.08, H, T + 0.04, u, H / 2, at);
      else bar(T + 0.04, H, 0.08, at, H / 2, u);
    }
    for (const y of [0.05, H - 0.05]) {
      if (axis === 'x') bar(len, 0.1, T + 0.06, (a + b) / 2, y, at);
      else bar(T + 0.06, 0.1, len, at, y, (a + b) / 2);
    }
    colliders.push(axis === 'x' ? { minX: a, maxX: b, minZ: at - T / 2, maxZ: at + T / 2, top: H } : { minX: at - T / 2, maxX: at + T / 2, minZ: a, maxZ: b, top: H });
  };
  run('x', R.minX, R.door.x0, R.minZ);
  run('x', R.door.x1, R.maxX, R.minZ);
  run('z', R.minZ, R.maxZ, R.minX);
  if (R.free) {
    run('z', R.minZ, R.maxZ, R.maxX);
    // The south wall is solid, so the board has a wall behind it; the roof sits over the lot.
    const paint = toon('#f3efe8');
    walls.add(mesh(box(R.maxX - R.minX, H, T), paint, (R.minX + R.maxX) / 2, H / 2, R.maxZ, false));
    colliders.push({ minX: R.minX, maxX: R.maxX, minZ: R.maxZ - T / 2, maxZ: R.maxZ + T / 2, top: H });
    walls.add(mesh(box(R.maxX - R.minX + 0.2, 0.12, R.maxZ - R.minZ + 0.2), paint, (R.minX + R.maxX) / 2, H + 0.06, (R.minZ + R.maxZ) / 2, false));
  }
  // Over the door, up to the loft's floor.
  bar(R.door.x1 - R.door.x0, 0.1, T + 0.06, (R.door.x0 + R.door.x1) / 2, 2.3, R.minZ);
  group.add(walls);

  // The door: two glass leaves that slide apart over the glass on either side when someone comes up.
  const dx = (R.door.x0 + R.door.x1) / 2;
  const half = (R.door.x1 - R.door.x0) / 2;
  const alu = toon('#aab4be');
  const leaves: [THREE.Group, number][] = [];
  for (const side of [-1, 1]) {
    const leaf = new THREE.Group();
    const h = 2.25;
    for (const y of [0.04, h - 0.04]) leaf.add(mesh(box(half, 0.07, 0.04), alu, 0, y, 0, false));
    for (const x of [-half / 2 + 0.03, half / 2 - 0.03]) leaf.add(mesh(box(0.06, h, 0.04), alu, x, h / 2, 0, false));
    const pane = glassPane(half - 0.12, h - 0.14);
    pane.position.y = h / 2;
    leaf.add(pane);
    leaf.add(mesh(box(0.03, 0.4, 0.07), toon(PALETTE.ink), -side * (half / 2 - 0.1), 1.05, 0, false));
    const x0 = dx + (side * half) / 2;
    leaf.position.set(x0, 0, R.minZ - T / 2 - 0.04);
    group.add(leaf);
    leaves.push([leaf, x0]);
  }
  doors.push({
    x: dx,
    y: 0,
    z: R.minZ,
    open: 0,
    show: (k) => {
      const e = k * k * (3 - 2 * k);
      for (const [leaf, x0] of leaves) leaf.position.x = x0 + Math.sign(x0 - dx) * e * (half - 0.06);
    },
  });
  const label = textPlane(plan.label, { bg: '#2b2d42', color: '#fffaf3', size: 56, border: '#fffaf3' });
  label.scale.multiplyScalar(0.62);
  label.position.set(dx, 2.52, R.minZ - 0.07);
  label.rotation.y = Math.PI;
  group.add(label);

  // The table, on two pedestals, and its chairs. One that runs north-south is built along x and turned.
  const table = new THREE.Group();
  const top = plan.table;
  const length = Math.max(top.width, top.depth);
  const breadth = Math.min(top.width, top.depth);
  table.add(mesh(roundedBox(length, 0.08, breadth, 0.1), toon(PALETTE.wood), 0, top.height - 0.04, 0));
  for (const sx of [-1, 1]) {
    table.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, top.height - 0.08, 10), toon(PALETTE.deskLeg), sx * (length / 2 - 0.7), (top.height - 0.08) / 2, 0));
    table.add(mesh(roundedBox(0.9, 0.05, Math.min(0.6, breadth - 0.2), 0.05), toon(PALETTE.deskLeg), sx * (length / 2 - 0.7), 0.025, 0));
  }
  table.rotation.y = top.depth > top.width ? Math.PI / 2 : 0;
  table.position.set(top.x, 0, top.z);
  group.add(table);
  colliders.push({ minX: top.x - top.width / 2, maxX: top.x + top.width / 2, minZ: top.z - top.depth / 2, maxZ: top.z + top.depth / 2, top: top.height });
  const talk: Interactable = { kind: 'meeting', x: top.x, z: top.z, radius: 2.6, room: plan.id };
  interactables.push(talk);
  table.userData.interact = talk;
  plan.seats.forEach((def, i) => {
    const view = buildMeetingSeat(def, i, top.height);
    group.add(view.group);
    desks.set(def.id, view);
    const at = deskSeat(def, 1.2);
    const it: Interactable = { kind: 'desk', deskId: def.id, x: at.x, z: at.z, radius: 1 };
    interactables.push(it);
    view.group.userData.interact = it;
  });

  // The board on the back wall: the meeting's output file as it's being written.
  const b = plan.board;
  const { group: frame, face } = wallBoard(b.width, b.height, '#aab4be');
  frame.position.set(b.x, b.y, b.z);
  frame.rotation.y = Math.PI;
  group.add(frame);
  const read: Interactable = { kind: 'meeting', x: b.x, z: b.z - 1.4, radius: 2.4, room: plan.id };
  interactables.push(read);
  frame.userData.interact = read;

  // The panel on the glass beside the door, like a room-booking screen: what's on, the round, the
  // tokens, and the summary once it's over. Beside the door rather than past it, so the board shows.
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.96), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  sign.position.set((R.minX + R.door.x0) / 2 + 0.01, 1.45, R.minZ - T / 2 - 0.03);
  sign.rotation.y = Math.PI;
  group.add(sign);
  const plate = mesh(roundedBox(0.66, 1.03, 0.03, 0.03), toon(PALETTE.ink), sign.position.x, sign.position.y, R.minZ - T / 2 - 0.012, false);
  group.add(plate);
  const door: Interactable = { kind: 'meeting', x: sign.position.x, z: R.minZ - 1.2, radius: 1.8, room: plan.id };
  interactables.push(door);
  sign.userData.interact = door;
  plate.userData.interact = door;

  // Flat lights set in the ceiling (the loft's floor) along the table: a hanging lamp would be in front of the board.
  const lengthways = top.width >= top.depth;
  for (const d of [-1, 1].map((k) => k * Math.min(0.95, length / 3))) {
    const lx = top.x + (lengthways ? d : 0);
    const lz = top.z + (lengthways ? 0 : d);
    group.add(mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.04, 20), toon('#fff7d6', { emissive: '#ffe08a' }), lx, H - 0.02, lz, false));
    night.halos.push({ at: new THREE.Vector3(lx, H - 0.08, lz), size: 0.9, color: '#ffe08a' });
    // Under a ceiling: they light the room, not the floor over it.
    night.roomLamps.push({ x: lx, y: H - 0.1, z: lz, reach: 5, color: LAMP_COLOR, power: 1.2, level: 1, floor: 0, top: H });
  }
  return { room: plan.id, board: face, sign };
}

declare module '../types' {
  interface OfficeHandles {
    /** Each meeting room's board, showing its meeting's output as it's written, and the sign by its door. */
    meetingScreens: MeetingScreen[];
  }
}

/** The meeting rooms: the first under the loft, the review room out on the open floor. */
export const meetingRoom: Fixture<'meetingScreens'> = (site) => {
  const meetingScreens = MEETING_ROOMS.map((plan) => buildMeetingRoom(plan, site.group, site.colliders, site.interactables, site.desks, site.doors, site.get('night')));
  // The first room's board is on the outside wall: pictures keep off it.
  const b = MEETING_ROOMS[0].board;
  site.wall('south', b.x, b.y, b.width + 0.4, b.height + 0.4);
  return { handle: { meetingScreens } };
};
