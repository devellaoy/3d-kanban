import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { floorPulled } from '../src/server/kanban/integrations/pulls/board.js';
import type { GhPull } from '../src/shared/protocol.js';
import type { KanbanTask } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, makeRepo, type Invocation } from './kanban-engine-fixture.js';
import { readClaudeTurn } from '../src/server/kanban/engine/adapters/claude.js';
import { grantDir } from '../src/server/kanban/uploads.js';

const hasArgs = (inv: Invocation, ...args: string[]) => args.every((a) => inv.args.includes(a));
/** Polls until `pred` holds (what the test stands waiting for), failing with `what` after `timeout` ms. */
async function waitFor(pred: () => boolean, what: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  assert.ok(pred(), `timed out waiting for ${what}`);
}
/** Waits until the agent has launched its helper (its log shows it, so its prompt was submitted and the worker works), its first Stop is heard (the worker no longer works) and the engine has looked at it: a release probe goes through the task's serial queue behind the engine's read of the turn's end (and does nothing to a task in progress), so the run is then held for the helper. */
async function holdsForHelper(fx: Awaited<ReturnType<typeof engineFixture>>, taskId: number, workerId: string): Promise<void> {
  await waitFor(() => !!readClaudeTurn(fx.workers.transcripts(workerId)?.claude ?? '')?.background, "the agent's helper to be launched");
  await waitFor(() => fx.workers.get(workerId)?.status !== 'working', "the agent's first Stop");
  await fx.engine.releaseIdle(taskId, ADA);
}
/** Counts the SessionStart hooks (a resumed process starting) heard of a worker from now on. */
function sessionStarts(fx: Awaited<ReturnType<typeof engineFixture>>, workerId: string): () => number {
  let n = 0;
  fx.workers.addObserver((o) => void (o.workerId === workerId && o.event === 'hook' && o.hookEvent === 'SessionStart' && (o.payload as { source?: string } | undefined)?.source === 'resume' && n++));
  return () => n;
}
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

test('start-up: a compact left by an older office is dropped, the task rests where it was and no compact prompt is ever composed', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const queued = fx.newTask({ usePlan: false, useReview: false });
  fx.repo.updateTask(queued.id, { status: 'review', phase: 'compact', runState: 'queued', queuedRun: { phase: 'compact', role: 'implementer', prompt: 'compact' } });
  const running = fx.newTask({ usePlan: false, useReview: false });
  fx.repo.updateTask(running.id, { status: 'waiting', waitingReason: 'failed', waitingText: 'Boom', phase: 'compact', runState: 'running', workerId: 'gone-worker' });
  const run = fx.repo.createRun({ taskId: running.id, phase: 'compact', tool: 'claude', workerId: 'gone-worker' });
  fx.engine.dispose();
  const { createEngine } = await import('../src/server/kanban/engine/index.js');
  const engine = createEngine(fx.ctx, { readPauseMs: 50 });
  t.after(() => engine.dispose());
  engine.begin();
  const q = await fx.waitTask(queued.id, (x) => x.runState === 'idle', 'the queued compact dropped');
  assert.equal(q.status, 'review', 'its column is kept');
  assert.equal(q.queuedRun, undefined);
  const r = await fx.waitTask(running.id, (x) => x.runState === 'idle', 'the running compact dropped');
  assert.equal(r.status, 'waiting');
  assert.equal(r.waitingReason, 'failed', 'a compact never moved its task');
  assert.equal(fx.repo.getRun(run.id)?.status, 'interrupted');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(fx.invocations().length, 0, 'nothing was hired or typed for either');
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

test('a Codex usage limit resumes at the reset time its account reports, plus a minute', async (t) => {
  const clock = Date.now();
  const fx = await engineFixture({ engine: { sweepMs: 10_000, now: () => clock } });
  t.after(() => fx.close());
  const resetAt = clock + 30 * 60_000;
  let asked = 0;
  fx.ctx.codexResetAt = async () => {
    asked++;
    return resetAt;
  };
  fx.setRules([{ when: 'Implement kanban task', reply: "You've hit your usage limit. Try again later." }]);
  const task = fx.newTask({ tool: 'codex', usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const limited = await fx.waitTask(task.id, (x) => x.waitingReason === 'usage_limit', 'the usage limit');
  assert.equal(limited.retryAt, resetAt + 60_000);
  assert.equal(asked, 1);
});

test('a used-up Codex week (reset days away, beyond autoResume\'s wait) gives up at once and names the reset time', async (t) => {
  const clock = Date.now();
  const fx = await engineFixture({ engine: { sweepMs: 10_000, now: () => clock } });
  t.after(() => fx.close());
  const resetAt = clock + 7 * 24 * 3_600_000;
  fx.ctx.codexResetAt = async () => resetAt;
  fx.setRules([{ when: 'Implement kanban task', reply: "You've hit your usage limit. Try again later." }]);
  const task = fx.newTask({ tool: 'codex', usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const gaveUp = await fx.waitTask(task.id, (x) => x.waitingReason === 'interrupted' || (x.status === 'waiting' && x.retryAt === undefined && !!x.waitingText), 'the give-up');
  assert.equal(gaveUp.retryAt, undefined);
  assert.ok(gaveUp.waitingText?.includes(new Date(resetAt).toLocaleString('en-GB')), gaveUp.waitingText);
});

test('a Codex run that only lost its connection never asks the account for a reset time', async (t) => {
  const clock = Date.now();
  const fx = await engineFixture({ engine: { sweepMs: 10_000, now: () => clock } });
  t.after(() => fx.close());
  let asked = 0;
  fx.ctx.codexResetAt = async () => (asked++, clock + 60_000);
  fx.setRules([{ when: 'Implement kanban task', reply: 'stream disconnected before completion: fetch failed' }]);
  const task = fx.newTask({ tool: 'codex', usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const limited = await fx.waitTask(task.id, (x) => x.waitingReason === 'usage_limit', 'the interruption');
  assert.equal(asked, 0);
  assert.equal(limited.retryAt, clock + 5 * 60_000);
});

test('a Codex usage limit with no reset time known (or a failing lookup) backs off; a Claude one never asks Codex', async (t) => {
  const clock = Date.now();
  const fx = await engineFixture({ engine: { sweepMs: 10_000, now: () => clock } });
  t.after(() => fx.close());
  let asked = 0;
  fx.ctx.codexResetAt = async () => {
    asked++;
    return undefined;
  };
  fx.setRules([{ when: 'Implement kanban task', reply: "You've hit your usage limit. Try again later." }]);
  const a = fx.newTask({ tool: 'codex', usePlan: false, useReview: false });
  await fx.engine.start(a.id, ADA);
  const limitedA = await fx.waitTask(a.id, (x) => x.waitingReason === 'usage_limit', 'the codex usage limit');
  assert.equal(limitedA.retryAt, clock + 5 * 60_000, 'the first backoff step');
  fx.ctx.codexResetAt = async () => {
    throw new Error('app-server is gone');
  };
  const b = fx.newTask({ tool: 'codex', usePlan: false, useReview: false });
  await fx.engine.start(b.id, ADA);
  const limitedB = await fx.waitTask(b.id, (x) => x.waitingReason === 'usage_limit', 'the failing lookup');
  assert.equal(limitedB.retryAt, clock + 5 * 60_000);
  fx.ctx.codexResetAt = async () => {
    asked++;
    return clock + 1_800_000;
  };
  const askedBefore = asked;
  const c = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(c.id, ADA);
  await fx.waitTask(c.id, (x) => x.waitingReason === 'usage_limit', 'the claude usage limit');
  assert.equal(asked, askedBefore, 'Codex is not asked about a Claude run');
});

test('a pr turn: PR: lines link their own repositories’ PRs nobody has; any other PR the board links by branch after the refresh', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'Read it.\n\nPLAN READY', exitPlan: '1. Do it' },
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Do it' },
    { when: 'This is review round 1 of', reply: 'Good.\nREVIEW: APPROVED' },
    { when: 'Open the pull requests for', reply: 'Opened [#7](https://github.com/acme/proj/pull/7).' },
  ]);
  const task = fx.newTask();
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  // The pulls plugin on the fixture's context, and a stand-in for the floor's board: refresh() brings its list, as the real one does.
  const parts = createPullsParts(fx.ctx, { gh: async (args) => (args[0] === 'repo' ? 'main' : '{"isCrossRepository":false}') });
  parts.plugin.start!();
  t.after(() => parts.plugin.stop!());
  let items: object[] = [];
  const asked: string[] = [];
  (fx.ctx.floor('proj') as unknown as { githubFor: unknown }).githubFor = (remote: string) => ({
    refresh: async () => {
      asked.push(remote);
      floorPulled({ id: 'proj', pullsState: () => ({ items: items as GhPull[], fetchedAt: 1, loading: false }) });
    },
  });
  const pr = async (expectLinks: (x: KanbanTask) => boolean, what: string) => {
    assert.equal(await fx.engine.pr(task.id, ADA, 'create'), undefined);
    return fx.waitTask(task.id, (x) => x.runState === 'idle' && expectLinks(x), what);
  };
  await pr((x) => x.flags.prRequested === true, 'the first pr turn');
  assert.deepEqual(fx.task(task.id).prs, [], 'a Markdown link is no PR: line, and the board did not list it yet');
  assert.deepEqual(asked, ['acme/proj'], 'but the board was asked to look now');

  // The board lists #7 from the task's branch: its sync links it, with an event.
  items = [{ number: 7, title: 'PR', url: 'https://github.com/acme/proj/pull/7', state: 'OPEN', isDraft: false, headRefName: fx.task(task.id).branch, createdAt: new Date(Date.now() + 60_000).toISOString(), repo: 'acme/proj' }];
  const linked = await pr((x) => x.prs.length > 0, 'the link by branch');
  assert.deepEqual(linked.prs.map((p) => [p.repoId, p.repo, p.number]), [['proj', 'acme/proj', 7]]);
  assert.deepEqual(fx.repo.listEvents(task.id).filter((e) => e.kind === 'pr.linked').map((e) => e.data), [{ repo: 'acme/proj', number: 7, by: 'branch' }]);

  // PR: lines: a bold bulleted Markdown link links; another repository's PR and another task's PR (linked by repoId only) do not.
  const other = fx.newTask();
  fx.repo.upsertPrLink(other.id, { repoId: 'proj', number: 9, url: 'https://github.com/acme/proj/pull/9', state: 'OPEN' });
  items = [];
  fx.setRules([{ when: 'Open the pull requests for', reply: '- **PR:** [#8](https://github.com/acme/proj/pull/8)\nPR: https://github.com/other/x/pull/1\nPR: https://github.com/acme/proj/pull/9' }]);
  const done = await pr((x) => x.prs.length > 1, 'the PR: lines');
  assert.deepEqual(done.prs.map((p) => p.number).sort(), [7, 8], 'not other/x#1, not the other task’s #9');
  assert.deepEqual(fx.task(other.id).prs.map((p) => p.number), [9]);
});

test('a turn that ends on background agents is not the run\'s end: the task waits for the agent\'s own Stop', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'The helper agent is at it; I will wait for it to finish.', reply: 'Changed the redirect; tests pass.', commit: 'Work', backgroundMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  // The first Stop has come (the interim text is in the log) and the task is still at work.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 15_000);
  assert.equal(done.summary, 'Changed the redirect; tests pass.');
  const results = fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result');
  assert.deepEqual(results.map((c) => c.text), ['Changed the redirect; tests pass.']);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
});

test('a turn that ends on a background command (a test suite) is not the run\'s end: no result, no review until the command is done', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', background: 'Waiting for the full suite.', backgroundCommand: true, reply: 'Changed the redirect; the full suite passes.', commit: 'Work', backgroundMs: 1500 },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  // The first Stop has come (the interim text is in the log): no result, no review round, still at work.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  assert.deepEqual(fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result'), []);
  assert.equal(reviewRuns(fx, task.id), 0);
  // The notification and the second Stop: the result is the second turn's text, and the review starts.
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review round after the command', 30_000);
  const results = fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result');
  assert.equal(results[0]?.text, 'Changed the redirect; the full suite passes.');
  assert.equal(fx.task(task.id).reviewRound, 1);
});

test('a prompt typed into the terminal while a background agent works does not hide it: its Stop is not the run\'s end, review waits for the agent', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const release = path.join(fx.root, 'release-helper');
  fx.setRules([
    { when: 'Implement kanban task', background: 'Waiting for the helper agent.', typedPrompt: 'How is it going?', reply: 'Changed the redirect; tests pass.', commit: 'Work', releaseFile: release },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  // The typed prompt's own Stop has come (the helper works until the test releases it): the run goes on, no result, no review.
  const logs = path.join(fx.root, 'transcripts');
  const typedLogged = () => readdirSync(logs).some((f) => f.endsWith('.jsonl') && readFileSync(path.join(logs, f), 'utf8').includes('Answered what you typed.'));
  for (const until = Date.now() + 20_000; !typedLogged(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > until) assert.fail('the typed prompt was never answered');
  // Time for the engine to read that Stop's log (readTries × readPauseMs); the helper is held meanwhile, so waiting longer is safe.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  assert.deepEqual(fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result'), []);
  assert.equal(reviewRuns(fx, task.id), 0);
  writeFileSync(release, '');
  // The helper is done and the final Stop comes: the result is that turn's text, and the review starts.
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review round after the helper', 30_000);
  const results = fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result');
  assert.equal(results[0]?.text, 'Changed the redirect; tests pass.');
});

test('a prompt typed into the terminal that the background agent\'s end came in is not the run\'s answer: the agent is asked to restate it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const release = path.join(fx.root, 'release-helper');
  fx.setRules([
    { when: 'Implement kanban task', background: 'Waiting for the helper agent.', typedPrompt: 'How is it going?', typedTakesNotice: true, releaseFile: release, commit: 'Work' },
    { when: 'Someone typed into your terminal', reply: 'Changed the redirect; tests pass.' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  writeFileSync(release, '');
  // The helper's end came inside the typed turn: that turn's reply ("Answered what you typed.") isn't the run's answer, so the agent is asked for it again.
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review round after the restated answer', 30_000);
  assert.ok(fx.invocations().some((i) => i.prompt && /Someone typed into your terminal/.test(i.prompt)));
  const results = fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result');
  assert.equal(results[0]?.text, 'Changed the redirect; tests pass.');
  assert.ok(!results.some((c) => c.text === 'Answered what you typed.'));
});

test('an office restart while the run is held keeps the typed-prompt protection: the agent is still asked to restate', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const release = path.join(fx.root, 'release-helper');
  fx.setRules([
    { when: 'Implement kanban task', background: 'Waiting for the helper agent.', typedPrompt: 'How is it going?', typedTakesNotice: true, releaseFile: release, commit: 'Work' },
    { when: 'Someone typed into your terminal', reply: 'Changed the redirect; tests pass.' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await holdsForHelper(fx, task.id, fx.repo.activeRun(task.id)!.workerId!);
  assert.ok(fx.repo.activeRun(task.id)?.promptedAt, 'the office kept when it prompted the run');
  fx.restartEngine();
  writeFileSync(release, '');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review round after the restated answer', 30_000);
  assert.ok(fx.invocations().some((i) => i.prompt && /Someone typed into your terminal/.test(i.prompt)));
  const results = fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result');
  assert.equal(results[0]?.text, 'Changed the redirect; tests pass.');
});

test('a prompt typed after the office\'s Stop but before its answer reached the log: the review keeps its verdict by restating it', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { review: { tool: 'claude', rounds: 1 } });
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'This is review round 1 of', earlier: 'Reading the diff.', reply: 'unused', lateLogMs: -1, typedAfterStop: 'How is it going?', typedMs: 1500 },
    { when: 'Someone typed into your terminal', reply: 'No findings.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.verdict ?? '-'}`), ['implement/-', 'review/approved']);
  assert.ok(fx.invocations().some((i) => i.prompt && /Someone typed into your terminal/.test(i.prompt)));
  assert.equal(fx.repo.listComments(task.id).comments.find((c) => c.kind === 'review')?.text, 'No findings.\n\nREVIEW: APPROVED');
});

test('a held run whose helper\'s report turn has no answer in the log yet, with a prompt typed right after it, restates the answer', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'unused', lateLogMs: -1, typedAfterStop: 'How is it going?', typedMs: 1500, commit: 'Work' },
    { when: 'Someone typed into your terminal', reply: 'Changed the redirect; tests pass.' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) >= 1, 'the review round after the restated answer', 40_000);
  assert.ok(fx.invocations().some((i) => i.prompt && /Someone typed into your terminal/.test(i.prompt)));
  assert.equal(fx.repo.listComments(task.id).comments.find((c) => c.kind === 'result')?.text, 'Changed the redirect; tests pass.');
});

test('a plan asked for in a prompt typed after a tool-only planning turn is stored as the plan', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', earlier: ' ', reply: 'unused', lateLogMs: -1, typedAfterStop: 'Make a plan', typedMs: 800, typedExitPlan: '1. Change the redirect\n2. Test it' }]);
  const task = fx.newTask({ planApproval: 'manual' });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan approval', 30_000);
  const plans = fx.repo.listPlans(task.id);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, '1. Change the redirect\n2. Test it');
  assert.equal(fx.repo.listRuns(task.id)[0].status, 'succeeded');
});

test('a stop the agent never confirms (no Stop after Esc) restarts the worker on its session at its desk, never sends it home; Continue prompts the same worker', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', delayMs: 30_000, escSilent: true },
    { when: 'Carry on please', reply: 'Carried on.' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  const workerId = running.workerId!;
  await waitFor(() => fx.invocations().some((i) => /Implement kanban task/.test(i.prompt ?? '')), 'the agent to have the implement prompt');
  const launches = () => fx.invocations().filter((i) => i.kind === 'claude' && !i.prompt && !i.interrupted && !i.args.includes('--output-format'));
  const before = launches().length;
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 10_000);
  assert.equal(fx.invocations().some((i) => i.interrupted), true, 'Esc was typed');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.ok(fx.workers.get(workerId), 'the same worker is still at its desk');
  assert.equal(stopped.workerId, workerId);
  assert.ok(stopped.workspace, 'the worktree stays with the task');
  await waitFor(() => launches().length === before + 1, 'the worker to be relaunched');
  const after = launches();
  assert.equal(after.length, before + 1, 'the worker was relaunched');
  assert.ok(after.at(-1)!.args.includes('--resume'), 'on its session');
  assert.ok(fx.workers.get(workerId), 'still there after the restart');
  await waitFor(() => fx.repo.listComments(task.id).comments.some((c) => c.kind === 'status' && /restarted on its session at its desk/.test(c.text)), 'the note');
  assert.equal(await fx.engine.continue(task.id, ADA, 'Carry on please'), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' || x.status === 'done' || x.runState === 'idle', 'the carried-on turn', 8000);
  assert.equal(done.workerId, workerId, 'the same worker took it');
  assert.ok(fx.invocations().some((i) => /Carry on please/.test(i.prompt ?? '')));
});

test('stop while the turn waits on background agents restarts the worker at its desk (ending its helpers), the worktree stays', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'Done.', backgroundMs: 20_000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await holdsForHelper(fx, task.id, running.workerId!);
  assert.equal(fx.task(task.id).status, 'in_progress', 'the first Stop did not move it');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 5000);
  assert.equal(stopped.waitingText, 'Stopped by Ada');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.ok(running.workerId && fx.workers.get(running.workerId), 'the worker is still at its desk');
  assert.equal(stopped.workerId, running.workerId);
  assert.ok(stopped.workspace && existsSync(path.join(fx.dir, stopped.workspace.worktree.path)), 'the worktree stays with the task');
  assert.equal(fx.invocations().some((i) => i.interrupted), false, 'no Esc was typed');
  await waitFor(() => fx.repo.listComments(task.id).comments.some((c) => c.kind === 'status' && /background agents worked: restarted on its session at its desk/.test(c.text)), 'the note');
  await waitFor(() => fx.invocations().some((i) => i.args.includes('--resume') && !i.prompt), 'the relaunch');
  fx.setRules([{ when: 'Carry on please', reply: 'Carried on.' }]);
  // Not awaited: Continue would wait for the (killed) helpers up to busyWaitMs if it counted them.
  const continued = fx.engine.continue(task.id, ADA, 'Carry on please');
  await waitFor(() => fx.invocations().some((i) => /Carry on please/.test(i.prompt ?? '')), 'the same worker to be prompted promptly, not after the old background wait', 6000);
  assert.equal(await continued, undefined);
  await fx.waitTask(task.id, (x) => x.status !== 'waiting' && x.runState === 'idle' || x.status === 'review' || x.status === 'done', 'the carried-on turn', 8000);
  assert.equal(fx.task(task.id).workerId, running.workerId);
});

test('a stop only the transcript confirms (Esc logged as an interrupt, no Stop hook, no rest) ends the turn: stopped, the worker rests, no restart', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', delayMs: 30_000, escSilent: true, escLogs: true }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  const workerId = running.workerId!;
  await waitFor(() => fx.invocations().some((i) => /Implement kanban task/.test(i.prompt ?? '')), 'the agent to have the implement prompt');
  const launches = () => fx.invocations().filter((i) => i.kind === 'claude' && !i.prompt && !i.interrupted && !i.args.includes('--output-format')).length;
  const before = launches();
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 10_000);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.equal(fx.workers.get(workerId)?.status, 'done', 'the worker rests at its desk');
  assert.equal(stopped.workerId, workerId);
  await new Promise((r) => setTimeout(r, 300)); // a relaunch, if one were wrongly made, would show by now
  assert.equal(launches(), before, 'no relaunch');
  assert.equal(fx.repo.listComments(task.id).comments.some((c) => c.kind === 'status' && /restarted|didn't stop/.test(c.text)), false, 'no restart note');
});

test('a Stop hook just before the grace ends the stop by itself: no relaunch, no "didn\'t stop" note', async (t) => {
  const fx = await engineFixture({ engine: { stopGraceMs: 1500 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Done.', delayMs: 30_000, escSilent: true, escStopMs: 1100 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await waitFor(() => fx.invocations().some((i) => /Implement kanban task/.test(i.prompt ?? '')), 'the agent to have the implement prompt');
  const launches = () => fx.invocations().filter((i) => i.kind === 'claude' && !i.prompt && !i.interrupted && !i.args.includes('--output-format')).length;
  const before = launches();
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 10_000);
  await new Promise((r) => setTimeout(r, 1000)); // past the grace, when the timer would have fired
  assert.equal(launches(), before, 'no relaunch');
  assert.equal(fx.repo.listComments(task.id).comments.some((c) => c.kind === 'status' && /restarted|didn't stop/.test(c.text)), false, 'no note');
});

test('Continue after an office restart prompts the restarted worker promptly: its old process\'s helpers are not counted', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'Done.', backgroundMs: 40_000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await holdsForHelper(fx, task.id, running.workerId!);
  const starts = sessionStarts(fx, running.workerId!);
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 5000);
  await waitFor(() => fx.repo.listComments(task.id).comments.some((c) => c.kind === 'status' && /restarted on its session at its desk/.test(c.text)), 'the note');
  // The relaunched process has started and its SessionStart is heard (by the old engine); then the office restarts: what
  // the engine knew of the new process (when it started) is gone, and no new SessionStart comes for an adopted PTY.
  await waitFor(() => starts() === 1, "the relaunched process's SessionStart");
  fx.restartEngine();
  fx.setRules([{ when: 'Carry on please', reply: 'Carried on.' }]);
  const t0 = Date.now();
  // Not awaited: Continue would wait for the (killed) helpers up to busyWaitMs if it counted them.
  const continued = fx.engine.continue(task.id, ADA, 'Carry on please');
  await waitFor(() => fx.invocations().some((i) => /Carry on please/.test(i.prompt ?? '')), 'the worker to be prompted promptly, not after the killed helpers\' wait', 6000);
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(await continued, undefined);
  assert.equal(fx.task(task.id).workerId, running.workerId);
});

test('stop during the resumed turn, after the agent reported back, interrupts the terminal as usual', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'Done.', backgroundMs: 300, resumeToolMs: 20_000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(fx.task(task.id).status, 'in_progress', 'the resumed turn is still the run');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 10_000);
  assert.equal(fx.invocations().some((i) => i.interrupted), true, 'Esc was typed');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.ok(running.workerId && fx.workers.get(running.workerId), 'the worker was not sent home: Esc cut the turn and its Stop finished the stop');
});

test('a log that lags behind the first Stop (the launch not logged yet) still holds the run for the background agent', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'Changed the redirect; tests pass.', commit: 'Work', launchLateMs: 100, backgroundMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(fx.task(task.id).status, 'in_progress');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 15_000);
  assert.equal(done.summary, 'Changed the redirect; tests pass.');
  assert.deepEqual(fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result').map((c) => c.text), ['Changed the redirect; tests pass.']);
});

test('Stop #1 racing the agent\'s notification: the run waits for the resumed turn, which ends on its own Stop though its reply is logged late', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'Changed the redirect; tests pass.', commit: 'Work', backgroundMs: 300, lateLogMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 15_000);
  assert.equal(done.summary, 'Changed the redirect; tests pass.', "from the resumed turn's Stop, not the interim text");
});

test('a turn that ends on teammates is not the run\'s end: their hooks leave it, and the task waits for the lead\'s own Stop', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', teammates: 'The teammate is at it; I will wait for its report.', reply: 'Changed the redirect; tests pass.', commit: 'Work', teammatesMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.phase === 'implement' && x.runState === 'running', 'the implement turn');
  // The first Stop has come and so has the teammate's hook (the worker works): the task is still at work.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  assert.equal(fx.workers.get(running.workerId!)?.status, 'working');
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 15_000);
  assert.equal(done.summary, 'Changed the redirect; tests pass.');
  assert.deepEqual(fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'result').map((c) => c.text), ['Changed the redirect; tests pass.']);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
});

const teamFix = [
  { when: 'Implement kanban task', teammates: 'Waiting for the teammate.', reply: 'Changed the redirect; tests pass.', commit: 'Work', teammatesMs: 200, lateTeamMs: 3000 },
  { when: 'asks for changes', reply: 'Fixed the missing null check.', commit: 'Null check' },
  { when: 'This is review round 1 of', reply: '1. src/login.ts:12 misses a null check.\n\nREVIEW: CHANGES_REQUESTED' },
  { when: 'round 2 of', reply: 'The fix is right.\n\nREVIEW: APPROVED' },
];

test('a phase that finds its own worker busy (a teammate still hooks it) waits for it to rest instead of failing', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules(teamFix);
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.reviewRound, 2);
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}${r.round ? `:${r.round}` : ''}/${r.status}`), ['implement/succeeded', 'review:1/succeeded', 'fix:1/succeeded', 'review:2/succeeded']);
});

test('a phase waits for teammates that woke on their own (the worker still done) before it types its prompt', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  // The review takes longer than the teammate needs to wake, so the fix finds it at work again.
  fx.setRules(teamFix.map((r) => (r.teammates ? { ...r, lateTeamMs: undefined, teamAgainMs: 4000 } : r.when.startsWith('This is review round 1') ? { ...r, delayMs: 800 } : r)));
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && x.reviewRound === 2, 'the review column', 40_000);
  assert.equal(done.reviewRound, 2);
  const rested = Number(readFileSync(path.join(fx.root, 'team-rested'), 'utf8'));
  const fix = fx.invocations().find((i) => /asks for changes/.test(i.prompt ?? ''));
  assert.ok(fix?.at && fix.at >= rested, `the fix prompt (${fix?.at}) came after the teammate rested (${rested})`);
});

test('a phase whose own worker never rests fails with the busy error after busyWaitMs', async (t) => {
  const fx = await engineFixture({ engine: { busyWaitMs: 500 } });
  t.after(() => fx.close());
  fx.setRules(teamFix.map((r) => (r.teammates ? { ...r, lateTeamMs: 30_000 } : r)));
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const failed = await fx.waitTask(task.id, (x) => x.status === 'waiting' && /is busy/.test(x.waitingText ?? ''), 'the busy failure', 30_000);
  assert.match(failed.waitingText ?? '', /is busy: wait for its turn to end/);
});

test('Stop while a phase waits for its busy own worker ends the run as stopped at once, with no prompt typed', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules(teamFix.map((r) => (r.teammates ? { ...r, lateTeamMs: 60_000 } : r)));
  const task = fx.newTask({ usePlan: false });
  await fx.engine.start(task.id, ADA);
  const waitingRun = () => fx.repo.listRuns(task.id).some((r) => r.phase === 'fix' && r.status === 'running');
  for (let i = 0; i < 300 && !waitingRun(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(waitingRun(), 'the fix run waits for its worker');
  const at = Date.now();
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  assert.ok(Date.now() - at < 3000, 'the stop did not wait for the busy worker');
  const stopped = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 5000);
  assert.equal(stopped.waitingText, 'Stopped by Ada');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.equal(fx.repo.listRuns(task.id).some((r) => r.status === 'running'), false);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fx.invocations().some((i) => /asks for changes/.test(i.prompt ?? '')), false, 'no fix prompt was typed');
});

test('a run held for background agents that never report back goes on after backgroundWaitMs, with a note', async (t) => {
  const fx = await engineFixture({ engine: { backgroundWaitMs: 800 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', background: 'Waiting for the helper agent.', reply: 'Never logged.', commit: 'Work', backgroundMs: 600_000 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 15_000);
  assert.equal(done.summary, 'Waiting for the helper agent.');
  assert.ok(fx.repo.listComments(task.id).comments.some((c) => c.authorKind === 'system' && /Waited 1 s for its agent's next Stop/.test(c.text)));
});

const reviewRuns = (fx: Awaited<ReturnType<typeof engineFixture>>, id: number) => fx.repo.listRuns(id).filter((r) => r.phase === 'review').length;

/** A task through implement and an approving review into the Review column. */
async function reviewed(fx: Awaited<ReturnType<typeof engineFixture>>) {
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
}

async function comment(fx: Awaited<ReturnType<typeof engineFixture>>, id: number, text: string) {
  const c = fx.repo.addComment({ taskId: id, authorKind: 'user', authorName: 'Ada', text }).comment;
  await fx.engine.commented(id, c.id, ADA);
}

test('a comment whose work changes nothing since the task came to Review goes back to Review without a new review round', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const done = await reviewed(fx);
  await fx.waitTask(done.id, (x) => !!x.handoffFingerprint, 'the stored fingerprint');
  fx.setRules([{ when: 'commented on task', reply: 'It already works that way.' }]);
  await comment(fx, done.id, 'Does it handle logout?');
  await fx.waitTask(done.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(done.id).some((r) => r.phase === 'resume' && r.status === 'succeeded'), 'the resume ended', 30_000);
  assert.equal(reviewRuns(fx, done.id), 1, 'no new review round');
  assert.ok(fx.repo.listComments(done.id).comments.some((c) => c.authorKind === 'system' && /nothing new to review/.test(c.text)));
});

test('a comment whose work commits is reviewed again, and its arrival stores a new fingerprint', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const done = await reviewed(fx);
  const first = (await fx.waitTask(done.id, (x) => !!x.handoffFingerprint, 'the stored fingerprint')).handoffFingerprint;
  fx.setRules([{ when: 'commented on task', reply: 'Renamed.', commit: 'Rename' }, { when: 'You are reviewing the work', reply: 'Good.\n\nREVIEW: APPROVED' }]);
  await comment(fx, done.id, 'Rename it.');
  await fx.waitTask(done.id, (x) => x.status === 'review' && x.runState === 'idle' && reviewRuns(fx, x.id) === 2, 'the second review', 30_000);
  await fx.waitTask(done.id, (x) => !!x.handoffFingerprint && x.handoffFingerprint !== first, 'a new fingerprint for the new arrival');
});

test('a manual round that is stopped, then a comment that changes nothing, runs no review', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const done = await reviewed(fx);
  await fx.waitTask(done.id, (x) => !!x.handoffFingerprint, 'the stored fingerprint');
  fx.setRules([{ when: 'You are reviewing the work', reply: 'Slow.\n\nREVIEW: APPROVED', delayMs: 20_000 }]);
  assert.equal(await fx.engine.review(done.id, ADA), undefined);
  await fx.waitTask(done.id, (x) => x.phase === 'review' && x.runState === 'running', 'the manual round', 20_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await fx.engine.stop(done.id, ADA), undefined);
  await fx.waitTask(done.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop');
  const before = reviewRuns(fx, done.id);
  fx.setRules([{ when: 'commented on task', reply: 'Nothing to change.' }]);
  await comment(fx, done.id, 'Anything else?');
  await fx.waitTask(done.id, (x) => x.status === 'review' && x.runState === 'idle', 'back in Review', 30_000);
  assert.equal(reviewRuns(fx, done.id), before, 'no review run after the comment');
});

test('a resume that ran before the task ever came to Review is judged against the base branch, so it is reviewed', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work', delayMs: 1200 },
    { when: 'commented on task', reply: 'Nothing more to do.' },
    { when: 'You are reviewing the work', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.runState === 'running', 'the implement turn');
  await comment(fx, task.id, 'One more thing.');
  assert.equal(fx.task(task.id).handoffFingerprint, undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'resume' && r.status === 'succeeded') && reviewRuns(fx, x.id) >= 1, 'a review after the resume', 40_000);
  const phases = fx.repo.listRuns(task.id).map((r) => r.phase);
  assert.ok(phases.includes('resume') && phases.lastIndexOf('review') > phases.indexOf('resume'), 'a review run comes after the resume run');
});

test('Fix PRs on an investigation checks out the PR branch, not the investigation branch, and no report folder is granted', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Address the open review comments', reply: 'Answered the comments.' },
    { when: 'nvestigat', reply: 'Found it.' },
  ]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  assert.match((await fx.engine.pr(task.id, ADA, 'create')) ?? '', /investigation/, 'no PR is opened for an investigation');
  assert.match((await fx.engine.pr(task.id, ADA, 'fix')) ?? '', /no open pull requests/);

  // The investigation left its own working branch on the task; the PR is on another.
  fx.repo.updateTask(task.id, { branch: 'office/scratch' });
  fx.repo.setRepoBranch(task.id, 'proj', 'office/scratch');
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 5, url: 'https://github.com/acme/proj/pull/5', state: 'OPEN', branch: 'fix/the-pr-branch' });
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-fix' && r.status === 'succeeded'), 'the pr-fix run');
  assert.equal(fx.task(task.id).branch, 'office/scratch', "the task's own branch is left alone");
  const run = fx.repo.listRuns(task.id).find((r) => r.phase === 'pr-fix')!;
  assert.equal(run.role, 'implementer');
  const inv = fx.invocations().slice(before).filter((i) => i.kind === 'claude');
  const text = inv.map((i) => i.prompt ?? i.args.join(' ')).join('\n');
  assert.match(text, /Address the open review comments[\s\S]*https:\/\/github\.com\/acme\/proj\/pull\/5/);
  assert.match(text, /fix\/the-pr-branch/, 'told to check out the PR branch');
  assert.ok(!text.includes('office/scratch'), "not told to check out the investigation's branch");
  assert.ok(!text.includes('investigateSafety') && !/read-only/i.test(inv.map((i) => i.args.join(' ')).join(' ')));
  assert.ok(!fx.invocations().slice(before).some((i) => i.args.some((a) => a.includes('reports'))), 'no report folder is granted');
});

test('Resolve conflicts on an investigation checks out the PR branch, and refuses a task with no PR of its own', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Bring the open pull requests', reply: 'Merged the target branch.' }, { when: 'nvestigat', reply: 'Found it.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  assert.match((await fx.engine.pr(task.id, ADA, 'conflicts')) ?? '', /no open pull requests/);
  fx.repo.updateTask(task.id, { branch: 'office/scratch' });
  fx.repo.setRepoBranch(task.id, 'proj', 'office/scratch');
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 5, url: 'https://github.com/acme/proj/pull/5', state: 'OPEN', branch: 'fix/the-pr-branch' });
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'conflicts'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-conflicts' && r.status === 'succeeded'), 'the pr-conflicts run');
  const text = fx.invocations().slice(before).filter((i) => i.kind === 'claude').map((i) => i.prompt ?? i.args.join(' ')).join('\n');
  assert.match(text, /Bring the open pull requests[\s\S]*pull\/5/);
  assert.match(text, /fix\/the-pr-branch/, 'told to check out the PR branch');
  assert.ok(!text.includes('office/scratch'), "not told to check out the investigation's branch");
});

test('Fix PRs in two repositories checks out the PR branch only where the task has an open PR', async (t) => {
  const api = path.join(mkdtempSync(path.join(tmpdir(), 'kanban-api-')), 'api');
  makeRepo(api);
  const fx = await engineFixture({ repos: [{ id: 'api', name: 'api', kind: 'git', dir: api, remote: 'acme/api', primary: false }] });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Address the open review comments', reply: 'Answered the comments.' }, { when: 'nvestigat', reply: 'Found it.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  fx.repo.updateTask(task.id, { branch: 'office/scratch' });
  fx.repo.setRepoBranch(task.id, 'proj', 'office/scratch');
  fx.repo.setRepoBranch(task.id, 'api', 'office/api-scratch');
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 5, url: 'https://github.com/acme/proj/pull/5', state: 'OPEN', branch: 'fix/the-pr-branch' });
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-fix' && r.status === 'succeeded'), 'the pr-fix run');
  const text = fx.invocations().slice(before).filter((i) => i.kind === 'claude').map((i) => i.prompt ?? i.args.join(' ')).join('\n');
  assert.match(text, /- [^\n]*`fix\/the-pr-branch`/);
  assert.match(text, /- api: `office\/api-scratch`/);
  assert.ok(!text.includes('office/scratch`'), "the repository with the PR isn't sent to the investigation's branch");
});

test("Fix PRs checks each repository's worktree on its own: the primary on the PR branch doesn't excuse the others", async (t) => {
  const api = path.join(mkdtempSync(path.join(tmpdir(), 'kanban-api-')), 'api');
  makeRepo(api);
  const fx = await engineFixture({ repos: [{ id: 'api', name: 'api', kind: 'git', dir: api, remote: 'acme/api', primary: false }] });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Address the open review comments', reply: 'Answered the comments.' }, { when: 'nvestigat', reply: 'Found it.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  const ws = done.workspace;
  assert.ok(ws?.repos?.some((r) => r.name === 'api'), 'the workspace has a worktree for api');
  // Both PRs are on feature/x; the primary's worktree is already there, api's isn't.
  for (const [repoId, repo, number] of [['proj', 'acme/proj', 5], ['api', 'acme/api', 6]] as const) {
    fx.repo.upsertPrLink(task.id, { repoId, repo, number, url: `https://github.com/${repo}/pull/${number}`, state: 'OPEN', branch: 'feature/x' });
  }
  execFileSync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: path.join(fx.dir, ws!.worktree.path) });
  const before = fx.invocations().length;
  assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-fix' && r.status === 'succeeded'), 'the pr-fix run');
  const text = fx.invocations().slice(before).filter((i) => i.kind === 'claude').map((i) => i.prompt ?? i.args.join(' ')).join('\n');
  assert.match(text, /- api: `feature\/x`/, "api is told to check out the PR's branch");
});

test("Fix PRs twice: the PR: lines of the answers don't move the PR's head branch to the task's", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Address the open review comments', reply: 'Answered the comments.\nPR: https://github.com/acme/proj/pull/5' }, { when: 'nvestigat', reply: 'Found it.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  fx.repo.updateTask(task.id, { branch: 'office/scratch' });
  fx.repo.setRepoBranch(task.id, 'proj', 'office/scratch');
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 5, url: 'https://github.com/acme/proj/pull/5', state: 'OPEN', branch: 'fix/the-pr-branch' });
  for (const round of [1, 2]) {
    const before = fx.invocations().length;
    assert.equal(await fx.engine.pr(task.id, ADA, 'fix'), undefined);
    await fx.waitTask(task.id, (x) => x.runState === 'idle' && fx.repo.listRuns(task.id).filter((r) => r.phase === 'pr-fix' && r.status === 'succeeded').length === round, `pr-fix run ${round}`);
    assert.deepEqual(fx.repo.listPrLinks(task.id).map((p) => [p.number, p.branch]), [[5, 'fix/the-pr-branch']], `the link keeps its branch after run ${round}`);
    const text = fx.invocations().slice(before).filter((i) => i.kind === 'claude').map((i) => i.prompt ?? i.args.join(' ')).join('\n');
    if (round === 2) assert.ok(!text.includes('office/scratch`'), "the second run isn't sent to the task's own branch");
  }
});
