// A pull-request review's reviewer works in a worktree cut from the head of the first pull request of each repository (engine/prheads.ts):
// fetched before the hire, never failing the review when it can't be, and said in the prompt's pull request lines.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import { fetchPrHeads, readingNote, type GitRunner } from '../src/server/kanban/engine/prheads.js';
import { ADA, engineFixture, type EngineFixture, type Invocation } from './kanban-engine-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const promptOf = (i: Invocation) => i.prompt ?? (i.args.includes('--') ? i.args[i.args.indexOf('--') + 1] : undefined);
/** The review prompt the reviewer's agent started with (waits for the fake agent to have been started). */
async function reviewPrompt(fx: EngineFixture): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const found = fx.invocations().find((x) => promptOf(x) && /Review these pull requests/.test(promptOf(x)!));
    if (found) return promptOf(found)!;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the reviewer was never started');
}

/** A pull request's head as a local branch (the fake fetch has nothing to fetch: the worktree is cut from `office-pr/<n>`, which `baseStartPoint` finds as a local branch). */
function prBranch(dir: string, n: number): string {
  const was = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(dir, 'checkout', '-q', '-b', `office-pr/${n}`);
  writeFileSync(path.join(dir, `pr${n}.txt`), `the change of pull request ${n}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `PR ${n}`);
  const tip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', was);
  return tip;
}

/** A git that records its calls and fails (or not) as the test says. */
function fake(fails = false) {
  const calls: { dir: string; args: string[] }[] = [];
  const run: GitRunner = async (dir, args) => {
    calls.push({ dir, args });
    if (fails) throw new Error('fatal: could not read from remote repository');
  };
  return { calls, run };
}

const wtOf = (fx: EngineFixture, workerId: string) => path.join(fx.dir, fx.workers.get(workerId)!.worktree!.path);
const pr = (n: number, more: object = {}) => ({ repo: 'acme/proj', number: n, base: 'main', ...more }) as never;

test('the first pull request of the repository is checked out in the reviewer’s worktree, the other is read with gh pr diff', async (t) => {
  const g = fake();
  const fx = await engineFixture({ engine: { prGit: g.run } });
  t.after(() => fx.close());
  const tip = prBranch(fx.dir, 3);
  fx.setRules([{ when: 'Review these pull requests', reply: 'They fit.\n\nREVIEW: APPROVED', delayMs: 1500 }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3, { title: 'Fix login' }), pr(4)], tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  const wt = wtOf(fx, got.workerId!);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), tip, "the reviewer's branch starts at the pull request's head");
  assert.ok(existsSync(path.join(wt, 'pr3.txt')), 'with its files there');
  assert.equal(g.calls.length, 1, 'only the first pull request of the repository is fetched');
  assert.deepEqual(g.calls[0].args, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/pull/3/head:refs/remotes/origin/office-pr/3', '+refs/heads/main:refs/remotes/origin/main']);
  const prompt = await reviewPrompt(fx);
  assert.match(prompt, /- acme\/proj#3 “Fix login” https:\/\/github\.com\/acme\/proj\/pull\/3 — Checked out in your worktree of Proj: read its change there with `git diff origin\/main\.\.\.HEAD`\./);
  assert.match(prompt, /- acme\/proj#4 https:\/\/github\.com\/acme\/proj\/pull\/4 — Not checked out \(your worktree of its repository is on the base branch\): read it with `gh pr diff 4 -R acme\/proj`\./);
  assert.match(prompt, /a pull request marked as checked out above is the code in its repository's worktree/);
  await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
});

test('a fetch that fails leaves the worktree on the base branch, and the prompt says to read the pull request with gh pr diff', async (t) => {
  const g = fake(true);
  const fx = await engineFixture({ engine: { prGit: g.run } });
  t.after(() => fx.close());
  const main = git(fx.dir, 'rev-parse', 'HEAD');
  prBranch(fx.dir, 3); // there, but the fetch said it failed: nothing is checked out
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1500 }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3)], tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  const wt = wtOf(fx, got.workerId!);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), main, 'the configured base: the review still started');
  assert.ok(!existsSync(path.join(wt, 'pr3.txt')));
  assert.equal(g.calls.length, 1);
  assert.match(await reviewPrompt(fx), /- acme\/proj#3 https:\/\/github\.com\/acme\/proj\/pull\/3 — Not checked out \(your worktree of its repository is on the base branch\): read it with `gh pr diff 3 -R acme\/proj`\./);
  const done = await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(fx.repo.listRuns(done.id)[0].verdict, 'approved');
});

test('the heads: a pull request of a repository elsewhere is fetched by its branch, a fork’s is not, every one with `every`', async () => {
  const g = fake();
  const def = { id: 'p', name: 'P', dir: '/tmp/p-main', palette: 0, addedBy: 'x', addedAt: 0, repo: 'acme/main', repos: [{ id: 'main', name: 'Main', dir: '/tmp/p-main', primary: true, kind: 'git', remote: 'acme/main' }, { id: 'api', name: 'Api', dir: '/tmp/p-api', kind: 'git', remote: 'azure:org/proj/api' }] } as unknown as FloorDef;
  const prs = [
    { repo: 'acme/main', number: 1, base: 'main' },
    { repo: 'acme/main', number: 2, base: 'main' },
    { repo: 'azure:org/proj/api', number: 7, branch: 'feature/x', base: 'develop' },
    { repo: 'azure:org/proj/api', number: 8, branch: 'feature/y', fork: true },
  ];
  const heads = await fetchPrHeads(def, prs, g.run);
  assert.deepEqual([...heads.checkedOut], ['acme/main#1', 'azure:org/proj/api#7']);
  assert.deepEqual(Object.keys(heads.bases).sort(), ['/tmp/p-api', '/tmp/p-main']);
  assert.equal(heads.bases['/tmp/p-main'], 'office-pr/1');
  assert.equal(heads.bases['/tmp/p-api'], 'feature/x', 'elsewhere: the head branch by name');
  assert.deepEqual(g.calls.map((c) => c.args.slice(4)), [['+refs/pull/1/head:refs/remotes/origin/office-pr/1', '+refs/heads/main:refs/remotes/origin/main'], ['+refs/heads/feature/x:refs/remotes/origin/feature/x', '+refs/heads/develop:refs/remotes/origin/develop']]);
  assert.match(readingNote(prs[1], heads, def), /Not checked out .*`gh pr diff 2 -R acme\/main`/);
  assert.match(readingNote(prs[3], heads, def), /office-pr/, 'a pull request of a host without gh is read with office-pr');
  const every = await fetchPrHeads(def, prs, fake().run, true);
  assert.deepEqual([...every.fetched.keys()].sort(), ['acme/main#1', 'acme/main#2', 'azure:org/proj/api#7'], 'a fork’s head on a host with no pull refs is never fetched');
  assert.deepEqual([...every.checkedOut], ['acme/main#1', 'azure:org/proj/api#7'], 'still only the first of each is the one to check out');
  // A fetch that throws is none: never a rejection.
  const none = await fetchPrHeads(def, prs, fake(true).run);
  assert.equal(none.checkedOut.size, 0);
  assert.deepEqual(none.bases, {});
});

test('without a base branch on the pull request, the line points to gh pr diff for what changed', async () => {
  const def = { id: 'p', name: 'P', dir: '/tmp/q', palette: 0, addedBy: 'x', addedAt: 0, repo: 'acme/q', repos: [{ id: 'q', name: 'Q', dir: '/tmp/q', primary: true, kind: 'git', remote: 'acme/q' }] } as unknown as FloorDef;
  const heads = await fetchPrHeads(def, [{ repo: 'acme/q', number: 5 }], fake().run);
  assert.equal(readingNote({ repo: 'acme/q', number: 5 }, heads, def), 'Checked out in your worktree of Q: read its change there with `gh pr diff 5 -R acme/q`.');
});

test('the real git fetches the pull request’s ref and its base branch into the checkout, which is what a worktree is then cut from', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-heads-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(seed, 'a.txt'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'topic');
  writeFileSync(path.join(seed, 'pr.txt'), 'the pull request\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'the pull request');
  const head = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/pull/3/head'); // a fork's pull request has only this ref
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'pipe' });
  const def = { id: 'p', name: 'P', dir: checkout, palette: 0, addedBy: 'x', addedAt: 0, repo: 'acme/proj', repos: [{ id: 'p', name: 'P', dir: checkout, primary: true, kind: 'git', remote: 'acme/proj' }] } as unknown as FloorDef;
  const heads = await fetchPrHeads(def, [{ repo: 'acme/proj', number: 3, base: 'main' }]);
  assert.deepEqual([...heads.checkedOut], ['acme/proj#3']);
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/office-pr/3'), head, 'the pull request’s head');
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/main'), git(seed, 'rev-parse', 'main'), 'and its base branch, which the diff is against');
  assert.equal(git(checkout, 'diff', '--name-only', 'origin/main...refs/remotes/origin/office-pr/3'), 'pr.txt');
  // A pull request that is not there: no head, no throw, nothing to cut the worktree from.
  const missing = await fetchPrHeads(def, [{ repo: 'acme/proj', number: 99, base: 'main' }]);
  assert.equal(missing.checkedOut.size, 0);
  assert.deepEqual(missing.bases, {});
});
