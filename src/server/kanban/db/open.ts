// Opens the kanban's SQLite database (<officeData>/.agent-office/kanban.sqlite, see kanbanDbPath):
// WAL, so the board reads while the engine writes; foreign keys on, which SQLite leaves off by
// default; and every migration applied.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';

/** The database file in the office's data dir (the `.agent-office` folder upstream keeps everything in). */
export function kanbanDbPath(dataDir: string): string {
  return path.join(dataDir, 'kanban.sqlite');
}

/** Opens (and creates, and migrates) the database at `file`; ':memory:' for tests. */
export function openKanbanDb(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  try {
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
