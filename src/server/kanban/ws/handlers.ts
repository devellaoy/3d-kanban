// The kanban's messages on the office's socket: each `kanban.*` type is handled by the kanban itself
// (Kanban.handleWs checks the message field by field), so the office's handler map has one entry for each
// type of KANBAN_CLIENT_TYPE_LIST, the one list of them (a type missing there fails the typecheck).
import { KANBAN_CLIENT_TYPE_LIST, isKanbanMsg, type KanbanClientMsg } from '../../../shared/kanban/protocol.js';
import type { FeatureHooks, HandlerMap } from '../../ws/handlers/types.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { kanbanClient } from '../office.js';


export const kanbanHandlers = Object.fromEntries(
  Object.keys(KANBAN_CLIENT_TYPE_LIST).map((t) => [t, (ctx: Ctx, c: Client, msg: KanbanClientMsg) => ctx.kanban?.handleWs(kanbanClient(ctx, c), msg)]),
) as HandlerMap<KanbanClientMsg>;

/**
 * A `kanban.*` type the handler map doesn't have (a newer or older page than this office): the
 * kanban answers it as before, with an error for its request, instead of it going nowhere.
 */
export function kanbanUnknown(ctx: Ctx, c: Client, msg: unknown): void {
  if (isKanbanMsg(msg)) ctx.kanban?.handleWs(kanbanClient(ctx, c), msg);
}

/** A browser went away: it hears no more kanban updates. */
export const kanbanHooks: FeatureHooks = { closed: (ctx, c) => ctx.kanban?.clientGone(c.id) };
