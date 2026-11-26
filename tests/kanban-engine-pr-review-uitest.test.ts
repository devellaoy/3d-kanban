// The UI test before a pull-request review (the request's `uiTest`, engine/prreview-ui.ts): a review task of its own, an implementer-role
// agent in a fresh worktree on the base branch who takes the pictures into the task's images folder, then the review by itself; the
// tester's worktree is removed, the reviewers' prompts list the pictures, and none of them is added to any pull request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitRunner } from '../src/server/kanban/engine/prheads.js';
import { uiImagesDir } from '../src/server/kanban/engine/uitesting.js';
import { checkScreenshots, type ScreenshotMark } from '../src/server/kanban/integrations/pulls/screenshots.js';
import { closingsIdle } from '../src/server/kanban/integrations/pulls/closes.js';
import { grantDir } from '../src/server/kanban/uploads.js';
import type { KanbanTask } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noFetch: GitRunner = async () => {
  throw new Error('no network');
};
const TESTER = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Test the UI of these pull requests', reply, ...more });
const MAIN = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Review these pull requests', reply, ...more });
const APPROVED = 'The UI looks right.\nREVIEW: APPROVED';
const pr = (n: number) => ({ repo: 'acme/proj', number: n, title: `PR ${n}`, base: 'main' }) as never;
const inReview = (x: KanbanTask) => x.status === 'review' && x.runState === 'idle';
const prRuns = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).filter((r) => r.phase === 'pr-review');
const notes = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'status').map((c) => c.text);
const prompts = (fx: EngineFixture, re: RegExp) => fx.invocations().filter((i) => i.prompt && re.test(i.prompt));

async function setup(t: { after(fn: () => unknown): void }, engine: object = {}) {
  const fx = await engineFixture({ engine: { prGit: noFetch, restartStaggerMs: 50, ...engine } });
  t.after(() => fx.close());
  return fx;
}

async function until(what: string, fn: () => boolean, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

async function uiReview(fx: EngineFixture, more: object = {}) {
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3), pr(4)], tool: 'claude', uiTest: true, ...more }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') throw new Error(got);
  return { id: got.taskId, tester: got.workerId! };
}

const branchLeft = (fx: EngineFixture, wt: string) => git(fx.dir, 'branch', '--list', 'office/*').includes(path.basename(wt));

test('uiTest: a task of its own even when one is named, the tester first (an implementer in a fresh worktree on the base), then the review by itself', async (t) => {
  const fx = await setup(t);
  const main = git(fx.dir, 'rev-parse', 'HEAD');
  // A task whose pull requests the office opened: its images would go into them (checkScreenshots), so the review must not be that task.
  const other = fx.newTask({ usePlan: false, useReview: false });
  fx.repo.updateTask(other.id, { status: 'review', runState: 'idle', flags: { prRequested: true } });
  const dir = () => uiImagesDir(fx.ctx.filesDir, id);
  let id = 0;
  fx.setRules([TESTER('Saved the pictures of the login view.', { delayMs: 1500 }), MAIN(APPROVED)]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ ...(pr(3) as object), branch: 'feat/login' }, pr(4)] as never, taskId: other.id, tool: 'claude', uiTest: true }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  id = got.taskId;
  assert.notEqual(id, other.id, 'a review task of its own');
  assert.equal(fx.task(other.id).status, 'review', 'the named task is left alone');
  assert.equal(fx.repo.listRuns(other.id).length, 0);
  assert.ok(notes(fx, id).some((n) => new RegExp(`asked for on task #${other.id} and tests the UI too.*a review task of its own`).test(n)), notes(fx, id).join(' | '));
  assert.equal(fx.task(id).type, 'investigate');
  assert.equal(fx.task(id).phase, 'pr-review');

  // The first run: the tester, an implementer, hired in a fresh worktree of the project on its base branch.
  const tester = fx.workers.get(got.workerId!)!;
  assert.equal(tester.kanban?.role, 'implementer');
  const wt = path.join(fx.dir, tester.worktree!.path);
  assert.ok(existsSync(wt));
  assert.equal(git(wt, 'rev-parse', 'HEAD'), main, 'cut from the base branch, not from a pull request');
  assert.equal(fx.task(id).workerId, tester.id);
  assert.equal(fx.task(id).reviewerWorkerId, undefined, 'no reviewer yet');
  assert.ok(existsSync(dir()), 'the pictures folder exists before the tester starts');
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/running']);
  // It has the implementer's flags (it runs a dev server and writes pictures), and may write in the task's folder.
  const start = await (async () => {
    for (let i = 0; i < 200; i++) {
      const found = prompts(fx, /Test the UI of these pull requests/)[0];
      if (found) return found;
      await sleep(25);
    }
    throw new Error('the tester never started');
  })();
  assert.equal(start.args[start.args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!start.args.includes('--disallowedTools'), 'not the reviewer’s read-only flags');
  assert.ok(start.args.some((a, i) => a === '--add-dir' && start.args[i + 1] === grantDir(fx.ctx.filesDir, id)), 'the task’s folder is writable');
  const prompt = start.prompt!;
  assert.match(prompt, /- acme\/proj#3 “PR 3” \(branch feat\/login\) https:\/\/github\.com\/acme\/proj\/pull\/3 — its head is not fetched: git fetch origin pull\/3\/head/);
  assert.ok(prompt.includes(`Save the pictures in ${dir()}`));
  assert.match(prompt, /not added to any pull request/);
  assert.match(prompt, /git worktree add --detach/);
  assert.match(prompt, /How to end your work/, 'the work-done contract of an investigation');
  assert.doesNotMatch(prompt, /REVIEW: APPROVED/, 'no verdict is asked of it');

  // The tester's pictures (the fake agent can't take any: the test saves them as it would).
  writeFileSync(path.join(dir(), 'login-before.png'), 'b');
  writeFileSync(path.join(dir(), 'login-after.png'), 'a');

  const done = await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/succeeded', 'reviewer/succeeded']);
  assert.equal(done.workerId, undefined, 'the tester went home');
  assert.equal(done.sessionId, undefined, 'and its session is nobody’s to resume');
  assert.equal(done.workspace, undefined, 'its worktree never became the task’s');
  assert.equal(done.branch, undefined);
  assert.equal(fx.workers.list().length, 0);
  await until('the tester’s worktree and branch to be removed', () => !existsSync(wt) && !branchLeft(fx, wt), 15_000);
  const comments = fx.repo.listComments(id).comments;
  assert.ok(comments.some((c) => c.kind === 'result' && /Saved the pictures of the login view/.test(c.text)), 'its reply is a result comment of the task');
  assert.ok(comments.some((c) => c.kind === 'review' && /UI looks right/.test(c.text)));
  // The reviewer's prompt lists the saved pictures, and its folder is readable.
  const review = prompts(fx, /Review these pull requests/)[0];
  assert.match(review.prompt!, /The UI of these pull requests was tested before your review/);
  assert.ok(review.prompt!.includes(`- login: before ${path.join(dir(), 'login-before.png')}, after ${path.join(dir(), 'login-after.png')}`), review.prompt);
  assert.ok(review.args.some((a, i) => a === '--add-dir' && review.args[i + 1] === grantDir(fx.ctx.filesDir, id)), 'the pictures can be read');
  assert.ok(review.args.includes('--disallowedTools'), 'the reviewer keeps its read-only flags');
  assert.equal(fx.repo.listEvents(id).filter((e) => e.kind === 'pr.review').map((e) => (e.data as { request: { uiTest?: boolean; taskId?: number } }).request).map((r) => `${r.uiTest}/${r.taskId}`).join(), 'true/undefined');

  // The pictures go into no pull request: the review task has no prRequested flag, and checkScreenshots goes by that flag.
  const calls: string[][] = [];
  const io = { run: async (args: string[]) => (calls.push(args), args[1] === 'view' ? JSON.stringify({ body: '', updatedAt: 't' }) : '') };
  fx.repo.upsertPrLink(id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN', branch: 'feat/login' });
  fx.repo.setRepoBranch(id, 'proj', 'feat/login');
  const marks = new Map<string, ScreenshotMark>();
  checkScreenshots(fx.ctx, 'proj', marks, io);
  await closingsIdle();
  assert.deepEqual(calls, [], 'nothing is attached to the pull requests');
  assert.equal(marks.size, 0);
  // And even with the flag a task whose pull requests the office opened has, its latest review having tested the UI keeps the pictures out of them.
  fx.repo.updateTask(id, { flags: { ...fx.task(id).flags, prRequested: true } });
  checkScreenshots(fx.ctx, 'proj', marks, io);
  await closingsIdle();
  assert.deepEqual(calls, [], 'still nothing: the review request’s uiTest is what keeps them out');
});

test('uiTest: without a named task it is a review task of its own as any review is, and the review keeps `post`', async (t) => {
  const fx = await setup(t);
  const posted: { text: string }[] = [];
  (fx.ctx.pulls as { postReview?: unknown }).postReview = async (_p: string, prs: { repo: string; number: number }[], text: string) => (posted.push({ text }), prs.map((p) => ({ repo: p.repo, number: p.number, url: 'https://example.test/r' })));
  fx.setRules([TESTER('Saved login-before.png and login-after.png.'), MAIN('Fine.\nREVIEW: APPROVED')]);
  const { id } = await uiReview(fx, { post: true });
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  await until('the posting', () => posted.length === 1);
  assert.equal(posted[0].text, 'Fine.\nREVIEW: APPROVED', 'what is posted is the review: the pictures are in no part of it');
  assert.ok(!/png|picture/i.test(posted[0].text));
});

test('uiTest: a tester whose agent exits fails the task like any run, and Retry starts the UI test again, then the review (once)', async (t) => {
  const fx = await setup(t);
  fx.setRules([TESTER('unused', { exit: true }), MAIN(APPROVED)]);
  const { id, tester } = await uiReview(fx);
  const wt = path.join(fx.dir, fx.workers.get(tester)!.worktree!.path);
  const failed = await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'interrupted', 'the interruption', 30_000);
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/interrupted']);
  assert.equal(prompts(fx, /Review these pull requests/).length, 0, 'the review does not start behind a failed UI test');
  assert.match(failed.waitingText ?? '', /exited/);
  fx.setRules([TESTER('Nothing to photograph: the pull requests change no UI.'), MAIN(APPROVED)]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/interrupted', 'implementer/succeeded', 'reviewer/succeeded']);
  assert.equal(prompts(fx, /Test the UI of these pull requests/).length, 2);
  assert.equal(prompts(fx, /Review these pull requests/).length, 1, 'one review');
  assert.equal(fx.repo.listComments(id).comments.filter((c) => c.kind === 'review').length, 1);
  await until('the first tester’s worktree to be gone', () => !existsSync(wt), 15_000);
  assert.equal(fx.workers.list().length, 0);
});

test('uiTest: Stop during the UI test stops the task, no review starts, and Retry starts from the UI test again', async (t) => {
  const fx = await setup(t);
  fx.setRules([TESTER('Slow.', { delayMs: 8000 }), MAIN(APPROVED)]);
  const { id, tester } = await uiReview(fx);
  await until('the tester to work', () => fx.workers.get(tester)?.status === 'working');
  assert.equal(await fx.engine.stop(id, ADA), undefined);
  const stopped = await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 20_000);
  assert.equal(stopped.phase, 'pr-review');
  await sleep(300);
  assert.equal(prompts(fx, /Review these pull requests/).length, 0, 'a stopped UI test starts no review');
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/stopped']);
  fx.setRules([TESTER('Quick.'), MAIN(APPROVED)]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/stopped', 'implementer/succeeded', 'reviewer/succeeded']);
  assert.equal(prompts(fx, /Review these pull requests/).length, 1);
});

test('uiTest: an office restart during the UI test starts it again, and the review starts once', async (t) => {
  const fx = await setup(t);
  fx.setRules([TESTER('unused', { delayMs: 60_000 }), MAIN(APPROVED)]);
  const { id, tester } = await uiReview(fx);
  // Mid-turn as the office sees it: the tester has the prompt (its launch record is cleared) and is working.
  const first = fx.repo.activeRun(id)!;
  await until('the tester to work', () => !fx.repo.runLaunch(first.id) && fx.workers.get(tester)?.status === 'working', 20_000);
  fx.setRules([TESTER('Pictures saved after the restart.'), MAIN(APPROVED)]);
  await fx.restartOffice();
  await fx.waitTask(id, (x) => x.runState === 'idle' && x.status !== 'in_progress', 'the review done', 90_000);
  assert.equal(fx.task(id).status, 'review');
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/interrupted', 'implementer/succeeded', 'reviewer/succeeded']);
  assert.equal(prompts(fx, /Review these pull requests/).length, 1, 'the review started once');
  assert.equal(fx.repo.listComments(id).comments.filter((c) => c.kind === 'review').length, 1);
  assert.equal(fx.workers.list().length, 0, 'the tester and its worktree are gone');
});

test('uiTest: a fork’s pull request is left out of the test and named as such; with only forks no tester is hired and the review starts directly', async (t) => {
  const calls: string[][] = [];
  const fx = await setup(t, { prGit: async (_d: string, args: string[]) => void calls.push(args) });
  fx.setRules([TESTER('Nothing to photograph.', { delayMs: 800 }), MAIN(APPROVED)]);
  const mixed = await fx.engine.reviewPrs({ project: 'proj', prs: [{ ...(pr(3) as object), fork: true }, pr(4)] as never, tool: 'claude', uiTest: true }, ADA);
  assert.ok(typeof mixed !== 'string', String(mixed));
  if (typeof mixed === 'string') return;
  const start = await (async () => {
    for (let i = 0; i < 200; i++) {
      const f = prompts(fx, /Test the UI of these pull requests/)[0];
      if (f) return f;
      await sleep(25);
    }
    throw new Error('the tester never started');
  })();
  assert.match(start.prompt!, /- acme\/proj#3 .* — from a fork: not checked out, not run and not tested/);
  assert.match(start.prompt!, /- acme\/proj#4 .* — its head is not fetched|its head is fetched as origin\/office-pr\/4/);
  assert.ok(calls.every((a) => !a.some((x) => /pull\/3\//.test(x))), 'the fork’s head is never fetched');
  await fx.waitTask(mixed.taskId, inReview, 'the review column', 40_000);

  const before = prompts(fx, /Test the UI of these pull requests/).length;
  const only = await fx.engine.reviewPrs({ project: 'proj', prs: [{ ...(pr(5) as object), fork: true }] as never, tool: 'claude', uiTest: true }, ADA);
  assert.ok(typeof only !== 'string', String(only));
  if (typeof only === 'string') return;
  assert.equal(fx.task(only.taskId).workerId, undefined, 'no tester');
  await fx.waitTask(only.taskId, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, only.taskId).map((r) => `${r.role}/${r.status}`), ['reviewer/succeeded']);
  assert.equal(prompts(fx, /Test the UI of these pull requests/).length, before, 'no tester prompt');
  assert.ok(notes(fx, only.taskId).some((n) => /from a fork.*no UI to test: the review starts without it/.test(n)), notes(fx, only.taskId).join(' | '));
});
