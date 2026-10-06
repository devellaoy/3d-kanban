// Whether a task worker's stored agent session still exists, to tell a session that is gone from an agent
// that merely exited early (an expired sign-in, a crash, a startup failure): only the first starts afresh.

import { readdirSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KanbanContext } from '../registry.js';
import type { KanbanTask, KanbanTool } from '../../../shared/kanban/types.js';

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** What a worker's provider keeps of its session on disk, as `floor.workers.transcripts` tells (a file known to be its log, and where Codex's sessions live). */
export interface SessionLogs {
  claude?: string;
  codex?: string;
  codexHome?: string;
}

/** Where Codex session rollouts were found, by session id (misses are not kept: the session may start logging later). */
const rollouts = new Map<string, string>();

/** The rollout of Codex's session `id` in `dir` (`sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`, or flat under `archived_sessions`), searched `depth` folders down; false when there is none, undefined when `dir` can't be read. */
function rolloutIn(dir: string, id: string, depth = 4): string | false | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const file = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(`-${id}.jsonl`)) return file;
    const inside = e.isDirectory() && depth > 0 ? rolloutIn(file, id, depth - 1) : undefined;
    if (inside) return inside;
  }
  return false;
}

/** The `sessions/YYYY/MM/DD` folders a session that was going at `at` (ms) may be filed in: that day and the ones around it (the day is Codex's own, in some time zone). */
function dayFolders(sessions: string, at: number): string[] {
  return [-1, 0, 1].map((d) => {
    const day = new Date(at + d * 86_400_000);
    return path.join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  });
}

/** Where Codex's rollout of session `id` is, or whether it can be told at all (see sessionLogged): the day folders of `at` first, then everything. */
function findRollout(home: string, id: string, at?: number): string | false | undefined {
  const cached = rollouts.get(id);
  if (cached && isFile(cached)) return cached;
  const sessions = path.join(home, 'sessions');
  const near = at === undefined ? undefined : dayFolders(sessions, at).map((d) => rolloutIn(d, id, 0)).find((f) => typeof f === 'string');
  const found = near ? [near] : [sessions, path.join(home, 'archived_sessions')].map((d) => rolloutIn(d, id));
  const hit = found.find((f) => typeof f === 'string');
  if (hit) rollouts.set(id, hit);
  return hit || (found.every((f) => f === undefined) ? undefined : false);
}

/**
 * Whether the agent's log of `sessionId` exists. Claude's: `<claude home>/projects/<cwd slug>/<id>.jsonl`, under the home the task's
 * owner's own sign-in gives, else the office's. Codex's: its rollout under the worker's Codex home (else the sign-in's, else the
 * office's), in `sessions` or `archived_sessions`. `false` only when the home was read and has no such file; undefined when that can't
 * be told (no readable folder): the caller then leaves the session alone. `at`: when the run was going (ms), to look in Codex's folders for that day first.
 */
export function sessionLogged(ctx: Pick<KanbanContext, 'runAs'>, task: Pick<KanbanTask, 'createdByAccount'>, tool: KanbanTool, sessionId: string, logs?: SessionLogs, at?: number): boolean | undefined {
  const env: Record<string, string> = {};
  if (task.createdByAccount) ctx.runAs?.apply?.(task.createdByAccount, env); // the account a task's hires run as (hireOwner)
  if (tool === 'codex') {
    const known = logs?.codex;
    if (known && (path.basename(known) === `${sessionId}.jsonl` || path.basename(known).endsWith(`-${sessionId}.jsonl`)) && isFile(known)) return true;
    const home = logs?.codexHome || env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const found = findRollout(home, sessionId, at);
    return found === undefined ? undefined : !!found;
  }
  if (tool !== 'claude') return undefined;
  const known = logs?.claude;
  if (known && path.basename(known) === `${sessionId}.jsonl` && isFile(known)) return true;
  const home = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projects = path.join(home, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return undefined;
  }
  return dirs.some((d) => isFile(path.join(projects, d, `${sessionId}.jsonl`)));
}
