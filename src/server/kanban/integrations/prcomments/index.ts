// The review comments of a task's pull requests (docs/kanban-architecture.md §4, §6 and §9): the Pull requests tab fetches them
// (the task's agent reads and analyses them in a pr-comments run), lists them for the user to decide on, and sends the decisions
// back (a pr-answers run). The engine runs both; this plugin is the browser's way in, over the office's own store (engine/prcomments.ts):
//
//   GET /api/kanban/tasks/<id>/pr-comments → PrCommentsState ('running' while its fetch run is under way)
//   WS  kanban.pr.comments.fetch {taskId}                  → kanban.ok, or kanban.error with why not
//   WS  kanban.pr.comments.send {taskId, fetchedAt, answers} → kanban.ok, or kanban.error with why not
//
// A send is only taken for the list as it was fetched (`fetchedAt`), with a decision on every comment; the decisions are kept as they were
// sent (`pending`, then `sent`) so a run that waits for a desk, or is retried, acts on the same ones. When the engine refuses a request the
// store is left as it was.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import { answersComplete } from '../../../../shared/kanban/prcomments.js';
import { FAILED_START, pendingLive, prCommentsState, readPrComments, updatePrComments, type PrCommentsStore } from '../../engine/prcomments.js';
import { fail, ok, sendJson } from '../util.js';

const ROUTE_RE = /^\/api\/kanban\/tasks\/(\d{1,12})\/pr-comments$/;

export function createPrCommentsPlugin(ctx: KanbanContext, now: () => number = Date.now): KanbanPlugin {
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const m = ROUTE_RE.exec(url.pathname);
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' }), true;
    const task = ctx.repo.getTask(Number(m[1]));
    if (!task) return sendJson(res, 404, { error: `There's no task #${m[1]}` }), true;
    return sendJson(res, 200, prCommentsState(ctx.filesDir, task)), true;
  };

  /**
   * The store as it was, put back after the engine refused: only when it holds nothing but what a failed start of that fetch left (a fetch that
   * is going, or one that has finished, keeps its own store), and in one step with the check, so a refused request never touches another's.
   */
  const restore = (taskId: number, old: PrCommentsStore | undefined) =>
    updatePrComments(ctx.filesDir, taskId, (cur) => (!cur ? old : !cur.origin && cur.error?.startsWith(FAILED_START) ? old : cur));
  /** Sends under way: a second one of the same task, while the first waits for the engine, is refused. */
  const sending = new Set<number>();

  return {
    name: 'prcomments',
    http: { '/api/kanban/tasks/': (req, res, url) => handle(req, res, url) },
    ws: {
      // The engine clears the old list when the fetch starts (engine/prcomments.ts origin); a refusal puts it back.
      'kanban.pr.comments.fetch': async (c, m) => {
        const task = ctx.repo.getTask(m.taskId);
        if (!task) return fail(c, m.rid, `There's no task #${m.taskId}`);
        const old = readPrComments(ctx.filesDir, task.id);
        const err = await ctx.engine.prRun(task.id, c, 'comments');
        ctx.taskChanged(task.id);
        if (typeof err === 'string' && err) {
          restore(task.id, old);
          return fail(c, m.rid, err);
        }
        ok(c, m.rid, { taskId: task.id });
      },
      'kanban.pr.comments.send': async (c, m) => {
        const task = ctx.repo.getTask(m.taskId);
        if (!task) return fail(c, m.rid, `There's no task #${m.taskId}`);
        const store = readPrComments(ctx.filesDir, task.id);
        if (!store || store.error || store.fetchedAt === undefined || store.fetchedAt !== m.fetchedAt) return fail(c, m.rid, 'The list of comments has changed since you saw it: fetch them again');
        // A pending that no run carries (the office died before the engine answered) is nothing: the list is still to be sent.
        if (store.sent || (store.pending && (pendingLive(task) || sending.has(task.id)))) return fail(c, m.rid, 'These decisions were sent already: fetch the comments again for a new list');
        const known = new Set(store.items.map((i) => i.id));
        const unknown = m.answers.find((a) => !known.has(a.id));
        if (unknown) return fail(c, m.rid, `The list has no comment ${unknown.id.slice(0, 100)}: fetch the comments again`);
        if (!answersComplete(store.items, m.answers)) return fail(c, m.rid, 'Decide every comment first (a custom answer needs its text)');
        const at = now();
        sending.add(task.id);
        updatePrComments(ctx.filesDir, task.id, (cur) => cur && { ...cur, pending: { items: store.items, answers: m.answers, at } });
        let err: string | void;
        try {
          err = await ctx.engine.prRun(task.id, c, 'answers');
        } finally {
          sending.delete(task.id);
        }
        ctx.taskChanged(task.id);
        // Only pending and sent change: whatever else the store holds now (a fetch's origin, say) is not this request's to write.
        if (typeof err === 'string' && err) {
          updatePrComments(ctx.filesDir, task.id, (cur) => cur && { ...cur, pending: undefined });
          return fail(c, m.rid, err);
        }
        updatePrComments(ctx.filesDir, task.id, (cur) => cur && { ...cur, pending: undefined, sent: { items: store.items, answers: m.answers, at } });
        ok(c, m.rid, { taskId: task.id });
      },
    },
  };
}
