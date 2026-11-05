// Shell tabs over the socket (shared/shelltabs/protocol.ts). Joins the handler map and the feature
// hooks with one line each (ws/handlers/index.ts); the ShellTabs of an office are made the first
// time anyone asks, and join ctx.workerListeners then so a worker going home ends its shells.
import { existsSync } from 'node:fs';
import type { ShellTabClientMsg } from '../../shared/shelltabs/protocol.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { num, str } from '../office/input.js';
import type { FeatureHooks, HandlerMap } from '../ws/handlers/types.js';
import { shellEnv } from './env.js';
import { ShellTabs, type ShellStart } from './shells.js';

const offices = new WeakMap<Ctx, ShellTabs>();

/** Where and how a shell would start for a worker, or why it can't. */
function startFor(ctx: Ctx, workerId: string, c: Client): ShellStart {
  const spec = ctx.workerFloor(workerId)?.workers.shellSpec(workerId);
  if (!spec) return 'That worker is no longer in the building';
  if (spec.info.lost || !existsSync(spec.cwd)) return "The worker's folder is gone: rebuild it or send the worker home first";
  return { cwd: spec.cwd, env: shellEnv(spec, c.accountId, ctx.signins) };
}

export function shellTabs(ctx: Ctx): ShellTabs {
  let tabs = offices.get(ctx);
  if (tabs) return tabs;
  const made = (tabs = new ShellTabs({ send: (c, msg) => ctx.sendTo(c, msg), spec: (id, c) => startFor(ctx, id, c) }));
  offices.set(ctx, made);
  // Only a worker going home (its id, not an update) ends its shells.
  ctx.workerListeners.push((_floor, w) => {
    if (typeof w === 'string') made.removeWorker(w);
  });
  return made;
}

export const shellTabHandlers = {
  'shelltab.list'(ctx, c, msg) {
    if (c.visitor) return;
    const id = str(msg.workerId, 32);
    if (ctx.workerFloor(id)) shellTabs(ctx).list(c, id);
  },
  'shelltab.unlist'(ctx, c, msg) {
    if (!c.visitor) offices.get(ctx)?.unlist(c, str(msg.workerId, 32));
  },
  'shelltab.open'(ctx, c, msg) {
    if (c.visitor) return;
    const err = shellTabs(ctx).open(c, str(msg.workerId, 32), c.peer.name);
    if (err) ctx.warn(c, err);
  },
  'shelltab.close'(ctx, c, msg) {
    if (!c.visitor) offices.get(ctx)?.close(str(msg.tabId, 32));
  },
  'shelltab.attach'(ctx, c, msg) {
    if (!c.visitor) offices.get(ctx)?.attach(c, str(msg.tabId, 32));
  },
  'shelltab.detach'(ctx, c, msg) {
    if (!c.visitor) offices.get(ctx)?.detach(c, str(msg.tabId, 32));
  },
  'shelltab.input'(ctx, c, msg) {
    if (!c.visitor) offices.get(ctx)?.input(c, str(msg.tabId, 32), str(msg.data, 64 * 1024));
  },
  'shelltab.resize'(ctx, c, msg) {
    if (!c.visitor) offices.get(ctx)?.resize(c, str(msg.tabId, 32), num(msg.cols), num(msg.rows));
  },
} satisfies HandlerMap<ShellTabClientMsg>;

export const shellTabHooks: FeatureHooks = {
  // Moving floors closes the worker windows of the floor left.
  leaving(ctx, c, was) {
    if (was) offices.get(ctx)?.forget(c, new Set(was.workers.list().map((w) => w.id)));
  },
  closed: (ctx, c) => offices.get(ctx)?.forget(c),
};

/** The office is closing: every shell ends. */
export const closeShellTabs = (ctx: Ctx) => offices.get(ctx)?.closeAll();
