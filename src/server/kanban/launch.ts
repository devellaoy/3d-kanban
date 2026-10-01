// What the kanban adds to how workers start (docs/fork.md, "Server"): the Claude settings file its
// workers run on, and the saved shape of a task worker in workers.json.
import { readFileSync, writeFileSync } from 'node:fs';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { Worker } from '../workers/types.js';

/**
 * Claude's --settings for kanban workers, next to the office's own: the same hooks and permissions,
 * and kanban workers run their phases in bypass mode without the TUI asking to confirm it.
 */
export function writeKanbanSettings(settingsPath: string): string {
  const kanbanPath = settingsPath.replace(/\.json$/, '-kanban.json');
  writeFileSync(kanbanPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, 'utf8')), skipDangerousModePermissionPrompt: true }, null, 2), { mode: 0o600 });
  return kanbanPath;
}

/** A task worker's part, as workers.json kept it. */
export function validKanban(k: unknown): WorkerInfo['kanban'] {
  const v = k as Partial<NonNullable<WorkerInfo['kanban']>> | undefined;
  return Number.isSafeInteger(v?.taskId) && (v!.role === 'implementer' || v!.role === 'reviewer') ? { taskId: v!.taskId!, role: v!.role } : undefined;
}

/** How a task worker is launched, as workers.json kept it. */
export function validExtra(e: unknown): Worker['extra'] {
  if (!e || typeof e !== 'object') return undefined;
  const v = e as Record<string, unknown>;
  const args = Array.isArray(v.launchArgs) && v.launchArgs.every((a) => typeof a === 'string') ? (v.launchArgs as string[]) : undefined;
  const env = v.env && typeof v.env === 'object' && Object.values(v.env).every((x) => typeof x === 'string') ? (v.env as Record<string, string>) : undefined;
  return { launchArgs: args, env, settingsFile: v.settingsFile === 'kanban' ? 'kanban' : undefined, reused: v.reused === true };
}
