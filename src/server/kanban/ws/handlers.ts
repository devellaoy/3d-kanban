// The kanban's messages on the office's socket: each `kanban.*` type is handled by the kanban itself
// (Kanban.handleWs checks the message field by field), so the office's handler map has one entry for each.
import { isKanbanMsg, type KanbanClientMsg } from '../../../shared/kanban/protocol.js';
import type { FeatureHooks, HandlerMap } from '../../ws/handlers/types.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { kanbanClient } from '../office.js';

/** Every kanban message type (a type missing here fails the typecheck, as one missing from a handler map does). */
const KANBAN_TYPES: Record<KanbanClientMsg['t'], true> = {
  'kanban.subscribe': true,
  'kanban.unsubscribe': true,
  'kanban.snapshot': true,
  'kanban.task.get': true,
  'kanban.comments.page': true,
  'kanban.task.create': true,
  'kanban.task.update': true,
  'kanban.task.move': true,
  'kanban.task.start': true,
  'kanban.task.stop': true,
  'kanban.task.continue': true,
  'kanban.task.retry': true,
  'kanban.task.review': true,
  'kanban.plan.approve': true,
  'kanban.plan.requestChanges': true,
  'kanban.task.pr': true,
  'kanban.task.compact': true,
  'kanban.task.release': true,
  'kanban.task.delete': true,
  'kanban.comment.add': true,
  'kanban.settings.get': true,
  'kanban.meta.get': true,
  'kanban.settings.set': true,
  'kanban.project.settings.set': true,
  'kanban.project.repos.set': true,
  'kanban.project.repo.clone': true,
  'kanban.project.prompt.set': true,
  'kanban.issues.list': true,
  'kanban.issues.refresh': true,
  'kanban.issues.createTask': true,
  'kanban.skills.list': true,
  'kanban.skills.sync': true,
  'kanban.secrets.set': true,
  'kanban.pr.review': true,
  'kanban.pr.bundle': true,
};

export const kanbanHandlers = Object.fromEntries(
  Object.keys(KANBAN_TYPES).map((t) => [t, (ctx: Ctx, c: Client, msg: KanbanClientMsg) => ctx.kanban?.handleWs(kanbanClient(ctx, c), msg)]),
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
