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
import { Bad, KANBAN_LIMITS, MODEL_RE, PROJECT_ID_RE, bad, bool, deskId, id, isObj, list, model, nullableText, oneOf, optInt, optOneOf, optText, project, text, workerId, type Obj, type Req } from './validate.js';
import { moveExtras } from './hold.js';
import { PR_MODES, type PrMode } from './prs.js';
import type { LoungeServerMsg } from './lounge.js';
import { ISSUE_OPS_CLIENT_TYPE_LIST, parseIssueOpsMsg, type IssueOpsClientMsg, type IssueOpsServerMsg } from './issueops.js';

// --- Limits ---------------------------------------------------------------------------------------

export { KANBAN_LIMITS, PROJECT_ID_RE, MODEL_RE } from './validate.js';

/**
 * A ProjectRepo id. Short, so `<floorId>~<repoId>` (the synthetic RepoSource.floor of a project's other
 * repositories) fits in the 64 characters upstream's Changes messages take.
 */
export const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
export const ATTACHMENT_ID_RE = /^[a-f0-9]{16,64}$/;
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
  /** A drag between columns (see moves.ts). `note`/`until`: the reason and date of a hold, or a message for the agent on a resume (see hold.ts). */
  | Req<{ t: 'kanban.task.move'; id: number; to: TaskStatus; note?: string; until?: number }>
  /** `deskId`: hire its worker at that desk (a desk or bean bag, not a board agent's kiosk or a meeting chair); refused when it's taken or not built. */
  | Req<{ t: 'kanban.task.start'; id: number; deskId?: string }>
  | Req<{ t: 'kanban.task.stop'; id: number }>
  /** Carry on from waiting; `answer` answers the plan's questions (or what the agent asked). */
  | Req<{ t: 'kanban.task.continue'; id: number; answer?: string; attachmentIds?: string[] }>
  /** Run the failed / interrupted phase again. */
  | Req<{ t: 'kanban.task.retry'; id: number }>
  /** One more review round, by hand. */
  | Req<{ t: 'kanban.task.review'; id: number }>
  | Req<{ t: 'kanban.plan.approve'; id: number; planId?: number }>
  | Req<{ t: 'kanban.plan.requestChanges'; id: number; text: string; attachmentIds?: string[] }>
  /** Have the agent open (create) the task's pull requests, fix them (review comments, checks) or resolve their conflicts. */
  | Req<{ t: 'kanban.task.pr'; id: number; mode: PrMode }>
  /** Send the task's workers home, keeping the worktree for later. */
  | Req<{ t: 'kanban.task.delete'; id: number }>
  /** Admins: opens the task's folder(s) in VS Code on the office's machine; answered with kanban.ok. */
  | Req<{ t: 'kanban.task.vscode'; id: number }>
  /** Admins: the same for a worker's folder(s), task worker or not. */
  | Req<{ t: 'kanban.worker.vscode'; workerId: string }>
  /** Answered with kanban.ok {commentId}. */
  | Req<{ t: 'kanban.comment.add'; id: number; text: string; attachmentIds?: string[] }>
  /** Answered with kanban.settings. */
  | Req<{ t: 'kanban.settings.get' }>
  /** The settings with the projects and who you are, without the board (⚙️ Settings); answered with kanban.meta. */
  | Req<{ t: 'kanban.meta.get' }>
  | Req<{ t: 'kanban.settings.set'; settings: KanbanSettingsPatch }>
  | Req<{ t: 'kanban.project.settings.set'; project: string; settings: Partial<ProjectSettings> }>
  | Req<{ t: 'kanban.project.rename'; project: string; name: string }>
  | Req<{ t: 'kanban.project.repos.set'; project: string; repos: ProjectRepoInput[] }>
  /**
   * Admins: clones `remote` (owner/name) into the building's projects folder (or reuses a checkout of
   * it that's there) and adds it to the project's repositories; answered with kanban.ok once it's in.
   */
  | Req<{ t: 'kanban.project.repo.clone'; project: string; remote: string; name?: string }>
  /** A project's own text for a kanban prompt; null goes back to the office's. */
  | Req<{ t: 'kanban.project.prompt.set'; project: string; id: string; text: string | null }>
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
  | Req<{ t: 'kanban.pr.bundle'; project: string; includeClosed?: boolean } & KanbanPrBundleKey>
  /** The task that owns a pull request, and whether its agent can fix it now: kanban.pr.owner. */
  | Req<{ t: 'kanban.pr.owner'; project: string; repo: string; number: number }>
  | IssueOpsClientMsg;

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
  | { t: 'kanban.meta'; rid?: string; projects: KanbanProjectInfo[]; settings: KanbanSettings; secrets: SecretStatus; me: { admin: boolean; name: string } }
  | { t: 'kanban.projects'; projects: KanbanProjectInfo[] }
  | { t: 'kanban.skills'; rid?: string; skills: SkillInfo[]; error?: string }
  | { t: 'kanban.pr.bundle'; rid?: string; project: string; key: KanbanPrBundleKey; prs: KanbanPrBundleItem[]; error?: string }
  | { t: 'kanban.pr.owner'; rid?: string; taskId: number | null; title?: string; fixable: boolean; reason?: string }
  | { t: 'kanban.ok'; rid?: string; taskId?: number; commentId?: number; workerId?: string; existed?: boolean; startError?: string; started?: true }
  | IssueOpsServerMsg
  | LoungeServerMsg
  | { t: 'kanban.error'; rid?: string; message: string };

export type KanbanServerType = KanbanServerMsg['t'];

// --- The validator --------------------------------------------------------------------------------

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
function prRef(x: unknown): PrRef {
  if (!isObj(x)) bad('prs must be pull requests: {repo, number}');
  const p = x as Obj;
  if (typeof p.repo !== 'string' || !GH_REPO_RE.test(p.repo)) bad('A pull request needs its repository as owner/name');
  if (!Number.isSafeInteger(p.number) || (p.number as number) <= 0) bad('A pull request needs its number');
  return { repo: p.repo as string, number: p.number as number };
}
function prRefs(v: unknown): PrRef[] {
  const seen = new Set<string>();
  const prs = list(v, 'prs', PR_REVIEW_MAX, prRef).filter((p) => {
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

/**
 * Every message type the browser may send, once: a type of KanbanClientMsg missing here fails the
 * typecheck. The office's handler map takes its kanban entries from it too (src/server/kanban/ws/handlers.ts).
 */
export const KANBAN_CLIENT_TYPE_LIST: Readonly<Record<KanbanClientType, true>> = {
  ...ISSUE_OPS_CLIENT_TYPE_LIST,
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
  'kanban.task.delete': true,
  'kanban.task.vscode': true,
  'kanban.worker.vscode': true,
  'kanban.comment.add': true,
  'kanban.settings.get': true,
  'kanban.meta.get': true,
  'kanban.settings.set': true,
  'kanban.project.settings.set': true,
  'kanban.project.repos.set': true,
  'kanban.project.rename': true,
  'kanban.project.prompt.set': true,
  'kanban.skills.list': true,
  'kanban.skills.sync': true,
  'kanban.secrets.set': true,
  'kanban.pr.review': true,
  'kanban.pr.bundle': true,
  'kanban.pr.owner': true,
  'kanban.project.repo.clone': true,
};

/** The same types, for checking a message's. */
export const KANBAN_CLIENT_TYPES: ReadonlySet<string> = new Set(Object.keys(KANBAN_CLIENT_TYPE_LIST));

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
  if (t in ISSUE_OPS_CLIENT_TYPE_LIST) return m(parseIssueOpsMsg(t as keyof typeof ISSUE_OPS_CLIENT_TYPE_LIST, r));
  const nullableProject = (v: unknown) => (v === null || v === undefined ? null : project(v));
  switch (t as KanbanClientType) {
    case 'kanban.subscribe':
    case 'kanban.snapshot':
      return m({ t: t as 'kanban.subscribe', project: nullableProject(r.project), ...(bool(r.includeArchived, 'includeArchived') ? { includeArchived: true } : {}) });
    case 'kanban.unsubscribe':
    case 'kanban.settings.get':
    case 'kanban.meta.get':
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
    case 'kanban.task.move': {
      const to = oneOf(r.to, 'to', TASK_STATUSES);
      return m({ t: 'kanban.task.move', id: id(r.id), to, ...moveExtras(r, to) });
    }
    case 'kanban.task.start': {
      const desk = deskId(r.deskId);
      return m({ t: 'kanban.task.start', id: id(r.id), ...(desk ? { deskId: desk } : {}) });
    }
    case 'kanban.task.stop':
    case 'kanban.task.retry':
    case 'kanban.task.review':
    case 'kanban.task.delete':
    case 'kanban.task.vscode':
      return m({ t: t as 'kanban.task.start', id: id(r.id) });
    case 'kanban.worker.vscode':
      return m({ t: 'kanban.worker.vscode', workerId: workerId(r.workerId) });
    case 'kanban.task.continue': {
      const answer = optText(r.answer, 'The answer', KANBAN_LIMITS.answer);
      const ids = attachmentIds(r.attachmentIds);
      return m({ t: 'kanban.task.continue', id: id(r.id), ...(answer?.trim() ? { answer } : {}), ...(ids?.length ? { attachmentIds: ids } : {}) });
    }
    case 'kanban.plan.approve': {
      const planId = optInt(r.planId, 'planId', 1, Number.MAX_SAFE_INTEGER);
      return m({ t: 'kanban.plan.approve', id: id(r.id), ...(planId !== undefined ? { planId } : {}) });
    }
    case 'kanban.plan.requestChanges': {
      const ids = attachmentIds(r.attachmentIds);
      const body = ids?.length ? text(r.text ?? '', 'What to change', KANBAN_LIMITS.answer, { empty: true }) : text(r.text, 'What to change', KANBAN_LIMITS.answer);
      return m({ t: 'kanban.plan.requestChanges', id: id(r.id), text: body, ...(ids?.length ? { attachmentIds: ids } : {}) });
    }
    case 'kanban.task.pr':
      return m({ t: 'kanban.task.pr', id: id(r.id), mode: oneOf(r.mode, 'mode', PR_MODES) });
    case 'kanban.comment.add': {
      const ids = attachmentIds(r.attachmentIds);
      const body = text(r.text, 'The comment', KANBAN_LIMITS.comment, { empty: !!ids?.length });
      return m({ t: 'kanban.comment.add', id: id(r.id), text: body, ...(ids?.length ? { attachmentIds: ids } : {}) });
    }
    case 'kanban.settings.set':
      return m({ t: 'kanban.settings.set', settings: settingsObj(r.settings, 'settings') as KanbanSettingsPatch });
    case 'kanban.project.settings.set':
      return m({ t: 'kanban.project.settings.set', project: project(r.project), settings: settingsObj(r.settings, 'settings') as Partial<ProjectSettings> });
    case 'kanban.project.rename':
      return m({ t: 'kanban.project.rename', project: project(r.project), name: text(r.name, 'The name', 100).trim() });
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
    case 'kanban.pr.owner': return m({ t: 'kanban.pr.owner', project: project(r.project), ...prRef(r) });
  }
  return bad(`Unknown kanban message ${t.slice(0, 60)}`);
}

/** The settings types a `settings` object carries, for the server's sanitisers. */
export type { IssueSourceConfig, SkillSelection };
