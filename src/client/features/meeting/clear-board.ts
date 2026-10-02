import * as THREE from 'three';
import { MEETING_ROOMS, deskSeat } from '../../../shared/layout';
import type { Ctx } from '../../core/context';
import type { DeskView } from '../../world/types';

/** How much room (m) a card keeps from the edge of the view of the board. */
const MARGIN = 0.15;

/**
 * Keeps the cards and name tags of the workers at a meeting room's table off its board. The board
 * faces the door, so that standing in the doorway you read the meeting's summary head-on; a card
 * floating over a head would hang in front of it if it falls inside the view from the door's middle
 * to the board's two edges. So each card that would hangs out sideways, away from that line, just far
 * enough to clear it. (A sprite takes its place from its worker only up and down, see Worker.update,
 * so this is where it stays sideways: it's put back when the worker leaves the chair.)
 */
export function keepBoardsClear(ctx: Ctx) {
  const rooms = MEETING_ROOMS.flatMap((r) => r.seats.map((def) => ({ def, r })));
  /** The workers' roots whose sprites are moved, and the chair each is at. */
  const shifted = new Map<THREE.Object3D, THREE.Object3D>();
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const put = (root: THREE.Object3D, x: number, z: number) => {
    for (const s of root.children) if (s instanceof THREE.Sprite) s.position.set(x, s.position.y, z);
  };

  ctx.ticks.add('hud', () => {
    // Another map's table has chairs of the same names in other places: only the office's are these.
    if (ctx.world().plan.meetingRooms !== MEETING_ROOMS) return;
    // Whoever has got up and gone has its sprites back over its head.
    for (const [root, anchor] of shifted)
      if (root.parent !== anchor) {
        put(root, 0, 0);
        shifted.delete(root);
      }
    for (const { def, r } of rooms) {
      const desk: DeskView | undefined = ctx.world().desks.get(def.id);
      if (!desk || desk.def !== def) continue;
      const axis = (r.room.door.x0 + r.room.door.x1) / 2;
      const reach = r.board.z - r.room.minZ;
      const dz = Math.max(0, deskSeat(def, 0.85).z - r.room.minZ);
      // How far from the door's middle the view of the board reaches, at this chair's depth.
      const view = ((r.board.width / 2) * dz) / reach;
      for (const root of desk.seatAnchor.children) {
        root.getWorldPosition(at);
        root.getWorldScale(scale);
        const side = Math.sign(at.x - axis) || 1;
        let moved = 0;
        for (const s of root.children) {
          if (!(s instanceof THREE.Sprite)) continue;
          // Its inner edge, from the axis, against the view; it moves out by the shortfall.
          const inner = Math.abs(at.x - axis) - (s.scale.x * scale.x) / 2;
          moved = Math.max(moved, view + MARGIN - inner);
        }
        if (moved <= 0 && !shifted.has(root)) continue;
        at.x += side * Math.max(0, moved);
        const local = root.worldToLocal(at);
        put(root, local.x, local.z);
        shifted.set(root, desk.seatAnchor);
      }
    }
  });
}
