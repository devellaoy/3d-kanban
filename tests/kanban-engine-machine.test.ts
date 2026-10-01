import test from 'node:test';
import assert from 'node:assert/strict';
import { next, type Effect, type MachineConfig, type MachineEvent, type MachineState, type MachineTask } from '../src/server/kanban/engine/machine.js';

const TODO: MachineState = { status: 'todo', runState: 'idle', reviewRound: 0, retryAttempts: 0 };
const TASK: MachineTask = { type: 'implement', usePlan: true, useReview: true, planApproval: 'auto' };
const CFG: MachineConfig = { rounds: 2, reReviewLastFix: true };

/** Runs events in order, checking none is refused, and gives back each step's state and effects. */
function drive(events: MachineEvent[], task: Partial<MachineTask> = {}, cfg: Partial<MachineConfig> = {}, from: MachineState = TODO) {
  let s = from;
  const steps: { state: MachineState; effects: Effect[] }[] = [];
  for (const e of events) {
    const r = next(s, e, { ...TASK, ...task }, { ...CFG, ...cfg });
    assert.ok(!('error' in r), `${e.type} was refused: ${'error' in r ? r.error : ''}`);
    if ('error' in r) break;
    s = r.state;
    steps.push(r);
  }
  return { state: s, steps, last: steps[steps.length - 1] };
}

const runOf = (effects: Effect[]) => effects.find((e): e is Extract<Effect, { type: 'run' }> => e.type === 'run');
/** The runs started along the way, as phase[:round]. */
const runs = (steps: { effects: Effect[] }[]) => steps.flatMap((s) => s.effects.filter((e): e is Extract<Effect, { type: 'run' }> => e.type === 'run').map((e) => (e.round !== undefined ? `${e.phase}:${e.round}` : e.phase)));

test('start: a plan first, straight to work without one, an investigation, and queued without a slot', () => {
  let r = drive([{ type: 'start', slot: true }]);
  assert.deepEqual(r.state, { ...TODO, status: 'in_progress', runState: 'starting', phase: 'plan', waitingReason: undefined, waitingText: undefined, retryAt: undefined });
  assert.deepEqual(runOf(r.last.effects), { type: 'run', phase: 'plan', role: 'implementer', prompt: 'plan' });

  r = drive([{ type: 'start', slot: true }], { usePlan: false });
  assert.equal(runOf(r.last.effects)?.prompt, 'implement');

  r = drive([{ type: 'start', slot: true }], { type: 'investigate' });
  assert.deepEqual(runOf(r.last.effects), { type: 'run', phase: 'implement', role: 'implementer', prompt: 'investigate' });

  r = drive([{ type: 'start', slot: false }]);
  assert.equal(r.state.status, 'in_progress');
  assert.equal(r.state.runState, 'queued');
  assert.equal(runOf(r.last.effects), undefined);
  // The slot comes free: it starts.
  r = drive([{ type: 'start', slot: true }], {}, {}, r.state);
  assert.equal(r.state.runState, 'starting');
  assert.equal(runOf(r.last.effects)?.phase, 'plan');

  for (const status of ['in_progress', 'review', 'done', 'archived'] as const) {
    const refused = next({ ...TODO, status, runState: status === 'in_progress' ? 'running' : 'idle' }, { type: 'start', slot: true }, TASK, CFG);
    assert.ok('error' in refused, status);
  }
});

test('the whole way: plan → implement → review CHANGES_REQUESTED → fix → review APPROVED → review column', () => {
  const r = drive([
    { type: 'start', slot: true },
    { type: 'planned', outcome: 'ready' },
    { type: 'implemented', changes: true },
    { type: 'reviewed', round: 1, approved: false },
    { type: 'fixed', round: 1, changes: true },
    { type: 'reviewed', round: 2, approved: true },
  ]);
  assert.deepEqual(runs(r.steps), ['plan', 'implement', 'review:1', 'fix:1', 'review:2']);
  assert.deepEqual(r.steps[1].effects[0], { type: 'acceptPlan' });
  assert.equal(runOf(r.steps[2].effects)?.role, 'reviewer');
  assert.equal(runOf(r.steps[2].effects)?.prompt, 'review');
  assert.equal(runOf(r.steps[3].effects)?.role, 'implementer');
  assert.equal(runOf(r.steps[4].effects)?.prompt, 'rereview');
  assert.equal(r.state.status, 'review');
  assert.equal(r.state.runState, 'idle');
  assert.equal(r.state.reviewRound, 2);
  assert.ok(r.last.effects.some((e) => e.type === 'reviewerHome'));
  assert.ok(r.last.effects.some((e) => e.type === 'finished'));
});

test('round limits: every round asks for changes, with and without a re-review of the last fix', () => {
  const allChanges = (rounds: number) => {
    const events: MachineEvent[] = [{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }, { type: 'implemented', changes: true }];
    for (let k = 1; k <= rounds; k++) events.push({ type: 'reviewed', round: k, approved: false }, { type: 'fixed', round: k, changes: true });
    return events;
  };
  // Re-review on: the last fix gets one more review, whose verdict ends it either way.
  let r = drive(allChanges(2), {}, { rounds: 2, reReviewLastFix: true });
  assert.deepEqual(runs(r.steps), ['plan', 'implement', 'review:1', 'fix:1', 'review:2', 'fix:2', 'review:3']);
  assert.equal(r.state.status, 'in_progress');
  let end = drive([{ type: 'reviewed', round: 3, approved: false }], {}, { rounds: 2 }, r.state);
  assert.equal(end.state.status, 'review');
  assert.equal(runOf(end.last.effects), undefined, 'no fix after the final re-review');
  assert.ok(end.last.effects.some((e) => e.type === 'note' && /final re-review/.test(e.text)));
  end = drive([{ type: 'reviewed', round: 3, approved: true }], {}, { rounds: 2 }, r.state);
  assert.equal(end.state.status, 'review');

  // Re-review off: straight to the review column after the last fix.
  r = drive(allChanges(3), {}, { rounds: 3, reReviewLastFix: false });
  assert.deepEqual(runs(r.steps), ['plan', 'implement', 'review:1', 'fix:1', 'review:2', 'fix:2', 'review:3', 'fix:3']);
  assert.equal(r.state.status, 'review');
  assert.ok(r.last.effects.some((e) => e.type === 'reviewerHome'));

  // One round, approved at once.
  r = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }, { type: 'implemented', changes: true }, { type: 'reviewed', round: 1, approved: true }], {}, { rounds: 1 });
  assert.equal(r.state.status, 'review');
  // Rounds out of range are held to 1..10.
  r = drive(allChanges(1), {}, { rounds: 0, reReviewLastFix: false });
  assert.equal(r.state.status, 'review');
});

test('no review without changes, without review on, or for an investigation', () => {
  let r = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }, { type: 'implemented', changes: false }]);
  assert.equal(r.state.status, 'review');
  assert.ok(r.last.effects.some((e) => e.type === 'note' && /nothing to review/.test(e.text)));
  r = drive([{ type: 'start', slot: true }, { type: 'implemented', changes: true }], { usePlan: false, useReview: false });
  assert.equal(r.state.status, 'review');
  assert.deepEqual(runs(r.steps), ['implement']);
  r = drive([{ type: 'start', slot: true }, { type: 'implemented', changes: true }], { type: 'investigate' });
  assert.equal(r.state.status, 'review');
  assert.deepEqual(runs(r.steps), ['implement']);
  assert.ok('error' in next(r.state, { type: 'review' }, { ...TASK, type: 'investigate' }, CFG));
});

test('manual plan approval waits; approving goes on, asking for changes plans again', () => {
  const planned = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }], { planApproval: 'manual' });
  assert.equal(planned.state.status, 'waiting');
  assert.equal(planned.state.waitingReason, 'plan_approval');
  assert.equal(planned.state.phase, 'plan');
  assert.equal(runOf(planned.last.effects), undefined);

  const approved = drive([{ type: 'approvePlan' }], { planApproval: 'manual' }, {}, planned.state);
  assert.deepEqual(approved.last.effects.map((e) => e.type), ['acceptPlan', 'run']);
  assert.equal(runOf(approved.last.effects)?.phase, 'implement');
  assert.equal(approved.state.status, 'in_progress');

  // Continue without an answer is approving; with one, it's a change request.
  const cont = drive([{ type: 'continue' }], { planApproval: 'manual' }, {}, planned.state);
  assert.equal(runOf(cont.last.effects)?.phase, 'implement');
  const changes = drive([{ type: 'requestPlanChanges', text: 'Use the old API' }], { planApproval: 'manual' }, {}, planned.state);
  assert.deepEqual(changes.last.effects[0], { type: 'planFeedback', text: 'Use the old API' });
  assert.deepEqual(runOf(changes.last.effects), { type: 'run', phase: 'plan', role: 'implementer', prompt: 'replan', text: 'Use the old API' });
  assert.ok('error' in next(planned.state, { type: 'requestPlanChanges', text: '  ' }, TASK, CFG));
  // Nothing to approve outside Waiting for a plan.
  assert.ok('error' in next({ ...TODO, status: 'review' }, { type: 'approvePlan' }, TASK, CFG));
});

test('questions → waiting → an answer → replan → ready → implement', () => {
  const asked = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'questions' }]);
  assert.equal(asked.state.status, 'waiting');
  assert.equal(asked.state.waitingReason, 'plan_questions');
  const answered = drive([{ type: 'continue', answer: 'Yes, both repos' }], {}, {}, asked.state);
  assert.deepEqual(runOf(answered.last.effects), { type: 'run', phase: 'plan', role: 'implementer', prompt: 'replan', text: 'Yes, both repos' });
  assert.ok(!answered.last.effects.some((e) => e.type === 'planFeedback'), 'answers are no plan feedback');
  const done = drive([{ type: 'planned', outcome: 'ready' }], {}, {}, answered.state);
  assert.equal(runOf(done.last.effects)?.phase, 'implement');
  // Carrying on without an answer tells it to assume.
  const assume = drive([{ type: 'continue' }], {}, {}, asked.state);
  assert.match(runOf(assume.last.effects)?.text ?? '', /assumptions/);
  // A comment is an answer too.
  const comment = drive([{ type: 'comment', text: 'Only the API', busy: false }], {}, {}, asked.state);
  assert.equal(runOf(comment.last.effects)?.prompt, 'replan');
});

test('comments: queued while busy, delivered at the turn end, a resume otherwise, and reviewed after', () => {
  const working = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }]);
  const queued = drive([{ type: 'comment', text: 'Also X', busy: true }], {}, {}, working.state);
  assert.deepEqual(queued.last.effects, [{ type: 'queueComment' }]);
  // The implementation ends with it pending: it's worked on first, then reviewed.
  const delivered = drive([{ type: 'implemented', changes: true, pending: true }], {}, {}, working.state);
  assert.deepEqual(runOf(delivered.last.effects), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', pending: true });
  const reviewed = drive([{ type: 'resumed', changes: true }], {}, {}, delivered.state);
  assert.deepEqual(runOf(reviewed.last.effects), { type: 'run', phase: 'review', role: 'reviewer', prompt: 'review', round: 1 });
  // Pending at a plan's end: it plans again with it.
  const replan = drive([{ type: 'planned', outcome: 'ready', pending: true }], {}, {}, drive([{ type: 'start', slot: true }]).state);
  assert.equal(runOf(replan.last.effects)?.prompt, 'replan');
  assert.ok(!replan.last.effects.some((e) => e.type === 'acceptPlan'));

  // In the review column a comment resumes the work, which is reviewed again, then back to Review.
  const inReview: MachineState = { ...TODO, status: 'review', phase: 'review', reviewRound: 2 };
  const resumed = drive([{ type: 'comment', text: 'Rename it', busy: false }, { type: 'resumed', changes: true }, { type: 'reviewed', round: 1, approved: true }], {}, {}, inReview);
  assert.deepEqual(runs(resumed.steps), ['resume', 'review:1']);
  assert.equal(resumed.state.status, 'review');
  // Without review on, the resume goes straight back to Review.
  const plain = drive([{ type: 'comment', text: 'Rename it', busy: false }, { type: 'resumed', changes: true }], { useReview: false }, {}, inReview);
  assert.equal(plain.state.status, 'review');
  // Nothing happens on To do or Done.
  for (const status of ['todo', 'done', 'archived'] as const) assert.deepEqual((next({ ...TODO, status }, { type: 'comment', text: 'x', busy: false }, TASK, CFG) as { effects: Effect[] }).effects, []);
  // Pending during a fix: the reviewer goes home, the comment is worked on, a new cycle follows.
  const fixing = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }, { type: 'implemented', changes: true }, { type: 'reviewed', round: 1, approved: false }]);
  const fixPending = drive([{ type: 'fixed', round: 1, changes: true, pending: true }], {}, {}, fixing.state);
  assert.deepEqual(fixPending.last.effects.map((e) => e.type), ['reviewerHome', 'run']);
});

test('the agent asking in its terminal: waiting, back to work when answered, then the turn ends normally', () => {
  const working = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }]);
  const asking = drive([{ type: 'asking', text: 'Asking about X' }], {}, {}, working.state);
  assert.equal(asking.state.status, 'waiting');
  assert.equal(asking.state.waitingReason, 'agent_asking');
  assert.equal(asking.state.waitingText, 'Asking about X');
  // A comment meanwhile waits for the turn.
  assert.deepEqual(drive([{ type: 'comment', text: 'x', busy: true }], {}, {}, asking.state).last.effects, [{ type: 'queueComment' }]);
  const back = drive([{ type: 'working' }], {}, {}, asking.state);
  assert.equal(back.state.status, 'in_progress');
  assert.equal(back.state.runState, 'running');
  // Answered and finished while still waiting: the turn's end moves it on all the same.
  const ended = drive([{ type: 'implemented', changes: true }], {}, {}, asking.state);
  assert.equal(runOf(ended.last.effects)?.phase, 'review');
});

test('stop: interrupts a running turn, then waits as stopped; a queued one just stops; retry goes on', () => {
  const working = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }]);
  const running = { ...working.state, runState: 'running' as const };
  const stopping = drive([{ type: 'stop' }], {}, {}, running);
  assert.equal(stopping.state.runState, 'stopping');
  assert.deepEqual(stopping.last.effects, [{ type: 'interrupt' }]);
  assert.ok('error' in next(stopping.state, { type: 'stop' }, TASK, CFG), 'already stopping');
  const stopped = drive([{ type: 'stopped', by: 'Ada' }], {}, {}, stopping.state);
  assert.equal(stopped.state.status, 'waiting');
  assert.equal(stopped.state.waitingReason, 'stopped');
  assert.equal(stopped.state.waitingText, 'Stopped by Ada');
  assert.equal(stopped.state.runState, 'idle');
  assert.ok('error' in next(stopped.state, { type: 'stop' }, TASK, CFG), 'not running');

  const retried = drive([{ type: 'retry', last: { phase: 'implement', role: 'implementer' } }], {}, {}, stopped.state);
  assert.deepEqual(runOf(retried.last.effects), { type: 'run', phase: 'implement', role: 'implementer', prompt: 'continue' });
  assert.equal(retried.state.status, 'in_progress');
  // Continue without an answer is a retry; with one, the answer resumes the work.
  assert.equal(runOf(drive([{ type: 'continue', last: { phase: 'fix', round: 2, role: 'implementer' } }], {}, {}, stopped.state).last.effects)?.round, 2);
  assert.equal(runOf(drive([{ type: 'continue', answer: 'Skip the tests' }], {}, {}, stopped.state).last.effects)?.phase, 'resume');

  // Stopping a queued task needs no interrupt; retrying it without a run starts it.
  const queued = drive([{ type: 'start', slot: false }]).state;
  const q = drive([{ type: 'stop' }], {}, {}, queued);
  assert.deepEqual(q.last.effects, []);
  assert.equal(q.state.waitingReason, 'stopped');
  assert.equal(runOf(drive([{ type: 'retry' }], {}, {}, q.state).last.effects)?.phase, 'plan');
  // Stopping the agent asking in its terminal interrupts it too.
  assert.deepEqual(drive([{ type: 'asking' }, { type: 'stop' }], {}, {}, working.state).last.effects, [{ type: 'interrupt' }]);
});

test('failures, usage limits and interruptions wait with a retry offered; retry resumes the reviewer too', () => {
  const reviewing = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }, { type: 'implemented', changes: true }]).state;
  const failed = drive([{ type: 'failed', error: 'boom' }], {}, {}, reviewing);
  assert.equal(failed.state.waitingReason, 'failed');
  assert.equal(failed.state.waitingText, 'boom');
  const limited = drive([{ type: 'limited', retryAt: 1000, attempts: 2 }], {}, {}, reviewing);
  assert.equal(limited.state.waitingReason, 'usage_limit');
  assert.equal(limited.state.retryAt, 1000);
  assert.equal(limited.state.retryAttempts, 2);
  const gaveUp = drive([{ type: 'gaveUp', text: 'too long' }], {}, {}, limited.state);
  assert.equal(gaveUp.state.retryAt, undefined);
  assert.equal(gaveUp.state.retryAttempts, 2);
  const interrupted = drive([{ type: 'interrupted' }], {}, {}, reviewing);
  assert.equal(interrupted.state.waitingReason, 'interrupted');
  for (const s of [failed.state, limited.state, gaveUp.state, interrupted.state]) {
    const r = drive([{ type: 'retry', last: { phase: 'review', round: 1, role: 'reviewer' } }], {}, {}, s);
    assert.deepEqual(runOf(r.last.effects), { type: 'run', phase: 'review', role: 'reviewer', prompt: 'continue', round: 1 });
    assert.equal(r.state.retryAt, undefined);
  }
  // A successful turn after the retries starts counting afresh.
  const recovered = drive([{ type: 'retry', last: { phase: 'implement', role: 'implementer' } }, { type: 'implemented', changes: true }], {}, {}, limited.state);
  assert.equal(recovered.state.retryAttempts, 0);
  // Nothing to retry in the plan's waiting or in Review.
  assert.ok('error' in next({ ...TODO, status: 'waiting', waitingReason: 'plan_questions' }, { type: 'retry' }, TASK, CFG));
  assert.ok('error' in next({ ...TODO, status: 'review' }, { type: 'retry' }, TASK, CFG));
});

test('a turn ending after the task was moved by hand leaves its column alone', () => {
  const working = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }]).state;
  const moved: MachineState = { ...working, status: 'done', runState: 'running' };
  for (const e of [{ type: 'implemented', changes: true }, { type: 'failed', error: 'x' }, { type: 'stopped' }, { type: 'interrupted' }] as MachineEvent[]) {
    const r = next(moved, e, TASK, CFG);
    assert.ok(!('error' in r));
    if ('error' in r) continue;
    assert.equal(r.state.status, 'done', e.type);
    assert.equal(r.state.runState, 'idle', e.type);
    assert.equal(runOf(r.effects), undefined, e.type);
  }
});

test('manual review and pull requests from the review column', () => {
  const inReview: MachineState = { ...TODO, status: 'review', phase: 'review', reviewRound: 1 };
  // One manual round: changes requested → a fix → back to Review, no re-review.
  const manual = drive([{ type: 'review' }, { type: 'reviewed', approved: false }, { type: 'fixed', changes: true }], {}, {}, inReview);
  assert.deepEqual(runs(manual.steps), ['review', 'fix']);
  assert.equal(runOf(manual.steps[0].effects)?.round, undefined);
  assert.equal(manual.state.status, 'review');
  assert.equal(manual.state.reviewRound, 1, 'a manual round leaves the round count');
  assert.equal(drive([{ type: 'review' }, { type: 'reviewed', approved: true }], {}, {}, inReview).state.status, 'review');

  const pr = drive([{ type: 'pr', mode: 'create' }], {}, {}, inReview);
  assert.deepEqual(runOf(pr.last.effects), { type: 'run', phase: 'pr', role: 'implementer', prompt: 'pr.create' });
  assert.equal(pr.state.status, 'in_progress');
  assert.equal(drive([{ type: 'prDone' }], {}, {}, pr.state).state.status, 'review');
  assert.equal(runOf(drive([{ type: 'pr', mode: 'fix' }], {}, {}, { ...inReview, status: 'done' }).last.effects)?.prompt, 'pr.fix');
  const inv = { ...TASK, type: 'investigate' as const };
  const fixInv = next(inReview, { type: 'pr', mode: 'fix' }, inv, CFG);
  assert.ok(!('error' in fixInv) && runOf(fixInv.effects)?.prompt === 'pr.fix', 'an investigation can have its PR fixed');
  assert.ok('error' in next(inReview, { type: 'pr', mode: 'create' }, inv, CFG), 'but opens none');
  assert.ok('error' in next({ ...inReview, runState: 'running' }, { type: 'pr', mode: 'create' }, TASK, CFG));
  assert.ok('error' in next(TODO, { type: 'pr', mode: 'create' }, TASK, CFG));
});

test('a comment typed while a review runs is worked on once the review cycle is over, then reviewed again', () => {
  const reviewing = drive([{ type: 'start', slot: true }, { type: 'planned', outcome: 'ready' }, { type: 'implemented', changes: true }]);
  assert.deepEqual(drive([{ type: 'comment', text: 'Also rename foo', busy: true }], {}, {}, reviewing.state).last.effects, [{ type: 'queueComment' }]);
  // Approved with the comment pending: the reviewer goes home, the implementer takes the comment first.
  const approved = drive([{ type: 'reviewed', round: 1, approved: true, pending: true }], {}, {}, reviewing.state);
  assert.deepEqual(approved.last.effects.map((e) => e.type), ['reviewerHome', 'note', 'run']);
  assert.deepEqual(runOf(approved.last.effects), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', pending: true });
  assert.equal(approved.state.status, 'in_progress', 'not in the review column yet');
  // Its result is reviewed again from round 1, then it goes to the review column.
  const after = drive([{ type: 'resumed', changes: true }, { type: 'reviewed', round: 1, approved: true }], {}, {}, approved.state);
  assert.deepEqual(runs(after.steps), ['review:1']);
  assert.equal(after.state.status, 'review');
  // Without review on, the resume goes straight to the review column.
  assert.equal(drive([{ type: 'resumed', changes: true }], { useReview: false }, {}, approved.state).state.status, 'review');
  // The rounds used up (the final re-review still asks for changes): the same.
  const last = drive([{ type: 'reviewed', round: 1, approved: false }, { type: 'fixed', round: 1, changes: true }, { type: 'reviewed', round: 2, approved: false }, { type: 'fixed', round: 2, changes: true }], {}, {}, reviewing.state);
  const exhausted = drive([{ type: 'reviewed', round: 3, approved: false, pending: true }], {}, {}, last.state);
  assert.deepEqual(runOf(exhausted.last.effects), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', pending: true });
  // A manual round approved with a comment pending, too.
  const manual = drive([{ type: 'review' }, { type: 'reviewed', approved: true, pending: true }], {}, {}, { ...TODO, status: 'review', phase: 'review', reviewRound: 1 });
  assert.equal(runOf(manual.last.effects)?.phase, 'resume');
  // Changes requested with a comment pending: the fix goes first, and the comment at the fix's end (as before).
  const fix = drive([{ type: 'reviewed', round: 1, approved: false, pending: true }], {}, {}, reviewing.state);
  assert.equal(runOf(fix.last.effects)?.phase, 'fix');
});

test('a pull-request review: its own run, then the review column; comments meanwhile are worked on after', () => {
  for (const from of [TODO, { ...TODO, status: 'review' as const }, { ...TODO, status: 'done' as const }, { ...TODO, status: 'waiting' as const, waitingReason: 'failed' as const }]) {
    const r = drive([{ type: 'prReview' }], {}, {}, from);
    assert.deepEqual(runOf(r.last.effects), { type: 'run', phase: 'pr-review', role: 'reviewer', prompt: 'pr.review' });
    assert.equal(r.state.status, 'in_progress');
    assert.equal(r.state.phase, 'pr-review');
    const done = drive([{ type: 'prReviewed' }], {}, {}, r.state);
    assert.equal(done.state.status, 'review', from.status);
    assert.deepEqual(done.last.effects.map((e) => e.type), ['finished', 'reviewerHome']);
    const pending = drive([{ type: 'prReviewed', pending: true }], {}, {}, r.state);
    assert.deepEqual(runOf(pending.last.effects), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', pending: true });
  }
  assert.ok('error' in next({ ...TODO, status: 'in_progress', runState: 'running' }, { type: 'prReview' }, TASK, CFG), 'not while running');
  assert.ok('error' in next({ ...TODO, status: 'archived' }, { type: 'prReview' }, TASK, CFG), 'not archived');
  // Interrupted, it waits with a Retry of the same run.
  const cut = drive([{ type: 'prReview' }, { type: 'interrupted' }]);
  assert.equal(cut.state.waitingReason, 'interrupted');
  assert.equal(runOf(drive([{ type: 'retry', last: { phase: 'pr-review', role: 'reviewer' } }], {}, {}, cut.state).last.effects)?.phase, 'pr-review');
});
