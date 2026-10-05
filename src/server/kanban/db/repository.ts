// Typed access to the kanban database: tasks, their repositories, comments, runs, plans,
// attachments, events and pull requests. Nothing outside src/server/kanban/db writes SQL. Rows
// come back as the shared types (src/shared/kanban/types.ts); JSON columns are parsed defensively,
// so a hand-edited row can't take the board down.

import type Database from 'better-sqlite3';
import type {
  AskingKind,
  CommentAuthorKind,
  CommentKind,
  KanbanAttachment,
  KanbanComment,
  KanbanEvent,
  KanbanPlan,
  KanbanPrLink,
  KanbanRun,
  KanbanTask,
  KanbanTaskCard,
  KanbanTool,
  LegacyRef,
  PendingMessage,
  RunPhase,
  RunStatus,
  TaskFlag,
  TaskOverrides,
  TaskWorkspace,
} from '../../../shared/kanban/types.js';
import { TASK_COLUMNS, json, opt, toDb } from './columns.js';

/** The most history lines a task keeps; older ones go as new ones come. */
export const TASK_EVENTS_CAP = 2000;
/** The comments a detail view gets at first, and the most one page holds. */
export const COMMENTS_PAGE = 50;

/** A task to create. Unset fields get the schema's defaults; the caller has applied the settings' defaults. */
export interface NewTask {
  project: string;
  title: string;
  description?: string;
  type?: KanbanTask['type'];
  status?: KanbanTask['status'];
  ticket?: string;
  ticketUrl?: string;
  repoIds?: string[] | null;
  tool: KanbanTool;
  model?: string;
  effort?: KanbanTask['effort'];
  usePlan: boolean;
  planApproval: KanbanTask['planApproval'];
  useReview: boolean;
  goal?: string;
  overrides?: TaskOverrides;
  tags?: string[];
  flags?: KanbanTask['flags'];
  summary?: string;
  branch?: string;
  workspace?: TaskWorkspace;
  createdBy: string;
  /** The account that made it (see KanbanTask.createdByAccount). */
  createdByAccount?: string;
  deskId?: string;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  doneAt?: number;
  archivedAt?: number;
  legacy?: LegacyRef;
}

/**
 * Fields to change on a task. A key that's present is written (undefined or null clears an optional
 * field); `updatedAt` is bumped on every update unless given.
 */
export type TaskUpdate = { [K in Exclude<keyof KanbanTask, 'id' | 'createdAt' | 'prs'>]?: KanbanTask[K] | null };

export interface NewComment {
  taskId: number;
  authorKind: CommentAuthorKind;
  authorName: string;
  tool?: KanbanTool;
  kind?: CommentKind;
  text: string;
  runId?: number;
  pending?: boolean;
  createdAt?: number;
  legacyId?: number;
}

export interface NewRun {
  taskId: number;
  phase: RunPhase;
  round?: number;
  role?: KanbanRun['role'];
  tool: KanbanTool;
  model?: string;
  effort?: KanbanRun['effort'];
  sessionId?: string;
  workerId?: string;
  status?: RunStatus;
  startedAt?: number;
}

export type RunUpdate = Partial<Pick<KanbanRun, 'status' | 'verdict' | 'summary' | 'error' | 'sessionId' | 'workerId' | 'finishedAt' | 'model' | 'effort' | 'promptedAt'>>;

/** An attachment row as the server keeps it: `stored` is the file's name in the uploads folder, never sent to browsers. */
export interface AttachmentRow extends KanbanAttachment {
  stored: string;
}

/** What the card needs from the settings: the review rounds and tool that apply to the task. */
export type CardReview = (task: Pick<KanbanTask, 'project' | 'overrides'>) => { rounds: number; tool: KanbanTool };

type Row = Record<string, unknown>;

export class KanbanRepository {
  constructor(readonly db: Database.Database) {}

  /** What each task's agent asking in its terminal waits on (KanbanTask.askingKind): the engine's, in memory only. */
  private askingKinds = new Map<number, AskingKind>();

  /** Sets (or with undefined, clears) what the task's asking agent waits on; shown only while it's agent_asking. */
  setAskingKind(taskId: number, kind: AskingKind | undefined) {
    if (kind) this.askingKinds.set(taskId, kind);
    else this.askingKinds.delete(taskId);
  }

  /** Runs `fn` in one transaction (nested calls join it). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- Task ids -----------------------------------------------------------------------------------

  /** The id the next new task gets. */
  nextTaskId(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'next_task_id'`).get() as { value: string } | undefined;
    const max = (this.db.prepare('SELECT MAX(id) AS m FROM tasks').get() as { m: number | null }).m ?? 0;
    return Math.max(Number(row?.value) || 1, max + 1);
  }

  /** Raises the id sequence to at least `n` (never lowers it): a migration starts it past the ids it brought. */
  bumpNextTaskId(n: number) {
    const next = Math.max(this.nextTaskId(), Math.floor(n));
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('next_task_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
  }

  // --- Tasks --------------------------------------------------------------------------------------

  createTask(input: NewTask): KanbanTask {
    return this.transaction(() => this.insert(this.nextTaskId(), input));
  }

  /** Creates a task with the id it asks for (an imported task keeping its number); throws when it's taken. */
  insertTaskWithId(id: number, input: NewTask): KanbanTask {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Task ids are positive whole numbers, not ${id}`);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) throw new Error(`Task #${id} already exists`);
      return this.insert(id, input);
    });
  }

  private insert(id: number, t: NewTask): KanbanTask {
    const now = Date.now();
    const created = t.createdAt ?? now;
    this.db
      .prepare(
        `INSERT INTO tasks (id, project, title, description, type, status, ticket, ticket_url, tool, model, effort, use_plan, plan_approval, use_review, goal,
          overrides, tags, flags, summary, branch, worktree, created_by, created_at, updated_at, started_at, finished_at, done_at, archived_at,
          legacy_source, legacy_id, migrated_at, created_by_account, desk_id)
         VALUES (@id, @project, @title, @description, @type, @status, @ticket, @ticketUrl, @tool, @model, @effort, @usePlan, @planApproval, @useReview, @goal,
          @overrides, @tags, @flags, @summary, @branch, @worktree, @createdBy, @createdAt, @updatedAt, @startedAt, @finishedAt, @doneAt, @archivedAt,
          @legacySource, @legacyId, @migratedAt, @createdByAccount, @deskId)`,
      )
      .run({
        id,
        project: t.project,
        title: t.title,
        description: t.description ?? '',
        type: t.type ?? 'implement',
        status: t.status ?? 'todo',
        ticket: t.ticket ?? null,
        ticketUrl: t.ticketUrl ?? null,
        tool: t.tool,
        model: t.model ?? null,
        effort: t.effort ?? null,
        usePlan: t.usePlan ? 1 : 0,
        planApproval: t.planApproval,
        useReview: t.useReview ? 1 : 0,
        goal: t.goal ?? null,
        overrides: JSON.stringify(t.overrides ?? {}),
        tags: JSON.stringify(t.tags ?? []),
        flags: JSON.stringify(t.flags ?? {}),
        summary: t.summary ?? null,
        branch: t.branch ?? null,
        worktree: t.workspace ? JSON.stringify(t.workspace) : null,
        createdBy: t.createdBy,
        createdAt: created,
        updatedAt: t.updatedAt ?? created,
        startedAt: t.startedAt ?? null,
        finishedAt: t.finishedAt ?? null,
        doneAt: t.doneAt ?? null,
        archivedAt: t.archivedAt ?? null,
        legacySource: t.legacy?.source ?? null,
        legacyId: t.legacy?.id ?? null,
        migratedAt: t.legacy?.migratedAt ?? null,
        createdByAccount: t.createdByAccount ?? null,
        deskId: t.deskId ?? null,
      });
    if (t.repoIds?.length) this.setTaskRepos(id, t.repoIds);
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('next_task_id', ?) ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`).run(String(id + 1));
    return this.getTask(id)!;
  }

  getTask(id: number): KanbanTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row && this.task(row);
  }

  /** Full tasks of a project (or every project), archived ones only when asked. */
  listTasks(project: string | null, opts: { includeArchived?: boolean } = {}): KanbanTask[] {
    return (this.selectTasks(project, opts, '*') as Row[]).map((r) => this.task(r));
  }

  /** The board's cards (no descriptions), newest change first. */
  listCards(project: string | null, opts: { includeArchived?: boolean } = {}, review?: CardReview): KanbanTaskCard[] {
    const rows = this.selectTasks(project, opts, `*, '' AS description`) as Row[];
    const counts = this.commentCounts(rows.map((r) => r.id as number));
    return rows.map((r) => toCard(this.task(r), counts.get(r.id as number) ?? 0, review));
  }

  /** One task's card. */
  card(id: number, review?: CardReview): KanbanTaskCard | undefined {
    const task = this.getTask(id);
    return task && toCard(task, this.countComments(id), review);
  }

  private selectTasks(project: string | null, opts: { includeArchived?: boolean }, cols: string): unknown[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (project !== null) {
      where.push('project = ?');
      args.push(project);
    }
    if (!opts.includeArchived) where.push(`status != 'archived'`);
    return this.db.prepare(`SELECT ${cols} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC`).all(...args);
  }

  /** Tasks in any of these states (the engine's sweeps: running ones, due retries...). */
  tasksWhere(filter: { status?: KanbanTask['status'][]; runState?: KanbanTask['runState'][]; retryDue?: number; project?: string }): KanbanTask[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.project !== undefined) {
      where.push('project = ?');
      args.push(filter.project);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      args.push(...filter.status);
    }
    if (filter.runState?.length) {
      where.push(`run_state IN (${filter.runState.map(() => '?').join(', ')})`);
      args.push(...filter.runState);
    }
    if (filter.retryDue !== undefined) {
      where.push('retry_at IS NOT NULL AND retry_at <= ?');
      args.push(filter.retryDue);
    }
    const rows = this.db.prepare(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`).all(...args) as Row[];
    return rows.map((r) => this.task(r));
  }

  /** The task a ticket already has in a project (issues → tasks is idempotent by ticket). */
  findTaskByTicket(project: string, ticket: string): KanbanTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE project = ? AND ticket = ? ORDER BY id LIMIT 1').get(project, ticket) as Row | undefined;
    return row && this.task(row);
  }

  /** Each ticket of the project's tasks and the first task made for it, in one query (the 3D issues board's 🗂️ #N). */
  ticketTaskIds(project: string): Map<string, number> {
    const rows = this.db.prepare("SELECT ticket, id FROM tasks WHERE project = ? AND ticket IS NOT NULL AND ticket <> '' ORDER BY id").all(project) as { ticket: string; id: number }[];
    const out = new Map<string, number>();
    for (const r of rows) if (!out.has(r.ticket)) out.set(r.ticket, r.id);
    return out;
  }

  findTaskByLegacy(source: string, legacyId: number): KanbanTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE legacy_source = ? AND legacy_id = ?').get(source, legacyId) as Row | undefined;
    return row && this.task(row);
  }

  /** Changes a task; returns it as it is now, or undefined when there's no such task. */
  updateTask(id: number, patch: TaskUpdate): KanbanTask | undefined {
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    let repoIds: string[] | null | undefined;
    let touchedRepos = false;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'repoIds') {
        touchedRepos = true;
        repoIds = value as string[] | null | undefined;
        continue;
      }
      const col = TASK_COLUMNS[key];
      if (!col) continue;
      sets.push(`${col} = @${key}`);
      args[key] = toDb(key, value);
    }
    if (!('updatedAt' in patch)) {
      sets.push('updated_at = @updatedAt');
      args.updatedAt = Date.now();
    }
    return this.transaction(() => {
      const r = this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(args);
      if (!r.changes) return undefined;
      if (touchedRepos) this.setTaskRepos(id, repoIds ?? null);
      return this.getTask(id);
    });
  }

  /** Marks a migrated task as brought in again now (see KanbanTask.legacy). */
  setMigratedAt(id: number, at: number) {
    this.db.prepare('UPDATE tasks SET migrated_at = ? WHERE id = ?').run(at, id);
  }

  deleteTask(id: number): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  }

  // --- Repositories and branches of a task --------------------------------------------------------

  /** The subset of repositories a task works in; null (or none) = all of them. */
  setTaskRepos(taskId: number, repoIds: string[] | null) {
    this.transaction(() => {
      const keep = new Map((this.db.prepare('SELECT repo_id, branch FROM task_repos WHERE task_id = ?').all(taskId) as Row[]).map((r) => [r.repo_id as string, r.branch as string | null]));
      this.db.prepare('DELETE FROM task_repos WHERE task_id = ?').run(taskId);
      const add = this.db.prepare('INSERT INTO task_repos (task_id, repo_id, position, branch) VALUES (?, ?, ?, ?)');
      const listed = repoIds ?? [];
      listed.forEach((r, i) => add.run(taskId, r, i, keep.get(r) ?? null));
      // Branches made in repositories that are no longer in the subset are still the task's.
      for (const [r, branch] of keep) if (branch && !listed.includes(r)) add.run(taskId, r, 1000, branch);
    });
  }

  /** The branch the agent made in one repository of the task (listed or not in its subset). */
  setRepoBranch(taskId: number, repoId: string, branch: string | null) {
    this.db
      .prepare(`INSERT INTO task_repos (task_id, repo_id, position, branch) VALUES (?, ?, 1000, ?) ON CONFLICT(task_id, repo_id) DO UPDATE SET branch = excluded.branch`)
      .run(taskId, repoId, branch);
  }

  /** Each repository's branch, by repo id. */
  repoBranches(taskId: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT repo_id, branch FROM task_repos WHERE task_id = ? AND branch IS NOT NULL').all(taskId) as Row[]) out[r.repo_id as string] = r.branch as string;
    return out;
  }

  private repoIdsOf(taskId: number): string[] | null {
    const rows = this.db.prepare('SELECT repo_id FROM task_repos WHERE task_id = ? AND position < 1000 ORDER BY position').all(taskId) as Row[];
    return rows.length ? rows.map((r) => r.repo_id as string) : null;
  }

  // --- Comments -----------------------------------------------------------------------------------

  /**
   * Adds a comment. A system comment saying exactly what the task's last comment already said isn't
   * added again (ai-kanban once wrote the same line 337 215 times): the earlier one comes back, with
   * `deduped` set.
   */
  addComment(c: NewComment): { comment: KanbanComment; deduped: boolean } {
    return this.transaction(() => {
      if (c.authorKind === 'system') {
        const last = this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(c.taskId) as Row | undefined;
        if (last && last.author_kind === 'system' && last.text === c.text) return { comment: this.comment(last), deduped: true };
      }
      const r = this.db
        .prepare('INSERT INTO comments (task_id, author_kind, author_name, tool, kind, text, run_id, pending, created_at, legacy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.taskId, c.authorKind, c.authorName, c.tool ?? null, c.kind ?? 'message', c.text, c.runId ?? null, c.pending ? 1 : 0, c.createdAt ?? Date.now(), c.legacyId ?? null);
      return { comment: this.getComment(Number(r.lastInsertRowid))!, deduped: false };
    });
  }

  getComment(id: number): KanbanComment | undefined {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Row | undefined;
    return row && this.comment(row);
  }

  /** A queued comment was delivered to the agent (or no longer is queued). */
  setCommentPending(id: number, pending: boolean) {
    this.db.prepare('UPDATE comments SET pending = ? WHERE id = ?').run(pending ? 1 : 0, id);
  }

  /** Every user comment on a task made at or after `since` (ms), oldest first. */
  userCommentsSince(taskId: number, since: number): KanbanComment[] {
    return (this.db.prepare(`SELECT * FROM comments WHERE task_id = ? AND author_kind = 'user' AND created_at >= ? ORDER BY id`).all(taskId, since) as Row[]).map((r) => this.comment(r));
  }

  /** A page of a task's comments, oldest first: the newest `limit`, or the `limit` before comment `before`. */
  listComments(taskId: number, opts: { before?: number; limit?: number } = {}): { comments: KanbanComment[]; more: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? COMMENTS_PAGE, 500));
    const rows = (
      opts.before !== undefined
        ? this.db.prepare('SELECT * FROM comments WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(taskId, opts.before, limit + 1)
        : this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit + 1)
    ) as Row[];
    const more = rows.length > limit;
    return { comments: rows.slice(0, limit).reverse().map((r) => this.comment(r)), more };
  }

  countComments(taskId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(taskId) as { n: number }).n;
  }

  private commentCounts(ids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (!ids.length) return out;
    // A board of one project shouldn't count every comment in the database (a migrated one has hundreds of thousands).
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (${chunk.map(() => '?').join(', ')}) GROUP BY task_id`).all(...chunk) as Row[];
      for (const r of rows) out.set(r.task_id as number, r.n as number);
    }
    return out;
  }

  // --- Runs ---------------------------------------------------------------------------------------

  createRun(r: NewRun): KanbanRun {
    const res = this.db
      .prepare('INSERT INTO runs (task_id, phase, round, role, tool, model, effort, session_id, worker_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.taskId, r.phase, r.round ?? null, r.role ?? 'implementer', r.tool, r.model ?? null, r.effort ?? null, r.sessionId ?? null, r.workerId ?? null, r.status ?? 'running', r.startedAt ?? Date.now());
    return this.getRun(Number(res.lastInsertRowid))!;
  }

  getRun(id: number): KanbanRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row && run(row);
  }

  /** When the run was held for background work (ms), or undefined: kept apart from KanbanRun, only the engine's restart reads it. */
  runHeldAt(id: number): number | undefined {
    const row = this.db.prepare('SELECT held_at FROM runs WHERE id = ?').get(id) as { held_at: number | null } | undefined;
    return row?.held_at ?? undefined;
  }

  setRunHeld(id: number, at: number | null) {
    this.db.prepare('UPDATE runs SET held_at = ? WHERE id = ?').run(at, id);
  }

  updateRun(id: number, patch: RunUpdate): KanbanRun | undefined {
    const cols: Record<string, string> = { status: 'status', verdict: 'verdict', summary: 'summary', error: 'error', sessionId: 'session_id', workerId: 'worker_id', finishedAt: 'finished_at', model: 'model', effort: 'effort', promptedAt: 'prompted_at' };
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k]) continue;
      sets.push(`${cols[k]} = @${k}`);
      args[k] = v ?? null;
    }
    if (sets.length) this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`).run(args);
    return this.getRun(id);
  }

  /** Ends a run: its status, and when (now unless given). */
  finishRun(id: number, patch: RunUpdate & { status: Exclude<RunStatus, 'running'> }): KanbanRun | undefined {
    return this.updateRun(id, { finishedAt: Date.now(), ...patch });
  }

  listRuns(taskId: number): KanbanRun[] {
    return (this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(run);
  }

  /** The id of the task's latest run, if it has one. */
  latestRunId(taskId: number): number | undefined {
    return (this.db.prepare('SELECT id FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as Row | undefined)?.id as number | undefined;
  }

  /** The task's run still going, if any (the latest one). */
  activeRun(taskId: number): KanbanRun | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE task_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(taskId) as Row | undefined;
    return row && run(row);
  }

  /** Every run left `running` (start-up reconcile). */
  runningRuns(): KanbanRun[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY id`).all() as Row[]).map(run);
  }

  // --- Plans --------------------------------------------------------------------------------------

  /** A new plan version, as a draft; earlier drafts are superseded. */
  addPlan(taskId: number, text: string, runId?: number, createdAt = Date.now()): KanbanPlan {
    return this.transaction(() => {
      const version = ((this.db.prepare('SELECT MAX(version) AS v FROM plans WHERE task_id = ?').get(taskId) as { v: number | null }).v ?? 0) + 1;
      this.db.prepare(`UPDATE plans SET status = 'superseded' WHERE task_id = ? AND status = 'draft'`).run(taskId);
      const r = this.db.prepare(`INSERT INTO plans (task_id, version, status, text, run_id, created_at) VALUES (?, ?, 'draft', ?, ?, ?)`).run(taskId, version, text, runId ?? null, createdAt);
      return this.getPlan(Number(r.lastInsertRowid))!;
    });
  }

  getPlan(id: number): KanbanPlan | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
    return row && plan(row);
  }

  /** Accepts a plan (the latest draft when no id is given); an earlier accepted one is superseded. */
  acceptPlan(taskId: number, by: string, planId?: number, at = Date.now()): KanbanPlan | undefined {
    return this.transaction(() => {
      const target = planId !== undefined ? this.getPlan(planId) : this.latestPlan(taskId);
      if (!target || target.taskId !== taskId) return undefined;
      this.db.prepare(`UPDATE plans SET status = 'superseded' WHERE task_id = ? AND status = 'accepted' AND id != ?`).run(taskId, target.id);
      this.db.prepare(`UPDATE plans SET status = 'accepted', accepted_at = ?, accepted_by = ? WHERE id = ?`).run(at, by, target.id);
      return this.getPlan(target.id);
    });
  }

  /** What the user asked to change about a plan. */
  setPlanFeedback(planId: number, feedback: string): KanbanPlan | undefined {
    this.db.prepare('UPDATE plans SET feedback = ? WHERE id = ?').run(feedback, planId);
    return this.getPlan(planId);
  }

  latestPlan(taskId: number): KanbanPlan | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId) as Row | undefined;
    return row && plan(row);
  }

  acceptedPlan(taskId: number): KanbanPlan | undefined {
    const row = this.db.prepare(`SELECT * FROM plans WHERE task_id = ? AND status = 'accepted' ORDER BY version DESC LIMIT 1`).get(taskId) as Row | undefined;
    return row && plan(row);
  }

  listPlans(taskId: number): KanbanPlan[] {
    return (this.db.prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version').all(taskId) as Row[]).map(plan);
  }

  // --- Attachments --------------------------------------------------------------------------------

  addAttachment(a: AttachmentRow): AttachmentRow {
    this.db
      .prepare('INSERT INTO attachments (id, task_id, comment_id, name, mime, size, stored, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.taskId ?? null, a.commentId ?? null, a.name, a.mime, a.size, a.stored, a.createdBy, a.createdAt);
    return this.getAttachment(a.id)!;
  }

  getAttachment(id: string): AttachmentRow | undefined {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Row | undefined;
    return row && attachment(row);
  }

  listAttachments(taskId: number): AttachmentRow[] {
    return (this.db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id').all(taskId) as Row[]).map(attachment);
  }

  /**
   * Attaches uploads to a task (and a comment). Only ones that aren't someone else's yet, or already
   * this task's: an id seen in another task's page can't be pulled over. Returns the ones attached.
   */
  linkAttachments(ids: string[], taskId: number, commentId?: number): AttachmentRow[] {
    return this.transaction(() => {
      const out: AttachmentRow[] = [];
      for (const id of ids) {
        const a = this.getAttachment(id);
        if (!a || (a.taskId !== undefined && a.taskId !== taskId)) continue;
        this.db.prepare('UPDATE attachments SET task_id = ?, comment_id = COALESCE(?, comment_id) WHERE id = ?').run(taskId, commentId ?? null, id);
        out.push(this.getAttachment(id)!);
      }
      return out;
    });
  }

  /** Uploads never attached to anything, older than `before` (to clean up). */
  orphanAttachments(before: number): AttachmentRow[] {
    return (this.db.prepare('SELECT * FROM attachments WHERE task_id IS NULL AND created_at < ?').all(before) as Row[]).map(attachment);
  }

  deleteAttachment(id: string) {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  }

  private commentAttachments(commentId: number): string[] {
    return (this.db.prepare('SELECT id FROM attachments WHERE comment_id = ? ORDER BY created_at, id').all(commentId) as Row[]).map((r) => r.id as string);
  }

  // --- Events -------------------------------------------------------------------------------------

  /** A line of the task's history; the oldest go once it has TASK_EVENTS_CAP. */
  appendEvent(taskId: number, kind: string, data?: unknown, at = Date.now(), cap = TASK_EVENTS_CAP): KanbanEvent {
    return this.transaction(() => {
      const r = this.db.prepare('INSERT INTO task_events (task_id, at, kind, data) VALUES (?, ?, ?, ?)').run(taskId, at, kind, data === undefined ? null : JSON.stringify(data));
      const id = Number(r.lastInsertRowid);
      this.db.prepare('DELETE FROM task_events WHERE task_id = ? AND id <= (SELECT id FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(taskId, taskId, cap);
      return { id, taskId, at, kind, ...(data === undefined ? {} : { data }) };
    });
  }

  /** The newest `limit` events, oldest first. */
  listEvents(taskId: number, limit = 200): KanbanEvent[] {
    const rows = this.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit) as Row[];
    return rows.reverse().map((r) => ({ id: r.id as number, taskId: r.task_id as number, at: r.at as number, kind: r.kind as string, ...(r.data !== null ? { data: json(r.data, null) } : {}) }));
  }

  // --- Pull requests ------------------------------------------------------------------------------

  upsertPrLink(taskId: number, pr: Omit<KanbanPrLink, 'createdAt' | 'updatedAt'> & { at?: number }): KanbanPrLink[] {
    const at = pr.at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO pr_links (task_id, repo_id, repo, number, url, state, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, repo_id, number) DO UPDATE SET repo = excluded.repo, url = excluded.url, state = excluded.state, branch = COALESCE(excluded.branch, branch), updated_at = excluded.updated_at`,
      )
      .run(taskId, pr.repoId, pr.repo ?? null, pr.number, pr.url, pr.state, pr.branch ?? null, at, at);
    return this.listPrLinks(taskId);
  }

  listPrLinks(taskId: number): KanbanPrLink[] {
    return (this.db.prepare('SELECT * FROM pr_links WHERE task_id = ? ORDER BY created_at, repo_id, number').all(taskId) as Row[]).map(prLink);
  }

  /** Every active (not done, not archived) task of any project with its branches, in one query: the owners of a branch when a PR is linked by it. */
  activeTaskBranches(): { id: number; project: string; createdAt: number; branch?: string; branches: Record<string, string> }[] {
    const rows = this.db
      .prepare(`SELECT t.id, t.project, t.created_at, t.branch, r.repo_id, r.branch AS repo_branch FROM tasks t LEFT JOIN task_repos r ON r.task_id = t.id AND r.branch IS NOT NULL WHERE t.status NOT IN ('done', 'archived') ORDER BY t.id`)
      .all() as Row[];
    const out = new Map<number, { id: number; project: string; createdAt: number; branch?: string; branches: Record<string, string> }>();
    for (const r of rows) {
      let t = out.get(r.id as number);
      if (!t) out.set(r.id as number, (t = { id: r.id as number, project: r.project as string, createdAt: r.created_at as number, ...(r.branch ? { branch: r.branch as string } : {}), branches: {} }));
      if (r.repo_id) t.branches[r.repo_id as string] = r.repo_branch as string;
    }
    return [...out.values()];
  }

  /** The tasks a pull request belongs to (by owner/name and number). */
  tasksOfPr(repo: string, number: number): number[] {
    return (this.db.prepare('SELECT DISTINCT task_id FROM pr_links WHERE lower(repo) = lower(?) AND number = ?').all(repo, number) as Row[]).map((r) => r.task_id as number);
  }

  /** Every link, in any project, to a pull request with this number or this URL (the caller narrows it to the repository: a link may have none). */
  prLinksMatching(number: number, url: string): (KanbanPrLink & { taskId: number; project: string })[] {
    const rows = this.db.prepare('SELECT l.*, t.project FROM pr_links l JOIN tasks t ON t.id = l.task_id WHERE l.number = ? OR l.url = ?').all(number, url) as Row[];
    return rows.map((r) => ({ taskId: r.task_id as number, project: r.project as string, ...prLink(r) }));
  }

  /** Every pull request linked to a task of `project`, with its task's id (to bring their states up to date). */
  prLinksOfProject(project: string): (KanbanPrLink & { taskId: number })[] {
    const rows = this.db.prepare('SELECT l.* FROM pr_links l JOIN tasks t ON t.id = l.task_id WHERE t.project = ? ORDER BY l.task_id, l.repo_id, l.number').all(project) as Row[];
    return rows.map((r) => ({ taskId: r.task_id as number, ...prLink(r) }));
  }

  /** A linked pull request's state, as GitHub has it now. True when it changed. */
  setPrLinkState(taskId: number, repoId: string, number: number, state: KanbanPrLink['state'], at = Date.now()): boolean {
    const r = this.db.prepare('UPDATE pr_links SET state = ?, updated_at = ? WHERE task_id = ? AND repo_id = ? AND number = ? AND state <> ?').run(state, at, taskId, repoId, number, state);
    return r.changes > 0;
  }

  removePrLink(taskId: number, repoId: string, number: number) {
    this.db.prepare('DELETE FROM pr_links WHERE task_id = ? AND repo_id = ? AND number = ?').run(taskId, repoId, number);
  }

  // --- Migration bookkeeping ----------------------------------------------------------------------

  mapLegacy(source: string, kind: string, legacyId: string | number, newId: string | number, at = Date.now()) {
    this.db
      .prepare('INSERT INTO legacy_map (source, kind, legacy_id, new_id, migrated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, kind, legacy_id) DO UPDATE SET new_id = excluded.new_id, migrated_at = excluded.migrated_at')
      .run(source, kind, String(legacyId), String(newId), at);
  }

  lookupLegacy(source: string, kind: string, legacyId: string | number): string | undefined {
    const row = this.db.prepare('SELECT new_id FROM legacy_map WHERE source = ? AND kind = ? AND legacy_id = ?').get(source, kind, String(legacyId)) as { new_id: string } | undefined;
    return row?.new_id;
  }

  // --- Row mapping --------------------------------------------------------------------------------

  private task(r: Row): KanbanTask {
    const id = r.id as number;
    const legacy: LegacyRef | undefined = r.legacy_source ? { source: r.legacy_source as string, id: r.legacy_id as number, migratedAt: (r.migrated_at as number) ?? 0 } : undefined;
    const t: KanbanTask = {
      id,
      project: r.project as string,
      title: r.title as string,
      description: (r.description as string) ?? '',
      type: r.type as KanbanTask['type'],
      status: r.status as KanbanTask['status'],
      ticket: opt(r.ticket),
      ticketUrl: opt(r.ticket_url),
      repoIds: this.repoIdsOf(id),
      phase: opt(r.phase),
      runState: (r.run_state as KanbanTask['runState']) ?? 'idle',
      waitingReason: opt(r.waiting_reason),
      waitingText: opt(r.waiting_text),
      reviewRound: (r.review_round as number) ?? 0,
      tool: r.tool as KanbanTool,
      model: opt(r.model),
      effort: opt(r.effort),
      usePlan: !!r.use_plan,
      planApproval: r.plan_approval as KanbanTask['planApproval'],
      useReview: !!r.use_review,
      goal: opt(r.goal),
      overrides: json<TaskOverrides>(r.overrides, {}),
      sessionId: opt(r.session_id),
      reviewerSessionId: opt(r.reviewer_session_id),
      workerId: opt(r.worker_id),
      reviewerWorkerId: opt(r.reviewer_worker_id),
      branch: opt(r.branch),
      workspace: json<TaskWorkspace | undefined>(r.worktree, undefined),
      pendingMessages: json<PendingMessage[]>(r.pending_messages, []),
      retryAt: opt(r.retry_at),
      retryAttempts: (r.retry_attempts as number) ?? 0,
      flags: json<Partial<Record<TaskFlag, boolean>>>(r.flags, {}),
      tags: json<string[]>(r.tags, []),
      summary: opt(r.summary),
      prs: this.listPrLinks(id),
      createdBy: r.created_by as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      startedAt: opt(r.started_at),
      finishedAt: opt(r.finished_at),
      doneAt: opt(r.done_at),
      archivedAt: opt(r.archived_at),
      legacy,
      deskId: opt(r.desk_id),
      createdByAccount: opt(r.created_by_account),
      queuedRun: json<KanbanTask['queuedRun']>(r.queued_run, undefined),
      handoffFingerprint: opt(r.handoff_fingerprint),
      hold: json<KanbanTask['hold']>(r.hold, undefined),
      askingKind: r.waiting_reason === 'agent_asking' ? this.askingKinds.get(id) : undefined,
    };
    for (const k of Object.keys(t) as (keyof KanbanTask)[]) if (t[k] === undefined) delete t[k];
    if (!Array.isArray(t.tags)) t.tags = [];
    if (!Array.isArray(t.pendingMessages)) t.pendingMessages = [];
    return t;
  }

  private comment(r: Row): KanbanComment {
    const c: KanbanComment = {
      id: r.id as number,
      taskId: r.task_id as number,
      authorKind: r.author_kind as CommentAuthorKind,
      authorName: r.author_name as string,
      tool: opt(r.tool),
      kind: (r.kind as CommentKind) ?? 'message',
      text: r.text as string,
      runId: opt(r.run_id),
      pending: !!r.pending,
      attachmentIds: this.commentAttachments(r.id as number),
      createdAt: r.created_at as number,
    };
    if (c.tool === undefined) delete c.tool;
    if (c.runId === undefined) delete c.runId;
    return c;
  }
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function run(r: Row): KanbanRun {
  return clean({
    id: r.id as number,
    taskId: r.task_id as number,
    phase: r.phase as RunPhase,
    round: opt<number>(r.round),
    role: r.role as KanbanRun['role'],
    tool: r.tool as KanbanTool,
    model: opt<string>(r.model),
    effort: opt<KanbanRun['effort']>(r.effort),
    sessionId: opt<string>(r.session_id),
    workerId: opt<string>(r.worker_id),
    status: r.status as RunStatus,
    verdict: opt<KanbanRun['verdict']>(r.verdict),
    summary: opt<string>(r.summary),
    error: opt<string>(r.error),
    startedAt: r.started_at as number,
    promptedAt: opt<number>(r.prompted_at),
    finishedAt: opt<number>(r.finished_at),
  });
}

function plan(r: Row): KanbanPlan {
  return clean({
    id: r.id as number,
    taskId: r.task_id as number,
    version: r.version as number,
    status: r.status as KanbanPlan['status'],
    text: r.text as string,
    feedback: opt<string>(r.feedback),
    runId: opt<number>(r.run_id),
    createdAt: r.created_at as number,
    acceptedAt: opt<number>(r.accepted_at),
    acceptedBy: opt<string>(r.accepted_by),
  });
}

function attachment(r: Row): AttachmentRow {
  return clean({
    id: r.id as string,
    taskId: opt<number>(r.task_id),
    commentId: opt<number>(r.comment_id),
    name: r.name as string,
    mime: r.mime as string,
    size: r.size as number,
    stored: r.stored as string,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
  });
}

function prLink(r: Row): KanbanPrLink {
  return clean({
    repoId: r.repo_id as string,
    repo: opt<string>(r.repo),
    number: r.number as number,
    url: r.url as string,
    state: r.state as KanbanPrLink['state'],
    branch: opt<string>(r.branch),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  });
}

/** An attachment as browsers see it: without where it's stored. */
export function publicAttachment(a: AttachmentRow): KanbanAttachment {
  const { stored: _, ...rest } = a;
  return rest;
}

/** A task's card. `review` gives the rounds and tool that apply (from the settings); without it, 0 and the task's tool. */
export function toCard(t: KanbanTask, commentCount: number, review?: CardReview): KanbanTaskCard {
  const r = review?.(t);
  return clean({
    id: t.id,
    project: t.project,
    title: t.title,
    type: t.type,
    status: t.status,
    ticket: t.ticket,
    ticketUrl: t.ticketUrl,
    repoIds: t.repoIds,
    phase: t.phase,
    runState: t.runState,
    reviewRound: t.reviewRound,
    reviewRounds: t.useReview ? (r?.rounds ?? 0) : 0,
    useReview: t.useReview,
    tool: t.tool,
    model: t.model,
    reviewTool: t.useReview ? r?.tool : undefined,
    waitingReason: t.waitingReason,
    waitingText: t.waitingText,
    askingKind: t.askingKind,
    hold: t.hold,
    retryAt: t.retryAt,
    prs: t.prs.map((p) => clean({ repoId: p.repoId, repo: p.repo, number: p.number, url: p.url, state: p.state })),
    tags: t.tags,
    workerId: t.workerId,
    reviewerWorkerId: t.reviewerWorkerId,
    commentCount,
    pendingCount: t.pendingMessages.length,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    legacy: t.legacy ? true : undefined,
  });
}
