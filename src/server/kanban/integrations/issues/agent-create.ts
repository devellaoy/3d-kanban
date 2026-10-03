// POST /office/tasks/create: an agent in the office puts work on the board (the MCP tool create_task,
// `office-tasks create`). It goes the way the board's own create goes (createBoardTask, or
// createFromIssue for an issue, which also assigns the issue to the person), so the task is the same.
// The asking worker's hook token says who it is; a person is named as the creator whenever the office
// can tell who the worker runs as, and the agent is recorded beside them (the `created` event's `via`).

import type { KanbanCaller, KanbanContext, KanbanHookHandler } from '../../registry.js';
import { KANBAN_EFFORTS, isKanbanTool, type KanbanEffort, type KanbanTool, type TaskType } from '../../../../shared/kanban/types.js';
import { GH_REPO_RE } from '../../../../shared/kanban/protocol.js';
import { checkRepoIds, createBoardTask } from '../../create.js';
import { BODY_MAX, readJson, sendJson } from '../util.js';
import { JIRA_KEY_RE } from './browse/jql.js';
import type { IssueCaller, IssueTaskOptions, IssueTaskResult } from './index.js';

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 100_000;
const NOTE_FROM_TASK_WORKER = "Created in To do: a task's worker can't start tasks; a person starts it from the board.";

/** An agent's request once checked: the project is an id, the repositories are ids, the issue is a key. */
export interface CreateRequest {
  project: string;
  title?: string;
  description?: string;
  repoIds?: string[];
  issue?: string;
  ticket?: string;
  ticketUrl?: string;
  tool?: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  type?: TaskType;
  start: boolean;
  deskId?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A field that may be left out: its text trimmed (undefined when empty), or why it isn't text. */
function text(body: Record<string, unknown>, field: string, max: number): string | undefined | { error: string } {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return { error: `${field} must be text` };
  const t = v.trim();
  if (t.length > max) return { error: `${field} may be at most ${max.toLocaleString('en-US')} characters` };
  return t || undefined;
}

const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

/** The project's GitHub repositories (owner/name): its checkouts' remotes and its GitHub repository sources', each once. */
function githubRepos(ctx: KanbanContext, project: string): string[] {
  const named = ctx.settings.project(project).issueSources.flatMap((s) => (s.kind === 'github-repo' ? s.repos : []));
  const all = [...ctx.repos(project).flatMap((r) => (r.kind === 'git' && r.remote ? [r.remote] : [])), ...named].filter((r) => GH_REPO_RE.test(r));
  return all.filter((r, i) => all.findIndex((x) => same(x, r)) === i);
}

/** An issue as the agent wrote it (12, "#12", "o/app#12", gh:…, ghp:…, a Jira key) as the key the issue sources use, or why not. */
function issueKey(ctx: KanbanContext, project: string, v: unknown): string | { error: string } {
  const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (typeof v !== 'number' && typeof v !== 'string') return { error: 'issue must be an issue number or key' };
  if (/^#?\d+$/.test(raw)) {
    const n = Number(raw.replace('#', ''));
    if (!Number.isSafeInteger(n) || n <= 0) return { error: `${raw} isn't an issue number` };
    const repos = githubRepos(ctx, project);
    return repos.length === 1 ? `gh:${repos[0]}#${n}` : { error: `${raw} could be an issue of ${repos.length ? repos.join(' or ') : 'any repository'}: give owner/repo#${n}` };
  }
  if (/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#\d{1,12}$/.test(raw)) return `gh:${raw}`;
  if (/^(gh|ghp):\S+$/.test(raw) || JIRA_KEY_RE.test(raw)) return raw;
  return { error: `${raw.slice(0, 80)} isn't an issue: give a number, owner/repo#n or a Jira key` };
}

/** What an agent asked for, checked against the office, or why it can't be done. Pure: nothing is changed. */
export function readCreateRequest(body: unknown, ctx: KanbanContext, floorId: string): CreateRequest | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Send JSON: {"title": "…", "description": "…"}';
  const b = body as Record<string, unknown>;
  const fields: Record<'title' | 'description' | 'project' | 'ticket' | 'ticketUrl' | 'model' | 'deskId', string | undefined> = {} as never;
  const limits = { title: TITLE_MAX * 4, description: DESCRIPTION_MAX, project: 200, ticket: 200, ticketUrl: 2000, model: 200, deskId: 100 };
  for (const [name, max] of Object.entries(limits) as [keyof typeof fields, number][]) {
    const got = text(b, name === 'deskId' ? 'desk' : name, max);
    if (isError(got)) return got.error;
    fields[name] = got;
  }
  // A title is one line.
  const title = fields.title?.replace(/\s+/g, ' ').trim();
  if (title && title.length > TITLE_MAX) return `title may be at most ${TITLE_MAX} characters`;
  if (fields.ticketUrl && !/^https?:\/\//i.test(fields.ticketUrl)) return 'ticketUrl must be an http(s) link';

  let project = floorId;
  if (fields.project) {
    const asked = fields.project;
    const def = ctx.project(asked) ?? ctx.projects().find((d) => same(d.name, asked));
    if (!def) return `There's no project ${asked}`;
    project = def.id;
  }
  if (!ctx.project(project)) return `There's no project ${project}`;

  let repoIds: string[] | undefined;
  if (b.repos !== undefined && b.repos !== null) {
    if (!Array.isArray(b.repos) || b.repos.some((r) => typeof r !== 'string')) return 'repos must be a list of repository names';
    const have = ctx.repos(project);
    const ids: string[] = [];
    for (const r of (b.repos as string[]).map((x) => x.trim()).filter(Boolean)) {
      const hit = have.find((x) => x.id === r) ?? have.find((x) => same(x.name, r));
      if (!hit) return `${r} isn't one of the project's repositories (${have.map((x) => x.name).join(', ') || 'none'})`;
      if (!ids.includes(hit.id)) ids.push(hit.id);
    }
    const why = checkRepoIds(ctx, project, ids);
    if (why) return why;
    if (ids.length) repoIds = ids;
  }

  let issue: string | undefined;
  if (b.issue !== undefined && b.issue !== null && b.issue !== '') {
    const key = issueKey(ctx, project, b.issue);
    if (isError(key)) return key.error;
    issue = key;
  }
  if (!issue) {
    if (!title) return 'title is required (or give an issue)';
    if (!fields.description) return 'description is required (or give an issue): say what is to be done, as the worker has nothing else to go on';
  }

  let tool: KanbanTool | undefined;
  if (b.provider !== undefined && b.provider !== null) {
    if (!isKanbanTool(b.provider)) return `provider must be claude or codex, not ${String(b.provider).slice(0, 40)}`;
    tool = b.provider;
  }
  let effort: KanbanEffort | undefined;
  if (b.effort !== undefined && b.effort !== null) {
    if (!KANBAN_EFFORTS.includes(b.effort as KanbanEffort)) return `effort must be one of ${KANBAN_EFFORTS.join(', ')}`;
    effort = b.effort as KanbanEffort;
  }
  let type: TaskType | undefined;
  if (b.type !== undefined && b.type !== null) {
    if (b.type !== 'implement' && b.type !== 'investigate') return 'type must be implement or investigate';
    type = b.type;
  }
  if (b.start !== undefined && typeof b.start !== 'boolean') return 'start must be true or false';

  return {
    project,
    ...(title ? { title } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(repoIds ? { repoIds } : {}),
    ...(issue ? { issue } : {}),
    ...(!issue && fields.ticket ? { ticket: fields.ticket } : {}),
    ...(!issue && fields.ticketUrl ? { ticketUrl: fields.ticketUrl } : {}),
    ...(tool ? { tool } : {}),
    ...(fields.model ? { model: fields.model } : {}),
    ...(effort ? { effort } : {}),
    ...(type ? { type } : {}),
    start: b.start === true,
    ...(fields.deskId ? { deskId: fields.deskId } : {}),
  };
}

type CreateFromIssue = (project: string, key: string, who: IssueCaller, opts?: IssueTaskOptions) => Promise<IssueTaskResult | string>;

/** The route handler; `createFromIssue` is the issues plugin's own (it alone can look an issue up). */
export function agentCreateHook(ctx: KanbanContext, createFromIssue: CreateFromIssue): KanbanHookHandler {
  return async (req, res, url, hook) => {
    // This plugin answers the whole prefix, so a neighbour like /office/tasks/createX isn't left to the refs plugin's 405.
    if (url.pathname !== '/office/tasks/create') return sendJson(res, 404, { error: 'Not found' }), true;
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' }), true;
    if (hook.kind === 'shell') return sendJson(res, 403, { error: 'Only agents can create tasks, not a plain shell' }), true;
    const body = await readJson(req, BODY_MAX);
    if (typeof body === 'string') return sendJson(res, 400, { error: body }), true;
    const asked = readCreateRequest(body, ctx, hook.floorId);
    if (typeof asked === 'string') return sendJson(res, 400, { error: asked }), true;

    const agent = hook.name ?? hook.workerId;
    const parentId = hook.taskId;
    const parent = parentId !== undefined ? ctx.repo.getTask(parentId) : undefined;
    // Who the task is the work of: the person the agent runs as; else whoever made the task it works for; else whoever hired a desk worker (which may be another agent); else the agent.
    const createdBy = hook.accountName ?? parent?.createdBy ?? (parentId === undefined && !hook.station && hook.hiredBy ? hook.hiredBy : agent);
    const who: IssueCaller & KanbanCaller = { name: createdBy, admin: false, ...(hook.accountId ? { accountId: hook.accountId } : {}), warn: (t) => ctx.toast(hook.floorId, t, 'warn') };
    // A task's worker runs unattended: what it makes waits in To do for a person, or one task could start many.
    const start = asked.start && parentId === undefined;
    const event = { via: agent, viaWorker: hook.workerId, ...(parentId !== undefined ? { viaTask: parentId } : {}) };

    let answered = false;
    /** The agent's answer, and what the floor and the parent task hear: before an issue is assigned, so a slow GitHub can't time the agent out into asking again. */
    const finish = (taskId: number, existed: boolean, started: boolean, startError: string | undefined) => {
      answered = true;
      const task = ctx.repo.getTask(taskId)!;
      if (!existed) {
        ctx.toast(hook.floorId, `📋 ${agent} created task #${task.id} “${task.title}”`, 'info');
        if (parent) {
          ctx.repo.appendEvent(parent.id, 'subtask.created', { taskId: task.id, by: agent });
          ctx.repo.addComment({ taskId: parent.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: `Created #${task.id} “${task.title}”` });
          ctx.taskChanged(parent.id);
        }
      }
      const note = existed ? (started ? undefined : `Task #${task.id} was made from this issue before`) : asked.start && !start ? NOTE_FROM_TASK_WORKER : undefined;
      sendJson(res, 200, {
        ok: true,
        task: { id: task.id, title: task.title, status: task.status, runState: task.runState, project: task.project, ...(task.ticket ? { ticket: task.ticket } : {}), url: `/kanban?task=${task.id}` },
        existed,
        started: started && !startError,
        queued: task.runState === 'queued',
        ...(startError ? { startError } : {}),
        ...(note ? { note } : {}),
      });
    };

    if (asked.issue) {
      const input = { ...(asked.title ? { title: asked.title } : {}), ...(asked.description ? { description: asked.description } : {}), ...(asked.tool ? { tool: asked.tool } : {}), ...(asked.model ? { model: asked.model } : {}), ...(asked.effort ? { effort: asked.effort } : {}), ...(asked.repoIds ? { repoIds: asked.repoIds } : {}), ...(asked.type ? { type: asked.type } : {}), event };
      const made = await createFromIssue(asked.project, asked.issue, who, { start, deskId: asked.deskId, input, reply: (r) => finish(r.taskId, r.existed, !!r.started, r.startError) });
      if (typeof made === 'string') return sendJson(res, 400, { error: made }), true;
      if (!answered) finish(made.taskId, made.existed, !!made.started, made.startError);
    } else {
      const made = await createBoardTask(
        ctx,
        {
          project: asked.project,
          title: asked.title!,
          description: asked.description,
          ...(asked.type ? { type: asked.type } : {}),
          ...(asked.ticket ? { ticket: asked.ticket } : {}),
          ...(asked.ticketUrl ? { ticketUrl: asked.ticketUrl } : {}),
          ...(asked.repoIds ? { repoIds: asked.repoIds } : {}),
          ...(asked.tool ? { tool: asked.tool } : {}),
          ...(asked.model ? { model: asked.model } : {}),
          ...(asked.effort ? { effort: asked.effort } : {}),
        },
        who,
        { start, deskId: asked.deskId, event },
      );
      if (typeof made === 'string') return sendJson(res, 400, { error: made }), true;
      finish(made.task.id, false, start && !made.startError, made.startError);
    }
    return true;
  };
}
