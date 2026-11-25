// What the kanban adds to how workers start: the Claude settings file its
// workers run on, and the saved shape of a task worker in workers.json.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
 * and `skipDangerousModePermissionPrompt`: the reviewers (and workers set to bypass mode) run in bypass mode without the TUI asking to
 * confirm it, so it is always on. Their Stop hook goes through the Stop gate
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
  kanbanPaths.add(kanbanPath);
  return kanbanPath;
}

/** Every floor's kanban settings file written in this process: a worker's own file is next to its floor's. */
const kanbanPaths = new Set<string>();
/** The folders the office keeps tasks' files in (<officeData>/.agent-office/kanban of each kanban opened in this process). */
const officeRoots = new Set<string>();

/** The kanban says where its tasks' folders are (kanban/index.ts): the floors' workers get folders inside it through their settings file. */
export function registerOfficeFiles(filesDir: string) {
  officeRoots.add(path.resolve(filesDir) + path.sep);
}

/** A task's own folder, or a project's instructions folder, under an office's data folder: `<…>/.agent-office/kanban/{grants,refs,reports}/task-<id>`, `<…>/.agent-office/kanban/instructions/<project-id>`. */
const OFFICE_TASK_DIR = /[\\/]\.agent-office[\\/]kanban[\\/](?:(?:grants|refs|reports)[\\/]task-\d+|instructions[\\/][a-z0-9-]{1,40})$/;

const workerSettingsPath = (kanbanPath: string, workerId: string) => kanbanPath.replace(/\.json$/, `-${workerId}.json`);

/**
 * A kanban Claude worker's launchArgs without the `--add-dir <folder>` pairs of the office's own folders (those inside `filesDir`: the
 * task's attached files, references and reports; registerOfficeFiles names the root), and those folders. Claude asks "Is this a directory you created or one you trust?"
 * for each --add-dir folder it hasn't been told to trust, in every permission mode; a folder in a settings file's
 * `permissions.additionalDirectories` asks nothing (writeWorkerSettings). Other folders (a repository) stay on the command line.
 */
export function splitOfficeDirs(args: string[], filesDir?: string): { args: string[]; dirs: string[] } {
  const roots = filesDir ? [path.resolve(filesDir) + path.sep] : [...officeRoots];
  // The floors wake their workers before the kanban opens (server.ts), so a worker resumed at the office's start is launched before
  // any root is named: the folders are then known by their shape, which only the office makes.
  const office = (d: string) => roots.some((r) => d.startsWith(r)) || (!filesDir && OFFICE_TASK_DIR.test(d));
  const out: string[] = [];
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-dir' && i + 1 < args.length && office(path.resolve(args[i + 1]))) dirs.push(args[++i]);
    else out.push(args[i]);
  }
  return { args: out, dirs };
}

/**
 * The settings file one kanban worker runs on when it has office folders: the kanban settings' content with the folders in
 * `permissions.additionalDirectories` (next to its `allow`). Written at every launch, so it is back after the office restarts.
 */
export function writeWorkerSettings(kanbanPath: string, workerId: string, dirs: string[]): string {
  const settings = JSON.parse(readFileSync(kanbanPath, 'utf8'));
  const file = workerSettingsPath(kanbanPath, workerId);
  const own = Array.isArray(settings.permissions?.additionalDirectories) ? settings.permissions.additionalDirectories : [];
  writeFileSync(file, JSON.stringify({ ...settings, permissions: { ...settings.permissions, additionalDirectories: [...new Set([...own, ...dirs])] } }, null, 2), { mode: 0o600 });
  return file;
}

/** A worker left: its own settings file goes, on whichever floor it was. */
export function removeWorkerSettings(workerId: string) {
  for (const kanbanPath of kanbanPaths) rmSync(workerSettingsPath(kanbanPath, workerId), { force: true });
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
