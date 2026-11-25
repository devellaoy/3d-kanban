import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTurnSignal } from '../src/shared/kanban/signals.js';
import { acceptSignal, applySignal, askedQuestion, expireSignal, heardQuestion, type SignalRun } from '../src/server/kanban/engine/signals.js';
import { finalMarker, planOutcome, prLines, reviewVerdict, workDone } from '../src/server/kanban/engine/markers.js';
import { ADA, engineFixture, hookToken, midTurn, type EngineFixture } from './kanban-engine-fixture.js';

// An agent's own announcement of how its turn ends (office-tasks done, MCP report_turn): docs/kanban-architecture.md §4, "The end of a turn".

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (phase: SignalRun['phase'], extra: Partial<SignalRun> = {}): SignalRun => ({ taskId: 1, runId: 1, phase, workerId: 'w', floorId: 'f', ended: false, ...extra });
const results = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'result').map((c) => c.text);
const notes = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'status').map((c) => c.text);

test('parseTurnSignal: only the announcements there are', () => {
  assert.deepEqual(parseTurnSignal({ kind: 'done' }), { kind: 'done' });
  assert.deepEqual(parseTurnSignal({ kind: 'plan-ready', url: 'x' }), { kind: 'plan-ready' });
  assert.deepEqual(parseTurnSignal({ kind: 'ask' }), { kind: 'ask' });
  assert.deepEqual(parseTurnSignal({ kind: 'review', verdict: 'changes' }), { kind: 'review', verdict: 'changes' });
  assert.deepEqual(parseTurnSignal({ kind: 'pr', url: ' https://github.com/a/b/pull/1 ' }), { kind: 'pr', url: 'https://github.com/a/b/pull/1' });
  for (const bad of [undefined, null, 'done', 3, {}, { kind: 'finish' }, { kind: 'review' }, { kind: 'review', verdict: 'maybe' }, { kind: 'pr' }, { kind: 'pr', url: '' }, { kind: 'pr', url: 'a b' }]) assert.equal(parseTurnSignal(bad), undefined, JSON.stringify(bad));
});

test('acceptSignal: each phase takes its own announcements, with a clear refusal for the rest', () => {
  const ok = (phase: SignalRun['phase'], sig: Parameters<typeof acceptSignal>[1]) => acceptSignal(run(phase), sig);
  for (const phase of ['implement', 'fix', 'resume', 'pr', 'pr-fix', 'pr-conflicts', 'pr-comments', 'pr-answers'] as const) {
    assert.equal(ok(phase, { kind: 'done' }), undefined, phase);
    assert.equal(ok(phase, { kind: 'ask' }), undefined, phase);
  }
  assert.equal(ok('plan', { kind: 'plan-ready' }), undefined);
  assert.equal(ok('plan', { kind: 'ask' }), undefined);
  assert.equal(ok('review', { kind: 'review', verdict: 'approved' }), undefined);
  assert.equal(ok('pr-review', { kind: 'review', verdict: 'changes' }), undefined);
  assert.equal(ok('pr-fix', { kind: 'pr', url: 'https://github.com/a/b/pull/1' }), undefined);
  assert.equal(ok('pr-answers', { kind: 'pr', url: 'https://github.com/a/b/pull/1' }), undefined);
  assert.match(ok('pr-comments', { kind: 'pr', url: 'https://github.com/a/b/pull/1' }) as string, /in its pr-comments phase: it takes "office-tasks done" or "office-tasks ask", not "pr"/, 'a fetch opens no pull requests');
  assert.equal(ok('review', { kind: 'done' }), 'This run is in its review phase: it takes "office-tasks review approved|changes", not "done"');
  assert.match(ok('implement', { kind: 'review', verdict: 'approved' }) as string, /in its implement phase: it takes "office-tasks done" or "office-tasks ask", not "review approved"/);
  assert.match(ok('plan', { kind: 'done' }) as string, /in its plan phase: it takes "office-tasks plan-ready" or "office-tasks ask", not "done"/);
  assert.match(ok('implement', { kind: 'plan-ready' }) as string, /not "plan-ready"/);
  assert.match(ok('implement', { kind: 'pr', url: 'https://github.com/a/b/pull/1' }) as string, /not "pr"/);
  assert.match(ok('review', { kind: 'ask' }) as string, /not "ask"/);
  assert.match(ok('compact', { kind: 'done' }) as string, /nothing to report/);
  assert.match(ok('pr', { kind: 'pr', url: 'ftp://x/y' }) as string, /http\(s\) URL/);
});

test('acceptSignal: no run, an ended or a stopping one is refused; a pr adds to the reported ones and keeps the announcement; the last one replaces', () => {
  assert.equal(acceptSignal(undefined, { kind: 'done' }), 'No run of yours is going: there is nothing to report');
  assert.match(acceptSignal(run('implement', { ended: true }), { kind: 'done' }) as string, /No run of yours is going/);
  assert.match(acceptSignal(run('implement', { stopping: {} }), { kind: 'done' }) as string, /being stopped/);
  const live = run('pr');
  acceptSignal(live, { kind: 'done' });
  acceptSignal(live, { kind: 'pr', url: 'https://github.com/a/b/pull/1/files' });
  acceptSignal(live, { kind: 'pr', url: 'https://github.com/a/b/pull/1' });
  acceptSignal(live, { kind: 'pr', url: 'https://github.com/a/b/pull/2' });
  assert.deepEqual(live.signal, { kind: 'done' });
  assert.deepEqual(live.signalPrs, ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2']);
  acceptSignal(live, { kind: 'ask' });
  assert.deepEqual(live.signal, { kind: 'ask' });
  expireSignal(live);
  assert.equal(live.signal, undefined);
  assert.equal(live.signalPrs, undefined);
});

test('applySignal: plan-ready and ask write the plan markers', () => {
  const ready = applySignal('plan', 'Step one.\nStep two.', { kind: 'plan-ready' }, []);
  assert.equal(finalMarker('plan', ready!.text), true);
  assert.equal(planOutcome(ready!.text), 'ready');
  assert.equal(applySignal('plan', 'Plan.\n\nPLAN READY', { kind: 'plan-ready' }, [])!.text, 'Plan.\n\nPLAN READY', 'a plan that has its marker is left');
  const asked = applySignal('plan', 'Which database?\nWhich repo?', { kind: 'ask' }, []);
  assert.equal(planOutcome(asked!.text), 'questions');
  assert.match(asked!.text, /^QUESTIONS:\nWhich database\?/);
  assert.equal(asked!.asked, undefined, 'a plan asks as it always did');
  const both = applySignal('plan', 'QUESTIONS:\n1. Which?\n\nPLAN READY', { kind: 'ask' }, []);
  assert.equal(planOutcome(both!.text), 'questions', 'the announcement wins over a PLAN READY line');
  assert.doesNotMatch(both!.text, /PLAN READY/);
  assert.equal(both!.text.match(/QUESTIONS:/g)!.length, 1);
  assert.equal(applySignal('plan', 'x', { kind: 'done' }, []), undefined, 'not an announcement of a plan');
});

test('applySignal: nothing to announce on an empty answer', () => {
  for (const [phase, sig] of [['plan', { kind: 'plan-ready' }], ['implement', { kind: 'done' }], ['implement', { kind: 'ask' }], ['review', { kind: 'review', verdict: 'changes' }]] as const) {
    assert.equal(applySignal(phase, '  \n ', sig, []), undefined, `${phase} ${sig.kind}`);
  }
});

test('applySignal: done adds the pull requests it reported and WORK DONE, each once', () => {
  const a = applySignal('implement', 'Changed it.', { kind: 'done' }, [])!;
  assert.equal(a.text, 'Changed it.\nWORK DONE');
  assert.equal(workDone(a.text), true);
  const b = applySignal('pr', 'Opened them.\nPR: https://github.com/a/b/pull/1', { kind: 'done' }, ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2'])!;
  assert.deepEqual(prLines(b.text).map((p) => p.url), ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2']);
  assert.equal(workDone(b.text), true);
  assert.equal(applySignal('implement', 'Done.\nWORK DONE', { kind: 'done' }, [])!.text, 'Done.\nWORK DONE');
  assert.equal(applySignal('implement', 'Done.', { kind: 'review', verdict: 'approved' }, []), undefined);
});

test('applySignal: ask in a phase that is not a plan ends with the question, its WORK DONE line dropped', () => {
  const a = applySignal('implement', 'Which db: sqlite or pg?\nWORK DONE', { kind: 'ask' }, [])!;
  assert.deepEqual(a, { text: 'Which db: sqlite or pg?', asked: true });
});

test('applySignal: changes requested wins over an approving text, with a note; approved never decides alone', () => {
  const c = applySignal('review', '1. Misses a null check.\n\nREVIEW: APPROVED', { kind: 'review', verdict: 'changes' }, [])!;
  assert.equal(reviewVerdict(c.text), 'changes_requested');
  assert.match(c.text, /Misses a null check/);
  assert.doesNotMatch(c.text, /APPROVED/);
  assert.equal(c.note, 'The reviewer announced changes requested while its answer said approved: taken as changes requested');
  const d = applySignal('pr-review', 'Findings.\nREVIEW: CHANGES_REQUESTED', { kind: 'review', verdict: 'changes' }, [])!;
  assert.equal(d.note, undefined);
  assert.equal(reviewVerdict(d.text), 'changes_requested');
  const noVerdict = applySignal('review', 'Looks fine to me.', { kind: 'review', verdict: 'changes' }, [])!;
  assert.equal(finalMarker('review', noVerdict.text), true, 'changes needs no verdict line of its own');
  assert.equal(applySignal('review', 'Looks fine to me.', { kind: 'review', verdict: 'approved' }, []), undefined, 'approved without the text saying it decides nothing');
  assert.deepEqual(applySignal('review', 'Fine.\n\nREVIEW: APPROVED', { kind: 'review', verdict: 'approved' }, []), { text: 'Fine.\n\nREVIEW: APPROVED' });
  assert.equal(applySignal('review', 'Fine.\n\nREVIEW: CHANGES_REQUESTED', { kind: 'review', verdict: 'approved' }, []), undefined, 'approved against a text that asks for changes: the text decides');
  assert.equal(applySignal('review', 'x', { kind: 'done' }, []), undefined);
});

// --- Through the engine ---------------------------------------------------------------------------------

/** The worker of the task's running implementer, once its turn is under way. */
async function implementer(fx: EngineFixture, id: number): Promise<string> {
  const t = await fx.waitTask(id, (x) => !!x.workerId && x.runState === 'running', 'the implementer at work');
  await midTurn(fx, t.workerId!);
  return t.workerId!;
}

test('done ends the run with no marker in the text, nothing nudged, the work reviewed as ever', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Changed the redirect.', noMarker: true, commit: 'Work', delayMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const w = await implementer(fx, task.id);
  assert.equal(fx.engine.signal(w, { kind: 'done' }), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.deepEqual(results(fx, task.id), ['Changed the redirect.']);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
});

test('without an announcement the same turn is held for its marker, as before', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Changed the redirect.', noMarker: true, commit: 'Work', delayMs: 300 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const w = await implementer(fx, task.id);
  await fx.waitTask(task.id, () => fx.workers.get(w)?.status === 'done', 'the Stop');
  await sleep(500);
  assert.equal(fx.task(task.id).status, 'in_progress');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
});

test('refused: no run, and every phase\'s wrong announcements', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  assert.match(fx.engine.signal('nobody', { kind: 'done' }) as string, /No run of yours is going/);
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'A plan.', noMarker: true, delayMs: 1500 },
  ]);
  const task = fx.newTask({ usePlan: true, useReview: true, planApproval: 'manual' });
  await fx.engine.start(task.id, ADA);
  const w = await implementer(fx, task.id);
  assert.match(fx.engine.signal(w, { kind: 'done' }) as string, /in its plan phase: it takes "office-tasks plan-ready" or "office-tasks ask", not "done"/);
  assert.match(fx.engine.signal(w, { kind: 'review', verdict: 'approved' }) as string, /in its plan phase/);
  assert.equal(fx.engine.signal(w, { kind: 'plan-ready' }), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan waiting for approval');
  assert.deepEqual(fx.repo.listPlans(task.id).map((p) => p.text), ['A plan.'], 'the marker written for the reader is not in the plan');
  assert.match(fx.engine.signal(w, { kind: 'plan-ready' }) as string, /No run of yours is going/, 'the run is over');
});

test('a plan that announces its questions asks them, whatever its text says', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'You are planning kanban task', reply: 'Which repo should it be in?\n\nPLAN READY', noMarker: true, delayMs: 1500 }]);
  const task = fx.newTask({ usePlan: true });
  await fx.engine.start(task.id, ADA);
  const w = await implementer(fx, task.id);
  assert.equal(fx.engine.signal(w, { kind: 'ask' }), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_questions', 'the plan asking');
  assert.equal(fx.repo.listComments(task.id).comments.find((c) => c.kind === 'questions')?.text.includes('PLAN READY'), false);
});

test('a reviewer\'s changes requested beats its approving text, with a note; and its approved alone ends nothing', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Changed it.', commit: 'Work' },
    { when: 'This is review round 1 of', reply: 'Misses a null check.\n\nREVIEW: APPROVED', delayMs: 1500 },
    { when: 'asks for changes', reply: 'Fixed.', commit: 'Fix', delayMs: 3000 },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  const rev = await fx.waitTask(task.id, (x) => !!x.reviewerWorkerId && x.phase === 'review', 'the review');
  await midTurn(fx, rev.reviewerWorkerId!);
  assert.match(fx.engine.signal(rev.reviewerWorkerId!, { kind: 'done' }) as string, /in its review phase/);
  assert.equal(fx.engine.signal(rev.reviewerWorkerId!, { kind: 'review', verdict: 'changes' }), undefined);
  await fx.waitTask(task.id, (x) => x.phase === 'fix', 'the fix');
  assert.equal(fx.repo.listRuns(task.id).find((r) => r.phase === 'review')?.verdict, 'changes_requested');
  assert.ok(notes(fx, task.id).some((n) => /announced changes requested while its answer said approved/.test(n)));
});

test('a reviewer\'s approved announcement without the verdict in its text does not end the review', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Changed it.', commit: 'Work' },
    { when: 'This is review round 1 of', reply: 'Looks fine to me.', noMarker: true, delayMs: 1200 },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: true });
  await fx.engine.start(task.id, ADA);
  const rev = await fx.waitTask(task.id, (x) => !!x.reviewerWorkerId && x.phase === 'review', 'the review');
  await midTurn(fx, rev.reviewerWorkerId!);
  assert.equal(fx.engine.signal(rev.reviewerWorkerId!, { kind: 'review', verdict: 'approved' }), undefined);
  await fx.waitTask(task.id, () => fx.workers.get(rev.reviewerWorkerId!)?.status === 'done', 'the reviewer\'s Stop');
  await sleep(600);
  assert.equal(fx.repo.listRuns(task.id).find((r) => r.phase === 'review')?.status, 'running');
  assert.equal(fx.task(task.id).status, 'in_progress');
});

test('an announcement only applies to the turn it was made in: the next prompt of the agent clears it', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: 'Changed the redirect.', noMarker: true, commit: 'Work', delayMs: 1500 }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const w = await implementer(fx, task.id);
  assert.equal(fx.engine.signal(w, { kind: 'done' }), undefined);
  fx.workers.handleHook(w, hookToken(fx, w), 'UserPromptSubmit', { prompt: 'something typed in' });
  await fx.waitTask(task.id, () => fx.workers.get(w)?.status === 'done', 'the Stop');
  await sleep(600);
  assert.equal(fx.task(task.id).status, 'in_progress', 'the earlier announcement ended nothing');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'running');
  // A new announcement, made in a later turn, does.
  fx.workers.prompt(w, 'Implement kanban task again');
  await midTurn(fx, w);
  assert.equal(fx.engine.signal(w, { kind: 'done' }), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review', 'the review column', 20_000);
});

test('implement: pr urls and done link the pull request without a PR: line in the text', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Changed it.', commit: 'Work' },
    { when: 'Open the pull requests for', reply: 'Opened it.', noMarker: true, delayMs: 1500 },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.equal(await fx.engine.pr(task.id, ADA, 'create'), undefined);
  const w = await implementer(fx, task.id);
  assert.match(fx.engine.signal(w, { kind: 'pr', url: 'ftp://nope' }) as string, /http\(s\)/);
  assert.equal(fx.engine.signal(w, { kind: 'pr', url: 'https://github.com/acme/proj/pull/42' }), undefined);
  assert.equal(fx.engine.signal(w, { kind: 'done' }), undefined);
  await fx.waitTask(task.id, (x) => x.runState === 'idle' && x.prs.length === 1, 'the pull request linked');
  assert.equal(fx.task(task.id).prs[0].number, 42);
  assert.equal(fx.task(task.id).flags.prRequested, true);
});

test('implement ask: the question is kept, the task waits for the answer, and a comment resumes the work', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Which db do you want: sqlite or pg?', noMarker: true, delayMs: 1500 },
    { when: 'commented on task', reply: 'Used sqlite.', commit: 'Sqlite' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const w = await implementer(fx, task.id);
  assert.equal(fx.engine.signal(w, { kind: 'ask' }), undefined);
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the task asking');
  assert.equal(waiting.askingKind, 'question');
  assert.equal(waiting.runState, 'idle');
  assert.equal(fx.repo.listComments(task.id).comments.find((c) => c.kind === 'questions')?.text, 'Which db do you want: sqlite or pg?');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'succeeded');
  assert.equal(fx.repo.listRuns(task.id).length, 1);

  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'sqlite please' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column after the answer');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => r.phase), ['implement', 'resume']);
  assert.equal(fx.task(task.id).askingKind, undefined);
  assert.ok(fx.invocations().some((i) => i.prompt && /sqlite please/.test(i.prompt)), 'the answer reached the agent');
  assert.deepEqual(results(fx, task.id).at(-1), 'Used sqlite.');
});

test('implement ask: Continue with an answer resumes too, and a comment made while the run waited for its prompt is not lost', async (t) => {
  const fx = await engineFixture({ engine: { nudgeIdleMs: 60_000 } });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Which db do you want?', noMarker: true, submitDelayMs: 700, delayMs: 1200 },
    { when: 'Use sqlite', reply: 'Used sqlite.', commit: 'Sqlite' },
    { when: 'Also add a README', reply: 'Added the README.', commit: 'Readme' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const t0 = await fx.waitTask(task.id, (x) => !!x.workerId && x.runState === 'running', 'the run');
  // Before the agent has taken its launch prompt: queued.
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Also add a README' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  await midTurn(fx, t0.workerId!);
  assert.equal(fx.engine.signal(t0.workerId!, { kind: 'ask' }), undefined);
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the task asking');
  assert.equal(waiting.pendingMessages.length, 1, 'the comment stays kept');
  assert.equal(await fx.engine.continue(task.id, ADA, 'Use sqlite'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(x.id).length >= 2, 'the review column', 30_000);
  const prompts = fx.invocations().filter((i) => i.prompt).map((i) => i.prompt!);
  assert.ok(prompts.some((p) => /Use sqlite/.test(p)), 'the answer reached the agent');
  assert.ok(fx.invocations().concat([]).some((i) => /Also add a README/.test(`${i.prompt ?? ''}${i.args.join(' ')}`)), 'the comment reached it too');
  assert.equal(fx.task(task.id).pendingMessages.length, 0);
});

test('heardQuestion: the same boolean as ever, and the question of a question tool\'s PreToolUse is kept for the run', () => {
  const live = {};
  const ask = (tool: string | undefined, hookEvent: string, payload?: unknown) => heardQuestion(live, { tool, hookEvent, payload });
  assert.equal(ask('Bash', 'PreToolUse', { tool_input: { command: 'ls' } }), false);
  assert.equal(ask(undefined, 'PreToolUse'), false);
  assert.equal(askedQuestion(live), undefined);
  const input = { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B' }] }, { question: 'Sure?' }] };
  assert.equal(ask('AskUserQuestion', 'PreToolUse', { tool_input: input }), true);
  assert.equal(askedQuestion(live), 'Pick: Which one?\n- A: first\n- B\n\nSure?');
  assert.equal(askedQuestion(live), undefined, 'taken once: a second wait for input records nothing again');
  // Other events of the tool don't bring it back; a later question is kept; an unknown shape forgets it; plain fields are tried.
  assert.equal(ask('AskUserQuestion', 'PostToolUse'), true);
  assert.equal(askedQuestion(live), undefined);
  assert.equal(ask('mcp.request_user_input', 'PreToolUse', { tool_input: { question: 'Plain?' } }), true);
  assert.equal(askedQuestion(live), 'Plain?');
  assert.equal(ask('AskUserQuestion', 'PreToolUse', { tool_input: { odd: 1 } }), true);
  assert.equal(askedQuestion(live), undefined);
  assert.equal(ask('AskUserQuestion', 'PreToolUse', 'nonsense'), true);
  assert.equal(askedQuestion(live), undefined);
});

test('heardQuestion: what the bridge says it left out is in the text, with its own cut marker', () => {
  const live = {};
  const ask = (input: unknown) => heardQuestion(live, { tool: 'request_user_input', hookEvent: 'PreToolUse', payload: { tool_input: input } });
  ask({ questions: [{ question: 'Long (cut here: 5 more characters)', options: [{ label: 'a' }], moreOptions: 3 }, { question: 'Two', moreOptions: 1 }], moreQuestions: 12 });
  assert.equal(askedQuestion(live), 'Long (cut here: 5 more characters)\n- a\n(3 more options were left out)\n\nTwo\n(1 more option was left out)\n\n(12 more questions were left out)');
  ask({ questions: [{ question: 'One' }], moreQuestions: 1 });
  assert.equal(askedQuestion(live), 'One\n\n(1 more question was left out)');
  ask({ questions: [{ question: 'One', moreOptions: -2 }], moreQuestions: '4' });
  assert.equal(askedQuestion(live), 'One');
});
