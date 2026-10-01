/**
 * The game room in the garage's west end (its walls, carpet and decor are world.ts's, its table
 * features/billiards'): walking into it the first time says what's there.
 */
import type { Ctx } from '../../core/context';
import { toast } from '../../ui/dom';
import { DOOR, ROOM } from './layout';

/** Whether a point (x, z) at height y is in the room, with `street` the level of its floor. */
export function inGameRoom(x: number, y: number, z: number, street: number): boolean {
  return x > ROOM.minX && x < ROOM.maxX - 0.3 && Math.abs(z - DOOR.z) < ROOM.maxZ && Math.abs(y - street) < 1.5;
}

export function installGameroom(ctx: Ctx) {
  let told = false;
  ctx.ticks.add('world', () => {
    if (told || !ctx.inOffice() || ctx.upTop()) return;
    const p = ctx.player.pos;
    if (!inGameRoom(p.x, p.y, p.z, ctx.player.street)) return;
    told = true;
    toast('🎱 The game room: walk up to the billiards table and press E');
  });
}
