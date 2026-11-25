// A review round with additional reviewers (engine/panel.ts): the main reviewer's own review (solo), one run per additional reviewer (co)
// and the main reviewer combining them (combine): ordinary runs, and exactly one `reviewed` for the round.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Capacity } from '../src/server/machine.js';
import { KANBAN_PROMPT_DEFS, PROMPT_CONTRACT, resolveKanbanPrompt, withContract } from '../src/shared/kanban/prompts.js';
import { placeholders } from '../src/shared/prompts.js';
import type { KanbanRun, KanbanTask } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const FIX: Rule = { when: 'asks for changes', reply: 'Fixed it.', commit: 'Fix' };
/** The additional reviewer's prompt carries kanban.review.co; it comes before the main reviewer's rule, which its review prompt matches too. */
const CO = 'reviewing this same folder at the same time';
const co = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: CO, reply, ...more });
const MAIN1 = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'This is review round 1 of', reply, ...more });
const COMBINE = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Combine them into the review', reply, ...more });
const APPROVED = 'Looks right.\nREVIEW: APPROVED';
const CHANGES = (what: string) => `${what}\nREVIEW: CHANGES_REQUESTED`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(t: { after(fn: () => unknown): void }, opts: { extra?: { tool: 'claude' | 'codex' }[]; rounds?: number; engine?: Parameters<typeof engineFixture>[0] extends infer O ? (O extends { engine?: infer E } ? E : never) : never; capacity?: Capacity } = {}) {
  const fx = await engineFixture({ engine: { panelWaitMs: 20_000, ...opts.engine }, ...(opts.capacity ? { capacity: opts.capacity } : {}) });
  t.after(() => fx.close());
  fx.settings.setProject('proj', { review: { tool: 'claude', rounds: opts.rounds ?? 1, reReviewLastFix: false, ...(opts.extra === undefined ? { extra: [{ tool: 'codex' }] } : opts.extra.length ? { extra: opts.extra } : {}) } });
  return fx;
}

const runs = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).filter((r) => r.phase === 'review');
const shape = (rs: KanbanRun[]) => rs.map((r) => `${r.seat ?? 0}:${r.panel ?? '-'}:${r.status}`);
const reviewComments = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'review');
const prompts = (fx: EngineFixture) => fx.invocations().flatMap((i) => (i.prompt ? [{ kind: i.kind, prompt: i.prompt }] : []));
const notes = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'status').map((c) => c.text);
/** How often a round ended asking for changes: the machine starts one fix run for each `reviewed` that does. */
const reviewed = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).filter((r) => r.phase === 'fix').length;

async function until(what: string, fn: () => boolean, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

/** Starts a task with no plan and a review, and waits for it to end up where `pred` says. */
async function start(fx: EngineFixture) {
  const task = fx.newTask({ usePlan: false, useReview: true });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return task.id;
}
const inReview = (x: KanbanTask) => x.status === 'review' && x.runState === 'idle';
const coWorker = (fx: EngineFixture, seat = 1) => fx.workers.list().find((w) => w.kanban?.seat === seat);

// --- The prompts -----------------------------------------------------------------------------------

test('the co and combine prompts: no placeholder is left, the combine one carries the review contract, the co one asks for no changes and no questions', () => {
  const co = KANBAN_PROMPT_DEFS['kanban.review.co'];
  assert.deepEqual(placeholders(co.text), []);
  assert.match(co.text, /Don't change any files/);
  assert.match(co.text, /Don't ask the user questions/);
  assert.match(co.text, /main reviewer, who combines/);
  const def = KANBAN_PROMPT_DEFS['kanban.review.combine'];
  const filled = resolveKanbanPrompt('kanban.review.combine', {}, { taskId: 7, round: 2, rounds: 3, reviews: 'Reviewer 2 (Codex): APPROVED\nfine', instructions: '', language: '' });
  assert.doesNotMatch(filled, /\{\{/);
  assert.match(filled, /round 2 of 3/);
  assert.match(filled, /Reviewer 2 \(Codex\): APPROVED/);
  assert.match(filled, /CHANGES_REQUESTED if at least one confirmed finding/);
  assert.equal(PROMPT_CONTRACT['kanban.review.combine'], 'review');
  assert.match(withContract(filled, 'review'), /REVIEW: APPROVED/);
  assert.ok(def.needs?.includes('reviews'));
});

// --- A. One extra reviewer ---------------------------------------------------------------------------

test('one extra reviewer: main approves first, the co-reviewer asks for changes later, the combine decides; one review comment, the fix prompt has the combined text', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: src/a.ts:3 misses a check.'), { delayMs: 1500 }), MAIN1(APPROVED), COMBINE(CHANGES('Confirmed: src/a.ts:3 misses a check.'))]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:succeeded', '0:combine:succeeded']);
  const ps = prompts(fx).map((p) => p.prompt);
  const fix = ps.find((p) => /asks for changes/.test(p))!;
  assert.match(fix, /Confirmed: src\/a\.ts:3/);
  assert.doesNotMatch(fix, /Co: src\/a\.ts:3/);
  // The co-reviewer's own prompt: the review, the panel's note and the review contract; the combine's has the findings of the others.
  const coPrompt = ps.find((p) => p.includes(CO))!;
  assert.match(coPrompt, /This is review round 1 of 1/);
  assert.match(coPrompt, /REVIEW: APPROVED/);
  const combine = ps.find((p) => /Combine them into the review/.test(p))!;
  assert.match(combine, /Reviewer 2 \(Codex\): CHANGES_REQUESTED\nCo: src\/a\.ts:3 misses a check\./);
  assert.match(combine, /Reviewer 1 \(Claude\), you: APPROVED/);
  assert.equal(reviewComments(fx, id).length, 1);
  assert.match(reviewComments(fx, id)[0].text, /Confirmed/);
  assert.ok(!reviewComments(fx, id).some((c) => /Co: src/.test(c.text)));
  assert.equal(reviewed(fx, id), 1, 'one machine event for the round: the fix started once');
  assert.equal(fx.repo.listRuns(id).filter((r) => r.phase === 'fix').length, 1);
  // The co-reviewer's worker has gone home; its session is kept for the next round.
  assert.equal(coWorker(fx), undefined);
  assert.ok(runs(fx, id).find((r) => r.seat === 1)?.sessionId, 'its session is on its run, for the next round');
});

test('the co-reviewer is on a worker of its own in the task worktree, with its own tool, a seat on its card, and no desk behind the implementer', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(APPROVED, { delayMs: 2000 }), MAIN1(APPROVED), COMBINE(APPROVED)]);
  const id = await start(fx);
  await until('the co-reviewer at work', () => !!coWorker(fx));
  const w = coWorker(fx)!;
  assert.equal(w.provider, 'codex');
  assert.equal(w.kanban?.seat, 1);
  assert.equal(w.kanban?.role, 'reviewer');
  const main = fx.workers.get(fx.task(id).reviewerWorkerId!)!;
  assert.equal(main.provider, 'claude');
  assert.equal(main.kanban?.seat, undefined);
  assert.equal(w.worktree?.path, fx.task(id).workspace?.worktree.path);
  assert.ok(!w.deskId || !w.deskId.includes('watch'), 'a co-reviewer takes a desk, the watch spot is the main reviewer`s');
  assert.equal(fx.task(id).coReviewers?.[0]?.workerId, w.id);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
});

// --- B. The ones that don't finish -----------------------------------------------------------------

test('a co-reviewer still working when the wait runs out is dropped; with no result of its own the main reviewer`s review is the round`s, with no combine run', async (t) => {
  const fx = await setup(t, { engine: { panelWaitMs: 800 } });
  fx.setRules([IMPLEMENT, co(CHANGES('Too late.'), { delayMs: 30_000 }), MAIN1(APPROVED)]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:interrupted']);
  assert.ok(notes(fx, id).some((n) => /Reviewer 2 \(Codex\) did not finish: it was still working/.test(n)), notes(fx, id).join(' | '));
  assert.equal(reviewComments(fx, id).length, 1);
  assert.match(reviewComments(fx, id)[0].text, /Looks right/);
  assert.ok(!prompts(fx).some((p) => /Combine them/.test(p.prompt)));
  assert.equal(coWorker(fx), undefined, 'its worker went home');
});

test('a co-reviewer that never gives a verdict did not finish: the round goes on without it, and says so', async (t) => {
  const fx = await setup(t, { engine: { maxNudges: 0 } });
  fx.setRules([IMPLEMENT, co('I looked at it, it seems fine.'), MAIN1(CHANGES('Main: src/b.ts:9.')), FIX]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  const r = runs(fx, id);
  assert.deepEqual(shape(r), ['0:solo:succeeded', '1:co:failed']);
  assert.match(r[1].error ?? '', /never gave its verdict/);
  assert.ok(notes(fx, id).some((n) => /Reviewer 2 \(Codex\) did not finish: it never gave its verdict/.test(n)));
  assert.equal(reviewed(fx, id), 1);
});

test('a co-reviewer asking in its terminal is not a question for the task: its seat did not finish, the task never waits asking', async (t) => {
  const fx = await setup(t, { extra: [{ tool: 'claude' }] });
  fx.setRules([IMPLEMENT, co('May I run rm -rf build?', { ask: true }), MAIN1(APPROVED)]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.ok(!fx.history(id).some((s) => s.task.waitingReason === 'agent_asking'));
  assert.equal(runs(fx, id).find((r) => r.seat === 1)?.status, 'interrupted');
  assert.deepEqual(shape(runs(fx, id)).filter((x) => x.startsWith('0')), ['0:solo:succeeded']);
});

// --- C. Two extra reviewers, both finishing orders ----------------------------------------------------

for (const order of ['main first', 'main last'] as const) {
  test(`two extra reviewers (codex and claude): ${order}; the combine lists the three and the round is one`, async (t) => {
    const fx = await setup(t, { extra: [{ tool: 'codex' }, { tool: 'claude' }] });
    const slow = { delayMs: 1500 };
    fx.setRules([IMPLEMENT, FIX, co(CHANGES('Codex: a.ts:1.'), { kind: 'codex', ...(order === 'main first' ? slow : {}) }), co(APPROVED, { kind: 'claude', ...(order === 'main first' ? { delayMs: 2500 } : {}) }), MAIN1(CHANGES('Main: m.ts:2.'), order === 'main last' ? { delayMs: 3000 } : {}), COMBINE(CHANGES('Confirmed: a.ts:1 and m.ts:2.'))]);
    const id = await start(fx);
    await fx.waitTask(id, inReview, 'the review column', 50_000);
    const r = runs(fx, id);
    assert.deepEqual(shape(r).filter((x) => x.startsWith('0')), ['0:solo:succeeded', '0:combine:succeeded']);
    assert.deepEqual(r.filter((x) => x.seat).map((x) => `${x.seat}:${x.tool}:${x.status}`).sort(), ['1:codex:succeeded', '2:claude:succeeded']);
    const combine = prompts(fx).find((p) => /Combine them into the review/.test(p.prompt))!.prompt;
    assert.match(combine, /Reviewer 2 \(Codex\): CHANGES_REQUESTED\nCodex: a\.ts:1\./);
    assert.match(combine, /Reviewer 3 \(Claude\): APPROVED/);
    assert.match(combine, /Reviewer 1 \(Claude\), you: CHANGES_REQUESTED\nMain: m\.ts:2\./);
    assert.equal(reviewComments(fx, id).length, 1);
    assert.equal(reviewed(fx, id), 1);
    // The combine was typed into the main reviewer's own session: no third worker for it.
    assert.equal(r.find((x) => x.panel === 'combine')?.workerId, r.find((x) => x.panel === 'solo')?.workerId);
  });
}

// --- D. Seats that fail ----------------------------------------------------------------------------

test('one of two co-reviewers exits mid-turn: the other one is combined, the combine prompt names the one that did not finish', async (t) => {
  const fx = await setup(t, { extra: [{ tool: 'codex' }, { tool: 'claude' }] });
  fx.setRules([IMPLEMENT, FIX, co('x', { kind: 'codex', exit: true }), co(CHANGES('Claude: c.ts:5.'), { kind: 'claude' }), MAIN1(APPROVED), COMBINE(APPROVED)]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  const combine = prompts(fx).find((p) => /Combine them into the review/.test(p.prompt))!.prompt;
  assert.match(combine, /Reviewer 2 \(Codex\): did not finish/);
  assert.match(combine, /Reviewer 3 \(Claude\): CHANGES_REQUESTED/);
  assert.ok(notes(fx, id).some((n) => /Reviewer 2 \(Codex\) did not finish: its agent exited/.test(n)));
  assert.equal(reviewComments(fx, id).length, 1);
});

test('a co-reviewer sent home by a person did not finish: no abandoned review, the round completes with the main reviewer`s own result', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Never said.'), { delayMs: 20_000 }), MAIN1(APPROVED, { delayMs: 800 })]);
  const id = await start(fx);
  await until('the co-reviewer at work', () => !!coWorker(fx));
  await fx.workers.kill(coWorker(fx)!.id, 'keep', undefined, undefined, { by: 'Ada', reason: 'sent-home' });
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.equal(runs(fx, id).find((r) => r.seat === 1)?.status, 'interrupted');
  assert.ok(notes(fx, id).some((n) => /Reviewer 2 \(Codex\) did not finish: Ada sent it home/.test(n)), notes(fx, id).join(' | '));
  assert.ok(!notes(fx, id).some((n) => /review round was dropped/.test(n)));
  assert.equal(reviewComments(fx, id).length, 1);
});

test('the office worker limit: a co-reviewer that cannot be hired is noted and left out, the round completes without it', async (t) => {
  const state = { limit: 1 };
  let fx: EngineFixture | undefined;
  const capacity: Capacity = {
    full: () => ((fx?.workers.list().length ?? 0) >= state.limit ? `The office is at its limit of ${state.limit} worker` : undefined),
    room: () => state.limit - (fx?.workers.list().length ?? 0),
  };
  fx = await setup(t, { capacity });
  fx.setRules([IMPLEMENT, MAIN1(APPROVED, { delayMs: 500 })]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded']);
  assert.ok(notes(fx, id).some((n) => /^Reviewer 2 \(Codex\) could not start: .*limit/.test(n)), notes(fx, id).join(' | '));
  assert.equal(fx.invocations().filter((i) => i.kind === 'codex').length, 0);
});

// --- E. A second round ------------------------------------------------------------------------------

test('changes requested, fixed, reviewed again: the co-reviewers come back on their sessions, a second combine runs with its round', async (t) => {
  const fx = await setup(t, { rounds: 2, extra: [{ tool: 'codex' }, { tool: 'claude' }] });
  const R2 = 'round 2 of 2[\\s\\S]*';
  fx.setRules([
    IMPLEMENT, FIX,
    { when: `${R2}Combine them into the review`, reply: APPROVED },
    { when: `${R2}${CO}`, reply: APPROVED },
    { when: 'Review the changes again \\(round 2 of 2\\)', reply: APPROVED },
    co(CHANGES('Co finds a.ts:1.')),
    MAIN1(APPROVED),
    COMBINE(CHANGES('Confirmed: a.ts:1.')),
  ]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  const r = runs(fx, id);
  assert.equal(r.filter((x) => x.panel === 'combine').length, 2);
  assert.deepEqual(r.filter((x) => x.panel === 'combine').map((x) => x.round), [1, 2]);
  assert.deepEqual(r.filter((x) => x.panel === 'solo').map((x) => x.round), [1, 2]);
  for (const seat of [1, 2]) {
    const mine = r.filter((x) => x.seat === seat);
    assert.deepEqual(mine.map((x) => x.round), [1, 2], `seat ${seat}`);
    assert.equal(mine[1].sessionId, mine[0].sessionId, `seat ${seat} came back on its session`);
  }
  // The main reviewer is typed to in its own session; each co-reviewer is hired again on its stored one.
  const resumes = fx.invocations().filter((i) => !i.prompt && (i.args.includes('--resume') || i.args.includes('resume')));
  assert.deepEqual(resumes.map((i) => i.kind).sort(), ['claude', 'codex']);
  assert.equal(reviewComments(fx, id).length, 2);
  assert.match(reviewComments(fx, id)[1].text, /Looks right/);
  // After the last round the co-reviewers are forgotten with the main reviewer.
  assert.equal(fx.task(id).coReviewers, undefined);
});

test('a co-reviewer whose tool changed since its last round starts a fresh session with the full review prompt', async (t) => {
  const fx = await setup(t, { rounds: 2 });
  fx.setRules([IMPLEMENT, FIX, { when: 'round 2 of 2[\\s\\S]*Combine them', reply: APPROVED }, { when: `round 2 of 2[\\s\\S]*${CO}`, reply: APPROVED }, { when: 'Review the changes again', reply: APPROVED }, co(CHANGES('Co: a.ts:1.')), MAIN1(APPROVED), COMBINE(CHANGES('Confirmed: a.ts:1.'))]);
  const id = await start(fx);
  // Between the rounds, while the implementer fixes, the seat's tool changes to claude.
  await fx.sawTask(id, (x) => x.phase === 'fix', 'the fix', 40_000);
  fx.settings.setProject('proj', { review: { tool: 'claude', rounds: 2, reReviewLastFix: false, extra: [{ tool: 'claude' }] } });
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  const second = runs(fx, id).filter((x) => x.seat === 1);
  assert.deepEqual(second.map((x) => x.tool), ['codex', 'claude']);
  assert.notEqual(second[1].sessionId, second[0].sessionId);
  const coPrompts = prompts(fx).filter((p) => p.prompt.includes(CO));
  assert.match(coPrompts[1].prompt, /This is review round 2 of 2/, 'a fresh session gets the whole review prompt');
});

// --- F. Stop, the main reviewer leaving ------------------------------------------------------------

test('stop while the co-reviewer works (the main reviewer is done): every run of the round ends, the task waits stopped; Retry runs the whole round again', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1(APPROVED)]);
  const id = await start(fx);
  await until('the main reviewer done and the co-reviewer working', () => runs(fx, id).some((r) => r.panel === 'solo' && r.status === 'succeeded') && !!coWorker(fx));
  assert.equal(fx.task(id).runState, 'running', 'the round counts as running between the main reviewer`s review and the combine');
  assert.equal(await fx.engine.retry(id, ADA), 'It is still running');
  assert.equal(await fx.engine.stop(id, ADA), undefined);
  const stopped = await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 15_000);
  assert.equal(stopped.runState, 'idle');
  assert.ok(runs(fx, id).every((r) => r.status !== 'running'), shape(runs(fx, id)).join(' '));
  assert.equal(runs(fx, id).find((r) => r.seat === 1)?.status, 'stopped');
  await until('the co-reviewer sent home', () => !coWorker(fx));
  assert.equal(reviewComments(fx, id).length, 0);
  // Retry: the whole round again, now with a quick co-reviewer.
  fx.setRules([co(CHANGES('Quick: q.ts:1.')), COMBINE(APPROVED), { when: 'was cut short before you finished', reply: APPROVED }, MAIN1(APPROVED)]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  const again = shape(runs(fx, id)).slice(-3);
  assert.deepEqual(again.sort(), ['0:combine:succeeded', '0:solo:succeeded', '1:co:succeeded']);
  assert.equal(reviewComments(fx, id).length, 1);
});

test('stop while the main reviewer and the co-reviewer are both still working: both runs stop, one stop event', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1(APPROVED, { delayMs: 30_000, escSilent: true })]);
  const id = await start(fx);
  await until('both reviewers working', () => !!coWorker(fx) && fx.workers.get(fx.task(id).reviewerWorkerId ?? '')?.status === 'working');
  assert.equal(await fx.engine.stop(id, ADA), undefined);
  await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 20_000);
  await until('every run over', () => runs(fx, id).every((r) => r.status !== 'running'));
  assert.deepEqual(shape(runs(fx, id)).sort(), ['0:solo:stopped', '1:co:stopped']);
  assert.equal(fx.history(id).filter((s) => s.task.waitingReason === 'stopped').length >= 1, true);
});

test('the main reviewer sent home while the co-reviewers work: the round is dropped, the co-reviewers` runs end, the task goes to review', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1(APPROVED, { delayMs: 30_000 })]);
  const id = await start(fx);
  await until('both reviewers working', () => !!coWorker(fx) && !!fx.task(id).reviewerWorkerId && fx.workers.get(fx.task(id).reviewerWorkerId!)?.status === 'working');
  await fx.workers.kill(fx.task(id).reviewerWorkerId!, 'keep', undefined, undefined, { by: 'Ada', reason: 'sent-home' });
  await fx.waitTask(id, (x) => x.status === 'review', 'the review column', 20_000);
  await until('every run over', () => runs(fx, id).every((r) => r.status !== 'running'));
  assert.equal(runs(fx, id).find((r) => r.seat === 1)?.status, 'stopped');
  assert.equal(runs(fx, id).find((r) => !r.seat)?.status, 'stopped');
  await until('the co-reviewer sent home', () => !coWorker(fx));
  assert.equal(reviewComments(fx, id).length, 0);
});

test('the main reviewer exits mid-turn: the round ends interrupted, the co-reviewer`s run with it, the task waits for Retry', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1('x', { exit: true })]);
  const id = await start(fx);
  await fx.waitTask(id, (x) => x.status === 'waiting', 'the task waiting', 30_000);
  await until('every run over', () => runs(fx, id).every((r) => r.status !== 'running'));
  assert.deepEqual(shape(runs(fx, id)).sort(), ['0:solo:interrupted', '1:co:interrupted']);
  await until('the co-reviewer sent home', () => !coWorker(fx));
});

// --- G. An office restart ---------------------------------------------------------------------------

test('the office restarts between the main reviewer`s review and the combine: the seat cut off is dropped and the round is published from the main reviewer`s result', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Cut off.'), { delayMs: 30_000 }), MAIN1(APPROVED)]);
  const id = await start(fx);
  await until('the main reviewer done and the co-reviewer working', () => runs(fx, id).some((r) => r.panel === 'solo' && r.status === 'succeeded') && fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'running'));
  fx.setRules([IMPLEMENT, MAIN1(APPROVED)]);
  await fx.restartOffice();
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:interrupted']);
  assert.equal(reviewComments(fx, id).length, 1);
});

test('the office restarts while the combine runs: it carries on as the combine, not as a round of its own', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: z.ts:1.')), MAIN1(APPROVED), COMBINE(CHANGES('Confirmed: z.ts:1.'), { delayMs: 30_000 }), { when: 'office was restarted', reply: CHANGES('Confirmed after the restart: z.ts:1.') }]);
  const id = await start(fx);
  await until('the combine running', () => fx.repo.listRuns(id).some((r) => r.panel === 'combine' && r.status === 'running') && fx.workers.get(fx.task(id).reviewerWorkerId ?? '')?.status === 'working');
  await fx.restartOffice();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  const mainRuns = shape(runs(fx, id)).filter((x) => x.startsWith('0'));
  assert.equal(mainRuns.filter((x) => x.includes('combine')).length, 2, mainRuns.join(' '));
  assert.equal(mainRuns.filter((x) => x.includes('solo')).length, 1, 'no round of its own');
  assert.equal(reviewComments(fx, id).length, 1);
  assert.equal(reviewed(fx, id), 1);
});

// --- H. No extra reviewers --------------------------------------------------------------------------

test('no additional reviewers: one review run, no panel, nothing of the round`s own in the task', async (t) => {
  const fx = await setup(t, { extra: [] });
  fx.setRules([IMPLEMENT, MAIN1(APPROVED)]);
  const id = await start(fx);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:-:succeeded']);
  assert.equal(fx.task(id).coReviewers, undefined);
  assert.ok(!prompts(fx).some((p) => p.prompt.includes(CO)));
  assert.equal(reviewComments(fx, id).length, 1);
});

// --- An engine restart that leaves the workers' terminals alone -----------------------------------------

test('the engine restarts in the gap, the co-reviewer`s terminal still there: it is followed again, and the round goes on to the combine', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: y.ts:2.'), { delayMs: 3000 }), MAIN1(APPROVED), COMBINE(CHANGES('Confirmed: y.ts:2.'))]);
  const id = await start(fx);
  await until('the main reviewer done and the co-reviewer working', () => runs(fx, id).some((r) => r.panel === 'solo' && r.status === 'succeeded') && fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'running'));
  fx.restartEngine();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:succeeded', '0:combine:succeeded']);
  assert.equal(reviewComments(fx, id).length, 1);
  assert.equal(reviewed(fx, id), 1);
});

// --- Result-review fixes ---------------------------------------------------------------------------

const inGap = (fx: EngineFixture, id: number) => runs(fx, id).some((r) => r.panel === 'solo' && r.status === 'succeeded') && fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'running') && !!coWorker(fx);

test('the implementer sent home in the gap: the task waits interrupted, the co-reviewer`s run is stopped and its worker goes home', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1(APPROVED)]);
  const id = await start(fx);
  await until('the gap', () => inGap(fx, id));
  await fx.workers.kill(fx.task(id).workerId!, 'keep', undefined, undefined, { by: 'Ada', reason: 'sent-home' });
  await fx.waitTask(id, (x) => x.status === 'waiting' && x.runState === 'idle', 'the task waiting', 20_000);
  await until('every run over', () => runs(fx, id).every((r) => r.status !== 'running'));
  assert.equal(runs(fx, id).find((r) => r.seat === 1)?.status, 'stopped');
  await until('the co-reviewer sent home', () => !coWorker(fx));
});

test('the main reviewer sent home in the gap: the round is dropped as when it leaves mid-review, the task goes to review, no combine', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1(APPROVED)]);
  const id = await start(fx);
  await until('the gap', () => inGap(fx, id));
  await fx.workers.kill(fx.task(id).reviewerWorkerId!, 'keep', undefined, undefined, { by: 'Ada', reason: 'sent-home' });
  await fx.waitTask(id, (x) => x.status === 'review', 'the review column', 20_000);
  await until('every run over', () => runs(fx, id).every((r) => r.status !== 'running'));
  assert.ok(!runs(fx, id).some((r) => r.panel === 'combine'));
  assert.equal(runs(fx, id).find((r) => r.seat === 1)?.status, 'stopped');
  assert.ok(notes(fx, id).some((n) => /Ada sent .* home: its review round was dropped/.test(n)), notes(fx, id).join(' | '));
  await until('the co-reviewer sent home', () => !coWorker(fx));
  assert.equal(reviewComments(fx, id).length, 0);
});

test('an old co-reviewer worker leaving after its seat was given to a new one does not wipe the new worker`s id', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(CHANGES('Slow.'), { delayMs: 30_000 }), MAIN1(APPROVED, { delayMs: 30_000 })]);
  const id = await start(fx);
  await until('the co-reviewer at work', () => !!coWorker(fx));
  const old = coWorker(fx)!.id;
  const task = fx.task(id);
  fx.repo.updateTask(id, { coReviewers: task.coReviewers!.map((c) => ({ ...c, workerId: 'a-newer-worker' })) });
  await fx.workers.kill(old, 'keep', undefined, undefined, { by: 'Ada', reason: 'sent-home' });
  await until('the old run over', () => fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status !== 'running'));
  assert.equal(fx.task(id).coReviewers?.[0]?.workerId, 'a-newer-worker');
});

test('a co-reviewer worker the task no longer lists is still sent home when the round ends', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, co(APPROVED, { delayMs: 1500 }), MAIN1(APPROVED), COMBINE(APPROVED)]);
  const id = await start(fx);
  await until('the co-reviewer at work', () => !!coWorker(fx));
  fx.repo.updateTask(id, { coReviewers: fx.task(id).coReviewers!.map((c) => ({ ...c, workerId: undefined })) });
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  await until('no co-reviewer worker left', () => !coWorker(fx));
});

test('a combine run that fails or is interrupted is run again by Retry as a combine: the round`s solo and co results are kept', async (t) => {
  const fx = await setup(t, { engine: { maxNudges: 0 } });
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: k.ts:4.')), MAIN1(APPROVED), COMBINE('I did not decide.')]);
  const id = await start(fx);
  await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the combine failing', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:succeeded', '0:combine:failed']);
  fx.setRules([IMPLEMENT, FIX, COMBINE(CHANGES('Confirmed: k.ts:4.')), { when: 'was cut short before you finished', reply: CHANGES('Confirmed: k.ts:4.') }]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:succeeded', '0:combine:failed', '0:combine:succeeded']);
  assert.equal(reviewComments(fx, id).length, 1);
  assert.equal(reviewed(fx, id), 1);
});

test('the main reviewer exiting during the combine: Retry combines again, not a new round', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: k.ts:4.')), MAIN1(APPROVED), COMBINE('x', { exit: true })]);
  const id = await start(fx);
  await fx.waitTask(id, (x) => x.status === 'waiting', 'the combine ending', 40_000);
  await until('the combine over', () => runs(fx, id).some((r) => r.panel === 'combine' && r.status === 'interrupted'));
  fx.setRules([IMPLEMENT, FIX, COMBINE(CHANGES('Confirmed: k.ts:4.')), co(CHANGES('Co again.')), MAIN1(APPROVED)]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(runs(fx, id)), ['0:solo:succeeded', '1:co:succeeded', '0:combine:interrupted', '0:combine:succeeded']);
});

test('the office restarts during the main reviewer`s own review with the co-reviewer already done: its result is kept, not hired again, and the combine uses it', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: m.ts:7.')), MAIN1(APPROVED, { delayMs: 30_000 })]);
  const id = await start(fx);
  await until('the co-reviewer done, the main reviewer working', () => fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'succeeded') && fx.workers.get(fx.task(id).reviewerWorkerId ?? '')?.status === 'working');
  fx.setRules([IMPLEMENT, FIX, { when: 'office was restarted', reply: APPROVED }, COMBINE(CHANGES('Confirmed: m.ts:7.'))]);
  await fx.restartOffice();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  assert.equal(fx.repo.listRuns(id).filter((r) => r.seat === 1).length, 1, 'the seat was not hired again');
  assert.equal(prompts(fx).filter((p) => p.kind === 'codex').length, 1, 'one prompt to a codex agent');
  const r = shape(runs(fx, id)).filter((x) => x.startsWith('0'));
  assert.deepEqual(r, ['0:solo:interrupted', '0:solo:succeeded', '0:combine:succeeded']);
  assert.match(prompts(fx).find((p) => /Combine them into the review/.test(p.prompt))!.prompt, /Co: m\.ts:7\./);
  assert.equal(reviewComments(fx, id).length, 1);
});

test('the engine restarts during the main reviewer`s own review with the co-reviewer working: it is followed again, one set of co-reviewers', async (t) => {
  const fx = await setup(t);
  fx.setRules([IMPLEMENT, FIX, co(CHANGES('Co: n.ts:1.'), { delayMs: 2500 }), MAIN1(APPROVED, { delayMs: 1500 }), COMBINE(APPROVED)]);
  const id = await start(fx);
  await until('both working', () => !!coWorker(fx) && fx.workers.get(fx.task(id).reviewerWorkerId ?? '')?.status === 'working');
  fx.restartEngine();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  assert.equal(fx.repo.listRuns(id).filter((r) => r.seat === 1).length, 1);
  assert.equal(prompts(fx).filter((p) => p.kind === 'codex').length, 1);
});

test('a co-reviewer`s hooks never touch the task`s asking state', async (t) => {
  const fx = await setup(t, { extra: [{ tool: 'claude' }] });
  fx.setRules([IMPLEMENT, co('May I run rm -rf build?', { ask: true, delayMs: 600 }), MAIN1(APPROVED, { delayMs: 4000 })]);
  const id = await start(fx);
  await until('the co-reviewer at work', () => !!coWorker(fx));
  const calls: unknown[] = [];
  const set = fx.repo.setAskingKind.bind(fx.repo);
  fx.repo.setAskingKind = (taskId, kind) => (calls.push(kind), set(taskId, kind));
  await until('the co-reviewer dropped', () => fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'interrupted'));
  assert.deepEqual(calls, [], 'the co-reviewer`s hooks set and cleared nothing on the task');
});

test('the task`s latest run is never an additional reviewer`s', async (t) => {
  const fx = await setup(t);
  const task = fx.newTask();
  const a = fx.repo.createRun({ taskId: task.id, phase: 'review', role: 'reviewer', tool: 'claude', panel: 'solo' });
  fx.repo.createRun({ taskId: task.id, phase: 'review', role: 'reviewer', tool: 'codex', seat: 1, panel: 'co' });
  assert.equal(fx.repo.latestRunId(task.id), a.id);
});
