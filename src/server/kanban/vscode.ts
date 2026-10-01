// Opens a task's (or a worker's) folders in VS Code on the office's machine: one folder as it is,
// several as a generated .code-workspace file kept under the kanban's files. The launch is a
// command on the office's own machine, so the browser only ever names a task or a worker, never a path.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Floor } from '../floor.js';
import { workspaceOf } from '../worktrees.js';
import { resolveCommand, run } from '../workers/process.js';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { WorkerInfo } from '../../shared/protocol.js';
import { taskRepos, workspaceDirs } from './engine/compose.js';
import type { KanbanContext } from './registry.js';

export interface VsFolder {
  name: string;
  dir: string;
}

/** What opening needs from the machine, replaceable in tests. */
export interface VsCodeDeps {
  run: typeof run;
  resolveCommand: typeof resolveCommand;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Runs a command with its arguments passed to Windows as they are (for cmd.exe's command line). */
  runVerbatim: (cmd: string, args: string[], cwd: string, timeout: number, env: Record<string, string>) => Promise<string>;
}

function runVerbatim(cmd: string, args: string[], cwd: string, timeout: number, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout, env, windowsVerbatimArguments: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `${cmd} failed`));
      else resolve(stdout.trim());
    });
  });
}

const defaultDeps: VsCodeDeps = { run, resolveCommand, platform: process.platform, env: process.env, runVerbatim };

// cmd.exe reads its command line itself, so what it treats as syntax is escaped with ^ as cross-spawn
// does (lib/util/escape.js, whose algorithm this follows). Once: VS Code's code.cmd hands %* straight
// to Code.exe, where the target arrives in its quotes (cross-spawn escapes twice only for npm's
// node_modules/.bin shims, which pass it on inside an IF block).
const META = /([()\][%!^"`<>&|;, *?])/g;
const escapeCommand = (cmd: string) => cmd.replace(META, '^$1');
function escapeArg(arg: string, doubleEscape: boolean): string {
  let out = `${arg}`;
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(META, '^$1');
  return doubleEscape ? out.replace(META, '^$1') : out;
}

/** The arguments to cmd.exe that run the batch file `command` with `args`, safe against cmd's parsing of & % ^ and the like. */
export function winCmdLine(command: string, args: string[]): string[] {
  return ['/d', '/s', '/c', `"${[escapeCommand(command), ...args.map((a) => escapeArg(a, false))].join(' ')}"`];
}

const TIMEOUT = 15_000;

/** Folders by path, the first of each kept. */
function unique(folders: VsFolder[]): VsFolder[] {
  const seen = new Set<string>();
  return folders.filter((f) => {
    const key = path.resolve(f.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether the folder of a task's workspace entry is still the task's: it is there, it is a worktree
 * of the repository at `repo` (when that is known), and the branch it is on is one the task has
 * for it (`owned`: as cut, as recorded after a rename). The branch's name may have changed, but a
 * worktree somebody else made at the same path, on another branch, is not the task's.
 */
async function ownsWorktree(dir: string, repo: string | undefined, owned: Set<string>): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    if (repo) {
      const listed = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], repo, 10_000);
      const want = realpathSync(dir);
      const inList = listed
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .some((l) => {
          try {
            return realpathSync(l.slice('worktree '.length)) === want;
          } catch {
            return false;
          }
        });
      if (!inList) return false;
    }
    return owned.has(await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], dir, 10_000));
  } catch {
    return false;
  }
}

/** The folders a task works in, primary first: its worktrees (the repositories' checkouts when those are gone or aren't the task's any more) and its plain folders. */
export async function taskFolders(ctx: KanbanContext, task: KanbanTask): Promise<VsFolder[]> {
  const def = ctx.project(task.project);
  if (!def) throw new Error(`There's no project ${task.project}`);
  const repos = taskRepos(def, task);
  if (!task.workspace) return unique(repos.map((r) => ({ name: r.name, dir: r.dir })));
  const out: VsFolder[] = [];
  const recorded = ctx.repo.repoBranches(task.id);
  for (const w of workspaceDirs(def.dir, def, task.workspace)) {
    const owned = new Set([w.branch, w.repo ? recorded[w.repo.id] : undefined, !w.repo || w.repo.primary ? task.branch : undefined].filter((b): b is string => !!b));
    const dir = (await ownsWorktree(w.dir, w.repo?.dir, owned)) ? w.dir : w.repo?.dir;
    if (dir) out.push({ name: w.repo?.name ?? path.basename(dir), dir });
  }
  for (const r of repos) if (!r.primary && r.kind === 'folder') out.push({ name: r.name, dir: r.dir });
  return unique(out);
}

/** The folders a worker works in, primary first: a task worker's are its task's. */
export async function workerFolders(ctx: KanbanContext, floor: Pick<Floor, 'dir' | 'project'>, info: WorkerInfo): Promise<VsFolder[]> {
  const taskId = info.kanban?.taskId;
  const task = taskId ? ctx.repo.getTask(taskId) : undefined;
  if (task) return taskFolders(ctx, task);
  const name = floor.project.name;
  if (!info.worktree) return [{ name, dir: floor.dir }];
  if (!info.repos?.length) {
    const own = path.join(floor.dir, workspaceOf(info)!);
    return [{ name, dir: existsSync(own) ? own : floor.dir }];
  }
  const out: VsFolder[] = [];
  const primary = path.join(floor.dir, info.worktree.path);
  out.push({ name, dir: existsSync(primary) ? primary : floor.dir });
  for (const r of info.repos) {
    const dir = path.join(floor.dir, r.path);
    out.push({ name: r.name, dir: existsSync(dir) ? dir : r.dir });
  }
  return unique(out);
}

/** Writes the .code-workspace of several folders (replacing the one from last time); returns its path. */
export function writeWorkspace(filesDir: string, key: string, folders: VsFolder[]): string {
  const dir = path.join(filesDir, 'workspaces');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.code-workspace`);
  writeFileSync(file, JSON.stringify({ folders: folders.map((f) => ({ name: f.name, path: f.dir })), settings: {} }, null, 2) + '\n');
  return file;
}

/** The office's own environment, as it must not reach VS Code (it would start as the office's Node, or as one of its agents). */
function scrubbed(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === 'ELECTRON_RUN_AS_NODE' || k === 'NODE_OPTIONS') continue;
    if (/^(AIKANBAN_|AGENT_OFFICE_|CLAUDE|ANTHROPIC)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Opens a folder or a .code-workspace file in VS Code; rejects with why it couldn't. */
export async function openInVsCode(target: string, deps: VsCodeDeps = defaultDeps): Promise<void> {
  const cwd = homedir();
  let failure = '';
  if (deps.platform === 'darwin') {
    try {
      await deps.run('open', ['-a', 'Visual Studio Code', target], cwd, TIMEOUT);
      return;
    } catch (err) {
      failure = (err as Error).message;
    }
  }
  const code = deps.resolveCommand('code');
  if (code) {
    // A .cmd shim (Windows) can only be started through cmd.
    const cmd = deps.platform === 'win32' && /\.(cmd|bat)$/i.test(code);
    try {
      await (cmd ? deps.runVerbatim(deps.env.ComSpec || 'cmd.exe', winCmdLine(code, [target]), cwd, TIMEOUT, scrubbed(deps.env)) : deps.run(code, [target], cwd, TIMEOUT, scrubbed(deps.env)));
      return;
    } catch (err) {
      failure = (err as Error).message;
    }
  }
  throw new Error(`VS Code wasn't found: install it, or in VS Code run 'Shell Command: Install code command in PATH'${failure ? ` (${failure})` : ''}`);
}

/** Opens the folders: the folder itself when it's one, else a generated workspace of them. `what` and `key` name it for the log and the workspace file. */
export async function openFor(ctx: KanbanContext, folders: VsFolder[], what: string, key: string, deps: VsCodeDeps = defaultDeps): Promise<string> {
  if (!folders.length) throw new Error('It has no folder to open');
  const target = folders.length === 1 ? folders[0].dir : writeWorkspace(ctx.filesDir, key, folders);
  console.log(`agent-office: opening VS Code for ${what}: ${target}`);
  await openInVsCode(target, deps);
  return target;
}
