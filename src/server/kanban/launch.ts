// What the kanban adds to how workers start: the Claude settings file its
// workers run on, and the saved shape of a task worker in workers.json.
import { readFileSync, writeFileSync } from 'node:fs';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { Worker } from '../workers/types.js';

/**
 * The command of a kanban worker's Stop hook: posts the hook's payload to the office's Stop gate (kanban/signals.ts) and prints its
 * answer, which Claude Code reads as `{"decision":"block","reason":…}` to carry on. When the office can't answer (no curl, down, any
 * 4xx/5xx) the original upstream command gets the same payload, so the Stop reaches the office as it did before.
 */
export function kanbanStopCommand(original: string): string {
  const post =
    `printf '%s' "$in" | curl -fsS -m 25 -X POST -H "Authorization: Bearer $AGENT_OFFICE_HOOK_TOKEN" -H "Content-Type: application/json" ` +
    `--data-binary @- "$AGENT_OFFICE_HOOK_URL/office/tasks/stop?worker=$AGENT_OFFICE_WORKER_ID" 2>/dev/null`;
  return (
    `in=$(cat); if [ -z "$AGENT_OFFICE_WORKER_ID" ] || [ -z "$AGENT_OFFICE_HOOK_URL" ]; then exit 0; fi; ` +
    `if command -v curl >/dev/null 2>&1 && out=$(${post}); then printf '%s\\n' "$out";` +
    `else printf '%s' "$in" | ( ${original} ) >/dev/null 2>&1; fi; true`
  );
}

/**
 * Claude's --settings for kanban workers, next to the office's own: the same hooks and permissions,
 * and kanban workers run their phases in bypass mode without the TUI asking to confirm it. Their Stop hook goes through the Stop gate
 * (kanbanStopCommand; AGENT_OFFICE_KANBAN_STOP_GATE=off leaves upstream's command).
 */
export function writeKanbanSettings(settingsPath: string): string {
  const kanbanPath = settingsPath.replace(/\.json$/, '-kanban.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const stop = settings.hooks?.Stop?.[0]?.hooks?.[0];
  if (process.env.AGENT_OFFICE_KANBAN_STOP_GATE !== 'off' && typeof stop?.command === 'string' && stop.command) {
    stop.command = kanbanStopCommand(stop.command);
    // The gate may read the log and run git (it gives up at 10 s); the wrapper's curl waits 25 s.
    stop.timeout = 40;
  }
  writeFileSync(kanbanPath, JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }, null, 2), { mode: 0o600 });
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
  return { launchArgs: args, env, settingsFile: v.settingsFile === 'kanban' ? 'kanban' : undefined, reused: v.reused === true, restartedAt: Number.isFinite(v.restartedAt) ? (v.restartedAt as number) : undefined };
}
