// ai-kanban's data as the migration reads it (read-only): its SQLite tables (tasks, comments,
// logs), settings.json (repositories with their linked folders, folders, roles, review settings)
// and the uploads/ and reports/ folders. Plus the pure rules that turn its rows into ours: statuses,
// comment authors and kinds, the runs its comment prefixes stand for, duplicate system comments,
// file paths. Nothing here writes anywhere.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CommentAuthorKind, CommentKind, KanbanTool, ReviewVerdict, RunPhase, SkillSelection, TaskStatus } from '../../src/shared/kanban/types.js';

export const LEGACY_SOURCE = 'ai-kanban';

// --- What ai-kanban keeps -------------------------------------------------------------------------

export interface LegacyTask {
  id: number;
  title: string;
  description: string;
  ticketId: string | null;
  repository: string;
  repoId: string | null;
  folderPath: string | null;
  status: string;
  branchName: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  summary: string | null;
  taskType: string | null;
  agentTool: string | null;
  model: string | null;
  effort: string | null;
  usePlan: number | null;
  review: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyComment {
  id: number;
  taskId: number;
  author: string;
  content: string;
  createdAt: string;
}

export interface LegacyLog {
  id: number;
  taskId: number;
  type: string;
  content: string;
  createdAt: string;
}

export interface LegacyLink {
  name?: string;
  path?: string;
  baseBranch?: string;
}
export interface LegacyRepository {
  id: string;
  name: string;
  path: string;
  baseBranch?: string;
  links?: LegacyLink[];
  branchInstructions?: string;
  generalInstructions?: string;
  debugTestingInstructions?: string;
  columnActions?: Record<string, string>;
}
export interface LegacyFolder {
  id: string;
  name: string;
  path: string;
  generalInstructions?: string;
  debugTestingInstructions?: string;
  columnActions?: Record<string, string>;
}
export interface LegacyRole {
  id: string;
  name?: string;
  defaultSkills?: string;
  reviewSkills?: string;
  instructions?: string;
  prompts?: Record<string, string>;
  phaseInstructions?: { plan?: string; implement?: string; review?: string };
}
export interface LegacySettings {
  repositories: LegacyRepository[];
  folders: LegacyFolder[];
  columns: { id: string; title: string }[];
  agentTool?: string;
  defaultModel?: string;
  defaultEffort?: string;
  reviewTool?: string;
  reviewModel?: string;
  reviewEffort?: string;
  reviewSkills?: string;
  reviewIterations?: number;
  implementPermissionMode?: string;
  roles: LegacyRole[];
  defaultRole?: string;
  autoResumeEnabled?: boolean;
  autoResumeMaxAttempts?: number;
  autoResumeMaxWaitHours?: number;
  apiKeys?: unknown[];
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** settings.json, read as it is (ai-kanban's own reader writes the file back; this never does). */
export function readLegacySettings(dataDir: string): LegacySettings {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // no settings: the defaults
  }
  return {
    repositories: arr<LegacyRepository>(raw.repositories).filter((r) => r && typeof r.id === 'string' && typeof r.path === 'string'),
    folders: arr<LegacyFolder>(raw.folders).filter((f) => f && typeof f.id === 'string' && typeof f.path === 'string'),
    columns: arr<{ id: string; title: string }>(raw.columns).filter((c) => c && typeof c.id === 'string'),
    agentTool: str(raw.agentTool),
    defaultModel: str(raw.defaultModel),
    defaultEffort: str(raw.defaultEffort),
    reviewTool: str(raw.reviewTool),
    reviewModel: str(raw.reviewModel),
    reviewEffort: str(raw.reviewEffort),
    reviewSkills: str(raw.reviewSkills),
    reviewIterations: typeof raw.reviewIterations === 'number' ? raw.reviewIterations : undefined,
    implementPermissionMode: str(raw.implementPermissionMode),
    roles: arr<LegacyRole>(raw.roles).filter((r) => r && typeof r.id === 'string'),
    defaultRole: str(raw.defaultRole),
    autoResumeEnabled: typeof raw.autoResumeEnabled === 'boolean' ? raw.autoResumeEnabled : undefined,
    autoResumeMaxAttempts: typeof raw.autoResumeMaxAttempts === 'number' ? raw.autoResumeMaxAttempts : undefined,
    autoResumeMaxWaitHours: typeof raw.autoResumeMaxWaitHours === 'number' ? raw.autoResumeMaxWaitHours : undefined,
    apiKeys: arr(raw.apiKeys),
  };
}

/** The old database, opened so it can't be written to (and not created when it isn't there). */
export function openLegacyDb(dataDir: string): Database.Database {
  const file = path.join(dataDir, 'database.sqlite');
  if (!existsSync(file)) throw new Error(`There's no ai-kanban database at ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

/** The columns a task row has in this database (older ai-kanbans had fewer). */
function taskColumns(db: Database.Database): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
}

export function readLegacyTasks(db: Database.Database): LegacyTask[] {
  const cols = taskColumns(db);
  const col = (name: string, fallback = 'NULL') => (cols.has(name) ? name : `${fallback} AS ${name}`);
  const sql = `SELECT id, title, description, ticketId, repository, ${col('repoId')}, ${col('folderPath')}, status, branchName, worktreePath, ${col('sessionId')}, summary,
    ${col('taskType')}, ${col('agentTool')}, ${col('model')}, ${col('effort')}, ${col('usePlan')}, ${col('review')}, createdAt, updatedAt FROM tasks ORDER BY id`;
  return db.prepare(sql).all() as LegacyTask[];
}

/** A task's comments from after `afterId`, oldest first, one at a time (a task can have 337 215). */
export function legacyComments(db: Database.Database, taskId: number, afterId = 0): IterableIterator<LegacyComment> {
  return db.prepare('SELECT id, taskId, author, content, createdAt FROM comments WHERE taskId = ? AND id > ? ORDER BY id').iterate(taskId, afterId) as IterableIterator<LegacyComment>;
}

/** A task's logs of these types from after `afterId`, oldest first. */
export function legacyLogs(db: Database.Database, taskId: number, types: string[], afterId = 0): IterableIterator<LegacyLog> {
  return db
    .prepare(`SELECT id, taskId, type, content, createdAt FROM logs WHERE taskId = ? AND id > ? AND type IN (${types.map(() => '?').join(', ')}) ORDER BY id`)
    .iterate(taskId, afterId, ...types) as IterableIterator<LegacyLog>;
}

export function legacyCounts(db: Database.Database) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const groups = (sql: string) => Object.fromEntries((db.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k ?? '(none)', r.n]));
  return {
    tasks: n('SELECT COUNT(*) AS n FROM tasks'),
    comments: n('SELECT COUNT(*) AS n FROM comments'),
    logs: n('SELECT COUNT(*) AS n FROM logs'),
    maxTaskId: n('SELECT COALESCE(MAX(id), 0) AS n FROM tasks'),
    byStatus: groups('SELECT status AS k, COUNT(*) AS n FROM tasks GROUP BY status'),
    byAuthor: groups('SELECT author AS k, COUNT(*) AS n FROM comments GROUP BY author'),
    byLogType: groups('SELECT type AS k, COUNT(*) AS n FROM logs GROUP BY type'),
  };
}

// --- Statuses -------------------------------------------------------------------------------------

/** Where an ai-kanban status lands, and the tag a custom column leaves. */
export function mapStatus(status: string): { status: TaskStatus; tag?: string; waiting?: boolean } {
  switch (status) {
    case 'todo':
      return { status: 'todo' };
    case 'in_progress':
    case 'waiting':
      // Its run doesn't carry on here (another checkout, another session): it waits for the user.
      return { status: 'waiting', waiting: true };
    case 'reviewable':
      return { status: 'review' };
    case 'done':
      return { status: 'done' };
    case 'history':
      return { status: 'archived' };
    default:
      // A custom column (pr-stage, pr-katselmointi...): there are none here, its id becomes a tag.
      return { status: 'review', tag: status.slice(0, 40) };
  }
}

// --- Comments -------------------------------------------------------------------------------------

/** The prefixes ai-kanban's agent comments start with, what kind of comment each is, and the run it stands for. */
const PREFIXES: { re: RegExp; kind: CommentKind; phase?: RunPhase; role?: 'reviewer' }[] = [
  { re: /^\*\*Suunnitelma:\*\*/, kind: 'plan', phase: 'plan' },
  { re: /^\*\*Kysymykset:\*\*/, kind: 'questions', phase: 'plan' },
  { re: /^\*\*Toteutus valmis:\*\*/, kind: 'result', phase: 'implement' },
  { re: /^\*\*Selvitys valmis:\*\*/, kind: 'result', phase: 'implement' },
  { re: /^\*\*Katselmointi:\*\*/, kind: 'review', phase: 'review', role: 'reviewer' },
  { re: /^\*\*Korjaukset[^*]*:\*\*/, kind: 'result', phase: 'fix' },
  { re: /^\*\*Jatko:\*\*/, kind: 'result', phase: 'resume' },
  { re: /^\*\*Saraketoiminto:\*\*/, kind: 'result', phase: 'pr' },
  { re: /^\*\*Tiivistelmä:\*\*/, kind: 'result', phase: 'compact' },
];

export interface MappedComment {
  authorKind: CommentAuthorKind;
  authorName: string;
  tool?: KanbanTool;
  kind: CommentKind;
  /** The run the comment is the result of (agent comments with a known prefix). */
  run?: { phase: RunPhase; role: 'implementer' | 'reviewer'; verdict?: ReviewVerdict };
}

/** The last `REVIEW:` line decides, as the engine reads it (none: no verdict). */
export function reviewVerdict(text: string): ReviewVerdict | undefined {
  let v: ReviewVerdict | undefined;
  for (const line of text.split('\n')) {
    const m = /^\s*\**\s*REVIEW:\s*(APPROVED|CHANGES_REQUESTED)\s*\**\s*$/.exec(line);
    if (m) v = m[1] === 'APPROVED' ? 'approved' : 'changes_requested';
  }
  return v;
}

/** Who wrote a comment and what it is. `claude` meant any agent: the task's tool (the review tool for reviews). */
export function mapComment(c: Pick<LegacyComment, 'author' | 'content'>, taskTool: KanbanTool, reviewTool: KanbanTool): MappedComment {
  if (c.author === 'user') return { authorKind: 'user', authorName: 'user', kind: 'message' };
  if (c.author === 'system') return { authorKind: 'system', authorName: 'Kanban', kind: 'status' };
  const p = PREFIXES.find((x) => x.re.test(c.content.trimStart()));
  const tool = p?.role === 'reviewer' ? reviewTool : taskTool;
  const name = tool === 'codex' ? 'Codex' : 'Claude';
  if (!p) return { authorKind: 'agent', authorName: name, tool, kind: 'message' };
  return {
    authorKind: 'agent',
    authorName: name,
    tool,
    kind: p.kind,
    ...(p.phase ? { run: { phase: p.phase, role: p.role ?? 'implementer', ...(p.phase === 'review' ? { verdict: reviewVerdict(c.content) } : {}) } } : {}),
  };
}

/**
 * Drops repeated system comments: one saying exactly what the task's previous comment said (ai-kanban
 * once wrote the same line 337 215 times), and any system text past `cap` times in one task.
 */
export class SystemDedupe {
  private last?: { author: string; text: string };
  private seen = new Map<string, number>();
  consecutive = 0;
  flood = 0;

  constructor(
    private cap = 20,
    last?: { author: string; text: string },
  ) {
    this.last = last;
  }

  /** Whether to keep it; counts what it drops. */
  keep(c: Pick<LegacyComment, 'author' | 'content'>): boolean {
    const prev = this.last;
    this.last = { author: c.author, text: c.content };
    if (c.author !== 'system') return true;
    if (prev?.author === 'system' && prev.text === c.content) {
      this.consecutive++;
      return false;
    }
    const n = (this.seen.get(c.content) ?? 0) + 1;
    this.seen.set(c.content, n);
    if (n > this.cap) {
      this.flood++;
      return false;
    }
    return true;
  }
}

// --- Paths ----------------------------------------------------------------------------------------

/** Rewrites absolute paths under the old data folder's uploads/ and reports/ to where they're copied. */
export function pathRewriter(fromDirs: string[], to: { uploads: string; reports: string }): (text: string) => { text: string; count: number } {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const roots = [...new Set(fromDirs.map((d) => d.replace(/[\\/]+$/, '')))].sort((a, b) => b.length - a.length);
  const re = roots.length ? new RegExp(`(?:${roots.map(esc).join('|')})[\\\\/](uploads|reports)(?=[\\\\/])`, 'g') : undefined;
  return (text) => {
    if (!re || !text) return { text, count: 0 };
    let count = 0;
    const out = text.replace(re, (_m, kind: string) => {
      count++;
      return kind === 'uploads' ? to.uploads : to.reports;
    });
    return { text: out, count };
  };
}

// --- Dates, tools, skills -------------------------------------------------------------------------

export function ms(iso: string | null | undefined, fallback = Date.now()): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

/** The tool a task runs on here: claude and codex as they were; copilot (and anything else) the default. */
export function mapTool(tool: string | null | undefined, fallback: KanbanTool): { tool: KanbanTool; changed: boolean } {
  if (tool === 'claude' || tool === 'codex') return { tool, changed: false };
  return { tool: fallback, changed: !!tool };
}

/**
 * ai-kanban's free-text skill lists ("kanban-dev, kanban-ui-screenshots", or "claude: X / codex: Y")
 * as a structured pick for these phases. Best effort: what doesn't look like a skill name is listed
 * in `unread`.
 */
export function parseSkillText(text: string | undefined, phases: ('plan' | 'implement' | 'review' | 'pr')[]): { selection: SkillSelection; unread: string[] } {
  const selection: SkillSelection = {};
  const unread: string[] = [];
  const t = (text ?? '').trim();
  if (!t) return { selection, unread };
  const per: { claude: string[]; codex: string[] } = { claude: [], codex: [] };
  const segments = /\b(claude|codex)\s*:/i.test(t) ? t.split(/[/;|\n]+/) : [t];
  for (const seg of segments) {
    const m = /^\s*(claude|codex)\s*:\s*(.*)$/i.exec(seg);
    const tools: ('claude' | 'codex')[] = m ? [m[1].toLowerCase() as 'claude' | 'codex'] : ['claude'];
    for (const raw of (m ? m[2] : seg).split(/[,\s]+/)) {
      const name = raw.trim().replace(/^\//, '');
      if (!name) continue;
      if (!/^[A-Za-z0-9][\w.:-]{0,99}$/.test(name)) {
        unread.push(raw);
        continue;
      }
      for (const tool of tools) if (!per[tool].includes(name)) per[tool].push(name);
    }
  }
  for (const phase of phases) {
    const entry = { ...(per.claude.length ? { claude: [...per.claude] } : {}), ...(per.codex.length ? { codex: [...per.codex] } : {}) };
    if (Object.keys(entry).length) selection[phase] = entry;
  }
  return { selection, unread };
}

/** A short hash of a text, as the built-in defaults below are kept. */
export function textHash(s: string | undefined): string | undefined {
  return s === undefined ? undefined : createHash('sha256').update(s.trim().replace(/\r\n?/g, '\n')).digest('hex').slice(0, 16);
}

/**
 * ai-kanban's built-in default role texts, as hashes (so a role that still has them isn't migrated
 * as a custom prompt). From its server/utils/roles.ts, current and earlier review guidances.
 */
export const BUILTIN_ROLE_HASHES = {
  instructions: ['54776d3338792ea8'],
  plan: ['8a3d6bd6a59f0b32'],
  implement: ['15357357fc6c9eab'],
  review: ['d0d0724a767eabae', '4eb1cfca7a964416', '17c06320e94e8b42', 'eae241a79aaf9f62'],
  prompts: { planner: 'software development planner', analyst: 'software development analyst', reviewer: 'experienced code reviewer', taskNoun: 'software development task' } as Record<string, string>,
};
