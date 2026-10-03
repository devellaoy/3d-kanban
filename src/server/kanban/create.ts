// Making a task the way the create dialog does: one path for the board (kanban.task.create), the
// issue board and agents (POST /office/tasks/create), so the defaults and the bookkeeping can't drift.

import type { KanbanTaskInput } from '../../shared/kanban/protocol.js';
import type { KanbanTask, TaskOverrides } from '../../shared/kanban/types.js';
import type { KanbanCaller, KanbanContext } from './registry.js';
import { wallChanged } from './integrations/issues/wall.js';

/** Why `repoIds` aren't all the project's repositories, if they aren't. */
export function checkRepoIds(ctx: KanbanContext, project: string, repoIds: string[] | null | undefined): string | undefined {
  if (!repoIds) return undefined;
  const known = new Set(ctx.repos(project).map((r) => r.id));
  const unknown = repoIds.filter((id) => !known.has(id));
  return unknown.length ? `${unknown.join(', ')} ${unknown.length === 1 ? "isn't one of" : "aren't"} the project's repositories` : undefined;
}

/** The fields of a new task that come from the office's and the project's defaults when the input doesn't say. */
export function taskDefaults(ctx: KanbanContext, project: string, input: Pick<KanbanTaskInput, 'tool' | 'model' | 'effort' | 'usePlan' | 'planApproval' | 'useReview'> = {}) {
  const d = ctx.settings.get().defaults;
  const tool = input.tool ?? d.tool;
  return {
    tool,
    // The office's default model is for its default tool; another tool starts on its own default.
    model: input.model ?? (tool === d.tool ? d.model : undefined),
    effort: input.effort ?? d.effort,
    usePlan: input.usePlan ?? d.usePlan,
    planApproval: input.planApproval ?? ctx.settings.planApproval(project),
    useReview: input.useReview ?? d.useReview,
  };
}

/**
 * Creates a task from the dialog's input, links its attachments, tells the browsers and, when asked,
 * starts it. `event` is extra data for the `created` event (who it was really made through). Resolves to
 * why not, or the task and why its start failed, if it did.
 */
export async function createBoardTask(
  ctx: KanbanContext,
  input: KanbanTaskInput,
  who: KanbanCaller,
  opts: { start?: boolean; deskId?: string; event?: Record<string, unknown> } = {},
): Promise<{ task: KanbanTask; startError?: string } | string> {
  if (!ctx.project(input.project)) return `There's no project ${input.project}`;
  const why = checkRepoIds(ctx, input.project, input.repoIds);
  if (why) return why;
  const overrides: TaskOverrides = {};
  if (input.review && Object.keys(input.review).length) overrides.review = input.review;
  if (input.implementPermission) overrides.implementPermission = input.implementPermission;
  const task = ctx.repo.createTask({
    project: input.project,
    title: input.title,
    description: input.description ?? '',
    type: input.type ?? 'implement',
    ticket: input.ticket,
    ticketUrl: input.ticketUrl,
    repoIds: input.repoIds ?? null,
    ...taskDefaults(ctx, input.project, input),
    goal: input.goal,
    overrides,
    tags: input.tags ?? [],
    createdBy: who.name,
    // Its drained, retried and swept hires run on this account's sign-ins.
    ...(who.accountId ? { createdByAccount: who.accountId } : {}),
  });
  if (input.attachmentIds?.length) ctx.repo.linkAttachments(input.attachmentIds, task.id);
  ctx.repo.appendEvent(task.id, 'created', { by: who.name, ...opts.event });
  ctx.taskChanged(task.id);
  // The 3D issues board's card for its ticket says which task it became.
  if (task.ticket) wallChanged(task.project);
  let startError: string | undefined;
  if (opts.start) {
    const err = await ctx.engine.start(task.id, who, opts.deskId ? { deskId: opts.deskId } : undefined);
    if (typeof err === 'string' && err) startError = err;
    ctx.taskChanged(task.id);
  }
  return { task: ctx.repo.getTask(task.id) ?? task, ...(startError ? { startError } : {}) };
}
