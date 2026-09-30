// What the 3D office's own worker actions become on a task worker (docs/kanban-coupling.md, "3D
// actions → task events"): a prompt the fork's dialogs send `asComment` (P's "💬 Message task", an
// issue card dropped on its desk, Ask → an existing task worker) is a comment on its task, which the
// engine follows and reviews; R on one whose task waits is the task's Retry. server.ts asks these
// first and does upstream's own thing only when they hand it back (undefined).

import type { WorkerInfo } from '../../shared/protocol.js';
import type { KanbanCaller, KanbanContext } from './registry.js';
import { canRetry } from './engine/machine.js';

const OPEN = new Set(['in_progress', 'waiting', 'review']);
/** Where a task the automation isn't on sits, for the refusal. */
const OUT: Record<string, string> = { todo: 'To do', done: 'Done', archived: 'the archive' };

/**
 * A prompt to `info` on `who`'s behalf. Without `asComment` it's upstream's, typed straight in (the
 * default, as upstream has it: the terminal's say box and every other caller). With it, an
 * implementer's becomes a user comment on its task (stored, sent to the task's subscribers, then
 * handed to the engine); a reviewer refuses it, and so does a task the automation isn't on (To do,
 * done, archived). Undefined when it's upstream's to type in: no `asComment`, not a task worker, or
 * the task is gone. Resolves to why not, or to nothing when the comment is in.
 */
export function promptTaskWorker(ctx: KanbanContext, info: WorkerInfo, text: string, who: KanbanCaller, asComment = false): Promise<string | void> | undefined {
  const k = info.kanban;
  if (!asComment || !k) return undefined;
  const task = ctx.repo.getTask(k.taskId);
  if (!task) return undefined;
  if (k.role === 'reviewer') return Promise.resolve(`${info.name} is reviewing task #${task.id}: comment on the task instead, or type into its terminal`);
  if (!OPEN.has(task.status)) return Promise.resolve(`Task #${task.id} is in ${OUT[task.status] ?? task.status}, so its agent isn't on it: comment on the kanban, or type into ${info.name}'s terminal`);
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) return Promise.resolve('Say what to tell it');
  const { comment } = ctx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: who.name, kind: 'message', text: body });
  ctx.broadcast({ t: 'kanban.comment', comment, project: task.project }, task.project);
  ctx.taskChanged(task.id);
  return ctx.engine
    .commented(task.id, comment.id, who)
    .then(() => {
      if (ctx.repo.getTask(task.id)) ctx.taskChanged(task.id);
    })
    .catch((err: Error) => {
      console.error(`agent-office: the kanban couldn't pass comment ${comment.id} on to task #${task.id}: ${err.message}`);
      return `The comment is on task #${task.id}, but its agent didn't get it: ${err.message}`;
    });
}

/**
 * R on `info`: when it's a task worker whose task waits with Retry (stopped, failed, interrupted, a
 * usage limit, the agent asking), the task's Retry, with no raw relaunch. Undefined otherwise.
 */
export function resumeTaskWorker(ctx: KanbanContext, info: WorkerInfo, who: KanbanCaller): Promise<string | void> | undefined {
  const k = info.kanban;
  if (!k) return undefined;
  const task = ctx.repo.getTask(k.taskId);
  if (!task || !canRetry(task)) return undefined;
  return ctx.engine.retry(task.id, who).then((err) => {
    if (ctx.repo.getTask(task.id)) ctx.taskChanged(task.id);
    return err;
  });
}
