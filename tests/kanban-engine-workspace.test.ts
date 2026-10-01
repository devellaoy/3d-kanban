import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allOn, checkoutLines } from '../src/server/kanban/engine/workspace.js';
import type { ProjectRepo, TaskWorkspace } from '../src/shared/kanban/types.js';

function checkout(root: string, rel: string, branch: string) {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });
}

const repo = (id: string, primary = false): ProjectRepo => ({ id, name: id, kind: 'git', dir: `/${id}`, primary });

test('allOn: a repository with no worktree in the workspace is left out, not false forever', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-allon-'));
  checkout(root, 'wt/web', 'feature/x');
  const ws = { worktree: { path: 'wt/web', branch: 'feature/x' } } as TaskWorkspace;
  assert.equal(await allOn(root, ws, [{ r: repo('web', true), b: 'feature/x' }, { r: repo('api'), b: 'feature/x' }]), true, 'api was added after the workspace was made');
  assert.equal(await allOn(root, ws, [{ r: repo('web', true), b: 'other' }, { r: repo('api'), b: 'feature/x' }]), false);
  checkout(root, 'wt/api', 'main');
  const both = { ...ws, repos: [{ name: 'api', path: 'wt/api' }] } as TaskWorkspace;
  assert.equal(await allOn(root, both, [{ r: repo('web', true), b: 'feature/x' }, { r: repo('api'), b: 'feature/x' }]), false, 'one that has a worktree is still asked');
});

test('checkoutLines: fixing, only the repositories with a PR branch or a branch of their own are listed; the task branch is the fallback, never another repository\'s PR branch', async () => {
  const repos = [repo('web', true), repo('api')];
  const task = { branch: undefined, workspace: undefined };
  assert.equal(await checkoutLines('/x', task, repos, { api: 'fix/it' }, true, true, true), '- api: `fix/it`');
  assert.equal(await checkoutLines('/x', task, repos, {}, true, false, true), undefined, 'nothing to check out');
  assert.equal(await checkoutLines('/x', { ...task, branch: 'own' }, repos, {}, true, false, true), '- web: `own`\n- api: `own`');
  assert.equal(await checkoutLines('/x', { ...task, branch: 'own' }, repos, { api: 'fix/it' }, false, false, true), '- web: `own`\n- api: `fix/it`', 'not fixing: every repository');
});
