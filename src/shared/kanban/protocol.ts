// The kanban's WebSocket messages (docs/kanban-architecture.md §6), joined into upstream's ClientMsg /
// ServerMsg. Every one is `kanban.<...>`. A request may carry `rid`; the server answers it exactly once:
// with the typed message named on the request (carrying the same rid), or `kanban.ok`, or
// `kanban.error`. Deltas (no rid) go to every client subscribed to the task's project (or to all
// projects). parseKanbanClientMsg is the one gate every browser message passes: types, lengths, enums.

import type {
  ImplementPermission,
  IssueSourceConfig,
  KanbanAttachment,
  KanbanComment,
  KanbanEffort,
  KanbanEvent,
  KanbanPlan,
  KanbanPrBundleItem,
  KanbanPrBundleKey,
  KanbanProjectInfo,
  KanbanRun,
  KanbanSettings,
  KanbanTask,
  KanbanTaskCard,
  KanbanTool,
  NormalizedIssue,
  PlanApproval,
  PrRef,
  ProjectRepo,
  ProjectSettings,
  ReviewSettings,
  SecretStatus,
  SkillInfo,
  SkillSelection,
  TaskStatus,
  TaskType,
} from './types.js';
import { KANBAN_EFFORTS, KANBAN_TOOLS, PR_REVIEW_MAX, TASK_STATUSES, TASK_TYPES } from './types.js';
import { DESK_BY_ID } from '../layout.js';

// --- Limits ---------------------------------------------------------------------------------------

export const KANBAN_LIMITS = {
  rid: 64,
  title: 300,
  description: 100_000,
  comment: 50_000,
  answer: 50_000,
  /** Room for the longest keys the issue sources make: `gh:<owner>/<name>#<n>` takes GH_REPO_RE's 201 characters and more. */
  ticket: 400,
  url: 2000,
  goal: 20_000,
  tag: 40,
  tags: 20,
  model: 100,
  attachments: 20,
  repoIds: 16,
  /** The same keys as ticket. */
  issueKey: 400,
  branch: 200,
  promptText: 20_000,
  secret: 4096,
  commentsPage: 200,
  /** owner/name (GH_REPO_RE, up to 201 characters) or a GitHub URL of it. */
  remote: 300,
  /**
   * How big a settings object the browser may send, as JSON. A project's settings hold three
   * instruction texts and a rewrite of every kanban prompt (PROMPT_MAX each), and JSON can double
   * that with escapes; still under the office's 2 MB WebSocket messages.
   */
  settingsJson: 1_500_000,
} as const;

/** A floor id (see Building.newDef). */
export const PROJECT_ID_RE = /^[a-z0-9-]{1,40}$/;
/**
 * A ProjectRepo id. Short, so `<floorId>~<repoId>` (the synthetic RepoSource.floor of a project's other
 * repositories) fits in the 64 characters upstream's Changes messages take.
 */
export const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
export const ATTACHMENT_ID_RE = /^[a-f0-9]{16,64}$/;
/** Claude aliases (opus, sonnet[1m]) and Codex ids (gpt-5.1-codex), nothing that looks like a flag. */
export const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]-]{0,99}$/;
/** owner/name on GitHub. */
export const GH_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

// --- Inputs ---------------------------------------------------------------------------------------

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

/**
 * What an edit may change. The description is locked once the task has first started (comment
 * instead); the repositories only while it's never been started. `null` clears an optional field.
 */
export interface KanbanTaskPatch {
  title?: string;
  description?: string;
  ticket?: string | null;
  ticketUrl?: string | null;
  repoIds?: string[] | null;
  type?: TaskType;
  tool?: KanbanTool;
  model?: string | null;
  effort?: KanbanEffort | null;
  usePlan?: boolean;
  planApproval?: PlanApproval;
  useReview?: boolean;
  goal?: string | null;
  review?: Partial<ReviewSettings> | null;
  implementPermission?: ImplementPermission | null;
  tags?: string[];
}

/** The office-wide settings, less the per-project ones (those are set with kanban.project.settings.set). */
export type KanbanSettingsPatch = Partial<Omit<KanbanSettings, 'schemaVersion' | 'projects'>>;

/** A repository of a project, as the settings dialog sends it (the server checks the folder). */
export type ProjectRepoInput = Omit<ProjectRepo, 'kind'> & { kind?: ProjectRepo['kind'] };

// --- Browser → server -----------------------------------------------------------------------------

type Req<T> = T & { rid?: string };

export type KanbanClientMsg =
  /** Deltas for one project, or (null) all of them; answered with kanban.snapshot. */
  | Req<{ t: 'kanban.subscribe'; project: string | null; includeArchived?: boolean }>
  | Req<{ t: 'kanban.unsubscribe' }>
  /** The board as it is now; answered with kanban.snapshot. */
  | Req<{ t: 'kanban.snapshot'; project: string | null; includeArchived?: boolean }>
  /** One task in full, with its newest comments; answered with kanban.task.detail. */
  | Req<{ t: 'kanban.task.get'; id: number; comments?: number }>
  /** Older comments (before comment id `before`); answered with kanban.comments. */
  | Req<{ t: 'kanban.comments.page'; id: number; before?: number; limit?: number }>
  /**
   * Answered with kanban.ok {taskId} (and startError when start was asked for and couldn't).
   * `deskId`: with start, its worker is hired at that desk (see kanban.task.start).
   */
  | Req<{ t: 'kanban.task.create'; task: KanbanTaskInput; start?: boolean; deskId?: string }>
  | Req<{ t: 'kanban.task.update'; id: number; patch: KanbanTaskPatch }>
  /** A drag between columns (see moves.ts). */
  | Req<{ t: 'kanban.task.move'; id: number; to: TaskStatus }>
  /** `deskId`: hire its worker at that desk (a desk or bean bag, not a board agent's kiosk or a meeting chair); refused when it's taken or not built. */
  | Req<{ t: 'kanban.task.start'; id: number; deskId?: string }>
  | Req<{ t: 'kanban.task.stop'; id: number }>
  /** Carry on from waiting; `answer` answers the plan's questions (or what the agent asked). */
  | Req<{ t: 'kanban.task.continue'; id: number; answer?: string }>
  /** Run the failed / interrupted phase again. */
  | Req<{ t: 'kanban.task.retry'; id: number }>
  /** One more review round, by hand. */
  | Req<{ t: 'kanban.task.review'; id: number }>
  | Req<{ t: 'kanban.plan.approve'; id: number; planId?: number }>
  | Req<{ t: 'kanban.plan.requestChanges'; id: number; text: string }>
  /** Have the agent open (create) or fix the task's pull requests. */
  | Req<{ t: 'kanban.task.pr'; id: number; mode: 'create' | 'fix' }>
  | Req<{ t: 'kanban.task.compact'; id: number }>
  /** Send the task's workers home, keeping the worktree for later. */
  | Req<{ t: 'kanban.task.release'; id: number }>
  | Req<{ t: 'kanban.task.delete'; id: number }>
  /** Answered with kanban.ok {commentId}. */
  | Req<{ t: 'kanban.comment.add'; id: number; text: string; attachmentIds?: string[] }>
  /** Answered with kanban.settings. */
  | Req<{ t: 'kanban.settings.get' }>
  | Req<{ t: 'kanban.settings.set'; settings: KanbanSettingsPatch }>
  | Req<{ t: 'kanban.project.settings.set'; project: string; settings: Partial<ProjectSettings> }>
  | Req<{ t: 'kanban.project.repos.set'; project: string; repos: ProjectRepoInput[] }>
  /**
   * Admins: clones `remote` (owner/name) into the building's projects folder (or reuses a checkout of
   * it that's there) and adds it to the project's repositories; answered with kanban.ok once it's in.
   */
  | Req<{ t: 'kanban.project.repo.clone'; project: string; remote: string; name?: string }>
  /** A project's own text for a kanban prompt; null goes back to the office's. */
  | Req<{ t: 'kanban.project.prompt.set'; project: string; id: string; text: string | null }>
  /** Answered with kanban.issues. */
  | Req<{ t: 'kanban.issues.list'; project: string }>
  | Req<{ t: 'kanban.issues.refresh'; project: string }>
  /** Idempotent by ticket: answered with kanban.ok {taskId, existed}. */
  | Req<{ t: 'kanban.issues.createTask'; project: string; issueKey: string; start?: boolean }>
  /** Answered with kanban.skills. */
  | Req<{ t: 'kanban.skills.list' }>
  | Req<{ t: 'kanban.skills.sync' }>
  /** Secrets (admins). null clears; the answer only says what's configured (kanban.settings.secrets). */
  | Req<{ t: 'kanban.secrets.set'; jira?: { site: string; email: string; token: string } | null; apiKey?: string | null }>
  /**
   * A review of several pull requests together: answered with kanban.ok {taskId, workerId} (the
   * review's task and its reviewer). With `panel`, the floor's meeting room reviews them instead,
   * answered with kanban.ok {} (and taskId when one was given).
   */
  | Req<{ t: 'kanban.pr.review'; project: string; prs: PrRef[]; taskId?: number; tool?: KanbanTool; model?: string; effort?: KanbanEffort; panel?: boolean }>
  /** The pull requests that belong together (open and draft ones; merged and closed too with includeClosed); answered with kanban.pr.bundle. */
  | Req<{ t: 'kanban.pr.bundle'; project: string; includeClosed?: boolean } & KanbanPrBundleKey>;

export type KanbanClientType = KanbanClientMsg['t'];

// --- Server → browser -----------------------------------------------------------------------------

export type KanbanServerMsg =
  | {
      t: 'kanban.snapshot';
      rid?: string;
      project: string | null;
      tasks: KanbanTaskCard[];
      projects: KanbanProjectInfo[];
      settings: KanbanSettings;
      secrets: SecretStatus;
      me: { admin: boolean; name: string };
    }
  /** A card changed or appeared. */
  | { t: 'kanban.task'; task: KanbanTaskCard }
  | { t: 'kanban.task.removed'; id: number; project: string }
  | {
      t: 'kanban.task.detail';
      rid?: string;
      task: KanbanTask;
      /** Newest page, oldest first. */
      comments: KanbanComment[];
      commentsMore: boolean;
      runs: KanbanRun[];
      plans: KanbanPlan[];
      attachments: KanbanAttachment[];
      events: KanbanEvent[];
    }
  | { t: 'kanban.comments'; rid?: string; taskId: number; comments: KanbanComment[]; more: boolean }
  | { t: 'kanban.comment'; comment: KanbanComment; project: string }
  | { t: 'kanban.run'; run: KanbanRun; project: string }
  | { t: 'kanban.plan'; plan: KanbanPlan; project: string }
  | { t: 'kanban.settings'; rid?: string; settings: KanbanSettings; secrets: SecretStatus }
  | { t: 'kanban.projects'; projects: KanbanProjectInfo[] }
  | { t: 'kanban.issues'; rid?: string; project: string; items: NormalizedIssue[]; error?: string; fetchedAt: number; loading: boolean }
  | { t: 'kanban.skills'; rid?: string; skills: SkillInfo[]; error?: string }
  | { t: 'kanban.pr.bundle'; rid?: string; project: string; key: KanbanPrBundleKey; prs: KanbanPrBundleItem[]; error?: string }
  | { t: 'kanban.ok'; rid?: string; taskId?: number; commentId?: number; workerId?: string; existed?: boolean; startError?: string }
  | { t: 'kanban.error'; rid?: string; message: string };

export type KanbanServerType = KanbanServerMsg['t'];

// --- The validator --------------------------------------------------------------------------------

class Bad extends Error {}
const bad = (why: string): never => {
  throw new Bad(why);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function text(v: unknown, name: string, max: number, opts: { empty?: boolean } = {}): string {
  if (typeof v !== 'string') bad(`${name} must be text`);
  const s = (v as string).replace(/\r\n?/g, '\n');
  if (s.length > max) bad(`${name} is too long (at most ${max.toLocaleString('en-US')} characters)`);
  if (!opts.empty && !s.trim()) bad(`${name} can't be empty`);
  return s;
}
function optText(v: unknown, name: string, max: number): string | undefined {
  return v === undefined ? undefined : text(v, name, max, { empty: true });
}
/** undefined: leave it; null: clear it. */
function nullableText(v: unknown, name: string, max: number): string | null | undefined {
  if (v === null) return null;
  return optText(v, name, max);
}
function id(v: unknown, name = 'id'): number {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) bad(`${name} must be a task number`);
  return v as number;
}
function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return v as number;
}
function bool(v: unknown, name: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') bad(`${name} must be true or false`);
  return v as boolean;
}
function oneOf<T extends string>(v: unknown, name: string, all: readonly T[]): T {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) bad(`${name} must be one of ${all.join(', ')}`);
  return v as T;
}
function optOneOf<T extends string>(v: unknown, name: string, all: readonly T[]): T | undefined {
  return v === undefined ? undefined : oneOf(v, name, all);
}
function project(v: unknown): string {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('project must be a floor id');
  return v as string;
}
/** A seat a task's worker can be hired at: a desk or bean bag of the layout, not a board agent's kiosk or a meeting chair. */
function deskId(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const desk = typeof v === 'string' && v.length <= 40 ? DESK_BY_ID.get(v) : undefined;
  if (!desk || desk.station || desk.room) bad('deskId must be a desk of the floor');
  return v as string;
}
function model(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !MODEL_RE.test(v)) bad('model must be a model id like opus or gpt-5-codex');
  return v as string;
}
function list<T>(v: unknown, name: string, max: number, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) bad(`${name} must be a list`);
  const arr = v as unknown[];
  if (arr.length > max) bad(`${name} can have at most ${max} entries`);
  return [...new Set(arr.map(item))];
}
function repoIds(v: unknown): string[] | null | undefined {
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
function attachmentIds(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  return list(v, 'attachmentIds', KANBAN_LIMITS.attachments, (x) => {
    if (typeof x !== 'string' || !ATTACHMENT_ID_RE.test(x)) bad('attachmentIds must be attachment ids');
    return x as string;
  });
}
function tags(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  return list(v, 'tags', KANBAN_LIMITS.tags, (x) => text(x, 'A tag', KANBAN_LIMITS.tag).trim()).filter(Boolean);
}
/** A settings-like object: just its shape and size here; server/kanban/settings.ts sanitises every field. */
function settingsObj(v: unknown, name: string): Obj {
  if (!isObj(v)) bad(`${name} must be an object`);
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return bad(`${name} can't be read`);
  }
  if (json.length > KANBAN_LIMITS.settingsJson) bad(`${name} is too big`);
  return v as Obj;
}
function review(v: unknown): Partial<ReviewSettings> | undefined {
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
const PLAN_APPROVALS: readonly PlanApproval[] = ['auto', 'manual'];
const PERMISSIONS: readonly ImplementPermission[] = ['bypass', 'workspace-write'];

function taskInput(v: unknown): KanbanTaskInput {
  if (!isObj(v)) bad('task must be an object');
  const r = v as Obj;
  const out: KanbanTaskInput = { project: project(r.project), title: text(r.title, 'The title', KANBAN_LIMITS.title).trim() };
  const assign = <K extends keyof KanbanTaskInput>(k: K, val: KanbanTaskInput[K] | undefined) => {
    if (val !== undefined) out[k] = val;
  };
  assign('description', optText(r.description, 'The description', KANBAN_LIMITS.description));
  assign('type', optOneOf(r.type, 'type', TASK_TYPES));
  assign('ticket', optText(r.ticket, 'The ticket', KANBAN_LIMITS.ticket)?.trim() || undefined);
  assign('ticketUrl', url(r.ticketUrl));
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
function url(v: unknown): string | undefined {
  const s = optText(v, 'The link', KANBAN_LIMITS.url)?.trim();
  if (!s) return undefined;
  if (!/^https?:\/\/\S+$/.test(s)) bad('The link must be an http(s) URL');
  return s;
}
function taskPatch(v: unknown): KanbanTaskPatch {
  if (!isObj(v)) bad('patch must be an object');
  const r = v as Obj;
  const out: KanbanTaskPatch = {};
  const assign = <K extends keyof KanbanTaskPatch>(k: K, val: KanbanTaskPatch[K] | undefined) => {
    if (val !== undefined) out[k] = val;
  };
  if (r.title !== undefined) out.title = text(r.title, 'The title', KANBAN_LIMITS.title).trim();
  assign('description', optText(r.description, 'The description', KANBAN_LIMITS.description));
  const ticket = nullableText(r.ticket, 'The ticket', KANBAN_LIMITS.ticket);
  assign('ticket', ticket === null ? null : ticket?.trim() || (ticket === undefined ? undefined : null));
  assign('ticketUrl', r.ticketUrl === null ? null : url(r.ticketUrl));
  assign('repoIds', repoIds(r.repoIds));
  assign('type', optOneOf(r.type, 'type', TASK_TYPES));
  assign('tool', optOneOf(r.tool, 'tool', KANBAN_TOOLS));
  assign('model', r.model === null ? null : model(r.model));
  assign('effort', r.effort === null ? null : optOneOf(r.effort, 'effort', KANBAN_EFFORTS));
  assign('usePlan', bool(r.usePlan, 'usePlan'));
  assign('planApproval', optOneOf(r.planApproval, 'planApproval', PLAN_APPROVALS));
  assign('useReview', bool(r.useReview, 'useReview'));
  const goal = nullableText(r.goal, 'The acceptance criteria', KANBAN_LIMITS.goal);
  assign('goal', goal === null ? null : goal === undefined ? undefined : goal.trim() || null);
  assign('review', r.review === null ? null : review(r.review));
  assign('implementPermission', r.implementPermission === null ? null : optOneOf(r.implementPermission, 'implementPermission', PERMISSIONS));
  assign('tags', tags(r.tags));
  if (!Object.keys(out).length) bad('Nothing to change');
  return out;
}
function prRefs(v: unknown): PrRef[] {
  const seen = new Set<string>();
  const prs = list(v, 'prs', PR_REVIEW_MAX, (x) => {
    if (!isObj(x)) bad('prs must be pull requests: {repo, number}');
    const p = x as Obj;
    if (typeof p.repo !== 'string' || !GH_REPO_RE.test(p.repo)) bad('A pull request needs its repository as owner/name');
    if (!Number.isSafeInteger(p.number) || (p.number as number) <= 0) bad('A pull request needs its number');
    return { repo: p.repo as string, number: p.number as number };
  }).filter((p) => {
    const key = `${p.repo.toLowerCase()}#${p.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!prs.length) bad('Pick at least one pull request');
  return prs;
}
function repoInputs(v: unknown): ProjectRepoInput[] {
  return list(v, 'repos', KANBAN_LIMITS.repoIds + 1, (x) => {
    if (!isObj(x)) bad('repos must be repositories');
    const r = x as Obj;
    if (typeof r.id !== 'string' || !(PROJECT_ID_RE.test(r.id) || REPO_ID_RE.test(r.id))) bad('A repository needs an id (lower-case letters, digits and -)');
    const out: ProjectRepoInput = {
      id: r.id as string,
      name: text(r.name, "A repository's name", 100).trim(),
      dir: text(r.dir, "A repository's folder", 4096).trim(),
      primary: r.primary === true,
    };
    const kind = optOneOf(r.kind, 'kind', ['git', 'folder'] as const);
    if (kind) out.kind = kind;
    const remote = optText(r.remote, 'remote', KANBAN_LIMITS.remote)?.trim();
    if (remote) out.remote = remote;
    const base = optText(r.baseBranch, 'baseBranch', KANBAN_LIMITS.branch)?.trim();
    if (base) out.baseBranch = base;
    const ins = optText(r.instructions, 'instructions', KANBAN_LIMITS.promptText);
    if (ins?.trim()) out.instructions = ins;
    return out;
  });
}
function bundleKey(r: Obj): KanbanPrBundleKey {
  const keys = ['taskId', 'branch', 'ticket'].filter((k) => r[k] !== undefined);
  if (keys.length !== 1) bad('Give exactly one of taskId, branch or ticket');
  if (r.taskId !== undefined) return { taskId: id(r.taskId, 'taskId') };
  if (r.branch !== undefined) return { branch: text(r.branch, 'The branch', KANBAN_LIMITS.branch).trim() };
  return { ticket: text(r.ticket, 'The ticket', KANBAN_LIMITS.ticket).trim() };
}

/** Every message type the browser may send. */
export const KANBAN_CLIENT_TYPES = new Set<string>([
  'kanban.subscribe', 'kanban.unsubscribe', 'kanban.snapshot', 'kanban.task.get', 'kanban.comments.page',
  'kanban.task.create', 'kanban.task.update', 'kanban.task.move', 'kanban.task.start', 'kanban.task.stop',
  'kanban.task.continue', 'kanban.task.retry', 'kanban.task.review', 'kanban.plan.approve', 'kanban.plan.requestChanges',
  'kanban.task.pr', 'kanban.task.compact', 'kanban.task.release', 'kanban.task.delete', 'kanban.comment.add',
  'kanban.settings.get', 'kanban.settings.set', 'kanban.project.settings.set', 'kanban.project.repos.set', 'kanban.project.prompt.set',
  'kanban.issues.list', 'kanban.issues.refresh', 'kanban.issues.createTask', 'kanban.skills.list', 'kanban.skills.sync',
  'kanban.secrets.set', 'kanban.pr.review', 'kanban.pr.bundle',
  'kanban.project.repo.clone',
] satisfies KanbanClientType[]);

/** Whether a raw message is meant for the kanban (its `t` starts with `kanban.`). */
export function isKanbanMsg(raw: unknown): raw is { t: string } {
  return isObj(raw) && typeof raw.t === 'string' && raw.t.startsWith('kanban.');
}

/**
 * Checks a message from a browser field by field and rebuilds it from what passed, so nothing it
 * didn't check gets through. Returns the message, or why it's refused. `rid` of a refused message is
 * in ridOf, for answering it.
 */
export function parseKanbanClientMsg(raw: unknown): KanbanClientMsg | string {
  try {
    return parse(raw);
  } catch (err) {
    if (err instanceof Bad) return err.message;
    throw err;
  }
}

/** The request id of a raw message, if it has a usable one. */
export function ridOf(raw: unknown): string | undefined {
  const rid = isObj(raw) ? raw.rid : undefined;
  return typeof rid === 'string' && rid.length > 0 && rid.length <= KANBAN_LIMITS.rid ? rid : undefined;
}

type WithoutRid<T> = T extends unknown ? Omit<T, 'rid'> : never;

function parse(raw: unknown): KanbanClientMsg {
  if (!isKanbanMsg(raw)) bad('Not a kanban message');
  const r = raw as unknown as Obj;
  const t = r.t as string;
  if (!KANBAN_CLIENT_TYPES.has(t)) bad(`Unknown kanban message ${t.slice(0, 60)}`);
  if (r.rid !== undefined && ridOf(r) === undefined) bad(`rid must be text of at most ${KANBAN_LIMITS.rid} characters`);
  const rid = ridOf(r);
  const m = (msg: WithoutRid<KanbanClientMsg>): KanbanClientMsg => (rid ? { ...msg, rid } : msg) as KanbanClientMsg;
  const nullableProject = (v: unknown) => (v === null || v === undefined ? null : project(v));
  switch (t as KanbanClientType) {
    case 'kanban.subscribe':
    case 'kanban.snapshot':
      return m({ t: t as 'kanban.subscribe', project: nullableProject(r.project), ...(bool(r.includeArchived, 'includeArchived') ? { includeArchived: true } : {}) });
    case 'kanban.unsubscribe':
    case 'kanban.settings.get':
    case 'kanban.skills.list':
    case 'kanban.skills.sync':
      return m({ t: t as 'kanban.unsubscribe' });
    case 'kanban.task.get': {
      const comments = optInt(r.comments, 'comments', 0, KANBAN_LIMITS.commentsPage);
      return m({ t: 'kanban.task.get', id: id(r.id), ...(comments !== undefined ? { comments } : {}) });
    }
    case 'kanban.comments.page': {
      const before = optInt(r.before, 'before', 1, Number.MAX_SAFE_INTEGER);
      const limit = optInt(r.limit, 'limit', 1, KANBAN_LIMITS.commentsPage);
      return m({ t: 'kanban.comments.page', id: id(r.id), ...(before !== undefined ? { before } : {}), ...(limit !== undefined ? { limit } : {}) });
    }
    case 'kanban.task.create': {
      const desk = deskId(r.deskId);
      return m({ t: 'kanban.task.create', task: taskInput(r.task), ...(bool(r.start, 'start') ? { start: true } : {}), ...(desk ? { deskId: desk } : {}) });
    }
    case 'kanban.task.update':
      return m({ t: 'kanban.task.update', id: id(r.id), patch: taskPatch(r.patch) });
    case 'kanban.task.move':
      return m({ t: 'kanban.task.move', id: id(r.id), to: oneOf(r.to, 'to', TASK_STATUSES) });
    case 'kanban.task.start': {
      const desk = deskId(r.deskId);
      return m({ t: 'kanban.task.start', id: id(r.id), ...(desk ? { deskId: desk } : {}) });
    }
    case 'kanban.task.stop':
    case 'kanban.task.retry':
    case 'kanban.task.review':
    case 'kanban.task.compact':
    case 'kanban.task.release':
    case 'kanban.task.delete':
      return m({ t: t as 'kanban.task.start', id: id(r.id) });
    case 'kanban.task.continue': {
      const answer = optText(r.answer, 'The answer', KANBAN_LIMITS.answer);
      return m({ t: 'kanban.task.continue', id: id(r.id), ...(answer?.trim() ? { answer } : {}) });
    }
    case 'kanban.plan.approve': {
      const planId = optInt(r.planId, 'planId', 1, Number.MAX_SAFE_INTEGER);
      return m({ t: 'kanban.plan.approve', id: id(r.id), ...(planId !== undefined ? { planId } : {}) });
    }
    case 'kanban.plan.requestChanges':
      return m({ t: 'kanban.plan.requestChanges', id: id(r.id), text: text(r.text, 'What to change', KANBAN_LIMITS.answer) });
    case 'kanban.task.pr':
      return m({ t: 'kanban.task.pr', id: id(r.id), mode: oneOf(r.mode, 'mode', ['create', 'fix'] as const) });
    case 'kanban.comment.add': {
      const ids = attachmentIds(r.attachmentIds);
      const body = text(r.text, 'The comment', KANBAN_LIMITS.comment, { empty: !!ids?.length });
      return m({ t: 'kanban.comment.add', id: id(r.id), text: body, ...(ids?.length ? { attachmentIds: ids } : {}) });
    }
    case 'kanban.settings.set':
      return m({ t: 'kanban.settings.set', settings: settingsObj(r.settings, 'settings') as KanbanSettingsPatch });
    case 'kanban.project.settings.set':
      return m({ t: 'kanban.project.settings.set', project: project(r.project), settings: settingsObj(r.settings, 'settings') as Partial<ProjectSettings> });
    case 'kanban.project.repos.set':
      return m({ t: 'kanban.project.repos.set', project: project(r.project), repos: repoInputs(r.repos) });
    case 'kanban.project.repo.clone': {
      const remote = text(r.remote, 'The GitHub repository', KANBAN_LIMITS.remote).trim();
      if (!GH_REPO_RE.test(remote)) bad('The GitHub repository is owner/name');
      const name = optText(r.name, "The repository's name", 100)?.trim();
      return m({ t: 'kanban.project.repo.clone', project: project(r.project), remote, ...(name ? { name } : {}) });
    }
    case 'kanban.project.prompt.set': {
      if (typeof r.id !== 'string' || !/^kanban\.[a-zA-Z.]{1,60}$/.test(r.id)) bad('id must be a kanban prompt id');
      const body = r.text === null ? null : text(r.text, 'The prompt', KANBAN_LIMITS.promptText, { empty: true });
      return m({ t: 'kanban.project.prompt.set', project: project(r.project), id: r.id as string, text: body });
    }
    case 'kanban.issues.list':
    case 'kanban.issues.refresh':
      return m({ t: t as 'kanban.issues.list', project: project(r.project) });
    case 'kanban.issues.createTask':
      return m({ t: 'kanban.issues.createTask', project: project(r.project), issueKey: text(r.issueKey, 'issueKey', KANBAN_LIMITS.issueKey).trim(), ...(bool(r.start, 'start') ? { start: true } : {}) });
    case 'kanban.secrets.set': {
      const out: { t: 'kanban.secrets.set'; jira?: { site: string; email: string; token: string } | null; apiKey?: string | null } = { t: 'kanban.secrets.set' };
      if (r.jira === null) out.jira = null;
      else if (r.jira !== undefined) {
        if (!isObj(r.jira)) bad('jira must be {site, email, token}');
        const j = r.jira as Obj;
        const site = text(j.site, 'The Jira site', 200).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(site)) bad('The Jira site is a host name, like yourteam.atlassian.net');
        out.jira = { site, email: text(j.email, 'The Jira e-mail', 320).trim(), token: text(j.token, 'The Jira API token', KANBAN_LIMITS.secret).trim() };
      }
      if (r.apiKey === null) out.apiKey = null;
      else if (r.apiKey !== undefined) {
        const key = text(r.apiKey, 'The API key', KANBAN_LIMITS.secret).trim();
        if (key.length < 16) bad('The API key must be at least 16 characters');
        out.apiKey = key;
      }
      if (out.jira === undefined && out.apiKey === undefined) bad('Nothing to change');
      return m(out);
    }
    case 'kanban.pr.review': {
      const taskId = r.taskId === undefined ? undefined : id(r.taskId, 'taskId');
      const tool = optOneOf(r.tool, 'tool', KANBAN_TOOLS);
      const mdl = model(r.model);
      const effort = optOneOf(r.effort, 'effort', KANBAN_EFFORTS);
      return m({
        t: 'kanban.pr.review',
        project: project(r.project),
        prs: prRefs(r.prs),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(tool ? { tool } : {}),
        ...(mdl ? { model: mdl } : {}),
        ...(effort ? { effort } : {}),
        ...(bool(r.panel, 'panel') ? { panel: true } : {}),
      });
    }
    case 'kanban.pr.bundle':
      return m({ t: 'kanban.pr.bundle', project: project(r.project), ...bundleKey(r), ...(bool(r.includeClosed, 'includeClosed') ? { includeClosed: true } : {}) });
  }
  return bad(`Unknown kanban message ${t.slice(0, 60)}`);
}

/** The settings types a `settings` object carries, for the server's sanitisers. */
export type { IssueSourceConfig, SkillSelection };
