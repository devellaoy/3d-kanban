// ai-kanban compatibility on the loopback hook server, so the user's existing skills and scripts
// work by pointing AIKANBAN_API_BASE at the office:
// - GET /api/tasks/reference?ref= answers in ai-kanban's shape (its kanban-task-refs skill reads it).
//   Auth: loopback only and read-only, as ai-kanban had it (no key: the skill sends none); it
//   never includes a terminal tail.
// - A minimal /api/v1 (jira-loop, jira-kanban-feeder): GET projects, GET tasks, GET tasks/:id,
//   POST tasks (idempotent on ticketId), POST tasks/:id/start. Loopback only, and once an API key
//   is set (only its sha256 is kept) every request must carry it (Bearer or X-API-Key). Starting a
//   task runs an agent that may do anything, so without a key nothing is started: any local process
//   could otherwise have one run as the office's user.
// Both refuse what a web page in this machine's browser could send (see loopbackRefusal): another
// Host (DNS rebinding), another Origin, a POST that isn't JSON. They never answer with CORS headers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanCaller, KanbanContext } from '../../registry.js';
import type { KanbanTask, TaskStatus } from '../../../../shared/kanban/types.js';
import { PROJECT_ID_RE } from '../../../../shared/kanban/protocol.js';
import { projectRepos } from '../../projects.js';
import { REF_LIMITS, reportDir, reportFiles, resolveTaskRef } from '../refs/resolve.js';
import { BODY_MAX, BODY_TOO_BIG, clip, createIntegrationTask, fromLoopback, loopbackRefusal, readJson, sendJson } from '../util.js';

// --- The API key (kept hashed: KanbanSecrets.checkApiKey compares) --------------------------------

function presentedKey(req: IncomingMessage): string | undefined {
  const auth = String(req.headers.authorization ?? '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  const header = req.headers['x-api-key'];
  return bearer || (typeof header === 'string' ? header.trim() : undefined) || undefined;
}

// --- ai-kanban's vocabulary -----------------------------------------------------------------------

/** Our columns in ai-kanban's words. */
const LEGACY_STATUS: Record<TaskStatus, string> = { todo: 'todo', in_progress: 'in_progress', waiting: 'waiting', review: 'reviewable', done: 'done', archived: 'history' };
const STATUS_TITLE: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', waiting: 'Waiting', review: 'Review', done: 'Done', archived: 'Archive' };
/** A status as ai-kanban's callers may give it. */
function ourStatus(s: string): TaskStatus | undefined {
  const t = s.trim().toLowerCase();
  if (t === 'reviewable') return 'review';
  if (t === 'history') return 'archived';
  return (Object.keys(LEGACY_STATUS) as TaskStatus[]).find((k) => k === t);
}
const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

function runStatus(t: KanbanTask): string {
  if (t.runState === 'queued') return 'queued';
  if (t.runState !== 'idle') return t.phase === 'plan' ? 'planning' : t.phase === 'review' ? 'reviewing' : 'implementing';
  return t.status === 'waiting' && t.waitingReason === 'failed' ? 'error' : 'idle';
}

// --- GET /api/tasks/reference ---------------------------------------------------------------------

/** One matched task, in the shape ai-kanban's reference endpoint answered with. */
export function legacyReference(ctx: KanbanContext, t: KanbanTask) {
  const def = ctx.project(t.project);
  const primary = def ? projectRepos(def)[0] : undefined;
  const plan = ctx.repo.acceptedPlan(t.id) ?? ctx.repo.latestPlan(t.id);
  const comments = ctx.repo
    .listComments(t.id, { limit: 200 })
    .comments.filter((c) => c.authorKind === 'user' || c.authorKind === 'agent')
    .slice(-REF_LIMITS.comments)
    .map((c) => ({ author: c.authorKind === 'agent' ? 'claude' : 'user', content: clip(c.text, REF_LIMITS.comment), createdAt: iso(c.createdAt) }));
  const dir = reportDir(ctx.filesDir, t.id);
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    ticketId: t.ticket ?? null,
    repository: def?.name ?? t.project,
    repoId: primary?.id ?? t.project,
    branchName: t.branch ?? null,
    taskType: t.type,
    status: LEGACY_STATUS[t.status],
    statusTitle: STATUS_TITLE[t.status],
    runStatus: runStatus(t),
    summary: t.summary ?? null,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    plan: plan ? clip(plan.text, REF_LIMITS.plan) : null,
    comments,
    reportFiles: reportFiles(dir).map((f) => ({ path: f.path, name: f.path.split(/[\\/]/).pop() ?? f.path, size: f.size })),
    reportDir: dir,
  };
}

function legacyCandidate(ctx: KanbanContext, t: KanbanTask) {
  return { id: t.id, title: t.title, ticketId: t.ticket ?? null, status: LEGACY_STATUS[t.status], statusTitle: STATUS_TITLE[t.status], taskType: t.type, repository: ctx.project(t.project)?.name ?? t.project, updatedAt: iso(t.updatedAt) };
}

/** ai-kanban's answer to a reference: one match in full, or candidates to pick from, or neither. */
export function legacyReferenceAnswer(ctx: KanbanContext, ref: string) {
  const matches = resolveTaskRef(ref, ctx.repo.listTasks(null, { includeArchived: true }));
  if (matches.length === 1) return { ok: true, ref, match: legacyReference(ctx, matches[0]), candidates: [] };
  return { ok: true, ref, match: null, candidates: matches.map((t) => legacyCandidate(ctx, t)) };
}

export async function handleLegacyReference(ctx: KanbanContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/tasks/reference') return false;
  if (!fromLoopback(req)) return sendJson(res, 403, { error: 'Only from this machine' }), true;
  const refused = loopbackRefusal(req);
  if (refused) return sendJson(res, refused.status, { error: refused.message }), true;
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' }), true;
  const ref = (url.searchParams.get('ref') ?? '').trim();
  if (!ref) return sendJson(res, 400, { error: 'ref is required: ?ref=<id | #id | ticket id | part of a title>' }), true;
  sendJson(res, 200, legacyReferenceAnswer(ctx, ref.slice(0, 300)));
  return true;
}

// --- /api/v1 --------------------------------------------------------------------------------------

const V1_MESSAGES: Record<string, string> = {
  'api.remoteDenied': 'The API only answers requests from this machine.',
  'api.missingKey': 'An API key is set, so send it as "Authorization: Bearer <key>" or "X-API-Key: <key>".',
  'api.invalidKey': 'Unknown API key.',
  'api.startNeedsKey': 'Starting a task over the API needs an API key: set one in ⚙️ Settings → 🗂️ Kanban and send it.',
  'request.invalid': 'The request could not be read.',
  'request.tooBig': `The request body may be at most ${BODY_MAX / 1024} KB.`,
  'task.notFound': 'Task not found.',
  'task.titleRequired': 'A non-empty "title" is required.',
  'task.descriptionRequired': 'A non-empty "description" is required.',
  'task.alreadyRunning': 'The task is already running; nothing to do.',
  'task.notStartable': 'Only a task in "todo" can be started.',
  'task.startFailed': 'Starting the task failed.',
  'project.notFound': 'Unknown projectId. GET /api/v1/projects lists them.',
  'column.unknownStatus': 'Unknown status.',
  'query.invalidScope': 'Invalid "scope": "active" or "all".',
  'notFound': 'No such route.',
};

function v1Error(res: ServerResponse, status: number, code: string, details?: Record<string, unknown>) {
  sendJson(res, status, { error: { code, message: V1_MESSAGES[code] ?? code, ...(details ? { details } : {}) } });
  return true;
}

/** The v1 API's own caller: the name tasks it makes show as created by. */
const API_CALLER: KanbanCaller = { name: 'API', admin: false };

function publicProject(ctx: KanbanContext, id: string) {
  const def = ctx.project(id);
  if (!def) return null;
  const repos = projectRepos(def);
  return { id: def.id, kind: repos[0].kind === 'git' ? ('repository' as const) : ('folder' as const), name: def.name };
}

function publicTask(ctx: KanbanContext, t: KanbanTask, withDescription = false) {
  return {
    id: t.id,
    title: t.title,
    ...(withDescription ? { description: t.description } : {}),
    ticketId: t.ticket ?? null,
    status: LEGACY_STATUS[t.status],
    statusTitle: STATUS_TITLE[t.status],
    active: t.status !== 'done' && t.status !== 'archived',
    runStatus: runStatus(t),
    running: t.runState !== 'idle',
    taskType: t.type,
    project: publicProject(ctx, t.project),
    branchName: t.branch ?? null,
    summary: t.summary ?? null,
    url: `/kanban?task=${t.id}`,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export async function handleV1(ctx: KanbanContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname.replace(/\/+$/, '');
  if (p !== '/api/v1' && !p.startsWith('/api/v1/')) return false;
  if (!fromLoopback(req)) return v1Error(res, 403, 'api.remoteDenied');
  const refused = loopbackRefusal(req);
  if (refused) return sendJson(res, refused.status, { error: { code: refused.code, message: refused.message } }), true;
  const stored = ctx.secrets.apiKey();
  if (stored) {
    const given = presentedKey(req);
    if (!given) return v1Error(res, 401, 'api.missingKey');
    if (!ctx.secrets.checkApiKey(given)) return v1Error(res, 401, 'api.invalidKey');
  }
  const q = url.searchParams;
  const str = (k: string) => (q.get(k) ?? '').trim();

  if (req.method === 'GET' && p === '/api/v1/projects') {
    const projects = ctx.projects().map((def) => {
      const repos = projectRepos(def);
      return {
        id: def.id,
        kind: repos[0].kind === 'git' ? 'repository' : 'folder',
        name: def.name,
        path: def.dir,
        baseBranch: repos[0].baseBranch ?? null,
        repositories: repos.map((r) => ({ id: r.id, name: r.name, kind: r.kind, path: r.dir, remote: r.remote ?? null, primary: r.primary })),
      };
    });
    return sendJson(res, 200, { projects }), true;
  }

  if (req.method === 'GET' && p === '/api/v1/tasks') {
    const scope = str('scope') || 'active';
    if (scope !== 'active' && scope !== 'all') return v1Error(res, 400, 'query.invalidScope');
    const statusRaw = str('status');
    const status = statusRaw ? ourStatus(statusRaw) : undefined;
    if (statusRaw && !status) return v1Error(res, 400, 'column.unknownStatus', { status: statusRaw });
    const projectId = str('projectId');
    if (projectId && !ctx.project(projectId)) return v1Error(res, 400, 'project.notFound', { id: projectId });
    const ticket = str('ticketId').toLowerCase();
    const text = str('q').toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(str('limit')) || 50));
    const offset = Math.max(0, Number(str('offset')) || 0);
    const all = ctx.repo.listTasks(projectId || null, { includeArchived: true }).filter((t) => {
      if (status ? t.status !== status : scope === 'active' && (t.status === 'done' || t.status === 'archived')) return false;
      if (ticket && (t.ticket ?? '').toLowerCase() !== ticket) return false;
      if (text && !t.title.toLowerCase().includes(text) && !(t.ticket ?? '').toLowerCase().includes(text)) return false;
      return true;
    });
    return sendJson(res, 200, { tasks: all.slice(offset, offset + limit).map((t) => publicTask(ctx, t)), total: all.length, limit, offset }), true;
  }

  const one = /^\/api\/v1\/tasks\/(\d{1,9})(\/start)?$/.exec(p);
  if (one) {
    const id = Number(one[1]);
    const task = ctx.repo.getTask(id);
    if (!task) return v1Error(res, 404, 'task.notFound', { id });
    if (req.method === 'GET' && !one[2]) return sendJson(res, 200, { task: publicTask(ctx, task, true) }), true;
    if (req.method === 'POST' && one[2]) {
      if (!stored) return v1Error(res, 403, 'api.startNeedsKey');
      if (task.runState !== 'idle') return v1Error(res, 409, 'task.alreadyRunning', { id });
      if (task.status !== 'todo') return v1Error(res, 409, 'task.notStartable', { id, status: LEGACY_STATUS[task.status] });
      const err = await ctx.engine.start(id, API_CALLER);
      ctx.taskChanged(id);
      if (typeof err === 'string' && err) return v1Error(res, 400, 'task.startFailed', { detail: err });
      const now = ctx.repo.getTask(id) ?? task;
      return sendJson(res, 200, { task: publicTask(ctx, now, true), queued: now.runState === 'queued' }), true;
    }
  }

  if (req.method === 'POST' && p === '/api/v1/tasks') {
    const body = await readJson(req, BODY_MAX);
    if (body === BODY_TOO_BIG) return v1Error(res, 413, 'request.tooBig');
    if (typeof body === 'string' || !body || typeof body !== 'object' || Array.isArray(body)) return v1Error(res, 400, 'request.invalid', typeof body === 'string' ? { detail: body } : undefined);
    const b = body as Record<string, unknown>;
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const description = typeof b.description === 'string' ? b.description : '';
    if (!title) return v1Error(res, 400, 'task.titleRequired');
    if (!description.trim()) return v1Error(res, 400, 'task.descriptionRequired');
    const projectId = typeof b.projectId === 'string' ? b.projectId.trim() : '';
    if (!PROJECT_ID_RE.test(projectId) || !ctx.project(projectId)) return v1Error(res, 400, 'project.notFound', { id: projectId });
    const ticket = typeof b.ticketId === 'string' && b.ticketId.trim() ? b.ticketId.trim().slice(0, 200) : undefined;
    // Refused before anything is made, so a caller doesn't get a task it didn't want without its start.
    if (b.start === true && !stored) return v1Error(res, 403, 'api.startNeedsKey');
    const made = await createIntegrationTask(
      ctx,
      {
        project: projectId,
        title,
        description,
        ...(ticket ? { ticket } : {}),
        type: b.taskType === 'investigate' ? 'investigate' : 'implement',
        ...(typeof b.usePlan === 'boolean' ? { usePlan: b.usePlan } : {}),
      },
      API_CALLER,
      b.start === true,
    );
    const started = b.start === true && !made.startError && made.task.status !== 'todo';
    return (
      sendJson(res, made.existed ? 200 : 201, {
        task: publicTask(ctx, made.task, true),
        created: !made.existed,
        started,
        startError: made.startError ? { code: 'task.startFailed', message: made.startError } : null,
      }),
      true
    );
  }
  return v1Error(res, 404, 'notFound');
}
