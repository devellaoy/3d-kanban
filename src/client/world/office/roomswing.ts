import * as THREE from 'three';
import { FLOOR, ROOMS_WING, SLAB, WALL_HEIGHT, WALL_T, WINDOWS, WING_ROOMS } from '../../../shared/layout';
import { mesh, roundedBox, toon } from '../toon';
import type { Collider, Interactable } from '../types';
import type { Fixture } from './fixture';
import { PALETTE, box } from './materials';
import { wallRun, wetPane, windowIn } from './shell';

// The meeting wing through the west wall: up to three meeting rooms out over the lawn, built out one at a
// time like the back office is through the north wall. While a room isn't built, its stretch of the west
// wall stands with its window in it (the plug); built, the wall there is gone, the room's glass front (see
// meeting-room.ts) is in the wall's line, and out behind it are the wing's own walls, floor and roof.

/** How tall a room is inside: its lowered ceiling (the wall goes on up past it, solid). */
const ROOM_HEIGHT = 2.75;

/** The wing, as far as it's built out. */
export interface RoomsWingView {
  /** How many rooms it's built out. */
  level: number;
  /** Builds it out `level` rooms (or walls it up): walls, floor, roof and the plugs in the wall. */
  set(level: number): void;
}

/** The sign that says there's room to grow, painted for how far the wing is built out. */
function paintGrowSign(c: HTMLCanvasElement, level: number) {
  const g = c.getContext('2d')!;
  const w = c.width;
  const h = c.height;
  const full = level >= ROOMS_WING.rooms;
  g.fillStyle = full ? '#e9ecef' : '#9ad7ff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#2b2d42';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '800 68px Nunito, ui-rounded, system-ui, sans-serif';
  g.fillText(full ? '🤝 All four meeting rooms' : '🚧 Room for a meeting room', w / 2, h * 0.4);
  g.font = '700 46px Nunito, ui-rounded, system-ui, sans-serif';
  g.fillText(full ? 'The meeting wing is built all the way out' : level ? 'Press E to build another meeting room' : 'Press E to knock through the west wall', w / 2, h * 0.72);
}

/** The meeting wing and the plugs of wall it stands in while it isn't built. */
export const roomsWing: Fixture<'rooms' | 'setRooms'> = (site) => {
  const T = WALL_T;
  const D = ROOMS_WING.depth;
  const group = site.group;
  const night = site.get('night');
  const looks = site.looks;

  // Each room's stretch of the west wall, with its window: standing while the room isn't there.
  const plugs = WING_ROOMS.map((s, i) => {
    const plug = new THREE.Group();
    const cols: Collider[] = [];
    const hole = WINDOWS.filter((o) => o.room === i);
    wallRun(plug, cols, 'z', FLOOR.minX - T / 2, s.z0, s.z1, -1, hole, looks, [false, false]);
    const glazing = new THREE.Group();
    for (const o of hole) {
      glazing.add(windowIn(o));
      site.wall(o.wall, o.u, (o.y0 + o.y1) / 2 - 0.03, o.width + 0.2, o.y1 - o.y0 + 0.12);
      plug.add(wetPane(o, night.wetGlass));
    }
    plug.add(glazing);
    group.add(plug);
    return { plug, cols };
  });

  // The sign, up over the next room's stretch of wall.
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 420;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sign = new THREE.Group();
  const board = mesh(roundedBox(2.64, 0.06, 1.12, 0.06), toon(PALETTE.ink), 0, 0, 0, false);
  board.rotation.x = Math.PI / 2;
  sign.add(board);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(2.56, 1.05), new THREE.MeshBasicMaterial({ map: tex }));
  face.position.z = 0.032;
  sign.add(face);
  sign.rotation.y = Math.PI / 2;
  sign.scale.setScalar(1.7); // big enough to read from across the room
  group.add(sign);
  const it: Interactable = { kind: 'expandrooms', x: FLOOR.minX + 1.6, z: 0, radius: 2.6 };
  site.interactables.push(it);
  sign.userData.interact = it;

  let built: THREE.Object3D[] = [];
  let mine: Collider[] = [];
  const view: RoomsWingView = {
    level: -1,
    set(level) {
      level = Math.max(0, Math.min(ROOMS_WING.rooms, level));
      if (level === view.level) return;
      view.level = level;
      for (const o of built) {
        o.removeFromParent();
        o.traverse((m) => {
          if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).geometry.dispose();
        });
      }
      built = [];
      for (const c of mine) {
        const i = site.colliders.indexOf(c);
        if (i >= 0) site.colliders.splice(i, 1);
      }
      mine = [];
      const take = (o: THREE.Object3D) => {
        group.add(o);
        built.push(o);
        return o;
      };
      plugs.forEach((p, i) => {
        p.plug.visible = i >= level;
        for (const c of p.cols) {
          const at = site.colliders.indexOf(c);
          if (i >= level && at < 0) site.colliders.push(c);
          else if (i < level && at >= 0) site.colliders.splice(at, 1);
        }
      });
      if (level > 0) {
        const north = WING_ROOMS[0].z0;
        const south = WING_ROOMS[level - 1].z1;
        const west = FLOOR.minX - D;
        const shell = new THREE.Group();
        // The back wall, and its two ends; the walls between the rooms.
        wallRun(shell, mine, 'z', west - T / 2, north - T, south + T, -1, [], looks, [true, true]);
        wallRun(shell, mine, 'x', north - T / 2, west - T, FLOOR.minX, -1, [], looks, [true, false]);
        wallRun(shell, mine, 'x', south + T / 2, west - T, FLOOR.minX, 1, [], looks, [true, false]);
        for (let i = 1; i < level; i++) {
          const z = (WING_ROOMS[i - 1].z1 + WING_ROOMS[i].z0) / 2;
          shell.add(mesh(box(D, WALL_HEIGHT, ROOMS_WING.wall), looks.wall, FLOOR.minX - D / 2, WALL_HEIGHT / 2, z, true));
          mine.push({ minX: west, maxX: FLOOR.minX, minZ: z - ROOMS_WING.wall / 2, maxZ: z + ROOMS_WING.wall / 2, top: 99 });
        }
        // Over each room's glass front, up to the ceiling: solid wall, painted like the rest.
        for (let i = 0; i < level; i++) {
          const s = WING_ROOMS[i];
          shell.add(mesh(box(T, WALL_HEIGHT - ROOM_HEIGHT, s.z1 - s.z0), looks.wall, FLOOR.minX - T / 2, (WALL_HEIGHT + ROOM_HEIGHT) / 2, (s.z0 + s.z1) / 2, false));
        }
        take(shell);
        // The floor: the room's planks carried on through (the same texture, lined up with it), on a slab
        // like the room's.
        const w = D + T;
        const d = south - north + 2 * T;
        const mid = (north + south) / 2;
        const floorGeo = new THREE.PlaneGeometry(D, d).rotateX(-Math.PI / 2).translate(FLOOR.minX - D / 2, 0, mid);
        const uv = floorGeo.getAttribute('uv');
        const pos = floorGeo.getAttribute('position');
        for (let k = 0; k < pos.count; k++) uv.setXY(k, (pos.getX(k) - FLOOR.minX) / (FLOOR.maxX - FLOOR.minX), (FLOOR.maxZ - pos.getZ(k)) / (FLOOR.maxZ - FLOOR.minZ));
        const floor = take(new THREE.Mesh(floorGeo, site.planks)) as THREE.Mesh;
        floor.receiveShadow = true;
        const band = toon('#e8a87c');
        const concrete = toon('#d3d6dd');
        const slab = new THREE.Mesh(box(w, SLAB - 0.01, d), [band, band, concrete, concrete, band, band]);
        slab.position.set(FLOOR.minX - w / 2 + T / 2, -SLAB / 2 - 0.005, mid);
        slab.receiveShadow = true;
        take(slab);
        // Its roof, flush with the tops of its walls, for when there's no floor over it.
        take(mesh(box(w, 0.02, d), toon('#fffaf3'), FLOOR.minX - w / 2 + T / 2, WALL_HEIGHT + 0.03, mid, false));
        mine.push({ minX: west - T, maxX: FLOOR.minX, minZ: north - T, maxZ: south + T, bottom: -SLAB, top: 0 });
        mine.push({ minX: west - T, maxX: FLOOR.minX, minZ: north - T, maxZ: south + T, bottom: WALL_HEIGHT, top: WALL_HEIGHT + SLAB });
      }
      site.colliders.push(...mine);

      // The sign over the next room's stretch of wall, or the last one's once they're all there.
      const next = WING_ROOMS[Math.min(level, ROOMS_WING.rooms - 1)];
      sign.position.set(FLOOR.minX + 0.05, 4.5, next.c);
      it.z = next.c;
      paintGrowSign(canvas, level);
      tex.needsUpdate = true;
    },
  };
  void document.fonts?.ready.then(() => {
    paintGrowSign(canvas, Math.max(0, view.level));
    tex.needsUpdate = true;
  });
  view.set(0);
  const setRooms = (level: number) => {
    view.set(level);
    site.get('setMeetingRooms')(level);
  };
  return { handle: { rooms: view, setRooms } };
};

declare module '../types' {
  interface OfficeHandles {
    /** The meeting wing through the west wall, as far as this floor's built out (see ROOMS_WING). */
    rooms: RoomsWingView;
    /** Builds the meeting wing out `level` rooms, or walls it up: the walls, and the rooms in them. */
    setRooms(level: number): void;
  }
}
