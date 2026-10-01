import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import type { KanbanContext } from '../src/server/kanban/registry.js';
import { openFor, openInVsCode, taskFolders, winCmdLine, workerFolders, writeWorkspace, type VsCodeDeps } from '../src/server/kanban/vscode.js';
import type { KanbanTask, ProjectRepo, TaskWorkspace } from '../src/shared/kanban/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

type Ctx = { after(fn: () => void): void };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** A git checkout with one commit. */
function checkout(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** A worktree of `repo` on a new branch, at `dir`. */
function worktree(repo: string, dir: string, branch: string): string {
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
  return dir;
}

function setup(t: Ctx, over: { repos?: (root: string) => ProjectRepo[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-vscode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = checkout(path.join(root, 'web'));
  const def: FloorDef = { id: 'web', name: 'Shop', dir, palette: 0, addedBy: 'Sam', addedAt: 1 };
  const repos = over.repos?.(root);
  if (repos) def.repos = [{ id: 'web', name: 'Web', kind: 'git', dir, primary: true }, ...repos];
  const ctx = {
    filesDir: path.join(root, 'files'),
    project: (id: string) => (id === 'web' ? def : undefined),
    repo: { getTask: (id: number) => tasks.get(id), repoBranches: (id: number) => branches.get(id) ?? {} },
  } as unknown as KanbanContext;
  const tasks = new Map<number, KanbanTask>();
  const branches = new Map<number, Record<string, string>>();
  const task = (over: Partial<KanbanTask> = {}) => ({ id: 7, project: 'web', ...over }) as KanbanTask;
  return { root, dir, def, ctx, tasks, branches, task };
}

const apiRepo = (root: string): ProjectRepo => ({ id: 'api', name: 'Api', kind: 'git', dir: checkout(path.join(root, 'api')), primary: false });
const docsRepo = (root: string): ProjectRepo => {
  const dir = path.join(root, 'docs');
  mkdirSync(dir);
  return { id: 'docs', name: 'Docs', kind: 'folder', dir, primary: false };
};

const wsOf = (primary: { path: string; branch: string }, repos: { floor: string; path: string; branch: string; dir: string }[] = []) =>
  ({ worktree: { ...primary, base: 'x' }, ...(repos.length ? { repos: repos.map((r) => ({ ...r, base: 'x' })) } : {}) }) as unknown as TaskWorkspace;

test('a task with one worktree opens that worktree', async (t) => {
  const { dir, ctx, task } = setup(t);
  const wt = worktree(dir, path.join(dir, '.agent-office', 'worktrees', 'a'), 'office/a');
  const folders = await taskFolders(ctx, task({ workspace: wsOf({ path: '.agent-office/worktrees/a', branch: 'office/a' }) }));
  assert.deepEqual(folders, [{ name: 'Shop', dir: wt }]);
});

test('a task across repositories opens the primary first, then the others', async (t) => {
  const { root, dir, ctx, task } = setup(t, { repos: (r) => [apiRepo(r)] });
  const a = worktree(dir, path.join(root, 'ws', 'web'), 'office/x');
  const b = worktree(path.join(root, 'api'), path.join(root, 'ws', 'api'), 'office/x');
  const ws = wsOf({ path: '../ws/web', branch: 'office/x' }, [{ floor: 'web~api', path: '../ws/api', branch: 'office/x', dir: path.join(root, 'api') }]);
  const folders = await taskFolders(ctx, task({ workspace: ws }));
  assert.deepEqual(
    folders.map((f) => [f.name, path.resolve(f.dir)]),
    [
      ['Web', a],
      ['Api', b],
    ].map(([n, d]) => [n, path.resolve(d)]),
  );
});

test('a removed worktree, or a plain folder that is no worktree of the repository, falls back to the repository', async (t) => {
  const { dir, ctx, task } = setup(t);
  const ws = wsOf({ path: '.agent-office/worktrees/gone', branch: 'office/gone' });
  assert.deepEqual(await taskFolders(ctx, task({ workspace: ws })), [{ name: 'Shop', dir }]);
  mkdirSync(path.join(dir, '.agent-office', 'worktrees', 'gone'), { recursive: true });
  assert.deepEqual(await taskFolders(ctx, task({ workspace: ws })), [{ name: 'Shop', dir }]);
});

test('a renamed branch in the task worktree still opens the worktree', async (t) => {
  const { dir, ctx, task, branches } = setup(t);
  const wt = worktree(dir, path.join(dir, '.agent-office', 'worktrees', 'r'), 'office/x');
  git(wt, 'branch', '-m', 'gh-1/x');
  const workspace = wsOf({ path: '.agent-office/worktrees/r', branch: 'office/x' });
  // Until the office has recorded the rename it can't tell it's the task's.
  assert.deepEqual(await taskFolders(ctx, task({ workspace })), [{ name: 'Shop', dir }]);
  // As Orchestrator.syncBranch records it: task.branch, and the branch of the repository.
  assert.deepEqual(await taskFolders(ctx, task({ workspace, branch: 'gh-1/x' })), [{ name: 'Shop', dir: wt }]);
  branches.set(7, { web: 'gh-1/x' });
  assert.deepEqual(await taskFolders(ctx, task({ workspace })), [{ name: 'Shop', dir: wt }]);
});

test("a worktree made later at the path of the task's removed one is not the task's", async (t) => {
  const { dir, ctx, task } = setup(t);
  const at = path.join(dir, '.agent-office', 'worktrees', 'same');
  worktree(dir, at, 'office/a');
  git(dir, 'worktree', 'remove', '--force', at);
  worktree(dir, at, 'office/b-unknown');
  const folders = await taskFolders(ctx, task({ workspace: wsOf({ path: '.agent-office/worktrees/same', branch: 'office/a' }) }));
  assert.deepEqual(folders, [{ name: 'Shop', dir }]);
});

test('a task without a workspace opens the checkouts of its repositories, and a folder repository too', async (t) => {
  const { root, dir, ctx, task } = setup(t, { repos: (r) => [apiRepo(r), docsRepo(r)] });
  assert.deepEqual(
    (await taskFolders(ctx, task({}))).map((f) => f.name),
    ['Web', 'Api', 'Docs'],
  );
  assert.deepEqual(await taskFolders(ctx, task({ repoIds: ['docs'] })), [
    { name: 'Web', dir },
    { name: 'Docs', dir: path.join(root, 'docs') },
  ]);
  const wt = worktree(dir, path.join(dir, '.agent-office', 'worktrees', 'b'), 'office/b');
  const withWs = await taskFolders(ctx, task({ repoIds: ['docs'], workspace: wsOf({ path: '.agent-office/worktrees/b', branch: 'office/b' }) }));
  assert.deepEqual(withWs, [
    { name: 'Web', dir: wt },
    { name: 'Docs', dir: path.join(root, 'docs') },
  ]);
});

test('an unknown project is an error', async (t) => {
  const { ctx, task } = setup(t);
  await assert.rejects(taskFolders(ctx, task({ project: 'nope' })), /no project nope/);
});

test('a worker opens its floor, its worktree, or every worktree of its workspace', async (t) => {
  const { root, dir, ctx, tasks, task } = setup(t);
  const floor = { dir, project: { name: 'Shop' } } as Parameters<typeof workerFolders>[1];
  const info = (over: Partial<WorkerInfo>) => ({ id: 'w1', name: 'Ann', ...over }) as WorkerInfo;
  assert.deepEqual(await workerFolders(ctx, floor, info({})), [{ name: 'Shop', dir }]);
  const wt = path.join(dir, '.agent-office', 'worktrees', 'w1');
  mkdirSync(wt, { recursive: true });
  assert.deepEqual(await workerFolders(ctx, floor, info({ worktree: { path: '.agent-office/worktrees/w1', branch: 'b', base: 'x' } })), [{ name: 'Shop', dir: wt }]);

  assert.deepEqual(await workerFolders(ctx, floor, info({ worktree: { path: '.agent-office/worktrees/missing', branch: 'b', base: 'x' } })), [{ name: 'Shop', dir }]);

  const ws = path.join(dir, '.agent-office', 'worktrees', 'ws');
  mkdirSync(path.join(ws, 'web'), { recursive: true });
  const multi = info({
    worktree: { path: '.agent-office/worktrees/ws/web', branch: 'b', base: 'x' },
    repos: [
      { floor: 'web~api', name: 'api', dir: path.join(root, 'api'), path: '.agent-office/worktrees/ws/api', branch: 'b', base: 'x' },
    ] as WorkerInfo['repos'],
  });
  assert.deepEqual(await workerFolders(ctx, floor, multi), [
    { name: 'Shop', dir: path.join(ws, 'web') },
    { name: 'api', dir: path.join(root, 'api') },
  ]);

  tasks.set(7, task({}));
  assert.deepEqual(await workerFolders(ctx, floor, info({ kanban: { taskId: 7, role: 'implementer' } })), [{ name: 'Shop', dir }]);
});

test('writeWorkspace writes the workspace file, replacing the last one', (t) => {
  const { root } = setup(t);
  const filesDir = path.join(root, 'files');
  const file = writeWorkspace(filesDir, 'task-web-7', [{ name: 'A', dir: '/a' }, { name: 'B', dir: '/b' }]);
  assert.equal(file, path.join(filesDir, 'workspaces', 'task-web-7.code-workspace'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { folders: [{ name: 'A', path: '/a' }, { name: 'B', path: '/b' }], settings: {} });
  assert.equal(writeWorkspace(filesDir, 'task-web-7', [{ name: 'C', dir: '/c' }]), file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).folders, [{ name: 'C', path: '/c' }]);
  assert.equal(path.dirname(writeWorkspace(filesDir, '../evil/key', [])), path.join(filesDir, 'workspaces'));
});

/** Deps that record their commands; `fail` names the commands that fail, `found` what `code` resolves to. */
function deps(platform: NodeJS.Platform, over: { fail?: string[]; found?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const calls: { cmd: string; args: string[]; timeout?: number; env?: Record<string, string>; verbatim?: true }[] = [];
  const d: VsCodeDeps = {
    run: async (cmd, args, _cwd, timeout, env) => {
      calls.push({ cmd, args, timeout, env });
      if (over.fail?.includes(cmd)) throw new Error(`${cmd} broke`);
      return '';
    },
    resolveCommand: () => (over.found === undefined ? '/usr/bin/code' : over.found),
    platform,
    runVerbatim: async (cmd, args, _cwd, timeout, env) => {
      calls.push({ cmd, args, timeout, env, verbatim: true });
      return '';
    },
    env: over.env ?? { PATH: '/bin', NODE_OPTIONS: '--x', ELECTRON_RUN_AS_NODE: '1', AIKANBAN_TASK_ID: '3', CLAUDE_CODE_X: '1', ANTHROPIC_API_KEY: 'k', AGENT_OFFICE_HOOK_TOKEN: 't', HOME: '/h' },
  };
  return { d, calls };
}

test('on a Mac VS Code is opened by name first', async () => {
  const { d, calls } = deps('darwin');
  await openInVsCode('/p', d);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args, c.timeout]), [['open', ['-a', 'Visual Studio Code', '/p'], 15_000]]);
});

test('when opening by name fails, the code command runs with a clean environment', async () => {
  const { d, calls } = deps('darwin', { fail: ['open'] });
  await openInVsCode('/p', d);
  assert.deepEqual(calls.map((c) => c.cmd), ['open', '/usr/bin/code']);
  assert.deepEqual(calls[1].args, ['/p']);
  assert.deepEqual(calls[1].env, { PATH: '/bin', HOME: '/h' });
});

test('elsewhere the code command is run directly', async () => {
  const { d, calls } = deps('linux');
  await openInVsCode('/p', d);
  assert.deepEqual(calls.map((c) => c.cmd), ['/usr/bin/code']);
});

test('with no VS Code the error says what to do, and why a command failed', async () => {
  await assert.rejects(openInVsCode('/p', deps('linux', { found: null }).d), /VS Code wasn't found: install it, or in VS Code run 'Shell Command: Install code command in PATH'$/);
  await assert.rejects(openInVsCode('/p', deps('linux', { fail: ['/usr/bin/code'] }).d), /wasn't found.*\(\/usr\/bin\/code broke\)/);
});

test('several folders open as a workspace file, one as itself', async (t) => {
  const { ctx, root } = setup(t);
  const one = deps('linux');
  assert.equal(await openFor(ctx, [{ name: 'A', dir: '/a' }], 'task #7', 'task-web-7', one.d), '/a');
  const two = deps('linux');
  const target = await openFor(ctx, [{ name: 'A', dir: '/a' }, { name: 'B', dir: '/b' }], 'task #7', 'task-web-7', two.d);
  assert.equal(target, path.join(root, 'files', 'workspaces', 'task-web-7.code-workspace'));
  assert.deepEqual(two.calls[0].args, [target]);
  await assert.rejects(openFor(ctx, [], 'task #7', 'k', two.d), /no folder/);
});

/**
 * What runs when cmd.exe /d /s /c gets `line`, and then VS Code's code.cmd passes %* on to Code.exe:
 * cmd drops /s's outer quotes, takes ^ as an escape outside quotes, splits commands at an unquoted
 * & | < >; the batch line parses %* that way again; Code.exe splits its command line into argv.
 */
function cmdReceives(line: string): { command: string; argv: string[] } {
  const parse = (text: string): { tokens: string[]; raw: string } => {
    const tokens: string[] = [];
    let raw = '';
    let tok = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!quoted && c === '^') {
        raw += text[++i];
        tok += text[i];
        continue;
      }
      if (!quoted && '&|<>'.includes(c)) throw new Error(`cmd would split the command at ${c}: ${text}`);
      if (c === '"') quoted = !quoted;
      if (c === ' ' && !quoted) {
        if (tok) tokens.push(tok);
        tok = '';
      } else tok += c;
      raw += c;
    }
    if (tok) tokens.push(tok);
    return { tokens, raw };
  };
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  const first = parse(line.slice(1, -1));
  const [command] = first.tokens;
  // The batch file's %*: everything after its own name, parsed by cmd once more on the batch line.
  const rest = parse(first.raw.slice(first.raw.indexOf(command) + command.length).trim()).raw;
  // Code.exe's argv (CommandLineToArgvW, enough for paths: quotes group and go).
  const argv: string[] = [];
  let arg = '';
  let quoted = false;
  let started = false;
  for (const c of rest) {
    if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (c === ' ' && !quoted) {
      if (started) argv.push(arg);
      arg = '';
      started = false;
    } else {
      arg += c;
      started = true;
    }
  }
  if (started) argv.push(arg);
  return { command: command.replace(/"/g, ''), argv };
}

test('winCmdLine escapes what cmd.exe would read as syntax, once for code.cmd', () => {
  assert.deepEqual(winCmdLine('C:\\Users\\me\\code.cmd', ['C:\\my repos\\a']), ['/d', '/s', '/c', '"C:\\Users\\me\\code.cmd ^"C:\\my^ repos\\a^""']);
  assert.equal(winCmdLine('code.cmd', ['C:\\repos\\a&b'])[3], '"code.cmd ^"C:\\repos\\a^&b^""');
  assert.equal(winCmdLine('code.cmd', ['C:\\100%\\a^b'])[3], '"code.cmd ^"C:\\100^%\\a^^b^""');
});

test('VS Code receives the target exactly, spaces, & % ^ and all', () => {
  const code = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
  for (const target of ['C:\\repos\\a', 'C:\\my repos\\a b', 'C:\\repos\\a&b', 'C:\\100%\\a^b (1)', 'C:\\x|y\\<z>!', 'C:\\files\\workspaces\\task-web-7.code-workspace']) {
    const got = cmdReceives(winCmdLine(code, [target])[3]);
    assert.equal(got.command, code);
    assert.deepEqual(got.argv, [target], target);
  }
});

test('on Windows a .cmd shim runs through cmd.exe with the escaped line, verbatim', async () => {
  const { d, calls } = deps('win32', { found: 'C:\\bin\\code.cmd', env: { ComSpec: 'C:\\Windows\\cmd.exe', PATH: 'p' } });
  await openInVsCode('C:\\a&b', d);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: 'C:\\Windows\\cmd.exe', args: winCmdLine('C:\\bin\\code.cmd', ['C:\\a&b']), timeout: 15_000, env: { ComSpec: 'C:\\Windows\\cmd.exe', PATH: 'p' }, verbatim: true });
});
