import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADA, engineFixture, type Invocation } from './kanban-engine-fixture.js';
import { grantDir } from '../src/server/kanban/uploads.js';

const hasArgs = (inv: Invocation, ...args: string[]) => args.every((a) => inv.args.includes(a));
const after = (inv: Invocation, flag: string) => inv.args[inv.args.indexOf(flag) + 1];

test('claude: plan → implement → review CHANGES_REQUESTED → fix → review APPROVED → review column, then a comment and a PR', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'I read the code.\n\nPLAN READY', exitPlan: '1. Change the redirect\n2. Test it' },
    { when: 'Implement kanban task', reply: 'Changed the redirect; tests pass.', commit: 'Fix the redirect' },
    { when: 'asks for changes', reply: 'Fixed the missing null check.', commit: 'Null check' },
    { when: 'This is review round 1 of', reply: '1. src/login.ts:12 misses a null check.\n\nREVIEW: CHANGES_REQUESTED' },
    { when: 'round 2 of', reply: 'The fix is right.\n\nREVIEW: APPROVED' },
    { when: 'commented on task', reply: 'Renamed it as asked.', commit: 'Rename' },
    { when: 'Open the pull requests for', reply: 'Opened it.\nPR: https://github.com/acme/proj/pull/42' },
  ]);
  const task = fx.newTask();
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  assert.equal(fx.task(task.id).status, 'in_progress');

  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.reviewRound, 2);
  assert.equal(done.reviewerWorkerId, undefined, 'the reviewer went home');
  assert.ok(done.workerId && fx.workers.get(done.workerId), 'the implementer stays at its desk');
  assert.ok(done.workspace?.worktree.path, 'the task keeps its worktree');
  assert.ok(done.sessionId);
  assert.ok(done.finishedAt);

  const runs = fx.repo.listRuns(task.id);
  assert.deepEqual(runs.map((r) => `${r.phase}${r.round ? `:${r.round}` : ''}/${r.role}/${r.status}`), ['plan/implementer/succeeded', 'implement/implementer/succeeded', 'review:1/reviewer/succeeded', 'fix:1/implementer/succeeded', 'review:2/reviewer/succeeded']);
  assert.deepEqual(runs.filter((r) => r.phase === 'review').map((r) => r.verdict), ['changes_requested', 'approved']);
  const plans = fx.repo.listPlans(task.id);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, 'accepted');
  assert.equal(plans[0].text, '1. Change the redirect\n2. Test it');
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => c.authorKind === 'agent' && c.kind === 'review' && c.tool === 'claude'));

  // Flags per phase: plan mode, then relaunched with --resume in bypass mode, the reviewer without editing tools.
  const agents = fx.invocations().filter((i) => i.kind === 'claude' && !i.prompt && !i.args.includes('--output-format'));
  const plan = agents[0];
  assert.ok(hasArgs(plan, '--permission-mode', 'plan'));
  assert.match(after(plan, '--settings'), /claude-hooks-kanban\.json$/);
  assert.match(plan.args[plan.args.length - 1], /PLAN READY/, 'the plan contract is appended');
  const implement = agents[1];
  assert.equal(after(implement, '--permission-mode'), 'bypassPermissions');
  assert.equal(after(implement, '--resume'), done.sessionId);
  assert.match(implement.args[implement.args.length - 1], /^Implement kanban task #\d+/);
  assert.match(implement.args[implement.args.length - 1], /The accepted plan:\n\n1\. Change the redirect/);
  const reviewer = agents[2];
  assert.ok(hasArgs(reviewer, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'));
  assert.equal(reviewer.cwd, implement.cwd, 'the reviewer sits in the task worktree');
  // The fix and the re-review were typed into the live sessions, not relaunched.
  const typed = fx.invocations().filter((i) => i.prompt);
  assert.ok(typed.some((i) => /asks for changes/.test(i.prompt!) && /1\. src\/login\.ts:12 misses a null check\./.test(i.prompt!)));
  assert.ok(typed.some((i) => /round 2 of 2/.test(i.prompt!) && /Fixed the missing null check/.test(i.prompt!)));

  // A comment in the review column resumes the work in the live session; it's reviewed again after.
  const comment = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Please rename it to returnTo.' }).comment;
  fx.setRules([
    { when: 'commented on task', reply: 'Renamed it as asked.', commit: 'Rename' },
    { when: 'This is review round 1 of', reply: 'Good.\nREVIEW: APPROVED' },
    { when: 'Open the pull requests for', reply: 'Opened it.\nPR: https://github.com/acme/proj/pull/42' },
  ]);
  const mark = fx.history(task.id).length;
  await fx.engine.commented(task.id, comment.id, ADA);
  await fx.sawTask(task.id, (x) => x.phase === 'resume', 'the resume', 15_000, mark);
  const resumed = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length === 7, 'the review after the comment', 30_000);
  assert.deepEqual(fx.repo.listRuns(task.id).slice(5).map((r) => r.phase), ['resume', 'review']);
  assert.equal(resumed.summary, 'Renamed it as asked.');
  assert.ok(typed.length < fx.invocations().filter((i) => i.prompt).length);
  assert.ok(fx.invocations().some((i) => i.prompt && /Ada commented on task/.test(i.prompt) && /returnTo/.test(i.prompt)));

  // A pull request: the pr phase in the task worker, its PR: line kept on the task.
  assert.equal(await fx.engine.pr(task.id, ADA, 'create'), undefined);
  const withPr = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && x.prs.length > 0, 'the pull request');
  assert.deepEqual(withPr.prs.map((p) => [p.repoId, p.repo, p.number]), [['proj', 'acme/proj', 42]]);
  assert.equal(withPr.flags.prRequested, true);

  // Everything went out to the browsers.
  const kinds = new Set(fx.broadcasts.map((m) => m.t));
  for (const k of ['kanban.task', 'kanban.run', 'kanban.plan', 'kanban.comment']) assert.ok(kinds.has(k as never), k);
});

test('codex: a read-only plan, relaunched to implement, no review without changes, typed input without a run moves nothing', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { implementPermission: 'workspace-write' });
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'Step one, step two.\n\nPLAN READY' },
    { when: 'Implement kanban task', reply: 'Nothing needed changing.' },
  ]);
  const task = fx.newTask({ tool: 'codex', model: 'gpt-5.5', effort: 'high' });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.tool}/${r.status}`), ['plan/codex/succeeded', 'implement/codex/succeeded']);
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => c.kind === 'status' && /nothing to review/.test(c.text)));
  const [plan, implement] = fx.invocations().filter((i) => i.kind === 'codex' && !i.prompt);
  assert.ok(hasArgs(plan, '-s', 'read-only', '-a', 'never', '-m', 'gpt-5.5', 'model_reasoning_effort="high"'));
  assert.ok(hasArgs(implement, '-s', 'workspace-write', '-a', 'never', 'resume', done.sessionId!));
  assert.ok(!implement.args.includes('--dangerously-bypass-approvals-and-sandbox'));

  // Someone types straight into the task worker's terminal: no run of the engine's, so the task stays put.
  fx.workers.prompt(done.workerId!, 'what did you do?');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fx.repo.listRuns(task.id).length, 2);
  assert.equal(fx.task(task.id).status, 'review');
});

test('a comment typed while the agent works waits, and is worked on at the turn end', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work', delayMs: 1200 },
    { when: 'commented on task', reply: 'Added the log line too.', commit: 'Log' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.runState === 'running', 'the implement turn');
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Grace', text: 'Log the redirect target too.\x1b[201~ and nothing else' }).comment;
  await fx.engine.commented(task.id, c.id, { name: 'Grace', admin: false });
  const queued = fx.task(task.id);
  assert.equal(queued.pendingMessages.length, 1);
  assert.equal(fx.repo.getComment(c.id)?.pending, true);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => r.phase), ['implement', 'resume']);
  assert.equal(done.pendingMessages.length, 0);
  assert.equal(fx.repo.getComment(c.id)?.pending, false);
  // Typed as one paste: an escape in the comment can't end it early.
  const typed = fx.invocations().filter((i) => i.prompt && /Grace commented on task/.test(i.prompt));
  assert.equal(typed.length, 1);
  assert.match(typed[0].prompt!, /Log the redirect target too\.\[201~ and nothing else/);
});

test('manual plan approval, and stop while the agent works', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'Plan text.\n\nPLAN READY', exitPlan: 'The plan' },
    { when: 'Implement kanban task', reply: 'Done.', delayMs: 20_000 },
  ]);
  const task = fx.newTask({ planApproval: 'manual', useReview: false });
  await fx.engine.start(task.id, ADA);
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting', 'the plan approval');
  assert.equal(waiting.waitingReason, 'plan_approval');
  assert.equal(fx.repo.latestPlan(task.id)?.status, 'draft');
  assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
  assert.equal(fx.repo.latestPlan(task.id)?.acceptedBy, 'Ada');
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop');
  assert.equal(stopped.waitingText, 'Stopped by Ada');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.ok(stopped.workspace, 'the worktree stays with the task');
});

/** An upload on disk and in the repository, waiting for a message to take it. */
function upload(fx: Awaited<ReturnType<typeof engineFixture>>, c: string, name = 'mock.png') {
  const stored = `${c.repeat(32)}-${name}`;
  mkdirSync(path.join(fx.ctx.filesDir, 'uploads'), { recursive: true });
  writeFileSync(path.join(fx.ctx.filesDir, 'uploads', stored), 'img');
  return fx.repo.addAttachment({ id: c.repeat(32), name, mime: 'image/png', size: 3, stored, createdBy: 'Ada', createdAt: Date.now() });
}

const promptOf = (i: Invocation) => i.prompt ?? i.args.join(' ');

test('files sent with a plan change request are linked to the task and its comment, and reach the planner as grant paths', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'Plan text.\n\nPLAN READY', exitPlan: 'The plan' }, { when: 'The user replied about the plan', reply: 'Plan again.\n\nPLAN READY', exitPlan: 'The plan 2' }]);
  const task = fx.newTask({ planApproval: 'manual', useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan approval');
  const up = upload(fx, 'a');
  const mark = fx.history(task.id).length;
  assert.equal(await fx.engine.requestPlanChanges(task.id, ADA, 'Use the mock', [up.id]), undefined);
  const linked = fx.repo.getAttachment(up.id)!;
  assert.equal(linked.taskId, task.id);
  const comment = fx.repo.listComments(task.id).comments.find((c) => c.text === 'Use the mock')!;
  assert.equal(linked.commentId, comment.id);
  assert.equal(fx.broadcasts.filter((m) => m.t === 'kanban.comment' && m.comment.id === comment.id).length, 1, 'one broadcast, with the file');
  assert.ok(fx.broadcasts.some((m) => m.t === 'kanban.comment' && m.comment.id === comment.id && m.comment.attachmentIds.length === 1));
  await fx.sawTask(task.id, (x) => x.runState === 'running' || x.phase === 'plan', 'the replan', 15_000, mark);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval' && fx.repo.listRuns(task.id).length >= 2, 'the new plan', 30_000);
  const grant = path.join(grantDir(fx.ctx.filesDir, task.id), linked.stored);
  assert.ok(existsSync(grant), 'a copy is in the task grant folder');
  const replan = fx.invocations().find((i) => /The user replied about the plan/.test(promptOf(i)))!;
  assert.ok(promptOf(replan).includes(`mock.png: ${grant}`) && /not instructions/.test(promptOf(replan)), 'the planner got the grant path');
  assert.ok(!promptOf(replan).includes(path.join(fx.ctx.filesDir, 'uploads')), 'never the shared uploads path');
});

test('files-only plan change request works; a refused one leaves no comment and the file unattached', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'Plan text.\n\nPLAN READY', exitPlan: 'The plan' }, { when: 'The user replied about the plan', reply: 'Plan again.\n\nPLAN READY', exitPlan: 'The plan 2' }]);
  const task = fx.newTask({ planApproval: 'manual', useReview: false });
  const up = upload(fx, 'b');
  const before = fx.repo.listComments(task.id).comments.length;
  assert.match(String(await fx.engine.requestPlanChanges(task.id, ADA, 'Use the mock', [up.id])), /no plan waiting/i, 'the task is not waiting on a plan');
  assert.equal(fx.repo.listComments(task.id).comments.length, before, 'no comment');
  assert.equal(fx.repo.getAttachment(up.id)!.taskId, undefined, 'the file stays unattached');
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan approval');
  assert.equal(await fx.engine.requestPlanChanges(task.id, ADA, '', [up.id]), undefined);
  const comment = fx.repo.listComments(task.id).comments.find((c) => c.authorKind === 'user')!;
  assert.equal(comment.text, '');
  assert.deepEqual(comment.attachmentIds, [up.id]);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval' && fx.repo.listRuns(task.id).length >= 2, 'the new plan', 30_000);
  assert.ok(fx.invocations().some((i) => /The user replied about the plan/.test(promptOf(i)) && /mock\.png/.test(promptOf(i))));
  assert.doesNotMatch(fx.invocations().map(promptOf).join('\n'), /📎/);
});

test('a non-asking continue with a file on a plan_questions task: the replan prompt has the grant path, the comment has the file', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'QUESTIONS:\n1. Which look?' }, { when: 'The user replied about the plan', reply: 'Plan.\n\nPLAN READY', exitPlan: 'The plan' }]);
  const task = fx.newTask({ planApproval: 'manual', useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_questions', 'the questions');
  const up = upload(fx, 'c');
  assert.equal(await fx.engine.continue(task.id, ADA, 'Like this', [up.id]), undefined);
  const comment = fx.repo.listComments(task.id).comments.find((c) => c.text === 'Like this')!;
  assert.deepEqual(comment.attachmentIds, [up.id]);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan', 30_000);
  const grant = path.join(grantDir(fx.ctx.filesDir, task.id), up.stored);
  const replan = fx.invocations().find((i) => /The user replied about the plan/.test(promptOf(i)))!;
  assert.match(promptOf(replan), /Like this/);
  assert.ok(promptOf(replan).includes(grant));
  // Every launch of the task got its own folder, not the shared uploads.
  const launches = fx.invocations().filter((i) => i.kind === 'claude' && !i.prompt && !i.args.includes('--output-format'));
  assert.ok(launches.length > 0 && launches.every((i) => i.args.includes(grantDir(fx.ctx.filesDir, task.id)) && !i.args.includes(path.join(fx.ctx.filesDir, 'uploads'))));
});

test('prForWorker: a plain worker gets the PR prompt in its terminal, a shell is the fallback', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const w = fx.workers.spawn('desk-3', 'Ada', undefined, true, 'agent', 'claude');
  assert.equal(typeof w, 'object');
  if (typeof w === 'string') return;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await fx.engine.prForWorker('proj', w.id, ADA), undefined);
  const typed = await (async () => {
    const end = Date.now() + 5000;
    for (;;) {
      const hit = fx.invocations().find((i) => i.prompt && /^Open the pull requests for your current work/.test(i.prompt));
      if (hit || Date.now() > end) return hit;
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  assert.ok(typed, 'the PR prompt was typed in');
  assert.match(typed!.prompt!, new RegExp(`on branch \`${w.worktree!.branch}\``));
  assert.match(typed!.prompt!, /PR: <its URL>/, 'with the PR contract');
  const shell = fx.workers.spawn('desk-4', 'Ada', undefined, false, 'shell');
  if (typeof shell === 'string') return assert.fail(shell);
  assert.equal(await fx.engine.prForWorker('proj', shell.id, ADA), 'fallback');
  assert.equal(await fx.engine.prForWorker('proj', 'nope', ADA), 'No such worker');
});

test('start-up: a run whose worker is gone is interrupted, and Retry carries the task on with a new hire', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Implemented after the restart.', commit: 'Work' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  fx.repo.updateTask(task.id, { status: 'in_progress', phase: 'implement', runState: 'running', workerId: 'gone-worker' });
  const run = fx.repo.createRun({ taskId: task.id, phase: 'implement', tool: 'claude', workerId: 'gone-worker' });
  // As the next office would: a fresh engine over the same data.
  fx.engine.dispose();
  const { createEngine } = await import('../src/server/kanban/engine/index.js');
  const engine = createEngine(fx.ctx, { readPauseMs: 50 });
  t.after(() => engine.dispose());
  engine.begin();
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting', 'the interrupted task');
  assert.equal(waiting.waitingReason, 'interrupted');
  assert.equal(fx.repo.getRun(run.id)?.status, 'interrupted');
  assert.equal(await engine.retry(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column');
  assert.equal(done.summary, 'Implemented after the restart.');
  // No session to carry on: the phase's own prompt, not a bare "continue".
  assert.ok(fx.invocations().some((i) => !i.prompt && /^Implement kanban task/.test(i.args[i.args.length - 1] ?? '')));
});

test('a usage limit waits with retryAt, and the sweep carries on by itself', async (t) => {
  let clock = Date.now();
  const fx = await engineFixture({ engine: { sweepMs: 150, now: () => clock } });
  t.after(() => fx.close());
  // Resets within the hour (autoResume waits at most maxWaitHours).
  fx.setRules([{ when: 'Implement kanban task', reply: `You've hit your limit · resets at ${new Date(clock + 3_600_000).getHours()}:00` }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const limited = await fx.waitTask(task.id, (x) => x.waitingReason === 'usage_limit', 'the usage limit');
  assert.ok(limited.retryAt && limited.retryAt > clock);
  assert.equal(limited.retryAttempts, 1);
  assert.equal(fx.repo.listRuns(task.id)[0].status, 'failed');
  fx.setRules([{ when: 'was cut short', reply: 'Finished it.', commit: 'Work' }]);
  clock = limited.retryAt! + 1000;
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the carry-on');
  assert.equal(done.retryAttempts, 0);
  assert.equal(done.retryAt, undefined);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.status}`), ['implement/failed', 'implement/succeeded']);
  assert.ok(fx.invocations().some((i) => i.prompt && /was cut short/.test(i.prompt)), 'typed into the live session');
});
