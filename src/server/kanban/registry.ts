// The plug-in contract of the kanban server: how its parts (the engine, issue sources, task
// references, skills, pull requests, the compatibility API) reach the office and each other without
// each one editing server.ts. installKanban (index.ts) builds the KanbanContext and routes to plugins.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FloorDef } from '../building.js';
import type { Floor } from '../floor.js';
import type { KanbanRepository } from './db/repository.js';
import type { KanbanSecrets, KanbanSettingsStore } from './settings.js';
import type { KanbanClientMsg, KanbanClientType, KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { LanguageSettings } from '../../shared/language.js';
import type { PromptId } from '../../shared/prompts.js';
import type { KanbanPrReviewRequest, KanbanTaskCard, PrRef, ProjectRepo } from '../../shared/kanban/types.js';

/** Who sent a WS message or an HTTP request from a browser. */
export interface KanbanCaller {
  /** The connection's id (a WS client), or undefined for HTTP. */
  clientId?: string;
  accountId?: string;
  name: string;
  admin: boolean;
}

/** A browser connection, as a WS handler sees it. */
export interface KanbanClient extends KanbanCaller {
  clientId: string;
  send(msg: KanbanServerMsg): void;
  /** A warning toast to this connection only. */
  warn?(text: string): void;
}

/** The worker a hook-server request came from (bearer token already checked). */
export interface KanbanHookCaller {
  workerId: string;
  floorId: string;
  /** The kanban task the worker works on, when it is a task worker. */
  taskId?: number;
}

export type KanbanWsHandler<T extends KanbanClientType = KanbanClientType> = (c: KanbanClient, msg: Extract<KanbanClientMsg, { t: T }>) => void | Promise<void>;
/** Returns true when it answered the request. */
export type KanbanHttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL, who: KanbanCaller) => boolean | Promise<boolean>;
export type KanbanHookHandler = (req: IncomingMessage, res: ServerResponse, url: URL, who: KanbanHookCaller) => boolean | Promise<boolean>;
/** Loopback-only routes whose auth the handler decides (ai-kanban compatibility: /api/tasks/reference, /api/v1). */
export type KanbanLoopbackHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

/** What the engine offers the other parts (implemented in engine/). Errors are returned as strings. */
export interface KanbanEngineApi {
  /** `deskId`: its worker is hired at that desk, which must be free and built (else why not). */
  start(taskId: number, who: KanbanCaller, opts?: { deskId?: string }): Promise<string | void>;
  stop(taskId: number, who: KanbanCaller): Promise<string | void>;
  continue(taskId: number, who: KanbanCaller, answer?: string, attachmentIds?: string[]): Promise<string | void>;
  retry(taskId: number, who: KanbanCaller): Promise<string | void>;
  review(taskId: number, who: KanbanCaller): Promise<string | void>;
  approvePlan(taskId: number, who: KanbanCaller): Promise<string | void>;
  requestPlanChanges(taskId: number, who: KanbanCaller, text: string, attachmentIds?: string[]): Promise<string | void>;
  pr(taskId: number, who: KanbanCaller, mode: 'create' | 'fix'): Promise<string | void>;
  /**
   * The task is moved back to To do or deleted: its workers at rest go home, worktree kept (reason
   * `released`); a run live only because the agent asks in its terminal is stopped. Resolves to why
   * not when it is running.
   */
  sendWorkersHome(taskId: number, who: KanbanCaller, why: 'reset' | 'delete'): Promise<string | void>;
  /**
   * The task went to done or archived: its workers that are at rest go home, worktree kept (reason
   * `released`). (Optional only so stand-ins in tests needn't have it.)
   */
  releaseIdle?(taskId: number, who: KanbanCaller): Promise<void>;
  /**
   * A task in Waiting or Review is put on hold: its workers go home (reason `hold`, worktree kept), nothing
   * runs for it. `who` must be its creator or an admin. Resolves to why not. (Optional only so stand-ins in tests needn't have it.)
   */
  hold?(taskId: number, who: KanbanCaller, opts?: { note?: string; until?: number }): Promise<string | void>;
  /** A held task goes on to Review or Done: the messages left meanwhile are kept for its next run. */
  releaseHeld?(taskId: number): Promise<string | void>;
  /** A task on hold is taken off it: its implementer is hired again and carries on, with `note` as the user's message. */
  unhold?(taskId: number, who: KanbanCaller, note?: string): Promise<string | void>;
  /** A user comment was stored: resume the task's work with it when its state allows. */
  commented(taskId: number, commentId: number, who: KanbanCaller): Promise<void>;
  /**
   * "O" at any worker's desk: an agent opens the pull requests (a task worker gets the task's pr phase).
   * Resolves to nothing when it's under way, to why not, or to exactly the string 'fallback' to have
   * upstream's own WorkerManager.openPr (a draft PR without an agent) run instead: server.ts then
   * handles the `worker.pr` message as upstream does (see PR_FALLBACK).
   */
  prForWorker(floorId: string, workerId: string, who: KanbanCaller): Promise<string | void>;
  /**
   * A review of several pull requests together, as an engine run (phase 'pr-review'): on `req.taskId`,
   * or on a new investigate task in `req.project`. A reviewer worker in a worktree of its own reads
   * them; its final text becomes an agent comment with the verdict, and the task goes to the review
   * column. The request is already checked (see KanbanPullsApi.review). Resolves to the task and the
   * reviewer (no reviewer yet when there's no room for one: the task is queued), or to why not.
   */
  reviewPrs(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string>;
}

/** The part of upstream's RunAs (workers.ts) the engine asks before it hires as an account. */
export interface KanbanRunAs {
  claudeReady(owner: string): boolean;
  /** Puts an account's own sign-ins in `env` (CLAUDE_CONFIG_DIR among them), as a worker of theirs starts with them. */
  apply?(owner: string, env: Record<string, string>, dirs?: string[]): unknown;
  why(which: 'claude'): string;
}

/** What prForWorker answers to hand "O" back to upstream's draft PR. */
export const PR_FALLBACK = 'fallback';

/** Pull requests across a project's repositories (implemented by the pull-request plugin). */
export interface KanbanPullsApi {
  /**
   * The PRs that belong together with a task, branch or ticket, across the project's repositories:
   * the open and draft ones, and the merged and closed ones too with `includeClosed`.
   */
  bundle(project: string, by: { taskId?: number; branch?: string; ticket?: string }, opts?: { includeClosed?: boolean }): Promise<PrRef[] | string>;
  /**
   * A review of several PRs at once: checks them (the project's repositories', there, no more than
   * PR_REVIEW_MAX), then has the engine run it (KanbanEngineApi.reviewPrs). Resolves to the review's
   * task and its reviewer (none yet when it's queued), or to why not.
   */
  review(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string>;
  /**
   * 🤝 The same PRs to the floor's meeting room: upstream's review panel, briefed with all of them.
   * Resolves to why not, if it couldn't. (Optional only so stand-ins in tests needn't have it.)
   */
  panel?(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<string | void>;
}

/** Reading other tasks, for agents (implemented by the task-references plugin). */
export interface KanbanRefsApi {
  /**
   * For a read-only plan phase, which can't call the API: writes the tasks `text` refers to
   * (#14, "task 14", "tehtävä 14", a ticket id) into a file and returns its path, or undefined when none.
   */
  referencedTasksFile(taskId: number, text: string): string | undefined;
}

/** Everything a plugin gets. */
export interface KanbanContext {
  /** The office's data dir (`<officeData>/.agent-office`). */
  dataDir: string;
  /** Where the kanban keeps files: `<dataDir>/kanban` (uploads/, reports/, refs/, skills/). */
  filesDir: string;
  repo: KanbanRepository;
  settings: KanbanSettingsStore;
  secrets: KanbanSecrets;
  /** Every project (floor) of the building, open or not. */
  projects(): FloorDef[];
  project(id: string): FloorDef | undefined;
  /** An open floor (its WorkerManager, GitHub, ...). */
  floor(id: string): Floor | undefined;
  /** A project's repositories, primary first. */
  repos(id: string): ProjectRepo[];
  /** Sets a project's repositories (validated); a string is why not. */
  setRepos(id: string, repos: ProjectRepo[]): string | void;
  /** Renames a project (its floor); a string is why not. The id, folder and repositories stay. */
  setName(id: string, name: string): string | void;
  /** The office-wide custom prompt texts (upstream prompts.json), for prompt layering. */
  officePrompts(): Partial<Record<string, { text: string }>>;
  /** An office prompt's text as the office has it now (OfficePrompts.text), for the language rule. */
  officeText(id: PromptId): string;
  /** The office's languages (⚙️ Settings), for the language rule of every prompt (see Composer.language). */
  languages(): LanguageSettings;
  /** The loopback hook server's base URL (what AIKANBAN_API_BASE is set to). */
  hookUrl: string;
  /** To every browser subscribed to `project` (or to all projects, when project is null). */
  broadcast(msg: KanbanServerMsg, project: string | null): void;
  toast(floorId: string, text: string, level?: 'info' | 'warn' | 'error'): void;
  /** Why the office can't take another worker now (its worker limit, upstream Capacity.full), if it can't. */
  capacity?(): string | undefined;
  /** Upstream's sign-in rule (RunAs): whether an account's Claude sign-in is ready, and what to tell it when it isn't. */
  runAs?: KanbanRunAs;
  /**
   * How gh runs for an account (upstream's signins.ghAs): `{env}` as them, undefined as the office's own
   * gh (no account, or an admin's choice), or a string: why it can't (they have no GitHub sign-in).
   */
  ghAs?(accountId?: string): { env: Record<string, string> } | string | undefined;
  /** The office's team notifications (upstream's webhook): one line about a task waiting on a person. */
  notify?(title: string, detail?: string): void;
  /** When the Codex limit a run on `codexHome` (the office's, when not given) hit starts over (ms since epoch), if Codex says; for autoResume. */
  codexResetAt?(codexHome?: string): Promise<number | undefined>;
  engine: KanbanEngineApi;
  pulls: KanbanPullsApi;
  refs: KanbanRefsApi;
  /** A task's card as the board shows it now (review rounds and tool from the settings), or undefined when there's no such task. */
  card(taskId: number): KanbanTaskCard | undefined;
  /**
   * Tells the subscribed browsers a task changed: its card (kanban.task), or kanban.task.removed when
   * it's gone. Call it after every change to a task row; it's cheap and idempotent.
   */
  taskChanged(taskId: number): void;
  /** The file an uploaded attachment is kept in (absolute), for handing to agents; undefined when there's none. */
  attachmentFile(id: string): string | undefined;
  /** What the plugins add to a task worker's launch (their workerArgs/workerEnv, merged). */
  workerExtras(taskId: number, tool: 'claude' | 'codex', phase: string): { args: string[]; env: Record<string, string> };
}

export interface KanbanPlugin {
  name: string;
  /** WS messages it handles (one plugin per message type). */
  ws?: { [T in KanbanClientType]?: KanbanWsHandler<T> };
  /** Browser routes under /api/kanban/ (session checked), by path prefix. */
  http?: Record<string, KanbanHttpHandler>;
  /** Hook-server routes (worker token checked), by path prefix, e.g. '/office/tasks'. */
  hook?: Record<string, KanbanHookHandler>;
  /** Loopback routes, by path prefix, e.g. '/api/tasks/reference', '/api/v1/'. */
  loopback?: Record<string, KanbanLoopbackHandler>;
  /** Extra env for a task worker's agent (e.g. skills), merged under the engine's own. */
  workerEnv?(taskId: number): Record<string, string>;
  /** Extra CLI args for a task worker's agent (e.g. --plugin-dir for skills). */
  workerArgs?(taskId: number, tool: 'claude' | 'codex', phase: string): string[];
  /**
   * A task was started (from anywhere: the board, an API call, a queue): called once the engine took the
   * start, never for one that failed. A throw or rejection is logged and loses only this plugin's part.
   */
  taskStarted?(taskId: number, who: KanbanCaller): void | Promise<void>;
  start?(): void;
  stop?(): void;
}

export type KanbanPluginFactory = (ctx: KanbanContext) => KanbanPlugin;
