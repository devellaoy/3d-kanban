// Moving the floor's loose furniture about, in build mode: the desks, the bean bags, the couch and
// poufs and the whiteboard (see shared/arrange.ts). Everyone on the floor sees it, and it's kept with
// the floor's plan. Only the office's own map has any of it.
import { MOVABLE_BY_ID } from '../../../shared/arrange.js';
import { OFFICE_MAP } from '../../../shared/maps/index.js';
import type { FurnitureClientMsg } from '../../../shared/protocol.js';
import type { Floor } from '../../floor.js';
import type { Client } from '../../office/client.js';
import type { Ctx } from '../../office/context.js';
import { num, str } from '../../office/input.js';
import { here } from './common.js';
import type { HandlerMap } from './types.js';

/** The floor you're on, if its furniture can be moved: only on the office's own map. */
function movable(ctx: Ctx, c: Client): Floor | undefined {
  const floor = here(ctx, c);
  if (!floor) return undefined;
  if (ctx.maps.pick() !== OFFICE_MAP) {
    ctx.warn(c, 'The furniture can only be moved in the office, not on this map');
    return undefined;
  }
  return floor;
}

/** Refused: the asker is told why, and gets the floor's plan again, so what they were carrying goes back without waiting for anyone else's change. */
const refused = (ctx: Ctx, c: Client, floor: Floor, why: string) => {
  ctx.warn(c, why);
  ctx.sendTo(c, { t: 'plan', plan: floor.plan.state() });
};

const planChanged = (ctx: Ctx, floor: Floor) => {
  ctx.toFloor(floor, { t: 'plan', plan: floor.plan.state() });
  ctx.floorsChanged();
};

/** Whoever sat on a couch or pouf that's gone is on their feet (the rest of the floor sees them get up). */
function standUpFrom(ctx: Ctx, floor: Floor, id: string) {
  for (const o of ctx.clients.values()) {
    if (o.peer.floor !== floor.id || !o.peer.seat?.startsWith(`${id}:`)) continue;
    delete o.peer.seat;
    ctx.broadcast({ t: 'peer.update', peer: o.peer }, o.id);
  }
}

export const furnitureHandlers = {
  'furniture.move'(ctx, c, msg) {
    const floor = movable(ctx, c);
    if (!floor) return;
    const r = floor.plan.arrange(str(msg.id, 40), { x: num(msg.x), z: num(msg.z), r: num(msg.r) });
    if (typeof r === 'string') return refused(ctx, c, floor, r);
    planChanged(ctx, floor);
    ctx.toastFloor(floor, r.back ? `🪑 ${c.peer.name} put ${r.label} back in` : `🪑 ${c.peer.name} moved ${r.label}`);
  },
  'furniture.remove'(ctx, c, msg) {
    const floor = movable(ctx, c);
    if (!floor) return;
    const r = floor.plan.remove(str(msg.id, 40), (id) => floor.workers.deskOccupied(id));
    if (typeof r === 'string') return refused(ctx, c, floor, r);
    standUpFrom(ctx, floor, r.id);
    planChanged(ctx, floor);
    ctx.toastFloor(floor, `🗑️ ${c.peer.name} took ${r.label} out`);
  },
  'furniture.reset'(ctx, c, msg) {
    const floor = movable(ctx, c);
    if (!floor) return;
    const id = msg.id === undefined ? undefined : str(msg.id, 40);
    if (id !== undefined && !MOVABLE_BY_ID.has(id)) return refused(ctx, c, floor, 'There is nothing like that to put back');
    const r = floor.plan.reset(id);
    if (typeof r === 'string') return refused(ctx, c, floor, r);
    planChanged(ctx, floor);
    ctx.toastFloor(floor, id === undefined ? `↺ ${c.peer.name} put all the furniture back where it comes` : `↺ ${c.peer.name} put ${r.labels[0]} back where it comes`);
  },
} satisfies HandlerMap<FurnitureClientMsg>;
