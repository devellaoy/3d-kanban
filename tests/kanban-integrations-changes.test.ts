// integrations/changes: a task's whole change, its commits and one commit's diff, read from a real
// git repository in a temp folder: a base branch (main), a feature branch with two commits, and an
// uncommitted edit plus a new file in the task's worktree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createChangesPlugin } from '../src/server/kanban/integrations/changes/index.js';
import { HASH_RE, parseNameStatus, parseNumstat } from '../src/server/kanban/integrations/changes/git.js';
import type { KanbanChangesList, KanbanCommitChanges, KanbanCommitList, KanbanRepoChanges } from '../src/shared/kanban/types.js';
import { def, makeCtx, WHO } from './kanban-integrations-ctx.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();

/** A project checkout on main with a feature branch of two commits, and a worktree of that branch with uncommitted work. */
function setup() {
  const ctx = makeCtx();
  const dir = path.join(ctx.tmp, 'proj');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'commit', '-q', '-am', 'first change');
  writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  git(dir, 'add', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'second change');
  git(dir, 'checkout', '-q', 'main');
  const floor = def('proj', dir);
  (ctx.projects as () => unknown[]) = () => [floor];
  ctx.project = (id: string) => (id === 'proj' ? floor : undefined);
  ctx.repos = (id: string) => (id === 'proj' ? [{ id: 'proj', name: 'proj', kind: 'git' as const, dir, primary: true }] : []);
  const plugin = createChangesPlugin(ctx, { fetch: false });
  return { ctx, dir, plugin };
}

async function get<T>(plugin: ReturnType<typeof createChangesPlugin>, url: string): Promise<{ status: number; body: T; handled: boolean }> {
  let status = 0;
  let text = '';
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(b?: string) {
      text = b ?? '';
    },
  } as unknown as ServerResponse;
  const u = new URL(url, 'http://x');
  const handled = await plugin.http!['/api/kanban/tasks/']({ method: 'GET' } as IncomingMessage, res, u, WHO);
  return { status, body: (text ? JSON.parse(text) : undefined) as T, handled };
}

test('changes from the branch in the project checkout (no workspace)', async () => {
  const { ctx, plugin } = setup();
  const task = ctx.repo.createTask({ project: 'proj', title: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T', branch: 'feature' });
  const list = await get<KanbanChangesList>(plugin, `/api/kanban/tasks/${task.id}/changes`);
  assert.equal(list.status, 200);
  assert.equal(list.body.project, 'proj');
  assert.equal(list.body.repos[0].primary, true);
  assert.equal(list.body.repos[0].source, 'checkout');
  assert.equal(list.body.repos[0].branch, 'feature');
  assert.equal(list.body.repos[0].base, 'main');

  const ch = await get<KanbanRepoChanges>(plugin, `/api/kanban/tasks/${task.id}/changes?repo=proj`);
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.body.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ['a.txt', 'modified', 1, 0],
    ['b.txt', 'added', 1, 0],
  ]);
  assert.match(ch.body.diff, /^\+two$/m);
  assert.equal(ch.body.truncated, false);
  assert.equal(ch.body.workingTree, null);

  const cs = await get<KanbanCommitList>(plugin, `/api/kanban/tasks/${task.id}/commits?repo=proj`);
  assert.deepEqual(cs.body.commits.map((c) => c.subject), ['second change', 'first change']);
  assert.equal(cs.body.uncommitted, null);
  assert.ok(cs.body.commits.every((c) => HASH_RE.test(c.hash) && c.author === 'T' && !Number.isNaN(Date.parse(c.date))));

  const first = cs.body.commits[1];
  const one = await get<KanbanCommitChanges>(plugin, `/api/kanban/tasks/${task.id}/commit?repo=proj&hash=${first.hash.slice(0, 10)}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.commit.hash, first.hash);
  assert.deepEqual(one.body.files.map((f) => f.path), ['a.txt']);
});

test('changes from the task worktree include its uncommitted work', async () => {
  const { ctx, dir, plugin } = setup();
  const wt = path.join(dir, '.agent-office', 'worktrees', 't1');
  git(dir, 'worktree', 'add', '-q', wt, 'feature');
  writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(wt, 'new.txt'), 'fresh\n');
  const base = git(dir, 'rev-parse', 'main');
  const task = ctx.repo.createTask({
    project: 'proj',
    title: 'x',
    tool: 'claude',
    usePlan: false,
    planApproval: 'auto',
    useReview: false,
    createdBy: 'T',
    branch: 'feature',
    workspace: { worktree: { path: '.agent-office/worktrees/t1', branch: 'feature', base, from: 'main' } },
  });
  const ch = await get<KanbanRepoChanges>(plugin, `/api/kanban/tasks/${task.id}/changes?repo=proj`);
  assert.equal(ch.body.source, 'worktree');
  assert.equal(ch.body.files.length, 2);
  assert.ok(ch.body.workingTree);
  const wtFiles = ch.body.workingTree!.files.map((f) => [f.path, f.status]);
  assert.deepEqual(wtFiles, [
    ['a.txt', 'modified'],
    ['new.txt', 'untracked'],
  ]);
  assert.match(ch.body.workingTree!.diff, /^\+three$/m);
  assert.match(ch.body.workingTree!.diff, /^\+fresh$/m);
  const cs = await get<KanbanCommitList>(plugin, `/api/kanban/tasks/${task.id}/commits?repo=proj`);
  assert.equal(cs.body.commits.length, 2);
  assert.equal(cs.body.uncommitted, 2);
});

test('a commit hash is validated and must be one of the task’s own commits', async () => {
  const { ctx, dir, plugin } = setup();
  const task = ctx.repo.createTask({ project: 'proj', title: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T', branch: 'feature' });
  for (const bad of ['', 'HEAD', 'abc', 'ABCDEF1', '--output=x', 'a'.repeat(41), 'main..feature']) {
    const r = await get<{ error: string }>(plugin, `/api/kanban/tasks/${task.id}/commit?repo=proj&hash=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, bad);
  }
  // The base commit is in the repository but not in base..branch.
  const baseSha = git(dir, 'rev-parse', 'main');
  const r = await get<{ error: string }>(plugin, `/api/kanban/tasks/${task.id}/commit?repo=proj&hash=${baseSha}`);
  assert.equal(r.status, 404);
  // Another repository id, and another task.
  assert.equal((await get(plugin, `/api/kanban/tasks/${task.id}/commits?repo=other`)).status, 404);
  assert.equal((await get(plugin, `/api/kanban/tasks/${task.id}/commits?repo=..%2Fx`)).status, 400);
  assert.equal((await get(plugin, `/api/kanban/tasks/999/changes`)).status, 404);
  // Not its path: left to the other plugins.
  assert.equal((await get(plugin, `/api/kanban/tasks/${task.id}/reports`)).handled, false);
});

test('a task without a branch says so rather than failing', async () => {
  const { ctx, plugin } = setup();
  const task = ctx.repo.createTask({ project: 'proj', title: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T' });
  const ch = await get<KanbanRepoChanges>(plugin, `/api/kanban/tasks/${task.id}/changes?repo=proj`);
  assert.equal(ch.status, 200);
  assert.ok(ch.body.error);
  assert.deepEqual(ch.body.files, []);
});

test('git -z output parsing: renames and binary files', () => {
  assert.deepEqual(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0A\0b.bin\0'), [
    { path: 'a.txt', status: 'modified' },
    { path: 'new.txt', oldPath: 'old.txt', status: 'renamed' },
    { path: 'b.bin', status: 'added' },
  ]);
  const nums = parseNumstat('3\t1\ta.txt\0' + '0\t0\t\0old.txt\0new.txt\0' + '-\t-\tb.bin\0');
  assert.deepEqual(nums.get('a.txt'), { additions: 3, deletions: 1, binary: false });
  assert.deepEqual(nums.get('new.txt'), { additions: 0, deletions: 0, binary: false });
  assert.deepEqual(nums.get('b.bin'), { additions: 0, deletions: 0, binary: true });
});
