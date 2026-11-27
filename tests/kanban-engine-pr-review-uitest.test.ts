// The UI test before a pull-request review (the request's `uiTest`, engine/prreview-ui.ts): a review task of its own, an implementer-role
// agent in a fresh worktree on the base branch who tests the UI, takes the pictures into the task's images folder and writes a report, then the review by itself; the
// tester's worktree is removed, the reviewers' prompts name the report and list the pictures, and none of them is added to any pull request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { putOfficeFile, replaceOfficeFile } from '../src/server/kanban/officefile.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitRunner } from '../src/server/kanban/engine/prheads.js';
import { uiImagesDir, uiTestReportFor } from '../src/server/kanban/engine/uitesting.js';
import { checkScreenshots, type ScreenshotMark } from '../src/server/kanban/integrations/pulls/screenshots.js';
import { closingsIdle } from '../src/server/kanban/integrations/pulls/closes.js';
import { dropUiTestReport, readUiTestReport, storeUiTestReport, uiTestReportPath } from '../src/server/kanban/taskfiles.js';
import { uiTestReport } from '../src/server/kanban/engine/prreview-ui.js';
import { grantDir } from '../src/server/kanban/uploads.js';
import type { KanbanTask } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noFetch: GitRunner = async () => {
  throw new Error('no network');
};
const TESTER = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Test the UI and the functionality of these pull requests', reply, ...more });
const MAIN = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Review these pull requests', reply, ...more });
const APPROVED = 'The UI looks right.\nREVIEW: APPROVED';
const pr = (n: number) => ({ repo: 'acme/proj', number: n, title: `PR ${n}`, base: 'main', fork: false }) as never;
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

/** Whether anything, a dangling link too, is at `p`. */
const lstatExists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

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
      const found = prompts(fx, /Test the UI and the functionality of these pull requests/)[0];
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
  assert.match(review.prompt!, /The UI and the functionality of these pull requests were tested before your review/);
  const reportFile = uiTestReportPath(fx.ctx.filesDir, id);
  assert.ok(readFileSync(reportFile, 'utf8').includes('Saved the pictures of the login view'), 'its reply is kept in the report file');
  assert.ok(review.prompt!.includes(`The tester's report is in ${reportFile}.`));
  assert.ok(review.prompt!.includes('Your reply must have a section "UI testing"'), 'the main reviewer writes the section');
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
  fx.setRules([TESTER('Nothing to photograph: the pull requests change no UI.', { delayMs: 1500 }), MAIN(APPROVED)]);
  // An old report (a read-only copy, as the office writes them) is gone when the UI test starts again.
  const old = uiTestReportPath(fx.ctx.filesDir, id);
  mkdirSync(path.dirname(old), { recursive: true });
  writeFileSync(old, 'OLD REPORT', { mode: 0o444 });
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await until('the second tester to start', () => prompts(fx, /Test the UI and the functionality of these pull requests/).length === 2);
  assert.ok(!existsSync(old), 'no file is left for the tester to find');
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.role}/${r.status}`), ['implementer/interrupted', 'implementer/succeeded', 'reviewer/succeeded']);
  assert.equal(prompts(fx, /Test the UI and the functionality of these pull requests/).length, 2);
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
      const f = prompts(fx, /Test the UI and the functionality of these pull requests/)[0];
      if (f) return f;
      await sleep(25);
    }
    throw new Error('the tester never started');
  })();
  assert.match(start.prompt!, /- acme\/proj#3 .* — from a fork: not checked out, not run and not tested/);
  assert.match(start.prompt!, /- acme\/proj#4 .* — its head is not fetched|its head is fetched as origin\/office-pr\/4/);
  assert.ok(calls.every((a) => !a.some((x) => /pull\/3\//.test(x))), 'the fork’s head is never fetched');
  await fx.waitTask(mixed.taskId, inReview, 'the review column', 40_000);

  const before = prompts(fx, /Test the UI and the functionality of these pull requests/).length;
  const only = await fx.engine.reviewPrs({ project: 'proj', prs: [{ ...(pr(5) as object), fork: true }] as never, tool: 'claude', uiTest: true }, ADA);
  assert.ok(typeof only !== 'string', String(only));
  if (typeof only === 'string') return;
  assert.equal(fx.task(only.taskId).workerId, undefined, 'no tester');
  await fx.waitTask(only.taskId, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, only.taskId).map((r) => `${r.role}/${r.status}`), ['reviewer/succeeded']);
  assert.equal(prompts(fx, /Test the UI and the functionality of these pull requests/).length, before, 'no tester prompt');
  assert.ok(notes(fx, only.taskId).some((n) => /from a fork.*no UI to test: the review starts without it/.test(n)), notes(fx, only.taskId).join(' | '));
});

test('uiTest: the tester’s worktree is cut from the target of the first pull request tested in the repository, and the prompt says which is which', async (t) => {
  // Its fetch of a pull request's own ref fails (nothing to fetch it from); a branch's fetch works: the worktree starts from the target, which is a local branch here.
  // A fetched branch lands where a real fetch puts it (refs/remotes/origin/<branch>), from the local branch of that name.
  const fx = await setup(t, { prGit: async (d: string, args: string[]) => {
      if (args.some((a) => /refs\/pull\//.test(a))) throw new Error('no such ref');
      for (const a of args) {
        const m = /^\+refs\/heads\/(.+):(refs\/remotes\/origin\/.+)$/.exec(a);
        if (m) git(d, 'update-ref', m[2], `refs/heads/${m[1]}`);
      }
    } });
  const mainTip = git(fx.dir, 'rev-parse', 'HEAD');
  git(fx.dir, 'checkout', '-q', '-b', 'release');
  writeFileSync(path.join(fx.dir, 'release.txt'), 'release only\n');
  git(fx.dir, 'add', '.');
  git(fx.dir, 'commit', '-q', '-m', 'release');
  const releaseTip = git(fx.dir, 'rev-parse', 'HEAD');
  git(fx.dir, 'checkout', '-q', 'main');
  assert.notEqual(releaseTip, mainTip);
  fx.setRules([TESTER('No UI change.', { delayMs: 1500 }), MAIN(APPROVED)]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ ...(pr(3) as object), base: 'release' }, pr(4)] as never, tool: 'claude', uiTest: true }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  const wt = path.join(fx.dir, fx.workers.get(got.workerId!)!.worktree!.path);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), releaseTip, 'the first pull request’s target is where the worktree starts');
  assert.ok(existsSync(path.join(wt, 'release.txt')));
  const start = await (async () => {
    for (let i = 0; i < 200; i++) {
      const f = prompts(fx, /Test the UI and the functionality of these pull requests/)[0];
      if (f) return f;
      await sleep(25);
    }
    throw new Error('the tester never started');
  })();
  assert.match(start.prompt!, /#3 .* it targets release, which your workspace starts from \(origin\/release\)/);
  // The other pull request targets main: its "before" pictures come from a worktree of main, by the command its line gives.
  const cmd = /#4 .* it targets main, not release that your workspace starts from: take its "before" pictures in a worktree of its own target, (git worktree add --detach \.\/base-4 origin\/main)/.exec(start.prompt!)?.[1];
  assert.ok(cmd, start.prompt!);
  assert.match(start.prompt!, /When its line names another target, put that target in a worktree of its own/);
  git(wt, ...cmd!.split(' ').slice(1));
  assert.equal(git(path.join(wt, 'base-4'), 'rev-parse', 'HEAD'), mainTip, 'the second pull request’s pictures start from its own target');
  assert.ok(!existsSync(path.join(wt, 'base-4', 'release.txt')));
  git(wt, 'worktree', 'remove', '--force', 'base-4');
  await fx.waitTask(got.taskId, inReview, 'the review column', 40_000);
});

test('uiTest: a pull request not confirmed not to be from a fork is not tested, and with none confirmed no tester is hired', async (t) => {
  const fx = await setup(t);
  fx.setRules([MAIN(APPROVED)]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 3, base: 'main' }] as never, tool: 'claude', uiTest: true }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  await fx.waitTask(got.taskId, inReview, 'the review column', 40_000);
  assert.deepEqual(prRuns(fx, got.taskId).map((r) => `${r.role}/${r.status}`), ['reviewer/succeeded']);
  assert.ok(notes(fx, got.taskId).some((n) => /confirmed not to be from a fork.*no UI to test/.test(n)), notes(fx, got.taskId).join(' | '));
  assert.ok(!notes(fx, got.taskId).some((n) => /to test the UI of, and then review/.test(n)), 'a skipped UI test is not announced as started');
  assert.ok(notes(fx, got.taskId).some((n) => /asked \w+ to review acme\/proj#3/.test(n)));
});

test('uiTest: the report the tester wrote is kept and is the result comment when its reply holds no report', async (t) => {
  const fx = await setup(t);
  fx.setRules([TESTER('Done. The UI test report is in the file named above.', { delayMs: 1500 }), MAIN(APPROVED)]);
  const { id } = await uiReview(fx);
  const file = uiTestReportPath(fx.ctx.filesDir, id);
  await until('the tester to start', () => prompts(fx, /Test the UI and the functionality of these pull requests/).length === 1);
  assert.ok(prompts(fx, /Test the UI and the functionality/)[0].prompt!.includes(`Write the report to ${file} as you go`));
  const body = '## UI test report\n### Tested\n- PR 3 login: PASSED';
  writeFileSync(file, body);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.equal(readFileSync(file, 'utf8').trim(), body, 'the file keeps what the tester wrote');
  const results = fx.repo.listComments(id).comments.filter((c) => c.kind === 'result');
  assert.deepEqual(results.map((c) => c.text), [body], 'the conversation shows what the reviewers read');
  assert.ok(prompts(fx, /Review these pull requests/)[0].prompt!.includes(`The tester's report is in ${file}.`));
});

test('uiTest: the file stays first and a reply that is a report too is kept after it, for the reviewers and the conversation alike', async (t) => {
  const fx = await setup(t);
  const full = '## UI test report\n### Tested\n- PR 3 login: FAILED\n### Findings\n- PR 3: the form submits twice';
  fx.setRules([TESTER(full, { delayMs: 1500 }), MAIN(APPROVED)]);
  const { id } = await uiReview(fx);
  const file = uiTestReportPath(fx.ctx.filesDir, id);
  await until('the tester to start', () => prompts(fx, /Test the UI and the functionality of these pull requests/).length === 1);
  writeFileSync(file, '## UI test report\n### Tested\n- PR 3 login: NOT TESTED');
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  const kept = readFileSync(file, 'utf8');
  assert.ok(kept.startsWith('## UI test report\n### Tested\n- PR 3 login: NOT TESTED'), 'what the tester wrote in the file comes first');
  assert.match(kept, /The tester's final reply:[\s\S]*the form submits twice/, 'and the finding only its reply has is not lost');
  const results = fx.repo.listComments(id).comments.filter((c) => c.kind === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].text.trim(), kept.trim(), 'one text in both places');
});

test('uiTestReport: the file is the report; a headed reply adds only what the file lacks, and without a file the reply is it', () => {
  const file = '## UI test report\n### Tested\n- PR 3 login: FAILED\n### Findings\n- PR 3: the form submits twice. Steps: open /login, press Enter twice.';
  // A short summary under the same heading never replaces the detailed report: it comes after it.
  const summary = '## UI test report\nOne path failed, see the file.';
  const both = uiTestReport(file, `${summary}\n\nWORK DONE`);
  assert.ok(both.startsWith(file), 'the detailed report is kept, first');
  assert.match(both, /press Enter twice[\s\S]*The tester's final reply:[\s\S]*One path failed/);
  // A reply that repeats the file, whatever its spacing, adds nothing; nor does one that is no report.
  assert.equal(uiTestReport(file, file.replace(/\n/g, '\n\n')), file);
  assert.equal(uiTestReport(file, 'Done. The UI test report is in the file named above.'), file);
  assert.equal(uiTestReport(file, ''), file);
  assert.equal(uiTestReport(undefined, ' Nothing to test. \n'), 'Nothing to test.');
  assert.equal(uiTestReport(undefined, ''), '');
});

test('uiTest: a file over the limit, a folder or a link at the report’s path is replaced unread by the reply, and a Retry clears a folder there', async (t) => {
  const fx = await setup(t);
  fx.setRules([TESTER('Nothing changes the UI.', { delayMs: 1500 }), MAIN(APPROVED)]);
  const { id } = await uiReview(fx);
  const file = uiTestReportPath(fx.ctx.filesDir, id);
  await until('the tester to start', () => prompts(fx, /Test the UI and the functionality of these pull requests/).length === 1);
  writeFileSync(file, 'x'.repeat(5_000_000));
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.equal(readFileSync(file, 'utf8').trim(), 'Nothing changes the UI.', 'the large file is gone, the reply is the report');
  assert.deepEqual(fx.repo.listComments(id).comments.filter((c) => c.kind === 'result').map((c) => c.text), ['Nothing changes the UI.']);
  assert.ok(prompts(fx, /Review these pull requests/)[0].prompt!.includes(`The tester's report is in ${file}.`));

  // The same three wrong things, through the helpers the run uses: none is a report, and the reset leaves nothing of any.
  const secret = path.join(path.dirname(file), 'secret.txt');
  writeFileSync(secret, 'secret');
  for (const wrong of [() => mkdirSync(path.join(file, 'inner'), { recursive: true }), () => symlinkSync(secret, file), () => symlinkSync(path.dirname(file), file)]) {
    rmSync(file, { recursive: true, force: true });
    wrong();
    assert.deepEqual(Object.keys(uiTestReportFor(fx.repo, fx.ctx.filesDir, id)), ['text'], 'no prompt names it: the kept text is given');
    assert.equal(readUiTestReport(fx.ctx.filesDir, id), undefined);
    dropUiTestReport(fx.ctx.filesDir, id);
    assert.ok(!existsSync(file) && !lstatExists(file), 'the reset removes it');
    assert.equal(storeUiTestReport(fx.ctx.filesDir, id, 'next'), file, 'and the next report can be written');
  }
  assert.equal(readFileSync(secret, 'utf8'), 'secret', 'a link is removed, never followed');
});

test('readUiTestReport: what is read is the file that was checked, even when the path becomes a link meanwhile', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ui-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = uiTestReportPath(root, 7);
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = path.join(root, 'secret.txt');
  writeFileSync(secret, 'secret');
  writeFileSync(file, 'the report');
  let swapped = false;
  const got = readUiTestReport(root, 7, {
    opened: () => {
      rmSync(file);
      symlinkSync(secret, file);
      swapped = true;
    },
  });
  assert.ok(swapped);
  assert.equal(got, 'the report', 'the open file, not what the path points at now');
  assert.equal(readUiTestReport(root, 7), undefined, 'and the link itself is never opened');
  // A file that grows past the limit after it was checked is no report either.
  rmSync(file);
  writeFileSync(file, 'x'.repeat(200_000));
  assert.equal(readUiTestReport(root, 7, { opened: () => writeFileSync(file, 'y'.repeat(300_000)) }), undefined);
});

test('readUiTestReport: a path that becomes a link between the check and the open is refused, with or without the platform’s no-follow flag', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ui-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = uiTestReportPath(root, 7);
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = path.join(root, 'secret.txt');
  writeFileSync(secret, 'secret');
  // 0: a platform without O_NOFOLLOW, where the open follows the link; undefined: this platform's own flag.
  for (const noFollow of [0, undefined]) {
    rmSync(file, { force: true });
    writeFileSync(file, 'the report');
    let swapped = false;
    const got = readUiTestReport(root, 7, {
      noFollow,
      beforeOpen: () => {
        rmSync(file);
        symlinkSync(secret, file);
        swapped = true;
      },
    });
    assert.ok(swapped);
    assert.equal(got, undefined, `the link's target is not the report (noFollow ${noFollow})`);
  }
  // Swapped to a link for the open and back to a file after it: still not the file that was checked.
  rmSync(file, { force: true });
  writeFileSync(file, 'the report');
  const back = readUiTestReport(root, 7, {
    noFollow: 0,
    beforeOpen: () => (rmSync(file), symlinkSync(secret, file)),
    opened: () => (rmSync(file), writeFileSync(file, 'the report')),
  });
  assert.equal(back, undefined);
  assert.equal(readFileSync(secret, 'utf8'), 'secret');
});

test('storeUiTestReport: what is at the path is never read, also when it cannot be removed first; a temporary name that is a link is not written through', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ui-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = uiTestReportPath(root, 7);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x'.repeat(5_000_000));
  // Every read of the report's path through fs is counted, and removing it fails: the store must still replace it, unread.
  const reads: string[] = [];
  const watch = <K extends 'readFileSync' | 'readSync' | 'openSync'>(name: K) => {
    const real = fs[name] as (...a: unknown[]) => unknown;
    t.mock.method(fs, name, ((...a: unknown[]) => {
      if (name === 'readSync' || (typeof a[0] === 'string' && a[0] === file)) reads.push(name);
      return real(...a);
    }) as never);
  };
  watch('readFileSync');
  watch('readSync');
  watch('openSync');
  const realRm = fs.rmSync;
  let refused = 0;
  t.mock.method(fs, 'rmSync', ((p: fs.PathLike, o?: fs.RmOptions) => {
    if (p === file) {
      refused++;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRm(p, o);
  }) as never);
  syncBuiltinESMExports();
  try {
    assert.equal(storeUiTestReport(root, 7, 'the report'), file);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(reads, [], 'the old file was not opened or read');
  assert.equal(refused, 0, 'a file is renamed over: it needs no removal that could fail');
  assert.equal(readFileSync(file, 'utf8'), 'the report\n');

  // A folder there cannot be renamed over: with its removal refused nothing is stored, and still nothing is read.
  rmSync(file);
  mkdirSync(path.join(file, 'inner'), { recursive: true });
  t.mock.method(fs, 'rmSync', ((p: fs.PathLike, o?: fs.RmOptions) => {
    if (p === file) {
      refused++;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRm(p, o);
  }) as never);
  syncBuiltinESMExports();
  try {
    assert.equal(storeUiTestReport(root, 7, 'the report'), undefined);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(lstatSync(file).isDirectory(), 'the folder is left as it is');
  assert.ok(refused > 0, 'the removal was tried and refused');
  rmSync(file, { recursive: true });

  // The temporary file: a link waiting at its name is left alone, target and all, and another name is used.
  const target = path.join(root, 'target.txt');
  writeFileSync(target, 'untouched');
  const trap = `${file}.trap.tmp`;
  symlinkSync(target, trap);
  const names = [trap, `${file}.free.tmp`];
  replaceOfficeFile(file, 'safe\n', () => names.shift()!);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(readFileSync(file, 'utf8'), 'safe\n');
  assert.ok(lstatSync(trap).isSymbolicLink(), 'the link itself is not removed or replaced');
  assert.ok(!existsSync(`${file}.free.tmp`), 'the temporary file became the report');
  // A write that takes only a part at a time still leaves the whole text, multi-byte characters too; one that takes nothing fails and leaves the old file.
  const whole = `${'äö€ '.repeat(3000)}end\n`;
  const realWrite = fs.writeSync as (...a: unknown[]) => number;
  let calls = 0;
  t.mock.method(fs, 'writeSync', ((fd: number, buf: Uint8Array, at: number, len: number) => (calls++, realWrite(fd, buf, at, Math.min(len, 1000)))) as never);
  syncBuiltinESMExports();
  try {
    replaceOfficeFile(file, whole);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(calls > 10, 'written in parts');
  assert.equal(readFileSync(file, 'utf8'), whole);
  t.mock.method(fs, 'writeSync', (() => 0) as never);
  syncBuiltinESMExports();
  try {
    assert.throws(() => replaceOfficeFile(file, 'short\n'), /bytes could be written/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(file, 'utf8'), whole, 'a half-written file never replaces the old one');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => /\.tmp$/.test(n) && !/trap/.test(n)), [], 'and its temporary file is removed');
  // The old, guessable name too, through the ordinary writer.
  const guess = `${file}.${process.pid}.tmp`;
  symlinkSync(target, guess);
  assert.equal(putOfficeFile(file, 'again'), true);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  // With every name taken it gives up rather than write through one.
  assert.throws(() => replaceOfficeFile(file, 'no\n', () => trap), /EEXIST/);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

test('readUiTestReport: only a regular file with text, up to 200 kB; a link, an empty or a large file is no report', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ui-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = uiTestReportPath(root, 7);
  assert.equal(readUiTestReport(root, 7), undefined, 'none');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '  \n ');
  assert.equal(readUiTestReport(root, 7), undefined, 'blank');
  writeFileSync(file, 'x'.repeat(200_001));
  assert.equal(readUiTestReport(root, 7), undefined, 'too large');
  writeFileSync(file, ' report \n');
  assert.equal(readUiTestReport(root, 7), 'report');
  const secret = path.join(root, 'secret.txt');
  writeFileSync(secret, 'secret');
  rmSync(file);
  symlinkSync(secret, file);
  assert.equal(readUiTestReport(root, 7), undefined, 'a link is not read');
});
