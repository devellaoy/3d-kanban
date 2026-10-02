// The inbound gate for visitors, in front of every message a visitor's browser sends (see
// ws/dispatch.ts). The rules are the pure tables in shared/multiplayer/allow.ts; this gives them
// the office's own lookups for what a message names (a worker's floor, a task's project).
import { visitorMay } from '../../shared/multiplayer/allow.js';
import type { ClientMsg } from '../../shared/protocol.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';

/** Whether `c` may send `msg`: anyone but a visitor may; a visitor only what the tables allow in their scope. */
export function visitorAllows(ctx: Ctx, c: Client, msg: ClientMsg): boolean {
  if (!c.visitor) return true;
  return visitorMay(msg, c.visitor, {
    floorOfWorker: (id) => ctx.workerFloor(id)?.id,
    projectOfTask: (id) => ctx.kanban?.ctx.repo.getTask(id)?.project,
  });
}
