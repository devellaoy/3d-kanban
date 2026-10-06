// Whether a task worker's stored agent session still exists, to tell a session that is gone from an agent
// that merely exited early (an expired sign-in, a crash, a startup failure): only the first starts afresh.

import { readdirSync, statSync } from 'node:fs';
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

/** Whether a rollout of Codex's session `id` lies in `dir` (`sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`, or flat under `archived_sessions`); undefined when `dir` can't be read. */
function rolloutIn(dir: string, id: string, depth = 4): boolean | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  return names.some((n) => (n.endsWith(`-${id}.jsonl`) && isFile(path.join(dir, n))) || (depth > 0 && rolloutIn(path.join(dir, n), id, depth - 1) === true));
}

/**
 * Whether the agent's log of `sessionId` exists. Claude's: `<claude home>/projects/<cwd slug>/<id>.jsonl`, under the home the task's
 * owner's own sign-in gives, else the office's. Codex's: its rollout under the worker's Codex home (else the sign-in's, else the
 * office's), in `sessions` or `archived_sessions`. `false` only when the home was read and has no such file; undefined when that can't
 * be told (no readable folder): the caller then leaves the session alone.
 */
export function sessionLogged(ctx: Pick<KanbanContext, 'runAs'>, task: Pick<KanbanTask, 'createdByAccount'>, tool: KanbanTool, sessionId: string, logs?: SessionLogs): boolean | undefined {
  const env: Record<string, string> = {};
  if (task.createdByAccount) ctx.runAs?.apply?.(task.createdByAccount, env); // the account a task's hires run as (hireOwner)
  if (tool === 'codex') {
    const known = logs?.codex;
    if (known && (path.basename(known) === `${sessionId}.jsonl` || path.basename(known).endsWith(`-${sessionId}.jsonl`)) && isFile(known)) return true;
    const home = logs?.codexHome || env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const found = ['sessions', 'archived_sessions'].map((d) => rolloutIn(path.join(home, d), sessionId));
    return found.every((f) => f === undefined) ? undefined : found.some((f) => f === true);
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
