import * as THREE from 'three';
import { MEETING_ROOMS, deskSeat, roomFrame } from '../../../shared/layout';
import { meetingsOf } from '../../../shared/meetings';
import type { Ctx } from '../../core/context';
import { store } from '../../state';
import type { DeskView } from '../../world/types';

/** How much room (m) a card keeps from the edge of the view of the board. */
const MARGIN = 0.15;

/**
 * Keeps the cards and name tags of the workers at a meeting room's table off its board. The board
 * faces the door, so that standing in the doorway you read the meeting's summary head-on; a card
 * floating over a head would hang in front of it if it falls inside the view from the door's middle
 * to the board's two edges. So any card that would is moved out sideways, away from that line, just far
 * enough to clear it. (A sprite takes its place from its worker only up and down, see Worker.update,
 * so this is where it stays sideways: it's put back when the worker leaves the chair.)
 */
export function keepBoardsClear(ctx: Ctx) {
  // What doesn't change per chair: where the room's door is, and how far from its middle the view of the board reaches at the chair's depth.
  const chairs = MEETING_ROOMS.flatMap((r) =>
    r.seats.map((def) => {
      // In the room's own frame: u along its door wall, v in from the door (a wing room faces east, so its u is world z).
      const f = roomFrame(r.room);
      const seat = deskSeat(def, 0.85);
      const axis = (r.room.door.u0 + r.room.door.u1) / 2;
      const dv = Math.max(0, f.toLocal(seat.x, seat.z)[1]);
      return { def, f, axis, along: (r.room.facing === 'east' ? 'z' : 'x') as 'x' | 'z', view: ((r.board.width / 2) * dv) / f.toLocal(r.board.x, r.board.z)[1] };
    }),
  );
  /** The workers' roots whose sprites are moved: the chair each is at, and where its sprites were last put. */
  const shifted = new Map<THREE.Object3D, { anchor: THREE.Object3D; x: number; z: number }>();
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const put = (root: THREE.Object3D, x: number, z: number) => {
    for (const s of root.children) if (s instanceof THREE.Sprite) s.position.set(x, s.position.y, z);
  };

  ctx.ticks.add('hud', () => {
    // Nothing is held and nothing is moved: the common case, and no work.
    if (!shifted.size && !meetingsOf(store.meeting).length) return;
    const world = ctx.world();
    // Another map's table has chairs of the same names in other places: only the office's are these.
    if (world.plan.meetingRooms !== MEETING_ROOMS) return;
    // Whoever has got up and gone has its sprites back over its head.
    for (const [root, s] of shifted)
      if (root.parent !== s.anchor) {
        put(root, 0, 0);
        shifted.delete(root);
      }
    for (const { def, f, axis, along, view } of chairs) {
      const desk: DeskView | undefined = world.desks.get(def.id);
      if (!desk || desk.def !== def || !desk.seatAnchor.children.length) continue;
      for (const root of desk.seatAnchor.children) {
        root.getWorldPosition(at);
        root.getWorldScale(scale);
        const u = f.toLocal(at.x, at.z)[0];
        const side = Math.sign(u - axis) || 1;
        let moved = 0;
        for (const s of root.children) {
          if (!(s instanceof THREE.Sprite)) continue;
          // Its inner edge, from the axis, against the view; it moves out by the shortfall.
          const inner = Math.abs(u - axis) - (s.scale.x * scale.x) / 2;
          moved = Math.max(moved, view + MARGIN - inner);
        }
        const was = shifted.get(root);
        if (moved <= 0 && !was) continue;
        at[along] += side * Math.max(0, moved);
        const local = root.worldToLocal(at);
        // Only when it has moved: a worker sitting still keeps its sprites where they are.
        if (was && Math.abs(was.x - local.x) < 1e-4 && Math.abs(was.z - local.z) < 1e-4) continue;
        put(root, local.x, local.z);
        shifted.set(root, { anchor: desk.seatAnchor, x: local.x, z: local.z });
      }
    }
  });
}
