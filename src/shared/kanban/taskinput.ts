// The parser of a new task's fields (kanban.task.create, and the `task` of kanban.issues.createTask) and
// the field helpers kanban.task.update shares. It imports only validate.ts and types.ts: issueops.ts
// needs it and protocol.ts imports issueops.ts, so reaching back into protocol.ts would make a cycle.

import type { ImplementPermission, KanbanEffort, KanbanTool, PlanApproval, ReviewSettings, TaskType } from './types.js';
import { KANBAN_EFFORTS, KANBAN_TOOLS, TASK_TYPES } from './types.js';
import { KANBAN_LIMITS, PROJECT_ID_RE, bad, bool, isObj, list, model, optInt, optOneOf, optText, project, text, type Obj } from './validate.js';

/**
 * A ProjectRepo id. Short, so `<floorId>~<repoId>` (the synthetic RepoSource.floor of a project's other
 * repositories) fits in the 64 characters upstream's Changes messages take.
 */
export const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
export const ATTACHMENT_ID_RE = /^[a-f0-9]{16,64}$/;
/** A new task, as the create dialog (or an issue) sends it. Unset fields take the project's and office's defaults. */
export interface KanbanTaskInput {
  project: string;
  title: string;
  description?: string;
  type?: TaskType;
  ticket?: string;
  ticketUrl?: string;
  /** Subset of the project's repositories; null or unset: all of them. */
  repoIds?: string[] | null;
  tool?: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  usePlan?: boolean;
  planApproval?: PlanApproval;
  useReview?: boolean;
  goal?: string;
  review?: Partial<ReviewSettings>;
  implementPermission?: ImplementPermission;
  tags?: string[];
  /** Uploaded files (POST /api/kanban/upload) to attach. */
  attachmentIds?: string[];
}

export function repoIds(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const ids = list(v, 'repoIds', KANBAN_LIMITS.repoIds, (x) => {
    // The primary repository's id is its floor's id (up to 40 characters), the others' are short.
    if (typeof x !== 'string' || !(REPO_ID_RE.test(x) || PROJECT_ID_RE.test(x))) bad('repoIds must be repository ids');
    return x as string;
  });
  if (!ids.length) bad('Pick at least one repository');
  return ids;
}
export function attachmentIds(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  return list(v, 'attachmentIds', KANBAN_LIMITS.attachments, (x) => {
    if (typeof x !== 'string' || !ATTACHMENT_ID_RE.test(x)) bad('attachmentIds must be attachment ids');
    return x as string;
  });
}
export function tags(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  return list(v, 'tags', KANBAN_LIMITS.tags, (x) => text(x, 'A tag', KANBAN_LIMITS.tag).trim()).filter(Boolean);
}
export function review(v: unknown): Partial<ReviewSettings> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) bad('review must be an object');
  const r = v as Obj;
  const out: Partial<ReviewSettings> = {};
  const tool = optOneOf(r.tool, 'review.tool', KANBAN_TOOLS);
  if (tool) out.tool = tool;
  const m = model(r.model);
  if (m) out.model = m;
  const effort = optOneOf(r.effort, 'review.effort', KANBAN_EFFORTS);
  if (effort) out.effort = effort;
  const rounds = optInt(r.rounds, 'review.rounds', 1, 10);
  if (rounds !== undefined) out.rounds = rounds;
  const re = bool(r.reReviewLastFix, 'review.reReviewLastFix');
  if (re !== undefined) out.reReviewLastFix = re;
  const sandbox = bool(r.sandbox, 'review.sandbox');
  if (sandbox !== undefined) out.sandbox = sandbox;
  return out;
}
export const PLAN_APPROVALS: readonly PlanApproval[] = ['auto', 'manual'];
export const PERMISSIONS: readonly ImplementPermission[] = ['bypass', 'workspace-write'];

/**
 * The task form's fields for a task made from an issue (`kanban.issues.createTask`'s `task`). The issue
 * decides `ticket` and `ticketUrl`, the message `project`, and the title defaults to the issue's, so the
 * title is optional here and those three are never read.
 */
export type IssueTaskFields = Omit<KanbanTaskInput, 'project' | 'title' | 'ticket' | 'ticketUrl'> & { title?: string };

/** The fields both parsers read the same way: everything but project, title, ticket and ticketUrl. */
function sharedFields(r: Obj): IssueTaskFields {
  const out: IssueTaskFields = {};
  const assign = <K extends keyof IssueTaskFields>(k: K, val: IssueTaskFields[K] | undefined) => {
    if (val !== undefined) out[k] = val;
  };
  assign('description', optText(r.description, 'The description', KANBAN_LIMITS.description));
  assign('type', optOneOf(r.type, 'type', TASK_TYPES));
  assign('repoIds', repoIds(r.repoIds));
  assign('tool', optOneOf(r.tool, 'tool', KANBAN_TOOLS));
  assign('model', model(r.model));
  assign('effort', optOneOf(r.effort, 'effort', KANBAN_EFFORTS));
  assign('usePlan', bool(r.usePlan, 'usePlan'));
  assign('planApproval', optOneOf(r.planApproval, 'planApproval', PLAN_APPROVALS));
  assign('useReview', bool(r.useReview, 'useReview'));
  assign('goal', optText(r.goal, 'The acceptance criteria', KANBAN_LIMITS.goal)?.trim() || undefined);
  assign('review', review(r.review));
  assign('implementPermission', optOneOf(r.implementPermission, 'implementPermission', PERMISSIONS));
  assign('tags', tags(r.tags));
  assign('attachmentIds', attachmentIds(r.attachmentIds));
  return out;
}

export function taskInput(v: unknown): KanbanTaskInput {
  if (!isObj(v)) bad('task must be an object');
  const r = v as Obj;
  const out: KanbanTaskInput = { ...sharedFields(r), project: project(r.project), title: text(r.title, 'The title', KANBAN_LIMITS.title).trim() };
  const ticket = optText(r.ticket, 'The ticket', KANBAN_LIMITS.ticket)?.trim() || undefined;
  if (ticket !== undefined) out.ticket = ticket;
  const ticketUrl = url(r.ticketUrl);
  if (ticketUrl !== undefined) out.ticketUrl = ticketUrl;
  return out;
}

/** An empty title is left out (the issue's own is used then). */
export function issueTaskInput(v: unknown): IssueTaskFields {
  if (!isObj(v)) bad('task must be an object');
  const r = v as Obj;
  const out = sharedFields(r);
  const title = optText(r.title, 'The title', KANBAN_LIMITS.title)?.trim();
  if (title) out.title = title;
  return out;
}
export function url(v: unknown): string | undefined {
  const s = optText(v, 'The link', KANBAN_LIMITS.url)?.trim();
  if (!s) return undefined;
  if (!/^https?:\/\/\S+$/.test(s)) bad('The link must be an http(s) URL');
  return s;
}
