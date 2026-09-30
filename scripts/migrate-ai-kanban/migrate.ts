// The migration itself (see docs/migration.md): ai-kanban's repositories, folders, tasks,
// comments, plans and settings into 3d-kanban's floors (floors.json, through upstream's Building),
// kanban database (KanbanRepository) and settings (KanbanSettingsStore). Re-runnable: tasks are
// matched by legacy_source + legacy_id, and comments and logs continue from where the last run
// stopped; a task changed in 3d-kanban since it was brought in is left alone.

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Building, type FloorDef } from '../../src/server/building.js';
import type { KanbanRepository, NewTask, TaskUpdate } from '../../src/server/kanban/db/repository.js';
import { DEFAULT_REVIEW, defaultKanbanSettings, type KanbanSettingsStore } from '../../src/server/kanban/settings.js';
import { projectRepos, validateProjectRepos } from '../../src/server/kanban/projects.js';
import { BRANCH_RE } from '../../src/server/kanban/repos-file.js';
import { MODEL_RE, REPO_ID_RE, type ProjectRepoInput } from '../../src/shared/kanban/protocol.js';
import { KANBAN_PROMPT_DEFS, isKanbanPromptId, type KanbanPromptId } from '../../src/shared/kanban/prompts.js';
import { KANBAN_EFFORTS, type KanbanEffort, type KanbanTool, type SkillSelection } from '../../src/shared/kanban/types.js';
import {
  BUILTIN_ROLE_HASHES,
  LEGACY_SOURCE,
  SystemDedupe,
  legacyComments,
  legacyCounts,
  legacyLogs,
  mapComment,
  mapStatus,
  mapTool,
  ms,
  parseSkillText,
  pathRewriter,
  readLegacySettings,
  readLegacyTasks,
  textHash,
  type LegacyRepository,
  type LegacySettings,
  type LegacyTask,
} from './legacy.js';

/** What the migration writes into (the real office, or scratch copies for a dry run). */
export interface MigrationTarget {
  repo: KanbanRepository;
  settings: KanbanSettingsStore;
  building: Building;
  /** Where the kanban's files go (`<dataDir>/kanban`): paths in texts point here, dry run or not. */
  filesDir: string;
  /** The office's home: the unassigned project's folder is made in it. */
  home: string;
  /** Files are counted, not copied, and no folder is made. */
  dry: boolean;
}

export interface MigrateOptions {
  /** ai-kanban's data folder (~/.ai-kanban/data). */
  from: string;
  /** `--map name=project`: an ai-kanban repository name to a floor id or a repository's name or id. */
  map?: Record<string, string>;
  withStreamLogs?: boolean;
  now?: number;
  /** Paths the old data folder is also known by, for rewriting (e.g. its realpath). */
  fromAliases?: string[];
}

export interface ProjectLine {
  name: string;
  floor?: string;
  kind: 'repository' | 'folder' | 'unassigned';
  action: 'created' | 'extended' | 'exists' | 'missing';
  repos: number;
  linksAdded: number;
  linksMissing: number;
  tasks: number;
}

export interface MigrationReport {
  apply: boolean;
  source: ReturnType<typeof legacyCounts>;
  projects: ProjectLine[];
  repositoryNames: { distinct: number; resolved: number; mapped: number; unassigned: number; unresolved: { name: string; tasks: number }[] };
  tasks: { created: number; updated: number; skippedEdited: number[]; byStatus: Record<string, number>; tagged: Record<string, number>; toolChanged: number; folderTasks: number };
  comments: { imported: number; dedupedConsecutive: number; dedupedFlood: number; pathsRewritten: number };
  plans: { imported: number; accepted: number };
  runs: { reconstructed: number; reviews: { approved: number; changesRequested: number; noVerdict: number } };
  events: { imported: number };
  streamLogs: { skipped: number; written: number };
  files: { uploads: number; reports: number; descriptionPathsRewritten: number };
  settings: { applied: string[]; reported: string[] };
  nextTaskId: number;
  warnings: string[];
}

const CREATED_BY = 'ai-kanban migration';
const UNASSIGNED = 'Migrated (unassigned)';
const LOG_TYPES = ['plan', 'plan_accepted', 'progress', 'question', 'error', 'system'];
const STREAM_TYPES = ['stream', 'stderr'];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');

/** Tasks whose ids 3d-kanban already uses for tasks of its own: the migration stops before writing anything. */
export function idCollisions(repo: KanbanRepository, tasks: Pick<LegacyTask, 'id'>[]): number[] {
  return tasks.filter((t) => !repo.findTaskByLegacy(LEGACY_SOURCE, t.id) && repo.getTask(t.id)).map((t) => t.id);
}

export function migrate(db: Database.Database, target: MigrationTarget, opts: MigrateOptions): MigrationReport {
  const now = opts.now ?? Date.now();
  const settingsIn = readLegacySettings(opts.from);
  const tasks = readLegacyTasks(db);
  const report: MigrationReport = {
    apply: !target.dry,
    source: legacyCounts(db),
    projects: [],
    repositoryNames: { distinct: 0, resolved: 0, mapped: 0, unassigned: 0, unresolved: [] },
    tasks: { created: 0, updated: 0, skippedEdited: [], byStatus: {}, tagged: {}, toolChanged: 0, folderTasks: 0 },
    comments: { imported: 0, dedupedConsecutive: 0, dedupedFlood: 0, pathsRewritten: 0 },
    plans: { imported: 0, accepted: 0 },
    runs: { reconstructed: 0, reviews: { approved: 0, changesRequested: 0, noVerdict: 0 } },
    events: { imported: 0 },
    streamLogs: { skipped: 0, written: 0 },
    files: { uploads: 0, reports: 0, descriptionPathsRewritten: 0 },
    settings: { applied: [], reported: [] },
    nextTaskId: 0,
    warnings: [],
  };

  // Nothing is written while an id is taken: no half-migrated office to clean up.
  const taken = idCollisions(target.repo, tasks);
  if (taken.length) {
    throw new Error(
      `3d-kanban already has tasks of its own with ids ai-kanban's tasks have (${taken.slice(0, 20).map((n) => `#${n}`).join(', ')}${taken.length > 20 ? ', …' : ''}). ` +
        'The migration keeps the old ids (so #123 still means the same task), so it stops here: migrate into an office without those tasks.',
    );
  }

  const projects = new Projects(target, settingsIn, report);
  const assign = projects.assignAll(tasks, opts.map ?? {});
  projects.applySettings();

  // --- Files ------------------------------------------------------------------------------------
  const uploadsTo = path.join(target.filesDir, 'uploads', 'ai-kanban');
  const reportsTo = path.join(target.filesDir, 'reports');
  const rewrite = pathRewriter([opts.from, ...(opts.fromAliases ?? [])], { uploads: uploadsTo, reports: reportsTo });
  report.files.uploads = copyTree(path.join(opts.from, 'uploads'), uploadsTo, target.dry);
  for (const t of tasks) report.files.reports += copyTree(path.join(opts.from, 'reports', `task-${t.id}`), path.join(reportsTo, `task-${t.id}`), target.dry);

  // --- Tasks ------------------------------------------------------------------------------------
  const office = target.settings.get();
  const defaultTool: KanbanTool = office.defaults.tool;
  const reviewTool = mapTool(settingsIn.reviewTool, defaultTool).tool;
  const repo = target.repo;
  let maxId = 0;
  for (const lt of tasks) {
    maxId = Math.max(maxId, lt.id);
    const project = assign.get(lt.id)!;
    const had = repo.findTaskByLegacy(LEGACY_SOURCE, lt.id);
    if (had && had.legacy && had.updatedAt > had.legacy.migratedAt) {
      report.tasks.skippedEdited.push(lt.id);
      continue;
    }
    const st = mapStatus(lt.status);
    report.tasks.byStatus[st.status] = (report.tasks.byStatus[st.status] ?? 0) + 1;
    if (st.tag) report.tasks.tagged[st.tag] = (report.tasks.tagged[st.tag] ?? 0) + 1;
    if (lt.folderPath) report.tasks.folderTasks++;
    const tool = mapTool(lt.agentTool, defaultTool);
    if (tool.changed) report.tasks.toolChanged++;
    const created = ms(lt.createdAt, now);
    const updated = Math.min(ms(lt.updatedAt, created), now);
    const desc = rewrite(lt.description ?? '');
    report.files.descriptionPathsRewritten += desc.count;
    const effort = KANBAN_EFFORTS.includes(lt.effort as KanbanEffort) ? (lt.effort as KanbanEffort) : undefined;
    const model = lt.model && MODEL_RE.test(lt.model) ? lt.model : undefined;
    const tags = [...new Set([...(had?.tags ?? []), ...(st.tag ? [st.tag] : [])])];
    const fields = {
      project,
      title: lt.title.replace(/\s+/g, ' ').trim().slice(0, 300) || `ai-kanban task ${lt.id}`,
      description: desc.text.slice(0, 100_000),
      type: lt.taskType === 'investigate' ? ('investigate' as const) : ('implement' as const),
      status: st.status,
      ticket: lt.ticketId?.trim().slice(0, 200) || undefined,
      tool: tool.tool,
      model,
      effort,
      usePlan: lt.usePlan !== 0,
      useReview: lt.review === 1,
      tags,
      summary: lt.summary ? rewrite(lt.summary).text : undefined,
      branch: lt.branchName && BRANCH_RE.test(lt.branchName) ? lt.branchName : undefined,
      startedAt: st.status === 'todo' ? undefined : created,
      finishedAt: st.status === 'review' ? updated : undefined,
      doneAt: st.status === 'done' || st.status === 'archived' ? updated : undefined,
      archivedAt: st.status === 'archived' ? updated : undefined,
    };
    repo.transaction(() => {
      let id: number;
      if (had) {
        const patch: TaskUpdate = { ...fields, updatedAt: updated };
        repo.updateTask(had.id, patch);
        id = had.id;
        report.tasks.updated++;
      } else {
        const input: NewTask = {
          ...fields,
          planApproval: target.settings.planApproval(project),
          flags: st.status === 'todo' ? {} : { descriptionLocked: true },
          createdBy: CREATED_BY,
          createdAt: created,
          updatedAt: updated,
          legacy: { source: LEGACY_SOURCE, id: lt.id, migratedAt: now },
        };
        id = repo.insertTaskWithId(lt.id, input).id;
        report.tasks.created++;
        const note = [
          `Migrated from ai-kanban (task #${lt.id}, column ${lt.status}, repository ${lt.repository}${lt.folderPath ? `, folder ${lt.folderPath}` : ''}).`,
          ...(lt.branchName ? [`Branch: ${lt.branchName}`] : []),
          ...(lt.worktreePath ? [`Its ai-kanban worktree: ${lt.worktreePath}`] : []),
          ...(lt.sessionId ? [`Its agent session (not carried on here): ${lt.sessionId}`] : []),
          ...(st.waiting ? ['It was running in ai-kanban; its run does not carry on here. Continue or retry it to start a fresh session.'] : []),
        ].join('\n');
        repo.addComment({ taskId: id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: note, createdAt: updated });
      }
      importComments(db, repo, id, lt.id, tool.tool, reviewTool, rewrite, report);
      importLogs(db, repo, id, lt.id, report);
      if (opts.withStreamLogs) report.streamLogs.written += writeStreamLogs(db, target, id, lt.id);
      else report.streamLogs.skipped += (db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE taskId = ? AND type IN ('stream', 'stderr')`).get(lt.id) as { n: number }).n;
      const reviews = repo.listRuns(id).filter((r) => r.phase === 'review').length;
      const accepted = repo.acceptedPlan(id);
      repo.updateTask(id, {
        reviewRound: reviews,
        runState: 'idle',
        ...(st.waiting ? { waitingReason: 'interrupted', waitingText: 'Migrated from ai-kanban while it ran: start its phase again' } : { waitingReason: null, waitingText: null }),
        flags: { ...(st.status === 'todo' ? {} : { descriptionLocked: true }), ...(accepted ? { planAccepted: true } : {}) },
        updatedAt: updated,
      });
      repo.setMigratedAt(id, Math.max(now, updated));
    });
  }
  // New tasks carry on after the highest id ai-kanban used, so the old numbers never come back.
  if (maxId && !target.dry) repo.bumpNextTaskId(maxId + 1);
  report.nextTaskId = Math.max(repo.nextTaskId(), maxId + 1);
  for (const p of report.projects) p.tasks = [...assign.values()].filter((f) => f === p.floor).length;
  return report;
}

// --- Comments, runs, plans, events ----------------------------------------------------------------

function importComments(db: Database.Database, repo: KanbanRepository, id: number, legacyId: number, tool: KanbanTool, reviewTool: KanbanTool, rewrite: ReturnType<typeof pathRewriter>, report: MigrationReport) {
  const after = Number(repo.lookupLegacy(LEGACY_SOURCE, 'task-comments', legacyId) ?? 0);
  const last = repo.listComments(id, { limit: 1 }).comments[0];
  const dedupe = new SystemDedupe(20, last ? { author: last.authorKind === 'system' ? 'system' : last.authorKind, text: last.text } : undefined);
  let round = repo.listRuns(id).filter((r) => r.phase === 'review').length;
  let lastId = after;
  for (const c of legacyComments(db, legacyId, after)) {
    lastId = c.id;
    const text = rewrite(c.content ?? '');
    report.comments.pathsRewritten += text.count;
    if (!dedupe.keep({ author: c.author, content: text.text })) continue;
    const m = mapComment({ author: c.author, content: text.text }, tool, reviewTool);
    const at = ms(c.createdAt);
    let runId: number | undefined;
    if (m.run) {
      if (m.run.phase === 'review') round++;
      const run = repo.createRun({ taskId: id, phase: m.run.phase, ...(m.run.phase === 'review' || m.run.phase === 'fix' ? { round: Math.max(1, round) } : {}), role: m.run.role, tool: m.tool ?? tool, status: 'succeeded', startedAt: at });
      repo.updateRun(run.id, { finishedAt: at, summary: clip(text.text, 4000), ...(m.run.verdict ? { verdict: m.run.verdict } : {}) });
      runId = run.id;
      report.runs.reconstructed++;
      if (m.run.phase === 'review') {
        if (m.run.verdict === 'approved') report.runs.reviews.approved++;
        else if (m.run.verdict === 'changes_requested') report.runs.reviews.changesRequested++;
        else report.runs.reviews.noVerdict++;
      }
    }
    const added = repo.addComment({ taskId: id, authorKind: m.authorKind, authorName: m.authorName, ...(m.tool ? { tool: m.tool } : {}), kind: m.kind, text: text.text.slice(0, 200_000), ...(runId ? { runId } : {}), createdAt: at, legacyId: c.id });
    if (added.deduped) report.comments.dedupedConsecutive++;
    else report.comments.imported++;
  }
  report.comments.dedupedConsecutive += dedupe.consecutive;
  report.comments.dedupedFlood += dedupe.flood;
  if (lastId > after) repo.mapLegacy(LEGACY_SOURCE, 'task-comments', legacyId, lastId);
}

function importLogs(db: Database.Database, repo: KanbanRepository, id: number, legacyId: number, report: MigrationReport) {
  const after = Number(repo.lookupLegacy(LEGACY_SOURCE, 'task-logs', legacyId) ?? 0);
  let lastId = after;
  for (const l of legacyLogs(db, legacyId, LOG_TYPES, after)) {
    lastId = l.id;
    const at = ms(l.createdAt);
    const text = (l.content ?? '').trim();
    if (l.type === 'plan') {
      if (!text) continue;
      repo.addPlan(id, text, undefined, at);
      report.plans.imported++;
    } else if (l.type === 'plan_accepted') {
      const latest = repo.latestPlan(id);
      if (text && text !== latest?.text) {
        repo.addPlan(id, text, undefined, at);
        report.plans.imported++;
      }
      if (repo.acceptPlan(id, 'ai-kanban', undefined, at)) report.plans.accepted++;
    } else {
      // The rest of the history, as events: what ai-kanban said while it worked.
      repo.appendEvent(id, `ai-kanban.${l.type}`, { text: clip(text, 1000) }, at);
      report.events.imported++;
    }
  }
  if (lastId > after) repo.mapLegacy(LEGACY_SOURCE, 'task-logs', legacyId, lastId);
}

/** ai-kanban's raw agent output, into a file per task (<filesDir>/legacy/ai-kanban/task-<id>/stream.log), never the database. */
function writeStreamLogs(db: Database.Database, target: MigrationTarget, id: number, legacyId: number): number {
  const after = Number(target.repo.lookupLegacy(LEGACY_SOURCE, 'task-stream', legacyId) ?? 0);
  const file = path.join(target.filesDir, 'legacy', 'ai-kanban', `task-${id}`, 'stream.log');
  let n = 0;
  let lastId = after;
  for (const l of legacyLogs(db, legacyId, STREAM_TYPES, after)) {
    lastId = l.id;
    n++;
    if (target.dry) continue;
    if (n === 1) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `[${l.createdAt}] ${l.type}: ${l.content}\n`);
  }
  if (lastId > after && !target.dry) target.repo.mapLegacy(LEGACY_SOURCE, 'task-stream', legacyId, lastId);
  return n;
}

/** Copies a folder's files where they aren't yet (never over one); returns how many it copied (or would). */
function copyTree(from: string, to: string, dry: boolean): number {
  if (!isDir(from)) return 0;
  let n = 0;
  const walk = (src: string, dst: string) => {
    for (const name of readdirSync(src)) {
      if (name === '.DS_Store') continue;
      const s = path.join(src, name);
      const d = path.join(dst, name);
      if (isDir(s)) walk(s, d);
      else if (!existsSync(d)) {
        n++;
        if (dry) continue;
        mkdirSync(dst, { recursive: true, mode: 0o700 });
        cpSync(s, d, { force: false, errorOnExist: false });
      }
    }
  };
  walk(from, to);
  return n;
}

// --- Projects -------------------------------------------------------------------------------------

/** A repository or folder of ai-kanban's, as a project here. */
interface Planned {
  line: ProjectLine;
  def?: FloorDef;
  repo?: LegacyRepository;
  folder?: LegacySettings['folders'][number];
}

class Projects {
  private byRepoId = new Map<string, Planned>();
  private byName = new Map<string, Planned>();
  private byPath = new Map<string, Planned>();
  private unassigned?: Planned;
  /** Floors that get tasks or settings: the role's prompts and skills go to these. */
  private used = new Set<string>();

  constructor(
    private target: MigrationTarget,
    private s: LegacySettings,
    private report: MigrationReport,
  ) {
    for (const r of s.repositories) this.add(this.plan(r.name || path.basename(r.path), r.path, 'repository', r), r.id, r.name);
    for (const f of s.folders) this.add(this.plan(f.name || path.basename(f.path), f.path, 'folder', undefined, f), f.id, f.name);
  }

  private add(p: Planned, id: string, name: string) {
    this.byRepoId.set(id, p);
    this.byName.set((name || '').toLowerCase(), p);
    this.byName.set(path.basename(p.repo?.path ?? p.folder?.path ?? '').toLowerCase(), p);
    this.byPath.set(norm(p.repo?.path ?? p.folder!.path), p);
    this.report.projects.push(p.line);
  }

  /** A floor for a local checkout or folder: the one it already is, or a new one; none when it isn't there. */
  private floorFor(dir: string, mkdir = false): { def?: FloorDef; action: ProjectLine['action'] } {
    const abs = norm(dir);
    const known = this.target.building.list().find((d) => norm(d.dir) === abs);
    if (known) return { def: known, action: 'exists' };
    if (!isDir(abs)) {
      if (!mkdir) return { action: 'missing' };
      if (!this.target.dry) mkdirSync(abs, { recursive: true, mode: 0o700 });
    }
    // Building's own rules: the id from the folder's name, the next free look, its GitHub origin.
    const def = this.target.building.ensureLocal(abs, CREATED_BY);
    return def ? { def, action: 'created' } : { action: 'missing' };
  }

  private plan(name: string, dir: string, kind: 'repository' | 'folder', repo?: LegacyRepository, folder?: LegacySettings['folders'][number]): Planned {
    const got = this.floorFor(dir);
    const line: ProjectLine = { name, kind, action: got.action, floor: got.def?.id, repos: got.def ? projectRepos(got.def).length : 0, linksAdded: 0, linksMissing: 0, tasks: 0 };
    const p: Planned = { line, def: got.def, repo, folder };
    if (got.def && repo?.links?.length) this.extend(p, repo);
    else if (!got.def) this.report.warnings.push(`${kind} ${name}: its folder isn't on this machine, so it gets no floor; its tasks go to ${UNASSIGNED} unless --map says otherwise`);
    return p;
  }

  /** The repository's linked folders become the project's other repositories (the ones that are there). */
  private extend(p: Planned, r: LegacyRepository) {
    const def = p.def!;
    const current = projectRepos(def);
    const input: ProjectRepoInput[] = current.map((x) => ({ ...x }));
    const dirs = new Set(current.map((x) => norm(x.dir)));
    const ids = new Set(current.map((x) => x.id));
    const names = new Set(current.map((x) => x.name.toLowerCase()));
    let added = 0;
    for (const link of r.links ?? []) {
      if (!link?.path || !isDir(link.path)) {
        p.line.linksMissing++;
        continue;
      }
      if (dirs.has(norm(link.path))) continue;
      let name = (link.name || path.basename(link.path)).trim().slice(0, 100);
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${(link.name || path.basename(link.path)).trim().slice(0, 90)} ${n}`;
      const base = path.basename(link.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 17) || 'repo';
      let id = REPO_ID_RE.test(base) ? base : `r-${base}`.slice(0, 20);
      for (let n = 2; ids.has(id) || id === def.id || !REPO_ID_RE.test(id); n++) id = `${base.slice(0, 16)}-${n}`;
      ids.add(id);
      names.add(name.toLowerCase());
      dirs.add(norm(link.path));
      input.push({ id, name, dir: norm(link.path), kind: existsSync(path.join(link.path, '.git')) ? 'git' : 'folder', primary: false, ...(link.baseBranch && BRANCH_RE.test(link.baseBranch) ? { baseBranch: link.baseBranch } : {}) });
      added++;
    }
    if (!added) return;
    const checked = validateProjectRepos(def, input);
    if (typeof checked === 'string') {
      this.report.warnings.push(`${p.line.name}: its linked folders couldn't be added (${checked})`);
      return;
    }
    const saved = this.target.building.setRepos(def.id, checked);
    if (typeof saved === 'string') return void this.report.warnings.push(`${p.line.name}: ${saved}`);
    p.def = saved;
    p.line.linksAdded = added;
    p.line.repos = projectRepos(saved).length;
    if (p.line.action === 'exists') p.line.action = 'extended';
  }

  private unassignedFloor(): string {
    if (!this.unassigned) {
      const got = this.floorFor(path.join(this.target.home, UNASSIGNED), true);
      const line: ProjectLine = { name: UNASSIGNED, kind: 'unassigned', action: got.action, floor: got.def?.id, repos: 1, linksAdded: 0, linksMissing: 0, tasks: 0 };
      this.unassigned = { line, def: got.def };
      this.report.projects.push(line);
      if (!got.def) throw new Error(`Couldn't make the ${UNASSIGNED} project`);
    }
    return this.unassigned.def!.id;
  }

  /** The floor of a --map target: a floor id, or an ai-kanban repository's or folder's name or id. */
  private mapped(to: string): string | undefined {
    const t = to.trim();
    if (this.target.building.list().some((d) => d.id === t)) return t;
    const p = this.byRepoId.get(t) ?? this.byName.get(t.toLowerCase());
    if (p?.def) return p.def.id;
    const floor = this.target.building.list().find((d) => d.name.toLowerCase() === t.toLowerCase());
    return floor?.id;
  }

  /** Every task's floor: its repository (by id, then by name), its folder, --map, else the unassigned project. */
  assignAll(tasks: LegacyTask[], map: Record<string, string>): Map<number, string> {
    const out = new Map<number, string>();
    const names = new Map<string, { tasks: number; how: 'resolved' | 'mapped' | 'unassigned' }>();
    const mapLower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [k, v] of mapLower) if (!this.mapped(v)) this.report.warnings.push(`--map ${k}=${v}: there's no floor or ai-kanban repository ${v}`);
    for (const t of tasks) {
      let floor: string | undefined;
      let how: 'resolved' | 'mapped' | 'unassigned' = 'resolved';
      if (t.folderPath) {
        const p = this.byPath.get(norm(t.folderPath));
        floor = p?.def?.id;
        if (!floor && !p) {
          // An ad-hoc folder (never in the settings): a folder project of its own, when it's there.
          const got = this.floorFor(t.folderPath);
          if (got.def) {
            const line: ProjectLine = { name: path.basename(t.folderPath), kind: 'folder', action: got.action, floor: got.def.id, repos: 1, linksAdded: 0, linksMissing: 0, tasks: 0 };
            const planned: Planned = { line, def: got.def };
            this.byPath.set(norm(t.folderPath), planned);
            this.report.projects.push(line);
            floor = got.def.id;
          }
        }
      }
      if (!floor && !t.folderPath) floor = (t.repoId ? this.byRepoId.get(t.repoId)?.def?.id : undefined) ?? this.byName.get((t.repository ?? '').toLowerCase())?.def?.id;
      if (!floor) {
        const target = mapLower.get((t.repository ?? '').toLowerCase());
        const m = target ? this.mapped(target) : undefined;
        if (m) {
          floor = m;
          how = 'mapped';
        }
      }
      if (!floor) {
        floor = this.unassignedFloor();
        how = 'unassigned';
      }
      out.set(t.id, floor);
      this.used.add(floor);
      const key = t.repository ?? '';
      const had = names.get(key);
      names.set(key, { tasks: (had?.tasks ?? 0) + 1, how: had && had.how !== how ? (had.how === 'unassigned' || how === 'unassigned' ? 'unassigned' : had.how) : how });
    }
    const r = this.report.repositoryNames;
    r.distinct = names.size;
    for (const [name, v] of names) {
      r[v.how]++;
      if (v.how === 'unassigned') r.unresolved.push({ name, tasks: v.tasks });
    }
    return out;
  }

  /** Repository and folder settings into their projects', the role and review settings where they aren't the defaults. */
  applySettings() {
    const st = this.target.settings;
    const applied = this.report.settings.applied;
    const reported = this.report.settings.reported;
    const planned = [...new Set([...this.byRepoId.values(), ...this.byPath.values()])];
    for (const p of planned) {
      if (!p.def) continue;
      const src = p.repo ?? p.folder;
      if (!src) continue;
      this.used.add(p.def.id);
      const cur = st.project(p.def.id);
      const patch: Record<string, string> = {};
      const fill = (key: 'branchInstructions' | 'generalInstructions' | 'testingInstructions', value: string | undefined) => {
        if (!value?.trim()) return;
        if (cur[key].trim() && cur[key].trim() !== value.trim()) return void reported.push(`${p.line.name}: ${key} kept as 3d-kanban has it`);
        if (cur[key].trim() === value.trim()) return;
        patch[key] = value;
        applied.push(`${p.line.name}: ${key}`);
      };
      fill('branchInstructions', p.repo?.branchInstructions);
      fill('generalInstructions', src.generalInstructions);
      fill('testingInstructions', src.debugTestingInstructions);
      if (Object.keys(patch).length) st.setProject(p.def.id, patch);
      for (const [col, text] of Object.entries(src.columnActions ?? {})) {
        if (!text?.trim()) continue;
        if (col === 'pr-stage') this.prompt(p.def.id, p.line.name, 'kanban.pr.create', text.trim(), 'the PR column action');
        else reported.push(`${p.line.name}: the ${col || '(unnamed)'} column's action isn't migrated (there are no column actions here); decide by hand`);
      }
    }

    // The role: its phase texts where they aren't ai-kanban's own defaults.
    const role = this.s.roles.find((r) => r.id === this.s.defaultRole) ?? this.s.roles[0];
    if (role) {
      const custom = (key: 'plan' | 'implement' | 'review' | 'instructions', text: string | undefined) => !!text?.trim() && !BUILTIN_ROLE_HASHES[key].includes(textHash(text)!);
      const phase = role.phaseInstructions ?? {};
      const extras: [KanbanPromptId | string, string, string][] = [];
      if (custom('instructions', role.instructions)) extras.push(['kanban.plan', role.instructions!, "Role instructions (from ai-kanban)"], ['kanban.implement', role.instructions!, 'Role instructions (from ai-kanban)']);
      if (custom('plan', phase.plan)) extras.push(['kanban.plan', phase.plan!, 'Planning guidance (from ai-kanban)']);
      if (custom('implement', phase.implement)) extras.push(['kanban.implement', phase.implement!, 'Implementation guidance (from ai-kanban)']);
      if (custom('review', phase.review)) extras.push(['kanban.review', phase.review!, 'What to evaluate (from ai-kanban)']);
      const byPrompt = new Map<string, string[]>();
      for (const [id, text, heading] of extras) byPrompt.set(id, [...(byPrompt.get(id) ?? []), `## ${heading}\n\n${text.trim()}`]);
      for (const floor of this.used) {
        const name = this.target.building.list().find((d) => d.id === floor)?.name ?? floor;
        for (const [id, parts] of byPrompt) {
          const base = isKanbanPromptId(id) ? KANBAN_PROMPT_DEFS[id as KanbanPromptId].text : '';
          this.prompt(floor, name, id, `${base}\n\n${parts.join('\n\n')}`, `the role ${role.name ?? role.id}`);
        }
      }
      for (const [k, v] of Object.entries(role.prompts ?? {})) if (v && BUILTIN_ROLE_HASHES.prompts[k] !== v) reported.push(`role ${role.name ?? role.id}: its ${k} wording isn't migrated (the prompts here have no personas)`);
      // Skills: free text to a structured pick (best effort).
      const main = parseSkillText(role.defaultSkills, ['plan', 'implement']);
      const review = parseSkillText(role.reviewSkills || this.s.reviewSkills, ['review']);
      const selection: SkillSelection = { ...main.selection, ...review.selection };
      for (const u of [...main.unread, ...review.unread]) reported.push(`skills: "${u}" isn't a skill name, left out`);
      if (Object.keys(selection).length) {
        for (const floor of this.used) {
          if (Object.keys(st.project(floor).skills).length) {
            reported.push(`${floor}: skills kept as 3d-kanban has them`);
            continue;
          }
          st.setProject(floor, { skills: selection });
        }
        applied.push(`skills ${JSON.stringify(selection)} for ${this.used.size} projects (Claude; check the Codex ones by hand)`);
      }
    }

    // Office-wide: the review, the defaults, auto-resume, where 3d-kanban still has its own defaults.
    const office = st.get();
    const fresh = defaultKanbanSettings();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const tool = (t: string | undefined): KanbanTool | undefined => (t === 'claude' || t === 'codex' ? t : undefined);
    const effort = (e: string | undefined) => (KANBAN_EFFORTS.includes(e as KanbanEffort) ? (e as KanbanEffort) : undefined);
    const model = (m: string | undefined) => (m && MODEL_RE.test(m) ? m : undefined);
    if (same(office.review, DEFAULT_REVIEW)) {
      const review = {
        ...(tool(this.s.reviewTool) ? { tool: tool(this.s.reviewTool) } : {}),
        ...(model(this.s.reviewModel) ? { model: model(this.s.reviewModel) } : {}),
        ...(effort(this.s.reviewEffort) ? { effort: effort(this.s.reviewEffort) } : {}),
        ...(this.s.reviewIterations ? { rounds: Math.max(1, Math.min(10, Math.round(this.s.reviewIterations))) } : {}),
      };
      if (Object.keys(review).length) {
        st.set({ review: { ...office.review, ...review } });
        applied.push(`review: ${Object.keys(review).join(', ')}`);
      }
    } else reported.push('review settings kept as 3d-kanban has them');
    if (this.s.reviewTool && !tool(this.s.reviewTool)) reported.push(`the review tool ${this.s.reviewTool} isn't one here; the review runs on ${st.get().review.tool}`);
    if (same(office.defaults, fresh.defaults)) {
      const d = {
        ...(tool(this.s.agentTool) ? { tool: tool(this.s.agentTool) } : {}),
        ...(model(this.s.defaultModel) ? { model: model(this.s.defaultModel) } : {}),
        ...(effort(this.s.defaultEffort) ? { effort: effort(this.s.defaultEffort) } : {}),
      };
      if (Object.keys(d).length) {
        st.set({ defaults: { ...office.defaults, ...d } });
        applied.push(`defaults: ${Object.keys(d).join(', ')}`);
      }
    } else reported.push('task defaults kept as 3d-kanban has them');
    if (this.s.agentTool && !tool(this.s.agentTool)) reported.push(`the default tool ${this.s.agentTool} isn't one here; tasks default to ${st.get().defaults.tool}`);
    if (same(office.autoResume, fresh.autoResume) && this.s.autoResumeEnabled !== undefined) {
      st.set({ autoResume: { enabled: this.s.autoResumeEnabled, maxAttempts: Math.max(0, Math.min(50, this.s.autoResumeMaxAttempts ?? fresh.autoResume.maxAttempts)), maxWaitHours: Math.max(1, Math.min(168, this.s.autoResumeMaxWaitHours ?? fresh.autoResume.maxWaitHours)) } });
      applied.push('auto-resume');
    }
    if (this.s.implementPermissionMode && this.s.implementPermissionMode !== 'bypassPermissions') reported.push(`the implement permission mode ${this.s.implementPermissionMode} has no match here: implement phases run ${st.get().defaults.implementPermission}`);
    if (this.s.apiKeys?.length) reported.push(`${this.s.apiKeys.length} API keys aren't migrated (only their hashes were kept): set a new one in the kanban settings`);
  }

  private prompt(floor: string, name: string, id: string, text: string, what: string) {
    if (!isKanbanPromptId(id)) return void this.report.settings.reported.push(`${name}: ${what} has no prompt ${id} here`);
    if (this.target.settings.project(floor).prompts[id] !== undefined) return void this.report.settings.reported.push(`${name}: the ${id} prompt kept as 3d-kanban has it`);
    const err = this.target.settings.setProjectPrompt(floor, id, text);
    if (err) this.report.settings.reported.push(`${name}: ${what} as ${id}: ${err}`);
    else this.report.settings.applied.push(`${name}: ${what} as the ${id} prompt`);
  }
}
