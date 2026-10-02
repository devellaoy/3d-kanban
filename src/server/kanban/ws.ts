// The kanban's own WebSocket messages (the board, tasks, comments, settings) and its HTTP routes
// (uploads). Every request is answered exactly once: its typed reply, kanban.ok or kanban.error,
// with the request's rid. Every change is pushed to the subscribed browsers as a delta. The move
// rules are src/shared/kanban/moves.ts, enforced here whatever the browser thinks it may do; what
// the process does (start, stop, review...) is the engine's (ctx.engine). Issues, skills and pull
// request reviews are the integration plugins' messages, not handled here.

import type { KanbanCaller, KanbanClient, KanbanContext, KanbanPlugin, KanbanWsHandler } from './registry.js';
import type { KanbanClientMsg, KanbanClientType, KanbanServerMsg, KanbanTaskPatch } from '../../shared/kanban/protocol.js';
import type { KanbanProjectInfo, KanbanTask, TaskOverrides } from '../../shared/kanban/types.js';
import { checkMove, isRunning } from '../../shared/kanban/moves.js';
import { isKanbanPromptId } from '../../shared/kanban/prompts.js';
import { PROMPT_MAX } from '../../shared/prompts.js';
import { COMMENTS_PAGE, publicAttachment, type TaskUpdate } from './db/repository.js';
import { projectInfo } from './projects.js';
import { openFor, taskFolders, workerFolders } from './vscode.js';
import { wallChanged, wallSourcesChanged } from './integrations/issues/wall.js';
import { chmodSync, existsSync } from 'node:fs';
import { ORPHAN_MAX_AGE_MS, removeAttachmentFiles, removeGrant, sweepOrphanUploads, uploadsDir, uploadRoutes } from './uploads.js';

const DAY_MS = 24 * 60 * 60_000;
/** How often done tasks are looked at for the archive (and stale uploads for the bin). */
export const SWEEP_EVERY_MS = 60 * 60_000;

/** Who listens to which project's deltas (kept by index.ts). */
export interface KanbanSubscriptions {
  subscribe(c: KanbanClient, project: string | null, includeArchived: boolean): void;
  unsubscribe(clientId: string): void;
}

type Msg<T extends KanbanClientType> = Extract<KanbanClientMsg, { t: T }>;

const ok = (c: KanbanClient, rid: string | undefined, extra: Omit<Extract<KanbanServerMsg, { t: 'kanban.ok' }>, 't' | 'rid'> = {}) => c.send({ t: 'kanban.ok', ...(rid ? { rid } : {}), ...extra });
const fail = (c: KanbanClient, rid: string | undefined, message: string) => c.send({ t: 'kanban.error', ...(rid ? { rid } : {}), message });

/** Every project, as the kanban lists them. */
export function projectInfos(ctx: KanbanContext): KanbanProjectInfo[] {
  const settings = ctx.settings.get();
  return ctx.projects().map((def) => projectInfo(def, settings, !!ctx.floor(def.id)));
}

/** Why `repoIds` aren't all the project's repositories, if they aren't. */
export function checkRepoIds(ctx: KanbanContext, project: string, repoIds: string[] | null | undefined): string | undefined {
  if (!repoIds) return undefined;
  const known = new Set(ctx.repos(project).map((r) => r.id));
  const unknown = repoIds.filter((id) => !known.has(id));
  return unknown.length ? `${unknown.join(', ')} ${unknown.length === 1 ? "isn't one of" : "aren't"} the project's repositories` : undefined;
}

/** The fields of a patch that shape how the task runs: set only while it's in To do. */
const STRUCTURAL: (keyof KanbanTaskPatch)[] = ['type', 'repoIds', 'usePlan', 'planApproval', 'useReview', 'goal', 'implementPermission'];
/**
 * Who carries it out (the implementer's tool, model and effort, and the review override): set
 * whenever no run is live. The next phase's hire picks them up; a new tool's session gets the handoff.
 */
const EXECUTOR: (keyof KanbanTaskPatch)[] = ['tool', 'model', 'effort', 'review'];

/**
 * A browser's edit as a repository update, or why it isn't allowed: structural fields only in To do,
 * the executor only while no run is live, the repositories only before the first start, the
 * description locked from the first start on.
 */
export function taskUpdateFrom(ctx: KanbanContext, task: KanbanTask, patch: KanbanTaskPatch): TaskUpdate | string {
  if (task.status === 'archived') return 'Bring it back from the archive first';
  const started = !!task.startedAt || !!task.flags.descriptionLocked;
  if (patch.description !== undefined && patch.description !== task.description && started) return 'The description is locked once the task has started: add a comment instead';
  const structural = STRUCTURAL.filter((k) => patch[k] !== undefined);
  if (structural.length && task.status !== 'todo') return `${structural.join(', ')} can only be changed while the task is in To do`;
  const executor = EXECUTOR.filter((k) => patch[k] !== undefined);
  if (executor.length && isRunning(task)) return `${executor.join(', ')} can only be changed while no run is going: stop it first`;
  if (patch.repoIds !== undefined && task.startedAt) return 'Its repositories are set once it has started';
  const why = checkRepoIds(ctx, task.project, patch.repoIds);
  if (why) return why;
  const up: TaskUpdate = {};
  if (patch.title !== undefined) up.title = patch.title;
  if (patch.description !== undefined) up.description = patch.description;
  if (patch.ticket !== undefined) up.ticket = patch.ticket;
  if (patch.ticketUrl !== undefined) up.ticketUrl = patch.ticketUrl;
  if (patch.repoIds !== undefined) up.repoIds = patch.repoIds;
  if (patch.type !== undefined) up.type = patch.type;
  if (patch.tool !== undefined) up.tool = patch.tool;
  if (patch.model !== undefined) up.model = patch.model;
  if (patch.effort !== undefined) up.effort = patch.effort;
  if (patch.usePlan !== undefined) up.usePlan = patch.usePlan;
  if (patch.planApproval !== undefined) up.planApproval = patch.planApproval;
  if (patch.useReview !== undefined) up.useReview = patch.useReview;
  if (patch.goal !== undefined) up.goal = patch.goal;
  if (patch.tags !== undefined) up.tags = patch.tags;
  if (patch.review !== undefined || patch.implementPermission !== undefined) {
    const o: TaskOverrides = { ...task.overrides };
    if (patch.review === null || (patch.review && !Object.keys(patch.review).length)) delete o.review;
    else if (patch.review) o.review = patch.review;
    if (patch.implementPermission === null) delete o.implementPermission;
    else if (patch.implementPermission) o.implementPermission = patch.implementPermission;
    up.overrides = o;
  }
  return up;
}

/** Done tasks untouched for settings.archiveAfterDays go to the archive. Returns their ids. */
export function archiveOldTasks(ctx: KanbanContext, now = Date.now()): number[] {
  const days = ctx.settings.get().archiveAfterDays;
  if (!days) return [];
  const cutoff = now - days * DAY_MS;
  const moved: number[] = [];
  for (const t of ctx.repo.tasksWhere({ status: ['done'] })) {
    if ((t.doneAt ?? t.updatedAt) > cutoff) continue;
    ctx.repo.updateTask(t.id, { status: 'archived', archivedAt: now, ...(t.runState === 'queued' ? { runState: 'idle' as const, queuedRun: null } : {}) });
    ctx.repo.appendEvent(t.id, 'archived', { auto: true, afterDays: days }, now);
    ctx.taskChanged(t.id);
    moved.push(t.id);
    // Its workers still at their desks go home, worktree kept (docs/kanban-coupling.md).
    void ctx.engine.releaseIdle?.(t.id, { name: 'Kanban', admin: true }).catch((err: Error) => console.error(`agent-office: the kanban couldn't send archived task #${t.id}'s workers home: ${err.message}`));
  }
  return moved;
}

export function createCorePlugin(ctx: KanbanContext, subs: KanbanSubscriptions): KanbanPlugin {
  let sweepTimer: NodeJS.Timeout | undefined;

  const snapshot = (c: KanbanClient, project: string | null, includeArchived: boolean, rid?: string) =>
    c.send({
      t: 'kanban.snapshot',
      ...(rid ? { rid } : {}),
      project,
      tasks: ctx.repo.listCards(project, { includeArchived }, (t) => {
        const r = ctx.settings.effectiveReview(t.project, t.overrides);
        return { rounds: r.rounds, tool: r.tool };
      }),
      projects: projectInfos(ctx),
      settings: ctx.settings.get(),
      secrets: ctx.secrets.status(),
      me: { admin: c.admin, name: c.name },
    });

  /** The task a request is about, or (answered already) undefined. */
  const taskOf = (c: KanbanClient, rid: string | undefined, id: number): KanbanTask | undefined => {
    const t = ctx.repo.getTask(id);
    if (!t) fail(c, rid, `There's no task #${id}`);
    return t;
  };
  const adminOnly = (c: KanbanClient, rid: string | undefined): boolean => {
    if (c.admin) return true;
    fail(c, rid, 'Only an admin can change that');
    return false;
  };
  const settingsChanged = () => {
    ctx.broadcast({ t: 'kanban.settings', settings: ctx.settings.get(), secrets: ctx.secrets.status() }, null);
    ctx.broadcast({ t: 'kanban.projects', projects: projectInfos(ctx) }, null);
  };

  /** A request the engine carries out: the task must be there; its answer is an error or nothing. */
  const viaEngine =
    <T extends KanbanClientType>(run: (m: Msg<T> & { id: number }, who: KanbanCaller) => Promise<string | void>): KanbanWsHandler<T> =>
    async (c, m) => {
      const msg = m as Msg<T> & { id: number; rid?: string };
      if (!taskOf(c, msg.rid, msg.id)) return;
      const err = await run(msg, c);
      if (ctx.repo.getTask(msg.id)) ctx.taskChanged(msg.id);
      if (typeof err === 'string' && err) fail(c, msg.rid, err);
      else ok(c, msg.rid, { taskId: msg.id });
    };

  const ws: KanbanPlugin['ws'] = {
    'kanban.subscribe': (c, m) => {
      subs.subscribe(c, m.project, !!m.includeArchived);
      snapshot(c, m.project, !!m.includeArchived, m.rid);
    },
    'kanban.unsubscribe': (c, m) => {
      subs.unsubscribe(c.clientId);
      ok(c, m.rid);
    },
    'kanban.snapshot': (c, m) => snapshot(c, m.project, !!m.includeArchived, m.rid),

    'kanban.task.get': (c, m) => {
      const task = taskOf(c, m.rid, m.id);
      if (!task) return;
      const want = m.comments ?? COMMENTS_PAGE;
      const page = want > 0 ? ctx.repo.listComments(task.id, { limit: want }) : { comments: [], more: ctx.repo.countComments(task.id) > 0 };
      // Whose account it runs as stays on the server.
      const { createdByAccount: _account, ...shown } = task;
      c.send({
        t: 'kanban.task.detail',
        ...(m.rid ? { rid: m.rid } : {}),
        task: shown,
        comments: page.comments,
        commentsMore: page.more,
        runs: ctx.repo.listRuns(task.id),
        plans: ctx.repo.listPlans(task.id),
        attachments: ctx.repo.listAttachments(task.id).map(publicAttachment),
        events: ctx.repo.listEvents(task.id),
      });
    },
    'kanban.comments.page': (c, m) => {
      if (!taskOf(c, m.rid, m.id)) return;
      const page = ctx.repo.listComments(m.id, { before: m.before, limit: m.limit ?? COMMENTS_PAGE });
      c.send({ t: 'kanban.comments', ...(m.rid ? { rid: m.rid } : {}), taskId: m.id, comments: page.comments, more: page.more });
    },

    'kanban.task.create': async (c, m) => {
      const input = m.task;
      if (!ctx.project(input.project)) return fail(c, m.rid, `There's no project ${input.project}`);
      const why = checkRepoIds(ctx, input.project, input.repoIds);
      if (why) return fail(c, m.rid, why);
      const d = ctx.settings.get().defaults;
      const tool = input.tool ?? d.tool;
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
        tool,
        // The office's default model is for its default tool; another tool starts on its own default.
        model: input.model ?? (tool === d.tool ? d.model : undefined),
        effort: input.effort ?? d.effort,
        usePlan: input.usePlan ?? d.usePlan,
        planApproval: input.planApproval ?? ctx.settings.planApproval(input.project),
        useReview: input.useReview ?? d.useReview,
        goal: input.goal,
        overrides,
        tags: input.tags ?? [],
        createdBy: c.name,
        // Its drained, retried and swept hires run on this account's sign-ins.
        ...(c.accountId ? { createdByAccount: c.accountId } : {}),
      });
      if (input.attachmentIds?.length) ctx.repo.linkAttachments(input.attachmentIds, task.id);
      ctx.repo.appendEvent(task.id, 'created', { by: c.name });
      ctx.taskChanged(task.id);
      // The 3D issues board's card for its ticket says which task it became.
      if (task.ticket) wallChanged(task.project);
      let startError: string | undefined;
      if (m.start) {
        const err = await ctx.engine.start(task.id, c, m.deskId ? { deskId: m.deskId } : undefined);
        if (typeof err === 'string' && err) startError = err;
        ctx.taskChanged(task.id);
      }
      ok(c, m.rid, { taskId: task.id, ...(startError ? { startError } : {}) });
    },

    'kanban.task.update': (c, m) => {
      const task = taskOf(c, m.rid, m.id);
      if (!task) return;
      const up = taskUpdateFrom(ctx, task, m.patch);
      if (typeof up === 'string') return fail(c, m.rid, up);
      ctx.repo.updateTask(task.id, up);
      ctx.repo.appendEvent(task.id, 'edited', { by: c.name, fields: Object.keys(m.patch) });
      ctx.taskChanged(task.id);
      if ('ticket' in m.patch) wallChanged(task.project);
      ok(c, m.rid, { taskId: task.id });
    },

    'kanban.task.move': async (c, m) => {
      const task = taskOf(c, m.rid, m.id);
      if (!task) return;
      const check = checkMove({ status: task.status, runState: task.runState }, m.to);
      if (!check.ok) return fail(c, m.rid, check.reason);
      if (check.action === 'start') {
        const err = await ctx.engine.start(task.id, c);
        ctx.taskChanged(task.id);
        return typeof err === 'string' && err ? fail(c, m.rid, err) : ok(c, m.rid, { taskId: task.id });
      }
      if (check.action === 'hold' || check.action === 'unhold') {
        // The engine parks the task (its workers go home) or hires its implementer again; it says why not.
        const run = check.action === 'hold' ? ctx.engine.hold?.(task.id, c, { note: m.note, until: m.until }) : ctx.engine.unhold?.(task.id, c, m.note);
        const err = run ? await run : "This office can't put tasks on hold";
        if (!(typeof err === 'string' && err)) ctx.repo.appendEvent(task.id, 'moved', { by: c.name, from: task.status, to: m.to, ...(m.note ? { note: m.note } : {}) });
        ctx.taskChanged(task.id);
        return typeof err === 'string' && err ? fail(c, m.rid, err) : ok(c, m.rid, { taskId: task.id });
      }
      const now = Date.now();
      const up: TaskUpdate = { status: m.to };
      // Out of the hold, however it goes on: the hold's reason and date are no more.
      if (task.status === 'on_hold') up.hold = null;
      if (check.action === 'reset') {
        // Sending somebody's workers home, or ending the run they are asking in, is the creator's call (or an admin's), as a delete is.
        if ((task.workerId || task.reviewerWorkerId) && !c.admin && task.createdBy !== c.name) return fail(c, m.rid, 'Only whoever made it, or an admin, can move a task with workers back to To do');
        // Its workers at rest go home first (worktree kept): the reset forgets which worktree was theirs.
        const err = await ctx.engine.sendWorkersHome(task.id, c, 'reset');
        if (typeof err === 'string' && err) return fail(c, m.rid, err);
        // Starting over: the automation's state goes, what the task is stays. So does its branch, as
        // information: the next start seats a fresh worktree and tells the agent to check that branch
        // out, rather than reusing a worktree that may be gone by then (merged and pruned, say).
        Object.assign(up, {
          phase: null,
          runState: 'idle',
          waitingReason: null,
          waitingText: null,
          reviewRound: 0,
          sessionId: null,
          reviewerSessionId: null,
          workerId: null,
          reviewerWorkerId: null,
          workspace: null,
          pendingMessages: [],
          retryAt: null,
          retryAttempts: 0,
          finishedAt: null,
          doneAt: null,
        } satisfies TaskUpdate);
      }
      if (m.to === 'done') Object.assign(up, { doneAt: now, archivedAt: null });
      if (m.to === 'archived') up.archivedAt = now;
      // Out of the process: a run it had queued never starts (the drain would hire for it).
      if ((m.to === 'done' || m.to === 'archived' || m.to === 'todo') && task.runState === 'queued') Object.assign(up, { runState: 'idle', queuedRun: null } satisfies TaskUpdate);
      if (task.status === 'done' && m.to === 'review') up.doneAt = null;
      ctx.repo.updateTask(task.id, up);
      ctx.repo.appendEvent(task.id, 'moved', { by: c.name, from: task.status, to: m.to, ...(check.action === 'reset' ? { reset: true } : {}) });
      ctx.taskChanged(task.id);
      ok(c, m.rid, { taskId: task.id });
      // Done with: its workers at rest go home, worktree kept (docs/kanban-coupling.md).
      if (m.to === 'done' || m.to === 'archived') await ctx.engine.releaseIdle?.(task.id, c).catch((err: Error) => console.error(`agent-office: the kanban couldn't send task #${task.id}'s workers home: ${err.message}`));
    },

    'kanban.task.delete': async (c, m) => {
      const task = taskOf(c, m.rid, m.id);
      if (!task) return;
      if (!c.admin && task.createdBy !== c.name) return fail(c, m.rid, 'Only whoever made it, or an admin, can delete a task');
      if (isRunning(task)) return fail(c, m.rid, 'Stop it first: it is running');
      // Its workers at rest go home first, worktree and branches kept.
      const err = await ctx.engine.sendWorkersHome(task.id, c, 'delete');
      if (typeof err === 'string' && err) return fail(c, m.rid, err);
      const files = ctx.repo.listAttachments(task.id);
      ctx.repo.deleteTask(task.id);
      removeAttachmentFiles(ctx.filesDir, files);
      removeGrant(ctx.filesDir, task.id);
      ctx.taskChanged(task.id);
      if (task.ticket) wallChanged(task.project);
      ok(c, m.rid, { taskId: task.id });
    },

    'kanban.task.vscode': async (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      const task = taskOf(c, m.rid, m.id);
      if (!task) return;
      try {
        await openFor(ctx, await taskFolders(ctx, task), `task #${task.id}`, `task-${task.project}-${task.id}`);
        ok(c, m.rid);
      } catch (err) {
        fail(c, m.rid, (err as Error).message);
      }
    },
    'kanban.worker.vscode': async (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      for (const def of ctx.projects()) {
        const floor = ctx.floor(def.id);
        const info = floor?.workers.get(m.workerId);
        if (!floor || !info) continue;
        try {
          await openFor(ctx, await workerFolders(ctx, floor, info), `worker ${info.name}`, `worker-${info.id}`);
          return ok(c, m.rid);
        } catch (err) {
          return fail(c, m.rid, (err as Error).message);
        }
      }
      fail(c, m.rid, `There's no worker ${m.workerId}`);
    },

    'kanban.comment.add': async (c, m) => {
      const task = taskOf(c, m.rid, m.id);
      if (!task) return;
      const { comment } = ctx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: c.name, kind: 'message', text: m.text });
      if (m.attachmentIds?.length) ctx.repo.linkAttachments(m.attachmentIds, task.id, comment.id);
      const stored = ctx.repo.getComment(comment.id) ?? comment;
      ctx.broadcast({ t: 'kanban.comment', comment: stored, project: task.project }, task.project);
      ctx.taskChanged(task.id);
      ok(c, m.rid, { taskId: task.id, commentId: stored.id });
      try {
        await ctx.engine.commented(task.id, stored.id, c);
      } catch (err) {
        console.error(`agent-office: the kanban couldn't pass comment ${stored.id} on to task #${task.id}: ${(err as Error).message}`);
      }
      if (ctx.repo.getTask(task.id)) ctx.taskChanged(task.id);
    },

    'kanban.task.start': viaEngine<'kanban.task.start'>((m, who) => ctx.engine.start(m.id, who, m.deskId ? { deskId: m.deskId } : undefined)),
    'kanban.task.stop': viaEngine<'kanban.task.stop'>((m, who) => ctx.engine.stop(m.id, who)),
    'kanban.task.continue': viaEngine<'kanban.task.continue'>((m, who) => ctx.engine.continue(m.id, who, m.answer, m.attachmentIds)),
    'kanban.task.retry': viaEngine<'kanban.task.retry'>((m, who) => ctx.engine.retry(m.id, who)),
    'kanban.task.review': viaEngine<'kanban.task.review'>((m, who) => ctx.engine.review(m.id, who)),
    'kanban.plan.approve': viaEngine<'kanban.plan.approve'>(async (m, who) => {
      if (m.planId !== undefined) {
        // The engine approves the latest plan: one that's been replaced can't be.
        const plan = ctx.repo.getPlan(m.planId);
        if (!plan || plan.taskId !== m.id) return `Task #${m.id} has no such plan`;
        if (ctx.repo.latestPlan(m.id)?.id !== plan.id) return 'A newer version of the plan has come since: approve that one';
      }
      return ctx.engine.approvePlan(m.id, who);
    }),
    'kanban.plan.requestChanges': viaEngine<'kanban.plan.requestChanges'>((m, who) => ctx.engine.requestPlanChanges(m.id, who, m.text, m.attachmentIds)),
    'kanban.task.pr': viaEngine<'kanban.task.pr'>((m, who) => ctx.engine.pr(m.id, who, m.mode)),

    'kanban.settings.get': (c, m) => c.send({ t: 'kanban.settings', ...(m.rid ? { rid: m.rid } : {}), settings: ctx.settings.get(), secrets: ctx.secrets.status() }),
    // What ⚙️ Settings needs without a board: no cards are built.
    'kanban.meta.get': (c, m) =>
      c.send({ t: 'kanban.meta', ...(m.rid ? { rid: m.rid } : {}), projects: projectInfos(ctx), settings: ctx.settings.get(), secrets: ctx.secrets.status(), me: { admin: c.admin, name: c.name } }),
    'kanban.settings.set': (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      ctx.settings.set(m.settings);
      settingsChanged();
      ok(c, m.rid);
    },
    'kanban.project.settings.set': (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      ctx.settings.setProject(m.project, m.settings);
      settingsChanged();
      // The floor's issues board follows the sources: theirs now, or its own repository's without any.
      if (m.settings && 'issueSources' in m.settings) wallSourcesChanged(m.project);
      ok(c, m.rid);
    },
    'kanban.project.repos.set': (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      // setRepos checks every folder (projects.ts validateProjectRepos).
      const err = ctx.setRepos(m.project, m.repos as Parameters<KanbanContext['setRepos']>[1]);
      if (typeof err === 'string' && err) return fail(c, m.rid, err);
      ctx.broadcast({ t: 'kanban.projects', projects: projectInfos(ctx) }, null);
      ok(c, m.rid);
    },
    'kanban.project.rename': (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      const err = ctx.setName(m.project, m.name);
      if (typeof err === 'string' && err) return fail(c, m.rid, err);
      ctx.broadcast({ t: 'kanban.projects', projects: projectInfos(ctx) }, null);
      ok(c, m.rid);
    },
    'kanban.project.prompt.set': (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      if (!isKanbanPromptId(m.id)) return fail(c, m.rid, `${m.id} isn't a kanban prompt`);
      if (m.text !== null && m.text.trim().length > PROMPT_MAX) return fail(c, m.rid, `A prompt can be ${PROMPT_MAX.toLocaleString('en-US')} characters at most`);
      const err = ctx.settings.setProjectPrompt(m.project, m.id, m.text);
      if (err) return fail(c, m.rid, err);
      settingsChanged();
      ok(c, m.rid);
    },
    'kanban.secrets.set': (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      const patch: Parameters<KanbanContext['secrets']['set']>[0] = {};
      if (m.jira !== undefined) patch.jira = m.jira;
      if (m.apiKey !== undefined) patch.apiKey = m.apiKey;
      let secrets;
      try {
        secrets = ctx.secrets.set(patch);
      } catch (err) {
        console.error(`agent-office: couldn't save the kanban secrets: ${(err as Error).message}`);
        return fail(c, m.rid, "The office couldn't save them");
      }
      // Only whether they're set, never what they are: to the asker, then to everyone.
      const settings = ctx.settings.get();
      c.send({ t: 'kanban.settings', ...(m.rid ? { rid: m.rid } : {}), settings, secrets });
      ctx.broadcast({ t: 'kanban.settings', settings, secrets }, null);
    },
  };

  const sweep = () => {
    try {
      archiveOldTasks(ctx);
      sweepOrphanUploads(ctx, Date.now() - ORPHAN_MAX_AGE_MS);
    } catch (err) {
      console.error(`agent-office: the kanban's hourly tidy-up failed: ${(err as Error).message}`);
    }
  };

  return {
    name: 'core',
    ws,
    http: uploadRoutes(ctx),
    start() {
      try {
        // An uploads folder from before it was made private keeps its old mode otherwise.
        if (existsSync(uploadsDir(ctx.filesDir))) chmodSync(uploadsDir(ctx.filesDir), 0o700);
      } catch (err) {
        console.error(`agent-office: couldn't make the kanban's uploads folder private: ${(err as Error).message}`);
      }
      sweep();
      sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
      sweepTimer.unref?.();
    },
    stop() {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    },
  };
}
