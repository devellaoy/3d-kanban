// Regressions from the devil's-advocate review of the engine: comments typed during a review, tasks
// whose worktree is gone, workers that exit mid-run, and pull-request
// reviews as engine runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkerObservation } from '../src/server/workers.js';
import { KANBAN_CONTRACTS } from '../src/shared/kanban/prompts.js';
import { ADA, engineFixture, type Invocation } from './kanban-engine-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
/** The prompt an invocation started with (the argument after `--`), or the one typed in. */
const promptOf = (i: Invocation) => i.prompt ?? (i.args.includes('--') ? i.args[i.args.indexOf('--') + 1] : undefined);

test('a comment typed while a review round runs is worked on when the review approves, then reviewed again', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'This is review round 1 of', reply: 'Looks fine.\n\nREVIEW: APPROVED', delayMs: 2500 },
    { when: 'commented on task', reply: 'Handled the comment.', commit: 'Rename' },
  ]);
  const task = fx.newTask({ usePlan: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.phase === 'review' && x.runState === 'running', 'the review running', 20_000);
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also rename foo to bar.' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  assert.equal(fx.task(task.id).pendingMessages.length, 1, 'queued while the reviewer works');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length === 4, 'the review column after the second review', 40_000);
  assert.deepEqual(done.pendingMessages, []);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.role}`), ['implement/implementer', 'review/reviewer', 'resume/implementer', 'review/reviewer']);
  assert.ok(fx.invocations().some((i) => i.prompt && /rename foo to bar/.test(i.prompt)), 'the comment reached the implementer');
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
});

test("a task whose worktree is gone gets a fresh one on its own branch instead of hanging in running", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'commented on task', reply: 'Handled.', commit: 'More work' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  const branch = r.branch!;
  assert.ok(branch);
  const old = path.join(fx.dir, r.workspace!.worktree.path);
  // What leave-on-merge does: the implementer goes home and its worktree goes (the branch stays).
  await fx.workers.kill(r.workerId!, 'worktree');
  if (existsSync(old)) git(fx.dir, 'worktree', 'remove', '--force', old);
  const gone = await fx.waitTask(task.id, (x) => !x.workerId && !x.workspace, 'the worker and its deleted worktree gone from the task');
  assert.equal(gone.branch, branch, 'the branch is still there, so the task keeps it');
  // Review by hand is refused with a reason rather than seating a reviewer in nothing.
  assert.match((await fx.engine.review(task.id, ADA)) ?? '', /worktree is gone/);

  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'One more thing.' }).comment;
  const before = fx.invocations().length;
  await fx.engine.commented(task.id, c.id, ADA);
  const after = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length === 2, 'the comment worked on', 20_000);
  assert.equal(after.branch, branch, "the task's branch is never lost");
  assert.ok(after.workspace && path.join(fx.dir, after.workspace.worktree.path) !== old, 'a fresh worktree');
  assert.ok(existsSync(path.join(fx.dir, after.workspace.worktree.path)));
  assert.equal(fx.repo.listRuns(task.id)[1].status, 'succeeded');
  const hire = fx.invocations().slice(before).find((i) => i.kind === 'claude' && promptOf(i));
  assert.ok(hire, 'a new hire');
  assert.ok(!hire.args.includes('--resume'), 'a fresh session: the old one ran in the folder that is gone');
  const prompt = promptOf(hire)!;
  assert.match(prompt, /You are taking over kanban task/, 'handed over');
  assert.ok(prompt.includes(`\`${branch}\``) && /check the task's branch out/.test(prompt), 'told to check out its branch');
  assert.match(prompt, /One more thing\./);
});

test('a worktree pruned under an idle implementer: it goes home and a fresh worktree carries on', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'commented on task', reply: 'Handled.', commit: 'More work' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  const old = r.workerId!;
  git(fx.dir, 'worktree', 'remove', '--force', path.join(fx.dir, r.workspace!.worktree.path));
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'One more thing.' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  const after = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length === 2, 'the comment worked on', 20_000);
  assert.equal(fx.workers.get(old), undefined, 'the stranded worker went home');
  assert.notEqual(after.workerId, old);
  assert.equal(after.branch, r.branch);
  assert.ok(existsSync(path.join(fx.dir, after.workspace!.worktree.path)));
});

test('a migrated task that already has a branch keeps it, and the fresh worktree checks it out', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  git(fx.dir, 'branch', 'kanban/uyt-7-old-work');
  fx.setRules([{ when: 'Implement kanban task', reply: 'Carried on.', git: ['checkout', 'kanban/uyt-7-old-work'], commit: 'More' }]);
  const task = fx.newTask({ usePlan: false, useReview: false, branch: 'kanban/uyt-7-old-work' });
  await fx.engine.start(task.id, ADA);
  const hired = await fx.waitTask(task.id, (x) => !!x.workspace, 'the hire');
  assert.equal(hired.branch, 'kanban/uyt-7-old-work', 'the hire does not overwrite the known branch');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(done.branch, 'kanban/uyt-7-old-work');
  const prompt = promptOf(fx.invocations().find((i) => i.kind === 'claude' && promptOf(i))!)!;
  assert.match(prompt, /- Proj: `kanban\/uyt-7-old-work`/);
  assert.doesNotMatch(prompt, /Name it kanban\//, 'no new branch is asked for');
  assert.equal(git(path.join(fx.dir, done.workspace!.worktree.path), 'rev-parse', '--abbrev-ref', 'HEAD'), 'kanban/uyt-7-old-work');
});

test('an agent that exits mid-run interrupts the run: the task waits with Retry, not running forever', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: '', exit: true }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const w = await fx.waitTask(task.id, (x) => x.status === 'waiting', 'waiting', 20_000);
  assert.equal(w.waitingReason, 'interrupted');
  assert.equal(w.runState, 'idle');
  assert.match(w.waitingText ?? '', /exited before its turn was done: Retry/);
  assert.equal(fx.repo.listRuns(task.id)[0].status, 'interrupted');
  // Retry carries on.
  fx.setRules([{ when: 'cut short|Implement kanban task', reply: 'Done now.', commit: 'Work' }]);
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column after the retry', 20_000);
});

test('upstream seam: a worker whose folder is gone at launch is heard exiting', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const heard: WorkerObservation[] = [];
  const off = fx.workers.addObserver((o) => void heard.push(o));
  t.after(off);
  const info = fx.workers.spawn('desk-5', 'Test', 'Hello', false, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, { reuse: { worktree: { path: '.agent-office/worktrees/gone/x', branch: 'office/gone' } } });
  assert.ok(typeof info !== 'string', String(info));
  if (typeof info === 'string') return;
  assert.equal(fx.workers.get(info.id)?.status, 'exited');
  assert.ok(fx.workers.get(info.id)?.lost);
  assert.ok(heard.some((o) => o.workerId === info.id && o.event === 'status' && o.status === 'exited'));
});

test('a pull-request review is an engine run: a new investigate task, a reviewer in its own worktree, its verdict, then home', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Review these pull requests', reply: 'The two fit together.\n\nREVIEW: APPROVED' }]);
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 3, title: 'UYT-9 Fix login', branch: 'kanban/uyt-9-fix' } as never, { repo: 'acme/proj', number: 4 }], tool: 'claude', model: 'claude-opus-5-5[1m]' }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  const task = fx.task(got.taskId);
  assert.equal(task.type, 'investigate');
  assert.equal(task.title, 'PR review: acme/proj#3, acme/proj#4');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.phase, 'pr-review');
  const reviewer = fx.workers.get(got.workerId)!;
  assert.equal(reviewer.kanban?.role, 'reviewer');
  assert.equal(reviewer.model, 'opus', "a full model id passes upstream's spawn as its alias");
  const wt = path.join(fx.dir, reviewer.worktree!.path);
  assert.ok(wt.includes(path.join('.agent-office', 'worktrees')), 'its own worktree, never the floor checkout');

  const done = await fx.waitTask(got.taskId, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  assert.equal(done.reviewerWorkerId, undefined);
  assert.equal(fx.workers.get(got.workerId), undefined, 'the reviewer went home');
  const branchLeft = () => git(fx.dir, 'branch', '--list', 'office/*').includes(path.basename(wt));
  for (let i = 0; i < 100 && (existsSync(wt) || branchLeft()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(wt), 'with its worktree');
  assert.ok(!branchLeft(), 'and its branch');
  assert.equal(done.workspace, undefined, "the reviewer's worktree was never the task's");
  const run = fx.repo.listRuns(got.taskId)[0];
  assert.equal(run.phase, 'pr-review');
  assert.equal(run.verdict, 'approved');
  assert.equal(run.status, 'succeeded');
  const comments = fx.repo.listComments(got.taskId).comments;
  assert.ok(comments.some((c) => c.authorKind === 'agent' && c.kind === 'review' && /fit together/.test(c.text)));
  assert.ok(comments.some((c) => c.kind === 'status' && /Ada asked \w+ to review acme\/proj#3, acme\/proj#4/.test(c.text)));

  const inv = fx.invocations().find((i) => i.kind === 'claude' && promptOf(i) && /Review these pull requests/.test(promptOf(i)!))!;
  assert.ok(inv.cwd.includes(path.join('.agent-office', 'worktrees')), `it ran in its worktree, not ${inv.cwd}`);
  assert.ok(['--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'].every((a) => inv.args.includes(a)));
  assert.equal(inv.args[inv.args.lastIndexOf('--model') + 1], 'claude-opus-5-5[1m]', 'the full id is what runs');
  const prompt = promptOf(inv)!;
  assert.match(prompt, /- acme\/proj#3 “UYT-9 Fix login” \(branch kanban\/uyt-9-fix\) https:\/\/github\.com\/acme\/proj\/pull\/3/);
  assert.ok(prompt.endsWith(KANBAN_CONTRACTS.prReview), 'the PR review contract');
});

test("a pull-request review of a task's bundle runs on that task and leaves its own worktree alone", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'Review these pull requests', reply: 'One problem.\n\nREVIEW: CHANGES_REQUESTED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false, ticket: 'UYT-3' });
  await fx.engine.start(task.id, ADA);
  const before = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  // Its bundle: a PR opened from the task's branch (a PR that isn't the task's makes a review task of its own).
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/proj', number: 5, branch: before.branch } as never], taskId: task.id }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.equal(got.taskId, task.id);
  const own = path.join(fx.dir, fx.workers.get(got.workerId)!.worktree!.path);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length === 2, 'the review column again', 20_000);
  // The reviewer goes home with its own worktree and branch (cleanup all), which git takes a moment to do.
  const branchLeft = () => git(fx.dir, 'branch', '--list', 'office/*').includes(path.basename(own));
  for (let i = 0; i < 100 && (existsSync(own) || branchLeft()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(own), "the reviewer's own worktree went with it");
  assert.deepEqual(done.workspace, before.workspace, "the task's worktree is untouched");
  assert.ok(existsSync(path.join(fx.dir, done.workspace!.worktree.path)));
  assert.equal(done.workerId, before.workerId, 'the implementer stays');
  assert.equal(fx.repo.listRuns(task.id)[1].verdict, 'changes_requested');
  const prompt = promptOf(fx.invocations().find((i) => promptOf(i) && /Review these pull requests/.test(promptOf(i)!))!)!;
  assert.match(prompt, new RegExp(`They are kanban task #${task.id}'s: Fix the login redirect \\(UYT-3\\)`));
  // The request is kept on the task, for a Retry to review the same pull requests again.
  assert.equal(fx.repo.listEvents(task.id).filter((e) => e.kind === 'pr.review').length, 1);
  // Refused for a project that doesn't exist.
  assert.match(String(await fx.engine.reviewPrs({ project: 'nope', prs: [{ repo: 'acme/proj', number: 5 }] }, ADA)), /no project/);
});
