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
const pr = (n: number, more: object = {}) => ({ repo: 'acme/proj', number: n, base: 'main', fork: false, ...more }) as never;

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
  assert.match(prompt, /- acme\/proj#4 https:\/\/github\.com\/acme\/proj\/pull\/4 — Not checked out: your worktree of its repository has pull request #3's head checked out, not this one's: read it with `gh pr diff 4 -R acme\/proj`\./);
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
    { repo: 'acme/main', number: 1, base: 'main', fork: false },
    { repo: 'acme/main', number: 2, base: 'main', fork: false },
    { repo: 'azure:org/proj/api', number: 7, branch: 'feature/x', base: 'develop', fork: false },
    { repo: 'azure:org/proj/api', number: 8, branch: 'feature/y', fork: true },
  ];
  const heads = await fetchPrHeads(def, prs, g.run);
  assert.deepEqual([...heads.checkedOut], ['acme/main#1', 'azure:org/proj/api#7']);
  assert.deepEqual(Object.keys(heads.bases).sort(), ['/tmp/p-api', '/tmp/p-main']);
  assert.equal(heads.bases['/tmp/p-main'], 'office-pr/1');
  assert.equal(heads.bases['/tmp/p-api'], 'feature/x', 'elsewhere: the head branch by name');
  assert.deepEqual(g.calls.map((c) => c.args.slice(4)), [['+refs/pull/1/head:refs/remotes/origin/office-pr/1', '+refs/heads/main:refs/remotes/origin/main'], ['+refs/heads/feature/x:refs/remotes/origin/feature/x', '+refs/heads/develop:refs/remotes/origin/develop']]);
  assert.match(readingNote(prs[1], heads, def), /Not checked out.*`gh pr diff 2 -R acme\/main`/);
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
  const heads = await fetchPrHeads(def, [{ repo: 'acme/q', number: 5, fork: false }], fake().run);
  assert.equal(readingNote({ repo: 'acme/q', number: 5, fork: false }, heads, def), 'Checked out in your worktree of Q: read its change there with `gh pr diff 5 -R acme/q`.');
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
  const heads = await fetchPrHeads(def, [{ repo: 'acme/proj', number: 3, base: 'main', fork: false }]);
  assert.deepEqual([...heads.checkedOut], ['acme/proj#3']);
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/office-pr/3'), head, 'the pull request’s head');
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/main'), git(seed, 'rev-parse', 'main'), 'and its base branch, which the diff is against');
  assert.equal(git(checkout, 'diff', '--name-only', 'origin/main...refs/remotes/origin/office-pr/3'), 'pr.txt');
  // A pull request that is not there: no head, no throw, nothing to cut the worktree from.
  const missing = await fetchPrHeads(def, [{ repo: 'acme/proj', number: 99, base: 'main', fork: false }]);
  assert.equal(missing.checkedOut.size, 0);
  assert.deepEqual(missing.bases, {});
});

test('a fork’s pull request is never checked out, on any host: no fetch, no worktree base, and its line says so', async () => {
  const g = fake();
  const def = { id: 'p', name: 'P', dir: '/tmp/f-main', palette: 0, addedBy: 'x', addedAt: 0, repo: 'acme/main', repos: [{ id: 'main', name: 'Main', dir: '/tmp/f-main', primary: true, kind: 'git', remote: 'acme/main' }, { id: 'api', name: 'Api', dir: '/tmp/f-api', kind: 'git', remote: 'azure:org/proj/api' }] } as unknown as FloorDef;
  const prs = [{ repo: 'acme/main', number: 1, base: 'main', fork: true }, { repo: 'acme/main', number: 2, base: 'main', fork: false }, { repo: 'azure:org/proj/api', number: 7, branch: 'x', fork: true }];
  const heads = await fetchPrHeads(def, prs, g.run, true);
  assert.deepEqual([...heads.fetched.keys()], ['acme/main#2']);
  assert.deepEqual(Object.keys(heads.bases), [], 'the first PR of the repository is a fork’s: the worktree stays on the base');
  assert.deepEqual(g.calls.map((c) => c.args.join(' ')).filter((a) => /pull\/1\//.test(a) || /heads\/x/.test(a)), []);
  assert.match(readingNote(prs[0], heads, def), /^From a fork, so not checked out .*`gh pr diff 1 -R acme\/main`\.$/);
  assert.match(readingNote(prs[2], heads, def), /^From a fork, so not checked out .*office-pr/);
});

test('a fork’s pull request in a review: nothing is fetched or checked out, and the prompt reads it with gh pr diff', async (t) => {
  const g = fake();
  const fx = await engineFixture({ engine: { prGit: g.run } });
  t.after(() => fx.close());
  const main = git(fx.dir, 'rev-parse', 'HEAD');
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1500 }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3, { fork: true })], tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.equal(git(wtOf(fx, got.workerId!), 'rev-parse', 'HEAD'), main);
  assert.equal(g.calls.length, 0, 'no git fetch of a fork’s code');
  assert.match(await reviewPrompt(fx), /From a fork, so not checked out .*`gh pr diff 3 -R acme\/proj`/);
  await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
});

test('end to end: the reviewer’s worktree is cut from the pull request’s ref in a real origin, by the real git', async (t) => {
  const fx = await engineFixture(); // no prGit: the real one
  t.after(() => fx.close());
  const origin = path.join(fx.root, 'origin.git');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(fx.dir, 'remote', 'add', 'origin', origin);
  git(fx.dir, 'push', '-q', 'origin', 'main');
  const tip = prBranch(fx.dir, 3);
  git(fx.dir, 'push', '-q', 'origin', `${tip}:refs/pull/3/head`); // where GitHub keeps every pull request's head, a fork's too
  git(fx.dir, 'branch', '-q', '-D', 'office-pr/3'); // the local copy of the test helper must not be what the worktree is cut from
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1500 }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3)], tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  const wt = wtOf(fx, got.workerId!);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), tip, 'cut from refs/remotes/origin/office-pr/3, fetched from refs/pull/3/head');
  assert.ok(existsSync(path.join(wt, 'pr3.txt')));
  assert.equal(git(fx.dir, 'rev-parse', 'refs/remotes/origin/office-pr/3'), tip);
  assert.match(await reviewPrompt(fx), /Checked out in your worktree of .*`git diff origin\/main\.\.\.HEAD`/);
  await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
});

test('unknown fork state is unsafe: a pull request not confirmed `fork: false` is never fetched, checked out, or listed as read in the worktree', async (t) => {
  const g = fake();
  const def = { id: 'p', name: 'P', dir: '/tmp/u', palette: 0, addedBy: 'x', addedAt: 0, repo: 'acme/u', repos: [{ id: 'u', name: 'U', dir: '/tmp/u', primary: true, kind: 'git', remote: 'acme/u' }] } as unknown as FloorDef;
  const prs = [{ repo: 'acme/u', number: 1, base: 'main' }, { repo: 'acme/u', number: 2, base: 'main', fork: false }];
  const heads = await fetchPrHeads(def, prs, g.run, true);
  assert.deepEqual([...heads.fetched.keys()], ['acme/u#2'], 'only the confirmed one');
  assert.deepEqual(Object.keys(heads.uiBases), []);
  assert.match(readingNote(prs[0], heads, def), /^Not checked out: the office could not confirm it is not from a fork.*`gh pr diff 1 -R acme\/u`\.$/);
  // Through the engine, and on a Retry (an older stored request has no fork flag at all).
  const fx = await engineFixture({ engine: { prGit: g.run } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 3000 }]);
  g.calls.length = 0;
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 3, base: 'main' }] as never, tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.equal(g.calls.length, 0, 'nothing fetched');
  assert.match(await reviewPrompt(fx), /could not confirm it is not from a fork.*`gh pr diff 3 -R acme\/proj`/);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await fx.engine.stop(got.taskId, ADA), undefined);
  await fx.waitTask(got.taskId, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 20_000);
  for (let i = 0; i < 100 && !['idle', 'done'].includes(fx.workers.get(got.workerId!)?.status ?? 'idle'); i++) await new Promise((r) => setTimeout(r, 40));
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED' }]);
  assert.equal(await fx.engine.retry(got.taskId, ADA), undefined);
  await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(g.calls.length, 0, 'the retried review fetched nothing either');
});

test('the fetches of all repositories share one deadline: a git that hangs is aborted and the review starts on the base branch with gh pr diff', async (t) => {
  const seen: AbortSignal[] = [];
  const hang: GitRunner = (_d, _a, signal) => new Promise((_, no) => { if (signal) { seen.push(signal); signal.addEventListener('abort', () => no(new Error('aborted'))); } });
  const fx = await engineFixture({ engine: { prGit: hang, prHeadsMs: 300 } });
  t.after(() => fx.close());
  const main = git(fx.dir, 'rev-parse', 'HEAD');
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1200 }]);
  const started = Date.now();
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3)], tool: 'claude' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.ok(Date.now() - started < 5000, `answered after ${Date.now() - started} ms`);
  assert.equal(git(wtOf(fx, got.workerId!), 'rev-parse', 'HEAD'), main);
  assert.ok(seen.length > 0 && seen.every((x) => x.aborted), 'the abandoned git is aborted');
  assert.match(await reviewPrompt(fx), /Not checked out \(your worktree of its repository is on the base branch\): read it with `gh pr diff 3 -R acme\/proj`/);
  await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
});

test('identical review requests make one task: concurrent ones share the answer, a later one within the window gets the same task, another set of PRs is its own review', async (t) => {
  const fx = await engineFixture({ engine: { prGit: fake(true).run } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED', delayMs: 1500 }]);
  const before = fx.repo.listTasks('proj').length;
  const [a, b] = await Promise.all([fx.engine.reviewPrs({ project: 'proj', prs: [pr(3), pr(4)], tool: 'claude', post: true }, ADA), fx.engine.reviewPrs({ project: 'proj', prs: [pr(4), pr(3)], tool: 'claude', post: true }, ADA)]);
  assert.ok(typeof a !== 'string' && typeof b !== 'string', `${String(a)} ${String(b)}`);
  if (typeof a === 'string' || typeof b === 'string') return;
  assert.equal(a.taskId, b.taskId);
  assert.equal(fx.repo.listTasks('proj').length, before + 1, 'one task');
  const later = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3), pr(4)], tool: 'claude', post: true }, ADA);
  assert.deepEqual(later, a, 'the same answer, no second run');
  assert.equal(fx.repo.listTasks('proj').length, before + 1);
  assert.equal(fx.repo.listRuns(a.taskId).filter((r) => r.phase === 'pr-review').length, 1);
  const other = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3), pr(5)], tool: 'claude', post: true }, ADA);
  assert.ok(typeof other !== 'string' && other.taskId !== a.taskId, 'another set of pull requests');
  const flags = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3), pr(4)], tool: 'claude' }, ADA);
  assert.ok(typeof flags !== 'string' && flags.taskId !== a.taskId, 'other choices');
});
