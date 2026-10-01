// Fix PRs trusts nothing a pull request names: a fork's PR is refused, and a head branch that is a
// base or integration branch is never checked out; the server gives the button's own reason; and a
// task sent home (reset, delete) takes a PR reviewer's own worktree with it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GhPull } from '../src/shared/protocol.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { ADA, engineFixture, makeRepo, type EngineFixture } from './kanban-engine-fixture.js';

const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const link = (fx: EngineFixture, id: number, repoId: string, repo: string, number: number, branch: string) => fx.repo.upsertPrLink(id, { repoId, repo, number, url: url(repo, number), state: 'OPEN', branch });
const polled = (fx: EngineFixture, repo: string, number: number, isCrossRepository?: boolean) => fx.pulls.push({ number, url: url(repo, number), repo, state: 'OPEN', ...(isCrossRepository === undefined ? {} : { isCrossRepository }) } as GhPull);
const promptsSince = (fx: EngineFixture, before: number) => fx.invocations().slice(before).filter((i) => i.kind === 'claude').map((i) => i.prompt ?? i.args.join(' ')).join('\n');
const fixDone = (fx: EngineFixture, id: number, n = 1) => fx.waitTask(id, (x) => x.runState === 'idle' && fx.repo.listRuns(id).filter((r) => r.phase === 'pr-fix' && r.status === 'succeeded').length === n, 'the pr-fix run');

async function investigated(fx: EngineFixture) {
  fx.setRules([{ when: 'Address the open review comments', reply: 'Answered the comments.' }, { when: 'nvestigat', reply: 'Found it.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  return task;
}

test("Fix PRs: a task whose open PRs are all forks' is refused; forks and base-branch PRs are left out of the run when another PR is fixable", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await investigated(fx);
  link(fx, task.id, 'proj', 'acme/proj', 5, 'fix/from-a-fork');
  polled(fx, 'acme/proj', 5, true);
  assert.match(String(await fx.engine.pr(task.id, ADA, 'fix')), /from a fork: fix it by hand/);
  assert.equal(fx.repo.listRuns(task.id).filter((r) => r.phase === 'pr-fix').length, 0, 'no run was started');

  link(fx, task.id, 'proj', 'acme/proj', 6, 'main');
  polled(fx, 'acme/proj', 6, false);
  link(fx, task.id, 'proj', 'acme/proj', 7, 'fix/own');
  polled(fx, 'acme/proj', 7, false);
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
  await fixDone(fx, task.id);
  const text = promptsSince(fx, before);
  assert.ok(text.includes(url('acme/proj', 7)) && text.includes('`fix/own`'), 'the own PR is fixed');
  assert.ok(!text.includes('pull/5') && !text.includes('fix/from-a-fork'), "the fork's PR is not listed nor checked out");
  assert.ok(!text.includes('pull/6') && !/^- [\w.-]+: `main`$/m.test(text), 'a PR from main is not checked out');
});

test('Fix PRs: a PR from the repository\'s own base branch is never a checkout target', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await investigated(fx);
  link(fx, task.id, 'proj', 'acme/proj', 5, 'release/1.x');
  link(fx, task.id, 'proj', 'acme/proj', 7, 'fix/own');
  fx.def.repos = [{ id: 'proj', name: 'proj', kind: 'git', dir: fx.dir, remote: 'acme/proj', primary: true, baseBranch: 'release/1.x' }];
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
  await fixDone(fx, task.id);
  const text = promptsSince(fx, before);
  assert.ok(text.includes('`fix/own`') && !text.includes('release/1.x') && !text.includes('pull/5'));
});

test('Fix PRs in two repositories lists only the repository that has an open PR when the task has no branch of its own', async (t) => {
  const api = path.join(mkdtempSync(path.join(tmpdir(), 'kanban-api-')), 'api');
  makeRepo(api);
  const fx = await engineFixture({ repos: [{ id: 'api', name: 'api', kind: 'git', dir: api, remote: 'acme/api', primary: false }] });
  t.after(() => fx.close());
  // A PR linked by its URL to a task that never worked here: no branch of its own, no workspace.
  fx.setRules([{ when: 'Address the open review comments', reply: 'Answered the comments.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false, status: 'review' });
  link(fx, task.id, 'api', 'acme/api', 9, 'fix/api-only');
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
  await fixDone(fx, task.id);
  assert.deepEqual([...new Set(promptsSince(fx, before).match(/^- [\w.-]+: `[^`]+`$/gm))], ['- api: `fix/api-only`'], "the primary isn't sent to the PR's branch");
});

test('Fix PRs: the server gives the button\'s reason, "asking in its terminal" before "stop it first", while a run is live', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Shall I delete build/ first?', ask: true }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  link(fx, task.id, 'proj', 'acme/proj', 5, 'fix/x');
  assert.match(String(await fx.engine.pr(task.id, ADA, 'fix')), /asking in its terminal: answer it first/);
});

test("a PR reviewer in a worktree of its own is cleaned up with it when the task is reset or deleted; the implementer's worktree is kept", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Changed it.', commit: 'Work' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  const spawned = fx.workers.spawn('desk-9', 'Ada (kanban)', undefined, true, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, { kanban: { taskId: task.id, role: 'reviewer' }, settingsFile: 'kanban' });
  assert.notEqual(typeof spawned, 'string', String(spawned));
  const reviewer = spawned as WorkerInfo;
  await new Promise((res) => setTimeout(res, 300));
  const own = path.join(fx.dir, reviewer.worktree!.path);
  assert.ok(existsSync(own));
  assert.equal(await fx.engine.sendWorkersHome(task.id, ADA, 'reset'), undefined);
  for (let i = 0; i < 100 && existsSync(own); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(fx.workers.get(reviewer.id), undefined, 'the reviewer went home');
  assert.ok(!existsSync(own), "its own worktree went with it");
  assert.ok(existsSync(path.join(fx.dir, r.workspace!.worktree.path)), "the implementer's worktree was kept");
});
