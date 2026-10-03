// The kanban's domain types, shared by the server and the browser (see docs/kanban-architecture.md).
// Everything here is plain data: what the database keeps, what the WebSocket carries, and what the
// agents are handed. Timestamps are integer milliseconds since the epoch.

import type { WorkerInfo, WorkerRepo } from '../protocol.js';

// --- Columns, phases and runs ---------------------------------------------------------------------

/** A task's column. Fixed: there are no custom columns. `archived` isn't on the board. */
export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'review' | 'on_hold' | 'done' | 'archived';
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'waiting', 'review', 'on_hold', 'done', 'archived'];
/** The board's columns, left to right. */
export const BOARD_COLUMNS: readonly TaskStatus[] = ['todo', 'in_progress', 'waiting', 'review', 'on_hold', 'done'];
export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

/** implement: plan → implement → review ⇄ fix. investigate: read-only, writes report files. */
export type TaskType = 'implement' | 'investigate';
export const TASK_TYPES: readonly TaskType[] = ['implement', 'investigate'];

/**
 * One phase execution of a task (a KanbanRun). `pr-review`: a review of several pull requests
 * together (KanbanEngineApi.reviewPrs), by a reviewer in a worktree of its own. `compact`: historical only.
 */
export type RunPhase = 'plan' | 'implement' | 'review' | 'fix' | 'resume' | 'pr' | 'pr-fix' | 'compact' | 'pr-review';
export const RUN_PHASES: readonly RunPhase[] = ['plan', 'implement', 'review', 'fix', 'resume', 'pr', 'pr-fix', 'compact', 'pr-review'];

/**
 * What the engine is doing with a task right now (KanbanTask.runState). `queued`: started, waiting for
 * room under the project's maxConcurrent or the office's worker limit; `starting`: a worker is being
 * hired or relaunched; `running`: a phase's turn is under way; `stopping`: a stop was asked for.
 * Every other moment is `idle` (the column then says why: waiting, review, done...).
 */
export type RunState = 'idle' | 'queued' | 'starting' | 'running' | 'stopping';
export const RUN_STATES: readonly RunState[] = ['idle', 'queued', 'starting', 'running', 'stopping'];

/** How one run went (KanbanRun.status). `interrupted`: its worker went away (an office restart, sent home). */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';
export const RUN_STATUSES: readonly RunStatus[] = ['running', 'succeeded', 'failed', 'stopped', 'interrupted'];

/** A review run's verdict, from the last `REVIEW:` line (see KANBAN_CONTRACTS.review). */
export type ReviewVerdict = 'approved' | 'changes_requested';

/** Why a task is in the waiting column (KanbanTask.waitingReason). */
export type WaitingReason =
  | 'plan_questions' // the plan phase ended with QUESTIONS: (or the replan heuristic)
  | 'plan_approval' // a finished plan waits for the user (planApproval 'manual')
  | 'agent_asking' // the agent is asking in its terminal (needs_input outside a plan)
  | 'stopped' // the user stopped it
  | 'failed' // a phase failed (see waitingText)
  | 'usage_limit' // usage limit or network interruption: retried at retryAt
  | 'interrupted'; // its worker went away mid-run (office restart, sent home)
export const WAITING_REASONS: readonly WaitingReason[] = ['plan_questions', 'plan_approval', 'agent_asking', 'stopped', 'failed', 'usage_limit', 'interrupted'];

/**
 * What an agent asking in its terminal (agent_asking) waits on, as its hooks said: a question
 * (AskUserQuestion, Codex's request_user_input), which an answer from the kanban is typed into, or a
 * permission prompt, answered only in the terminal. Unknown (none given): answered in the terminal too.
 */
export type AskingKind = 'question' | 'permission';

/** The agent CLIs the kanban process drives. Other providers stay ordinary office workers. */
export type KanbanTool = 'claude' | 'codex';
export const KANBAN_TOOLS: readonly KanbanTool[] = ['claude', 'codex'];
export const isKanbanTool = (v: unknown): v is KanbanTool => v === 'claude' || v === 'codex';

/**
 * Reasoning effort as the kanban picks it. Claude takes low…max (`--effort`); Codex takes
 * minimal…xhigh (`model_reasoning_effort`); the adapters map what the other one doesn't have.
 */
export type KanbanEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const KANBAN_EFFORTS: readonly KanbanEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type PlanApproval = 'auto' | 'manual';
/** How implement/fix/resume/pr phases run: fully bypassed, or codex's workspace-write sandbox. */
export type ImplementPermission = 'bypass' | 'workspace-write';
/** A task worker's part (WorkerInfo.kanban.role). */
export type KanbanRole = 'implementer' | 'reviewer';

// --- Tasks ----------------------------------------------------------------------------------------

/** Where a task's work happens: the workspace (or single worktree) its workers sit in, as WorkerManager keeps it. */
export interface TaskWorkspace {
  worktree: NonNullable<WorkerInfo['worktree']>;
  /** The project's other repositories in the workspace (see WorkerInfo.repos). */
  repos?: WorkerRepo[];
}

/** A comment typed while the worker was busy, delivered at its next rest (see KanbanTask.pendingMessages). */
export interface PendingMessage {
  commentId: number;
  text: string;
  by: string;
  at: number;
}

/** A pull request opened for a task, one per repository (see pr_links). */
export interface KanbanPrLink {
  /** ProjectRepo.id of the repository it's in. */
  repoId: string;
  /** owner/name on GitHub, when known. */
  repo?: string;
  number: number;
  url: string;
  state: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED';
  branch?: string;
  createdAt: number;
  updatedAt: number;
}

export type TaskFlag = 'descriptionLocked' | 'planAccepted' | 'prRequested';

/** Per-task overrides of the office and project settings. */
export interface TaskOverrides {
  review?: Partial<ReviewSettings>;
  implementPermission?: ImplementPermission;
  skills?: SkillSelection;
}

/** Where a migrated task came from (see scripts/migrate-ai-kanban). */
export interface LegacyRef {
  source: string;
  id: number;
  migratedAt: number;
}

/** A task as the server keeps it, in full (the detail view). */
export interface KanbanTask {
  /** Integer, global across projects: #123. Migrated tasks keep their old id. */
  id: number;
  /** The floor id of its project. */
  project: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  /** An issue key: `UYT-1415` (Jira), `gh:owner/repo#12`, `ghp:owner/3#PVTI_…`. */
  ticket?: string;
  ticketUrl?: string;
  /** The ProjectRepo ids it works in; null = all of the project's repositories. */
  repoIds: string[] | null;
  /** The phase it's in, or last ran. */
  phase?: RunPhase;
  runState: RunState;
  waitingReason?: WaitingReason;
  /** A line for the waiting column: the error, the agent's question... */
  waitingText?: string;
  /** agent_asking only: what the agent waits on, while its run is followed (kept in memory, never stored). */
  askingKind?: AskingKind;
  /** The review round it's in or last finished (0: none yet). */
  reviewRound: number;
  /** The implementer's tool, model and effort. */
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  usePlan: boolean;
  planApproval: PlanApproval;
  useReview: boolean;
  /** Acceptance criteria, when given (see the kanban.goal prompt). */
  goal?: string;
  overrides: TaskOverrides;
  /** The implementer's agent session, resumed across phases and workers. */
  sessionId?: string;
  reviewerSessionId?: string;
  /** Office workers on the project's floor, while they're hired. */
  workerId?: string;
  reviewerWorkerId?: string;
  /** The branch the agent created (the primary repository's; per repository in task_repos). */
  branch?: string;
  workspace?: TaskWorkspace;
  pendingMessages: PendingMessage[];
  /** Usage-limit / network wait: when the engine tries again, and how many times it has. */
  retryAt?: number;
  retryAttempts: number;
  flags: Partial<Record<TaskFlag, boolean>>;
  tags: string[];
  /** The latest summary an agent gave of the task. */
  summary?: string;
  prs: KanbanPrLink[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** First started: the description is locked from then on. */
  startedAt?: number;
  /** Last moved to the review column by the automation. */
  finishedAt?: number;
  doneAt?: number;
  archivedAt?: number;
  legacy?: LegacyRef;
  /** The desk its implementer is hired at: the one it was started at, else where it last sat. Re-hires prefer it when it's free. */
  deskId?: string;
  /** The account that made it, whose sign-ins its drained, retried and swept hires run on (server-side; not sent to browsers). */
  createdByAccount?: string;
  /** The run waiting for a desk or for room under the office's worker limit (runState `queued`). */
  queuedRun?: QueuedRun;
  /** What its workspace held when it last came to the Review column (workspaceFingerprint): a comment's work that leaves it so is not reviewed again. */
  handoffFingerprint?: string;
}

/** A run the engine couldn't hire a worker for yet (KanbanTask.queuedRun): started as it is once there's room. */
export interface QueuedRun {
  phase: RunPhase;
  role: KanbanRole;
  /** The engine's prompt kind (engine/machine.ts PromptKind). */
  prompt: string;
  round?: number;
  pending?: boolean;
  text?: string;
}

/** A task as the board shows it: no description body, just what the card's badges need. */
export interface KanbanTaskCard {
  id: number;
  project: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  ticket?: string;
  ticketUrl?: string;
  /** null = all of the project's repositories; the UI names them from KanbanProjectInfo.repos. */
  repoIds: string[] | null;
  phase?: RunPhase;
  runState: RunState;
  /** "review 2/3": the round and the rounds it gets. */
  reviewRound: number;
  reviewRounds: number;
  useReview: boolean;
  tool: KanbanTool;
  model?: string;
  reviewTool?: KanbanTool;
  waitingReason?: WaitingReason;
  waitingText?: string;
  askingKind?: AskingKind;
  retryAt?: number;
  prs: { repoId: string; repo?: string; number: number; url: string; state: KanbanPrLink['state'] }[];
  tags: string[];
  workerId?: string;
  reviewerWorkerId?: string;
  commentCount: number;
  /** Comments typed while the worker is busy, not delivered yet. */
  pendingCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  legacy?: boolean;
}

// --- Runs, plans, comments, attachments -----------------------------------------------------------

export interface KanbanRun {
  id: number;
  taskId: number;
  phase: RunPhase;
  /** The review round (review and fix runs). */
  round?: number;
  role: KanbanRole;
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  sessionId?: string;
  workerId?: string;
  status: RunStatus;
  verdict?: ReviewVerdict;
  /** The turn's final text, or a summary of it. */
  summary?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export type PlanStatus = 'draft' | 'accepted' | 'superseded';

/** A version of a task's plan. A new draft supersedes the ones before it; accepting one supersedes any accepted earlier. */
export interface KanbanPlan {
  id: number;
  taskId: number;
  version: number;
  status: PlanStatus;
  text: string;
  /** What the user asked to change, when they did. */
  feedback?: string;
  runId?: number;
  createdAt: number;
  acceptedAt?: number;
  acceptedBy?: string;
}

export type CommentAuthorKind = 'user' | 'agent' | 'system';
/** What a comment is, so the UI never has to parse its text. */
export type CommentKind = 'message' | 'result' | 'plan' | 'questions' | 'review' | 'status';

export interface KanbanComment {
  id: number;
  taskId: number;
  authorKind: CommentAuthorKind;
  /** The person, the worker's name, or 'Kanban'. */
  authorName: string;
  /** Which agent wrote it (agent comments). */
  tool?: KanbanTool;
  kind: CommentKind;
  text: string;
  runId?: number;
  /** A user comment still queued for a busy worker. */
  pending: boolean;
  attachmentIds: string[];
  createdAt: number;
}

export interface KanbanAttachment {
  /** Random hex; served at /api/kanban/attachments/<id>. */
  id: string;
  /** None until it's attached to a task (uploaded in the create dialog). */
  taskId?: number;
  commentId?: number;
  name: string;
  mime: string;
  size: number;
  createdBy: string;
  createdAt: number;
}

/** One line of a task's history (capped per task). */
export interface KanbanEvent {
  id: number;
  taskId: number;
  at: number;
  kind: string;
  data?: unknown;
}

// --- Projects -------------------------------------------------------------------------------------

/**
 * One repository of a project (FloorDef.repos). The floor's own checkout is always the primary,
 * with the floor's id as its id; the others' ids are short slugs, unique in the project.
 */
export interface ProjectRepo {
  id: string;
  name: string;
  kind: 'git' | 'folder';
  /** Absolute path of the checkout (or folder) on the office's machine. */
  dir: string;
  /** owner/name on GitHub. */
  remote?: string;
  /** Only in KanbanProjectInfo.repos: owner/name read from the checkout's origin while no remote is saved. */
  detectedRemote?: string;
  /** The branch work is cut from and PRs target; unset: the branch the checkout is on. */
  baseBranch?: string;
  primary: boolean;
  /** Extra instructions for work in this repository. */
  instructions?: string;
}

/** A project as the kanban lists it: its floor, its repositories and a summary of its settings. */
export interface KanbanProjectInfo {
  /** The floor id. */
  id: string;
  name: string;
  /** owner/name of the primary repository. */
  repo?: string;
  dir: string;
  repos: ProjectRepo[];
  /** The floor is open (its checkout is there); a closed one's tasks can't run. */
  open: boolean;
  settings: {
    maxConcurrent: number;
    planApproval: PlanApproval;
    issueSources: number;
    promptOverrides: number;
    reviewRounds: number;
  };
}

// --- Settings -------------------------------------------------------------------------------------

export interface ReviewSettings {
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  /** Review rounds, 1..10. */
  rounds: number;
  /** After the last round's fix, review once more (true) or go straight to the review column. */
  reReviewLastFix: boolean;
  /** Keep the reviewer off the web too (claude: no WebFetch/WebSearch). */
  sandbox: boolean;
}

export type SkillPhase = 'plan' | 'implement' | 'review' | 'pr';
export const SKILL_PHASES: readonly SkillPhase[] = ['plan', 'implement', 'review', 'pr'];
/** Skills per phase and tool, by name (SkillInfo.name). */
export type SkillSelection = Partial<Record<SkillPhase, { claude?: string[]; codex?: string[] }>>;

/** Where a project's issues come from (see server/kanban/issues). */
export type IssueSourceConfig =
  | {
      id: string;
      kind: 'github-repo';
      /** owner/name; empty = the project's git repositories with a GitHub remote. */
      repos: string[];
      filters: { assignee?: string; labels?: string[]; state?: 'open' | 'closed' | 'all' };
    }
  | {
      id: string;
      kind: 'github-project';
      /** User or organisation that owns the Projects v2 board. */
      owner: string;
      number: number;
      filters: { assignee?: string; status?: string; iteration?: string };
    }
  | {
      id: string;
      kind: 'jira';
      /** e.g. yourteam.atlassian.net (the token is in kanban-secrets.json). */
      site: string;
      projectKeys: string[];
      filters: { assignee?: string; epic?: string; labels?: string[]; statusCategoryNot?: string[]; jql?: string };
    };
export type IssueSourceKind = IssueSourceConfig['kind'];

export interface ProjectSettings {
  branchInstructions: string;
  generalInstructions: string;
  testingInstructions: string;
  maxConcurrent: number; // tasks of this project running at once
  publicLanguage?: string; // what its issues, pull requests and commits are written in; FOLLOW_PROJECT (@project): by its own instructions; unset: the office's
  planApproval?: PlanApproval;
  implementPermission?: ImplementPermission;
  review?: Partial<ReviewSettings>;
  issueSources: IssueSourceConfig[];
  /** Project prompt overrides, by kanban prompt id (see resolveKanbanPrompt). */
  prompts: Partial<Record<string, string>>;
  skills: SkillSelection;
}

export interface KanbanSettings {
  schemaVersion: number;
  defaults: {
    tool: KanbanTool;
    model?: string;
    effort?: KanbanEffort;
    usePlan: boolean;
    planApproval: PlanApproval;
    useReview: boolean;
    implementPermission: ImplementPermission;
  };
  review: ReviewSettings;
  autoResume: { enabled: boolean; maxAttempts: number; maxWaitHours: number };
  /** Done tasks older than this go to the archive (0: never). */
  archiveAfterDays: number;
  projects: Record<string, ProjectSettings>;
}

/** What the browser may know about the secrets: whether they're set, never what they are. */
export interface SecretStatus {
  jira: { configured: boolean; site?: string };
  /** The key for the loopback /api/v1 compatibility API (jira-loop, jira-kanban-feeder). */
  apiKey: { configured: boolean };
}

// --- Issues and skills ----------------------------------------------------------------------------

/** An issue from any source, the same shape for all of them. */
export interface NormalizedIssue {
  source: IssueSourceKind;
  /** IssueSourceConfig.id it came from. */
  sourceId?: string;
  /** The ticket key a task created from it gets: `UYT-1415`, `gh:owner/repo#12`. */
  key: string;
  title: string;
  url: string;
  body: string;
  assignee?: string;
  labels: string[];
  status?: string;
  epic?: string;
  project?: string;
  /** owner/name for GitHub issues. */
  repo?: string;
  updatedAt: string;
  /** The task already made from it, if any. */
  taskId?: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  tool: KanbanTool;
  /** Its folder on the office's machine. */
  location: string;
  origin: 'bundled' | 'user' | 'account' | 'repo';
  /** Config homes it's installed in (e.g. ~/.claude, an account's home). */
  installedIn: string[];
}

// --- What agents get about other tasks ------------------------------------------------------------

/** Another task, as `office-tasks get`, MCP get_task and /api/tasks/reference hand it to an agent. */
export interface TaskRefBundle {
  id: number;
  title: string;
  description: string;
  ticket?: string;
  ticketUrl?: string;
  project: { id: string; name: string };
  repos: { id: string; name: string; branch?: string; remote?: string }[];
  status: TaskStatus;
  phase?: RunPhase;
  summary?: string;
  acceptedPlan?: string;
  runs: { phase: RunPhase; round?: number; status: RunStatus; verdict?: ReviewVerdict; summary?: string; finishedAt?: number }[];
  comments: { authorKind: CommentAuthorKind; authorName: string; kind: CommentKind; text: string; createdAt: number }[];
  prs: { repo?: string; number: number; url: string; state: KanbanPrLink['state'] }[];
  /** Absolute paths of report files an investigation wrote. */
  reportFiles: string[];
}

// --- Reviewing pull requests ----------------------------------------------------------------------

/** One pull request, by repository: across a project's repositories, so several can be reviewed together. */
export interface PrRef {
  /** owner/name on GitHub. */
  repo: string;
  number: number;
}

/**
 * A review of several pull requests at once: picked one by one (any of the project's repositories),
 * or a task's bundle (see KanbanPrBundleKey). Every PR must be in one of the project's repositories.
 */
export interface KanbanPrReviewRequest {
  /** The floor id. */
  project: string;
  prs: PrRef[];
  /** The kanban task they belong to, when the review is of a task's bundle. */
  taskId?: number;
  tool?: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  /** 🤝 A review panel in the floor's meeting room instead of one reviewer (see integrations/pulls). */
  panel?: boolean;
}

/** How a bundle of related pull requests is found in a project: one task's PRs, or those sharing a branch or a ticket. */
export type KanbanPrBundleKey = { taskId: number } | { branch: string } | { ticket: string };

/** A pull request of a bundle, as kanban.pr.bundle lists it. */
export interface KanbanPrBundleItem extends PrRef {
  url: string;
  title: string;
  state: KanbanPrLink['state'];
  branch?: string;
  /** ProjectRepo.id of its repository. */
  repoId?: string;
  taskId?: number;
}

/** The most pull requests one review takes. */
export const PR_REVIEW_MAX = 20;

// --- A task's changes and reports, over HTTP (integrations/changes, integrations/reports) ---------

/** One file of a change, as the Changes tab lists it. */
export interface KanbanChangedFile {
  path: string;
  /** Where a renamed or copied file came from. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unmerged' | 'untracked';
  additions: number;
  deletions: number;
  binary?: boolean;
}

/** A diff: its files and its unified text, cut at a cap (`truncated`). */
export interface KanbanDiff {
  files: KanbanChangedFile[];
  diff: string;
  truncated: boolean;
}

/** One commit of a task's branch (base..branch). */
export interface KanbanCommit {
  hash: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
}

/**
 * A repository of a task as the Changes tab reads it: from the task's workspace (its worktree) while
 * there is one, else from the branch in the project's own checkout.
 */
export interface KanbanRepoChangesInfo {
  /** ProjectRepo.id. */
  id: string;
  name: string;
  /** The project's own checkout (its id is the project's): upstream's Changes window calls it no `repo`. */
  primary?: boolean;
  source: 'worktree' | 'checkout';
  /** What the change is measured against (origin/main, main, or the commit the worktree was cut from). */
  base?: string;
  baseCommit?: string;
  branch?: string;
  headCommit?: string;
  /** Why there's nothing to show, when there isn't. */
  error?: string;
}

/** GET /api/kanban/tasks/<id>/changes (no repo): the task's repositories. */
export interface KanbanChangesList {
  taskId: number;
  /** The task's project (= its floor): the primary repository's id, and the start of the others' floor ids. */
  project: string;
  /** The primary one first. */
  repos: KanbanRepoChangesInfo[];
}

/** GET /api/kanban/tasks/<id>/changes?repo=<id>: one repository's whole change, and its uncommitted work. */
export interface KanbanRepoChanges extends KanbanRepoChangesInfo, KanbanDiff {
  taskId: number;
  /** Uncommitted edits and new files in the worktree; null without a workspace. */
  workingTree: KanbanDiff | null;
}

/** GET /api/kanban/tasks/<id>/commits?repo=<id>. */
export interface KanbanCommitList extends KanbanRepoChangesInfo {
  taskId: number;
  commits: KanbanCommit[];
  /** How many files the worktree has uncommitted (the "Uncommitted" pseudo entry); null without a workspace. */
  uncommitted: number | null;
}

/** GET /api/kanban/tasks/<id>/uncommitted?repo=<id>: how many files the worktree has uncommitted against HEAD (null without one). */
export interface KanbanUncommitted {
  taskId: number;
  repo: string;
  uncommitted: number | null;
}

/** GET /api/kanban/tasks/<id>/commit?repo=<id>&hash=<sha>. */
export interface KanbanCommitChanges extends KanbanDiff {
  taskId: number;
  repo: string;
  commit: KanbanCommit;
}

/** A report file an investigation wrote (GET /api/kanban/tasks/<id>/reports). */
export interface KanbanReportFile {
  /** Its path under the task's report folder, with `/` between folders. */
  name: string;
  size: number;
  mtime: number;
}

// --- Task workers in the 3D office (docs/kanban-coupling.md) ---------------------------------------

/**
 * WorkerInfo.kanban: the task a worker works on, and its card as it is now. The engine keeps it
 * current (WorkerManager.setKanbanSummary), so every 3D and /lite client has it with the ordinary
 * worker.update. Only taskId and role are there from the hire on; the rest follows the card.
 */
export interface KanbanWorkerSummary {
  taskId: number;
  role: KanbanRole;
  title?: string;
  status?: TaskStatus;
  phase?: RunPhase;
  /** The engine's state of it: anything but idle means a run is under way (or queued, or stopping). */
  runState?: RunState;
  /** The review round in progress or last finished, and how many the task has. */
  round?: number;
  rounds?: number;
  waitingReason?: WaitingReason;
  retryAt?: number;
}

/** Why a worker leaves its desk: which of the office's paths sent it home. */
export type DepartureReason = 'sent-home' | 'queue' | 'meeting' | 'merged' | 'released' | 'hold' | 'engine';
export const DEPARTURE_REASONS: readonly DepartureReason[] = ['sent-home', 'queue', 'meeting', 'merged', 'released', 'hold', 'engine'];

/**
 * What a worker is sent home with (Floor.sendHome, WorkerManager.kill): kept on the worker before it
 * goes, and read by the engine when a task worker leaves (the rules in docs/kanban-coupling.md).
 * `by` is who sent it (a person's name, or the part of the office that did); `done` asks for its task
 * to be done.
 */
export interface DepartureIntent {
  by: string;
  done?: boolean;
  reason: DepartureReason;
}
