import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type Invocation } from './kanban-engine-fixture.js';

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
  await fx.engine.commented(task.id, comment.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'resume' || x.phase === 'review', 'the resume');
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
