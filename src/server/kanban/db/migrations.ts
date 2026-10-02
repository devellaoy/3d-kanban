// The kanban database's schema, as numbered migrations (docs/kanban-architecture.md §5). The
// database's PRAGMA user_version is the number of the last one applied; each runs once, in a
// transaction, in order. Never edit a migration that has shipped: add the next one.

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

const INITIAL = `
-- A task: one unit of work on one project (a floor). Its id is global across projects and is
-- handed out from meta.next_task_id, so migrated tasks can keep the ids they had.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'implement',
  status TEXT NOT NULL DEFAULT 'todo',
  ticket TEXT,
  ticket_url TEXT,
  phase TEXT,
  run_state TEXT NOT NULL DEFAULT 'idle',
  waiting_reason TEXT,
  waiting_text TEXT,
  review_round INTEGER NOT NULL DEFAULT 0,
  tool TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  effort TEXT,
  use_plan INTEGER NOT NULL DEFAULT 1,
  plan_approval TEXT NOT NULL DEFAULT 'auto',
  use_review INTEGER NOT NULL DEFAULT 1,
  goal TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  reviewer_session_id TEXT,
  worker_id TEXT,
  reviewer_worker_id TEXT,
  branch TEXT,
  worktree TEXT,
  pending_messages TEXT NOT NULL DEFAULT '[]',
  retry_at INTEGER,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  created_by TEXT NOT NULL DEFAULT '?',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  done_at INTEGER,
  archived_at INTEGER,
  legacy_source TEXT,
  legacy_id INTEGER,
  migrated_at INTEGER
);
CREATE INDEX tasks_project_status ON tasks(project, status);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_retry ON tasks(retry_at) WHERE retry_at IS NOT NULL;
CREATE INDEX tasks_ticket ON tasks(project, ticket) WHERE ticket IS NOT NULL;
CREATE UNIQUE INDEX tasks_legacy ON tasks(legacy_source, legacy_id) WHERE legacy_source IS NOT NULL;

-- The subset of the project's repositories a task works in (none: all of them), and the branch
-- the agent made in each.
CREATE TABLE task_repos (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  PRIMARY KEY (task_id, repo_id)
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL,
  author_name TEXT NOT NULL,
  tool TEXT,
  kind TEXT NOT NULL DEFAULT 'message',
  text TEXT NOT NULL,
  run_id INTEGER,
  pending INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  legacy_id INTEGER
);
CREATE INDEX comments_task ON comments(task_id, id);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  round INTEGER,
  role TEXT NOT NULL DEFAULT 'implementer',
  tool TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  session_id TEXT,
  worker_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  verdict TEXT,
  summary TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX runs_task ON runs(task_id, id);
CREATE INDEX runs_running ON runs(status) WHERE status = 'running';

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  text TEXT NOT NULL,
  feedback TEXT,
  run_id INTEGER,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT,
  UNIQUE (task_id, version)
);

-- Uploaded files. task_id stays null until the file is attached (uploaded in the create dialog).
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_task ON attachments(task_id);
CREATE INDEX attachments_comment ON attachments(comment_id);

-- A task's history, capped per task (see TASK_EVENTS_CAP).
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT
);
CREATE INDEX task_events_task ON task_events(task_id, id);

CREATE TABLE pr_links (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  repo TEXT,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  branch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, repo_id, number)
);
CREATE INDEX pr_links_repo ON pr_links(repo, number);

-- What a migration brought in, by its old id, so running it again updates instead of duplicating.
CREATE TABLE legacy_map (
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  new_id TEXT NOT NULL,
  migrated_at INTEGER NOT NULL,
  PRIMARY KEY (source, kind, legacy_id)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('next_task_id', '1');
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema', up: (db) => db.exec(INITIAL) },
  {
    version: 2,
    name: 'task desk, creator account and queued run',
    // desk_id: the desk its implementer is hired at (the one it was started at, else where it last sat).
    // created_by_account: whose sign-ins its drained, retried and swept hires run on. queued_run: the
    // run waiting for a desk or for room under the office's worker limit (JSON, see QueuedRun).
    up: (db) => db.exec(`ALTER TABLE tasks ADD COLUMN desk_id TEXT;
ALTER TABLE tasks ADD COLUMN created_by_account TEXT;
ALTER TABLE tasks ADD COLUMN queued_run TEXT;`),
  },
  {
    version: 3,
    name: 'task handoff fingerprint',
    // handoff_fingerprint: the workspace as the user last got it in the Review column (workspaceFingerprint),
    // so a comment's work that changes nothing since is not reviewed again.
    up: (db) => db.exec('ALTER TABLE tasks ADD COLUMN handoff_fingerprint TEXT;'),
  },
  {
    version: 4,
    name: 'task hold',
    // hold: why and since when a task is on hold, and the look of its implementer (JSON, see TaskHold).
    up: (db) => db.exec('ALTER TABLE tasks ADD COLUMN hold TEXT;'),
  },
];

/** The schema version this build expects. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Brings the database up to SCHEMA_VERSION. Refuses a database from a newer build rather than
 * guessing at a schema it doesn't know. Returns the migrations it applied.
 */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (current > latest) throw new Error(`The kanban database is at schema version ${current}, newer than this build knows (${latest}): upgrade 3d-kanban`);
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied.push(m.version);
  }
  return applied;
}
