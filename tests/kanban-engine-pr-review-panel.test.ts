// A pull-request review with the review settings' additional reviewers (engine/panel.ts in the pr-review phase): the main reviewer's own
// review (solo), one run per additional reviewer (co, in the main reviewer's worktree) and the main reviewer combining them in its own
// session (combine), exactly one `prReviewed` for the round; who owns the worktree; and the review posted on the pull requests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GitRunner } from '../src/server/kanban/engine/prheads.js';
import { PR_POSTED } from '../src/shared/kanban/prompts.js';
import { reviewBody } from '../src/server/kanban/integrations/pulls/postreview.js';
import type { KanbanRun, KanbanTask } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** No network in the tests: every fetch of a head fails, and the review starts on the base branch. */
const noFetch: GitRunner = async () => {
  throw new Error('no network');
};

const APPROVED = 'Looks right.\nREVIEW: APPROVED';
const CO = 'Other reviewers are reviewing this same folder';
const co = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: CO, kind: 'codex', reply, ...more });
const COMBINE = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Combine them into the review', reply, ...more });
const MAIN = (reply: string, more: Partial<Rule> = {}): Rule => ({ when: 'Review these pull requests', kind: 'claude', reply, ...more });
const CO_FINDING = 'The cache of pull request 4 is never cleared.\nREVIEW: CHANGES_REQUESTED';
const COMBINED = 'One confirmed finding: the cache is never cleared.\nREVIEW: CHANGES_REQUESTED';
const pr = (n: number) => ({ repo: 'acme/proj', number: n, title: `PR ${n}`, base: 'main' }) as never;

async function setup(t: { after(fn: () => unknown): void }, extra: { tool: 'claude' | 'codex'; focus?: string }[] = [{ tool: 'codex' }], engine: object = {}) {
  const fx = await engineFixture({ engine: { panelWaitMs: 20_000, prGit: noFetch, ...engine } });
  t.after(() => fx.close());
  fx.settings.setProject('proj', { review: { tool: 'claude', rounds: 1, reReviewLastFix: false, ...(extra.length ? { extra } : {}) } });
  return fx;
}

async function until(what: string, fn: () => boolean, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

const inReview = (x: KanbanTask) => x.status === 'review' && x.runState === 'idle';
const shape = (rs: KanbanRun[]) => rs.map((r) => `${r.phase}:${r.seat ?? 0}:${r.panel ?? '-'}:${r.status}`);
const prRuns = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).filter((r) => r.phase === 'pr-review');
const reviewComments = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'review');
const notes = (fx: EngineFixture, id: number) => fx.repo.listComments(id).comments.filter((c) => c.kind === 'status').map((c) => c.text);
const prompts = (fx: EngineFixture) => fx.invocations().flatMap((i) => (i.prompt ? [{ kind: i.kind, prompt: i.prompt }] : []));
const coWorker = (fx: EngineFixture) => fx.workers.list().find((w) => w.kanban?.seat === 1);
const branchLeft = (fx: EngineFixture, wt: string) => git(fx.dir, 'branch', '--list', 'office/*').includes(path.basename(wt));
const sentHome = { by: 'Ada', reason: 'sent-home' as const };

async function review(fx: EngineFixture, more: object = {}, prs = [pr(3), pr(4)]) {
  const got = await fx.engine.reviewPrs({ project: 'proj', prs, tool: 'claude', ...more }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') throw new Error(got);
  return { id: got.taskId, main: got.workerId! };
}

/** Waits for the worktree and the branch the reviewer's own hire made to be gone (git takes a moment to remove them). */
async function gone(fx: EngineFixture, wt: string) {
  await until('the worktree and its branch to be removed', () => !existsSync(wt) && !branchLeft(fx, wt), 15_000);
}

test('a round: the main reviewer, an additional reviewer in its worktree, and the combine in its own session; one review result, one prReviewed', async (t) => {
  const fx = await setup(t);
  fx.setRules([co(CO_FINDING, { delayMs: 900 }), COMBINE(COMBINED), MAIN(APPROVED)]);
  const { id, main } = await review(fx);
  await until('the additional reviewer', () => !!coWorker(fx));
  const mainInfo = fx.workers.get(main)!;
  const wt = path.join(fx.dir, mainInfo.worktree!.path);
  assert.equal(coWorker(fx)!.worktree!.path, mainInfo.worktree!.path, 'the additional reviewer sits in the main reviewer’s worktree');
  assert.equal(fx.task(id).phase, 'pr-review');

  const done = await fx.waitTask(id, inReview, 'the review column', 30_000);
  assert.deepEqual(shape(prRuns(fx, id)), ['pr-review:0:solo:succeeded', 'pr-review:1:co:succeeded', 'pr-review:0:combine:succeeded']);
  const [solo, coRun, combine] = prRuns(fx, id);
  assert.equal(combine.workerId, solo.workerId, 'the combine went on in the main reviewer’s own session, no new hire');
  assert.equal(coRun.tool, 'codex');
  assert.equal(fx.repo.runLaunch(coRun.id), undefined, 'an additional reviewer’s run keeps no launch record');
  assert.equal(combine.verdict, 'changes_requested');
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [COMBINED], 'only the round’s result is the task’s review: the solo and the additional reviewer’s are not');
  assert.equal(done.reviewerWorkerId, undefined, 'the main reviewer went home');
  assert.equal(done.coReviewers, undefined);
  assert.equal(fx.workers.list().length, 0, 'nobody is left at a desk');
  // Exactly one prReviewed: the task entered Review once (a second would have put it there again).
  assert.equal(fx.history(id).filter((s) => s.task.status === 'review' && s.task.runState === 'idle').filter((s, i, all) => i === 0 || all[i - 1].task.status !== 'review').length, 1);
  // The combine prompt names the pull requests and the reviews, in no task-and-round language.
  const combinePrompt = prompts(fx).find((p) => /Combine them into the review/.test(p.prompt))!.prompt;
  assert.match(combinePrompt, /- acme\/proj#3 “PR 3”/);
  assert.match(combinePrompt, /Reviewer 2 \(Codex\): CHANGES_REQUESTED\nThe cache of pull request 4 is never cleared\./);
  assert.doesNotMatch(combinePrompt, /task #|round \d of/);
  // The additional reviewer's prompt is the review prompt and the additional reviewer's rule.
  const coPrompt = prompts(fx).find((p) => p.kind === 'codex' && /Review these pull requests/.test(p.prompt))!.prompt;
  assert.ok(coPrompt.includes(CO));
  await gone(fx, wt);
});

test('the worktree is the main reviewer’s: an additional reviewer sent home does not take it, the main reviewer leaving last does', async (t) => {
  const fx = await setup(t);
  fx.setRules([co('Never finishes in time.\nREVIEW: APPROVED', { delayMs: 8000 }), MAIN(APPROVED, { delayMs: 2500 })]);
  const { id, main } = await review(fx);
  await until('the additional reviewer', () => !!coWorker(fx));
  const wt = path.join(fx.dir, fx.workers.get(main)!.worktree!.path);
  const second = coWorker(fx)!.id;
  await fx.workers.kill(second, undefined, undefined, undefined, sentHome); // a person's departure: the default cleanup would take the worktree if it were not guarded
  assert.equal(fx.workers.get(second), undefined);
  assert.ok(existsSync(wt), 'the main reviewer still sits in it');
  assert.ok(fx.workers.get(main), 'and is still at its desk');
  const done = await fx.waitTask(id, inReview, 'the review column', 30_000);
  assert.ok(notes(fx, id).some((n) => /Reviewer 2 \(Codex\) did not finish: Ada sent it home/.test(n)), notes(fx, id).join(' | '));
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [APPROVED], 'the seat that did not finish adds nothing: the main reviewer’s own review is the result');
  assert.equal(done.status, 'review');
  await gone(fx, wt);
});

test('a person sends the main reviewer home mid-round: the round is dropped, the task is in Review, and the worktree and its branch are cleaned up', async (t) => {
  const fx = await setup(t);
  fx.setRules([co('Not yet.\nREVIEW: APPROVED', { delayMs: 8000 }), MAIN(APPROVED, { delayMs: 8000 })]);
  const { id, main } = await review(fx);
  await until('the additional reviewer', () => !!coWorker(fx));
  const wt = path.join(fx.dir, fx.workers.get(main)!.worktree!.path);
  await fx.workers.kill(main, undefined, undefined, undefined, sentHome);
  const done = await fx.waitTask(id, inReview, 'the review column', 15_000);
  assert.ok(notes(fx, id).some((n) => /Ada sent .* home.*its review round was dropped, and the task is in Review/.test(n)), notes(fx, id).join(' | '));
  await until('the additional reviewer to be gone', () => !coWorker(fx), 15_000);
  assert.deepEqual(prRuns(fx, id).map((r) => `${r.seat ?? 0}:${r.status}`).sort(), ['0:stopped', '1:stopped']);
  assert.equal(done.reviewerWorkerId, undefined);
  await gone(fx, wt);
  assert.equal(fx.workers.list().length, 0);
});

test('the main reviewer gone before the combine: nobody is hired, the task fails with why, and Retry reviews the pull requests again', async (t) => {
  const fx = await setup(t);
  fx.setRules([co(CO_FINDING, { delayMs: 2500 }), COMBINE(COMBINED), MAIN(APPROVED)]);
  const { id, main } = await review(fx);
  await until('the main reviewer’s own review', () => prRuns(fx, id)[0]?.status === 'succeeded');
  const wt = path.join(fx.dir, fx.workers.get(main)!.worktree!.path);
  // The office itself takes the main reviewer away (its departure is no one's decision for the task): the additional reviewer still runs.
  await fx.workers.kill(main, undefined, undefined, undefined, { by: 'Kanban', reason: 'engine' });
  const failed = await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the failure', 30_000);
  assert.match(failed.waitingText ?? '', /reviews could not be combined: The main reviewer is no longer at its desk/);
  assert.equal(prompts(fx).filter((p) => /Combine them into the review/.test(p.prompt)).length, 0, 'no combine prompt was typed anywhere');
  assert.equal(fx.invocations().filter((i) => i.prompt && /Review these pull requests/.test(i.prompt)).length, 2, 'and nobody was hired for it: the main reviewer and the additional one only');
  assert.deepEqual(shape(prRuns(fx, id)), ['pr-review:0:solo:succeeded', 'pr-review:1:co:succeeded', 'pr-review:0:combine:failed']);
  await gone(fx, wt);
  // Retry runs the round again from the start, in a worktree of its own (not another combine that can never start).
  fx.setRules([co(CO_FINDING), COMBINE(COMBINED), MAIN(APPROVED)]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  const again = await fx.waitTask(id, inReview, 'the review column after the retry', 30_000);
  assert.equal(again.status, 'review');
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [COMBINED]);
});

test('without additional reviewers a pull-request review is one run, as before', async (t) => {
  const fx = await setup(t, []);
  fx.setRules([MAIN(APPROVED)]);
  const { id } = await review(fx);
  const done = await fx.waitTask(id, inReview, 'the review column', 20_000);
  assert.deepEqual(shape(prRuns(fx, id)), ['pr-review:0:-:succeeded']);
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [APPROVED]);
  assert.equal(done.coReviewers, undefined);
  assert.equal(fx.invocations().filter((i) => i.kind === 'codex').length, 0);
});

// --- An office restart in the middle of a round ----------------------------------------------------

const coRunning = (fx: EngineFixture, id: number) => fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'running');

test('the office restarts between the main reviewer’s review and the combine: the seat cut off is dropped and the round is published from the main reviewer’s result', async (t) => {
  const fx = await setup(t);
  fx.setRules([co(CO_FINDING, { delayMs: 30_000 }), MAIN(APPROVED)]);
  const { id } = await review(fx);
  await until('the main reviewer done and the additional reviewer working', () => prRuns(fx, id).some((r) => r.panel === 'solo' && r.status === 'succeeded') && coRunning(fx, id));
  fx.setRules([MAIN(APPROVED)]);
  await fx.restartOffice();
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  assert.deepEqual(shape(prRuns(fx, id)), ['pr-review:0:solo:succeeded', 'pr-review:1:co:interrupted']);
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [APPROVED]);
  await until('everyone is gone', () => fx.workers.list().length === 0, 15_000);
});

test('the office restarts while the combine runs: it carries on as the combine in the main reviewer’s own session, not as a round of its own', async (t) => {
  const fx = await setup(t);
  fx.setRules([co(CO_FINDING), MAIN(APPROVED), COMBINE(COMBINED, { delayMs: 30_000 })]);
  const { id } = await review(fx);
  await until('the combine running', () => prRuns(fx, id).some((r) => r.panel === 'combine' && r.status === 'running') && fx.workers.get(fx.task(id).reviewerWorkerId ?? '')?.status === 'working');
  fx.setRules([COMBINE(COMBINED)]);
  await fx.restartOffice();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  const main = shape(prRuns(fx, id)).filter((x) => x.startsWith('pr-review:0'));
  assert.equal(main.filter((x) => x.includes('combine')).length, 2, main.join(' '));
  assert.equal(main.filter((x) => x.includes('solo')).length, 1, 'no round of its own');
  assert.equal(prompts(fx).filter((p) => /Review these pull requests/.test(p.prompt)).length, 2, 'no new review prompt: the main reviewer and the additional one only');
  assert.equal(prompts(fx).filter((p) => /Combine them into the review/.test(p.prompt)).length, 2, 'the combine, typed again into the same session');
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [COMBINED]);
  assert.equal(fx.history(id).filter((s) => s.task.status === 'review' && s.task.runState === 'idle').filter((s, i, all) => i === 0 || all[i - 1].task.status !== 'review').length, 1);
});

test('the engine restarts in the gap with the additional reviewer’s terminal still there: it is followed again, and the round goes on to the combine', async (t) => {
  const fx = await setup(t);
  fx.setRules([co(CO_FINDING, { delayMs: 1500 }), MAIN(APPROVED), COMBINE(COMBINED)]);
  const { id } = await review(fx);
  await until('the main reviewer done and the additional reviewer working', () => prRuns(fx, id).some((r) => r.panel === 'solo' && r.status === 'succeeded') && coRunning(fx, id) && coWorker(fx)?.status === 'working');
  fx.restartEngine();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  assert.deepEqual(shape(prRuns(fx, id)), ['pr-review:0:solo:succeeded', 'pr-review:1:co:succeeded', 'pr-review:0:combine:succeeded']);
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [COMBINED]);
});

test('the office restarts during the main reviewer’s own review with the additional reviewer already done: its result is kept, not hired again, and the combine uses it', async (t) => {
  const fx = await setup(t);
  fx.setRules([co(CO_FINDING), MAIN(APPROVED, { delayMs: 30_000 })]);
  const { id } = await review(fx);
  await until('the additional reviewer done, the main reviewer working', () => fx.repo.listRuns(id).some((r) => r.seat === 1 && r.status === 'succeeded') && fx.workers.get(fx.task(id).reviewerWorkerId ?? '')?.status === 'working');
  fx.setRules([{ when: 'office was restarted', reply: APPROVED }, COMBINE(COMBINED)]);
  await fx.restartOffice();
  await fx.waitTask(id, inReview, 'the review column', 60_000);
  assert.equal(fx.repo.listRuns(id).filter((r) => r.seat === 1).length, 1, 'the seat was not hired again');
  assert.equal(prompts(fx).filter((p) => p.kind === 'codex').length, 1, 'one prompt to a codex agent');
  assert.deepEqual(shape(prRuns(fx, id)).filter((x) => x.startsWith('pr-review:0')), ['pr-review:0:solo:interrupted', 'pr-review:0:solo:succeeded', 'pr-review:0:combine:succeeded']);
  assert.match(prompts(fx).find((p) => /Combine them into the review/.test(p.prompt))!.prompt, /The cache of pull request 4 is never cleared\./);
  assert.deepEqual(reviewComments(fx, id).map((c) => c.text), [COMBINED]);
});

// --- Posting ---------------------------------------------------------------------------------------

interface Post {
  project: string;
  prs: { repo: string; number: number }[];
  text: string;
  account?: string;
  opts?: { verdict?: string; cut?: boolean };
}

/** A postReview that records its calls, and answers each pull request with a URL (or with an error when `fail` is set). */
function poster(fx: EngineFixture, fail?: 'error' | 'throw') {
  const calls: Post[] = [];
  (fx.ctx.pulls as { postReview?: unknown }).postReview = async (project: string, prs: Post['prs'], text: string, account?: string, opts?: Post['opts']) => {
    calls.push({ project, prs, text, ...(account ? { account } : {}), ...(opts ? { opts } : {}) });
    if (fail === 'throw') throw new Error('gh fell over');
    return prs.map((p) => (fail ? { repo: p.repo, number: p.number, error: 'Resource not accessible by integration' } : { repo: p.repo, number: p.number, url: `https://github.com/${p.repo}/pull/${p.number}#pullrequestreview-9` }));
  };
  return calls;
}

test('post: the round’s final text is posted once, on every pull request, and the task says so', async (t) => {
  const fx = await setup(t);
  const calls = poster(fx);
  fx.setRules([co(CO_FINDING), COMBINE(COMBINED), MAIN(APPROVED)]);
  const { id } = await review(fx, { post: true });
  await fx.waitTask(id, inReview, 'the review column', 30_000);
  await until('the note about the posting', () => notes(fx, id).filter((n) => /^Posted the review on/.test(n)).length === 2);
  assert.equal(calls.length, 1, 'once for the round: not for the main reviewer’s own review or the additional reviewer’s');
  assert.equal(calls[0].project, 'proj');
  assert.deepEqual(calls[0].prs.map((p) => p.number), [3, 4]);
  assert.match(calls[0].text, /^One confirmed finding: the cache is never cleared\.\nREVIEW: CHANGES_REQUESTED$/, 'the combine run’s text, as the reviewer wrote it (the posting strips the verdict line)');
  assert.ok(notes(fx, id).includes('Posted the review on acme/proj#3: https://github.com/acme/proj/pull/3#pullrequestreview-9'));
  assert.ok(notes(fx, id).includes('Posted the review on acme/proj#4: https://github.com/acme/proj/pull/4#pullrequestreview-9'));
  // The reply is told it is posted, in the main reviewer's, the additional reviewer's and the combine prompt alike.
  const all = prompts(fx).filter((p) => /Review these pull requests|Combine them into the review/.test(p.prompt));
  assert.equal(all.length, 3);
  for (const p of all) assert.ok(p.prompt.includes(PR_POSTED), `${p.kind} is told its reply is posted`);
  assert.equal(fx.repo.listEvents(id).filter((e) => e.kind === 'pr.review').map((e) => (e.data as { request: { post?: boolean } }).request.post).join(), 'true', 'the request keeps `post` for a Retry');
});

test('post: a review with no additional reviewers posts its own text', async (t) => {
  const fx = await setup(t, []);
  const calls = poster(fx);
  fx.setRules([MAIN('The two fit together.\nREVIEW: APPROVED')]);
  const { id } = await review(fx, { post: true });
  await fx.waitTask(id, inReview, 'the review column', 20_000);
  await until('the posting', () => calls.length === 1);
  assert.equal(calls[0].text, 'The two fit together.\nREVIEW: APPROVED');
  assert.ok(prompts(fx).some((p) => p.prompt.includes(PR_POSTED)));
});

test('without post nothing is posted and the prompts carry no word about it', async (t) => {
  const fx = await setup(t);
  const calls = poster(fx);
  fx.setRules([co(CO_FINDING), COMBINE(COMBINED), MAIN(APPROVED)]);
  const { id } = await review(fx);
  await fx.waitTask(id, inReview, 'the review column', 30_000);
  await sleep(300);
  assert.equal(calls.length, 0);
  assert.ok(!notes(fx, id).some((n) => /Posted the review|Could not post/.test(n)));
  assert.ok(prompts(fx).every((p) => !p.prompt.includes(PR_POSTED)));
  assert.equal(fx.repo.listEvents(id).filter((e) => e.kind === 'pr.review').some((e) => 'post' in ((e.data as { request: object }).request)), false);
});

for (const how of ['error', 'throw'] as const) {
  test(`post: a posting that ${how === 'error' ? 'is refused' : 'throws'} is a note, never the task’s state`, async (t) => {
    const fx = await setup(t, []);
    const calls = poster(fx, how);
    fx.setRules([MAIN(APPROVED)]);
    const { id } = await review(fx, { post: true }, [pr(3)]);
    const done = await fx.waitTask(id, inReview, 'the review column', 20_000);
    await until('the note', () => notes(fx, id).some((n) => /^Could not post the review on acme\/proj#3: /.test(n)));
    assert.match(notes(fx, id).find((n) => /^Could not post/.test(n))!, how === 'error' ? /Resource not accessible by integration/ : /gh fell over/);
    assert.equal(calls.length, 1);
    assert.equal(done.status, 'review');
    assert.equal(fx.task(id).status, 'review', 'still in Review after the note');
    assert.equal(fx.repo.listRuns(id)[0].status, 'succeeded');
  });
}

test('post: a stopped run posts nothing, and its Retry keeps the choice and posts once', async (t) => {
  const fx = await setup(t, []);
  const calls = poster(fx);
  fx.setRules([MAIN(APPROVED, { delayMs: 6000 })]);
  const { id, main } = await review(fx, { post: true }, [pr(3)]);
  await until('the reviewer to work', () => fx.workers.get(main)?.status === 'working');
  assert.equal(await fx.engine.stop(id, ADA), undefined);
  await fx.waitTask(id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 20_000);
  await sleep(200);
  assert.equal(calls.length, 0, 'a stopped run posts nothing');
  fx.setRules([MAIN('Fine after all.\nREVIEW: APPROVED')]);
  assert.equal(await fx.engine.retry(id, ADA), undefined);
  await fx.waitTask(id, inReview, 'the review column after the retry', 30_000);
  await until('the posting', () => calls.length === 1);
  assert.equal(calls[0].text, 'Fine after all.\nREVIEW: APPROVED');
  await sleep(200);
  assert.equal(calls.length, 1, 'once');
});

test('post: with additional reviewers that never deliver, a long approving review is posted whole with the verdict it ended with', async (t) => {
  const fx = await setup(t, [{ tool: 'codex' }], { panelWaitMs: 800 });
  const calls = poster(fx);
  const findings = Array.from({ length: 2000 }, (_, i) => `Finding ${i}: a note.`).join('\n');
  const long = `${findings}\nREVIEW: APPROVED`;
  assert.ok(long.length > 40_000);
  fx.setRules([co('never', { delayMs: 60_000 }), MAIN(long)]);
  const { id } = await review(fx, { post: true });
  await fx.waitTask(id, inReview, 'the review column', 40_000);
  await until('the posting', () => calls.length === 1);
  assert.equal(calls[0].opts?.verdict, 'approved', 'the run’s own verdict, not one read from a cut text');
  assert.equal(calls[0].opts?.cut, false);
  assert.equal(calls[0].text, long, 'the whole text, not the run’s clipped summary');
  assert.ok(fx.repo.listRuns(id)[0].summary!.length < long.length, 'the run row keeps only the start');
  const body = reviewBody([pr(3), pr(4)], calls[0].text, calls[0].opts as never);
  assert.match(body, /^\*\*Review by Agent Office: approved\*\*/);
  assert.ok(body.includes('Finding 1999: a note.') && !/REVIEW: APPROVED/.test(body) && !/cut/.test(body));
});

test('post: the review is posted as the account that asked, not the task’s creator, and a Retry keeps it', async (t) => {
  const fx = await setup(t, []);
  const calls = poster(fx);
  fx.setRules([MAIN('Fine.\nREVIEW: APPROVED', { delayMs: 3000 })]);
  const task = fx.newTask({ usePlan: false, useReview: false, createdByAccount: 'acc-creator' } as never);
  fx.repo.updateTask(task.id, { status: 'review', runState: 'idle' });
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [pr(3)], taskId: task.id, tool: 'claude', post: true }, { name: 'Bea', admin: true, accountId: 'acc-asker' });
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.equal(got.taskId, task.id, 'on the task that owns the pull request');
  assert.equal((fx.repo.listEvents(task.id).find((e) => e.kind === 'pr.review')!.data as { account?: string }).account, 'acc-asker');
  await until('the reviewer to work', () => fx.workers.get(got.workerId!)?.status === 'working');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped', 'the stop', 20_000);
  await until('the stopped reviewer to rest', () => ['idle', 'done'].includes(fx.workers.get(got.workerId!)?.status ?? ''));
  fx.setRules([MAIN('Fine.\nREVIEW: APPROVED')]);
  assert.equal(await fx.engine.retry(task.id, { name: 'Cy', admin: true, accountId: 'acc-other' }), undefined);
  await fx.waitTask(task.id, inReview, 'the review column', 30_000);
  await until('the posting', () => calls.length === 1);
  assert.equal(calls[0].account, 'acc-asker');
});
