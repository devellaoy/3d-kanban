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

/**
 * Whether Claude's transcript of `sessionId` exists (`<claude home>/projects/<cwd slug>/<id>.jsonl`, under the home the
 * task's owner's own sign-in gives, else the office's). `false` only when the home's projects folder was read and has no such
 * file; undefined when that can't be told (Codex, no readable folder): the caller then leaves the session alone.
 */
export function sessionLogged(ctx: Pick<KanbanContext, 'runAs'>, task: Pick<KanbanTask, 'createdByAccount'>, tool: KanbanTool, sessionId: string, known?: string): boolean | undefined {
  if (tool !== 'claude') return undefined;
  if (known && path.basename(known) === `${sessionId}.jsonl` && isFile(known)) return true;
  const env: Record<string, string> = {};
  if (task.createdByAccount) ctx.runAs?.apply?.(task.createdByAccount, env); // the account a task's hires run as (hireOwner)
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
