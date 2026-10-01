// Opens a task's (or a worker's) folders in VS Code on the office's machine: one folder as it is,
// several as a generated .code-workspace file kept under the kanban's files. The launch is a
// command on the office's own machine, so the browser only ever names a task or a worker, never a path.

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
}

const defaultDeps: VsCodeDeps = { run, resolveCommand, platform: process.platform, env: process.env };

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
 * Whether `dir` is there and is a worktree of the repository at `repo` (the branch it is on doesn't
 * matter: agents rename theirs). A folder that was deleted, or one that is only a plain directory, isn't.
 */
async function isWorktreeOf(dir: string, repo: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    const listed = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], repo, 10_000);
    const want = realpathSync(dir);
    return listed
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => {
        try {
          return realpathSync(l.slice('worktree '.length)) === want;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** The folders a task works in, primary first: its worktrees (the repositories' checkouts when those are gone) and its plain folders. */
export async function taskFolders(ctx: KanbanContext, task: KanbanTask): Promise<VsFolder[]> {
  const def = ctx.project(task.project);
  if (!def) throw new Error(`There's no project ${task.project}`);
  const repos = taskRepos(def, task);
  if (!task.workspace) return unique(repos.map((r) => ({ name: r.name, dir: r.dir })));
  const out: VsFolder[] = [];
  for (const w of workspaceDirs(def.dir, def, task.workspace)) {
    const usable = w.repo ? await isWorktreeOf(w.dir, w.repo.dir) : existsSync(w.dir);
    const dir = usable ? w.dir : w.repo?.dir;
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
      await (cmd ? deps.run(deps.env.ComSpec || 'cmd.exe', ['/c', code, target], cwd, TIMEOUT, scrubbed(deps.env)) : deps.run(code, [target], cwd, TIMEOUT, scrubbed(deps.env)));
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
