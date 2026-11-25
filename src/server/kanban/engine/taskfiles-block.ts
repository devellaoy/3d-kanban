// The {{plan}} and {{history}} blocks of the task prompts: the accepted plan and the task's conversation as references to their
// per-task files (see ../taskfiles.ts), or as text for a file that could not be written.

import type { KanbanPromptId } from '../../../shared/kanban/prompts.js';
import type { KanbanComment, KanbanTask } from '../../../shared/kanban/types.js';
import type { KanbanContext } from '../registry.js';
import { taskConversation } from '../conversation.js';
import { syncConversationFile, syncPlanFile } from '../taskfiles.js';

type Render = (id: KanbanPromptId, project: string, vars: Record<string, string | number>) => string;

/** How much of the conversation the inline fallback carries (the newest entries): a new worker's prompt goes in an argument of limited size. */
export const HISTORY_TEXT_MAX = 30_000;

/** The accepted plan of `task` as a reference to its file (the text where the file could not be written), '' without a plan (a stale file goes). */
export function planBlock(ctx: KanbanContext, text: Render, task: KanbanTask): string {
  const accepted = ctx.repo.acceptedPlan(task.id)?.text.trim();
  const file = syncPlanFile(ctx.filesDir, task.id, accepted);
  if (file) return text('kanban.acceptedPlan.file', task.project, { path: file });
  return accepted ? text('kanban.acceptedPlan', task.project, { plan: accepted }) : '';
}

/** The task's conversation as a reference to its file (its newest part as text where the file could not be written), '' when there is none. */
export function historyBlock(ctx: KanbanContext, text: Render, userText: (c: KanbanComment) => string, task: KanbanTask): string {
  const conv = taskConversation(ctx, task.id, userText);
  const file = syncConversationFile(ctx.filesDir, task.id, conv?.markdown());
  if (!conv) return '';
  if (file) return text('kanban.review.history', task.project, { path: file });
  return text('kanban.review.history.text', task.project, { text: conv.tail(HISTORY_TEXT_MAX) });
}
