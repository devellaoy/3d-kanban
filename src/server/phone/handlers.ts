// The phone: follow the workers of any floor without walking there (shared/phone/protocol.ts).
// Joins the handler map and the feature hooks with one line each (ws/handlers/index.ts). Every worker
// change in the building reaches the watchers of its floor through ctx.workerListeners (office/context.ts),
// which this module joins the first time someone watches, so the office never imports it.
import type { Floor } from '../floor.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { str } from '../office/input.js';
import type { FeatureHooks, HandlerMap } from '../ws/handlers/types.js';
import { musicHandlers, musicHooks } from './music-handlers.js';
import type { PhoneClientMsg } from '../../shared/phone/protocol.js';

/** Who follows which floor (a person follows one at a time), per office. */
interface Watching {
  byFloor: Map<string, Set<Client>>;
  floorOf: Map<Client, string>;
}
const offices = new WeakMap<Ctx, Watching>();

function watching(ctx: Ctx): Watching {
  let w = offices.get(ctx);
  if (w) return w;
  const mine: Watching = (w = { byFloor: new Map(), floorOf: new Map() });
  offices.set(ctx, mine);
  ctx.workerListeners.push((floor, worker) => {
    const watchers = mine.byFloor.get(floor.id);
    if (!watchers) return;
    const msg = typeof worker === 'string' ? ({ t: 'phone.workerRemove', floor: floor.id, workerId: worker } as const) : ({ t: 'phone.worker', floor: floor.id, worker } as const);
    // Someone standing on the floor already gets worker.update / worker.remove.
    for (const c of watchers) if (c.peer.floor !== floor.id) ctx.sendTo(c, msg);
  });
  return w;
}

function stop(ctx: Ctx, c: Client) {
  const w = offices.get(ctx);
  const id = w?.floorOf.get(c);
  if (!w || id === undefined) return;
  w.floorOf.delete(c);
  const set = w.byFloor.get(id);
  set?.delete(c);
  if (set && !set.size) w.byFloor.delete(id);
}

function start(ctx: Ctx, c: Client, floor: Floor) {
  const w = watching(ctx);
  stop(ctx, c);
  w.floorOf.set(c, floor.id);
  let set = w.byFloor.get(floor.id);
  if (!set) w.byFloor.set(floor.id, (set = new Set()));
  set.add(c);
  ctx.sendTo(c, { t: 'phone.floor', floor: floor.id, workers: floor.workers.list(), project: floor.project ?? null });
}

export const phoneHandlers = {
  ...musicHandlers,
  'phone.watch'(ctx, c, msg) {
    const id = msg.floor === null ? '' : str(msg.floor, 64);
    const floor = id ? ctx.floors.get(id) : undefined;
    if (floor) start(ctx, c, floor);
    else stop(ctx, c); // null, or a floor that isn't there: stop following
  },
} satisfies HandlerMap<PhoneClientMsg>;

export const phoneHooks: FeatureHooks = {
  closed: (ctx, c) => {
    stop(ctx, c);
    musicHooks.closed!(ctx, c);
  },
};
