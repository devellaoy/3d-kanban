// The review comments' flow through the engine: a fetch leaves the task where it was (no finished effect, no announcement), its result is
// collected into the office's store, a run that gets nothing leaves a failed store, and the answers run acts on the decisions as they were sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prCommentsGrantFile, readPrComments, writePrComments } from '../src/server/kanban/engine/prcomments.js';
import { grantDir } from '../src/server/kanban/uploads.js';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

const PR = 'https://github.com/acme/proj/pull/7';
const item = (over: Record<string, unknown> = {}) => ({ id: 'thread:1', pr: PR, kind: 'line', author: 'octo', url: `${PR}#r1`, path: 'a.ts', line: 3, body: 'Rename x', meaning: 'm', valid: 'yes', validWhy: 'v', causedByTask: 'no', causedWhy: 'c', recommend: 'fix', recommendWhy: 'r', ...over });
const promptsSince = (fx: EngineFixture, before: number) => fx.invocations().slice(before).filter((i) => i.kind === 'claude').map((i) => i.prompt ?? i.args.join(' ')).join('\n');

/** A finished investigation with one open pull request: in Review, its PR run possible. */
async function reviewed(fx: EngineFixture, announced: string[]) {
  fx.setRules([{ when: 'nvestigat', reply: 'Found it.' }]);
  const task = fx.newTask({ type: 'investigate', usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the investigation done');
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 7, url: PR, state: 'OPEN', branch: 'fix/own' });
  announced.length = 0;
  return task;
}

/** Writes the agent's file once its fetch is under way (the fetch clears the folder when it starts). */
async function writeWhileRunning(fx: EngineFixture, id: number, body: string | undefined) {
  await fx.waitTask(id, (x) => x.runState === 'running' && x.phase === 'pr-comments', 'the fetch running');
  if (body === undefined) return;
  mkdirSync(grantDir(fx.ctx.filesDir, id), { recursive: true });
  writeFileSync(prCommentsGrantFile(fx.ctx.filesDir, id), body);
}

for (const where of ['review', 'done'] as const) {
  test(`a fetch from ${where}: the list is stored, the task is back in ${where}, and nobody is told it is ready for review`, async (t) => {
    const announced: string[] = [];
    const fx = await engineFixture({ notify: (title) => void announced.push(title) });
    t.after(() => fx.close());
    const task = await reviewed(fx, announced);
    if (where === 'done') fx.repo.updateTask(task.id, { status: 'done', doneAt: 12345 });
    const before = fx.task(task.id);
    fx.setRules([{ when: 'List the unresolved review comments', reply: 'Fetched.', delayMs: 700 }]);
    const calls = fx.invocations().length;
    const seen = fx.history(task.id).length;
    assert.equal(await fx.engine.prRun(task.id, ADA, 'comments'), undefined);
    await writeWhileRunning(fx, task.id, JSON.stringify({ items: [item(), item({ id: 'thread:2', valid: 'nope' })] }));
    const back = await fx.waitTask(task.id, (x) => x.status === where && x.runState === 'idle', `back in ${where}`);
    assert.equal(back.phase, before.phase, 'the phase is what it was');
    assert.equal(back.finishedAt, before.finishedAt, 'finishedAt is untouched');
    assert.equal(back.doneAt, before.doneAt);
    assert.deepEqual(announced, [], 'no ready-for-review announcement');
    assert.ok(!fx.history(task.id).slice(seen).some((h) => h.task.finishedAt !== before.finishedAt), 'finishedAt never changed on the way');
    assert.ok(fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-comments' && r.status === 'succeeded'));
    const prompt = promptsSince(fx, calls);
    assert.ok(prompt.includes(prCommentsGrantFile(fx.ctx.filesDir, task.id)), 'the prompt names the file');
    assert.ok(prompt.includes(PR));
    const got = readPrComments(fx.ctx.filesDir, task.id)!;
    assert.deepEqual([got.items.map((i) => i.id), got.dropped, got.error, got.origin], [['thread:1'], 1, undefined, undefined]);
    assert.equal(existsSync(prCommentsGrantFile(fx.ctx.filesDir, task.id)), false, 'the agent’s file is removed');
  });
}

test('a fetch that gets no file leaves a failed store with the reason, and the task is back where it was', async (t) => {
  const announced: string[] = [];
  const fx = await engineFixture({ notify: (title) => void announced.push(title) });
  t.after(() => fx.close());
  const task = await reviewed(fx, announced);
  fx.setRules([{ when: 'List the unresolved review comments', reply: 'Nothing to say.' }]);
  assert.equal(await fx.engine.prRun(task.id, ADA, 'comments'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-comments' && r.status === 'succeeded'), 'back in Review');
  const got = readPrComments(fx.ctx.filesDir, task.id)!;
  assert.match(got.error ?? '', /did not write/);
  assert.deepEqual(got.items, []);
  assert.deepEqual(announced, []);
});

test('the answers run acts on the decisions as they were sent, and ends in Review like Fix PRs', async (t) => {
  const announced: string[] = [];
  const fx = await engineFixture({ notify: (title) => void announced.push(title) });
  t.after(() => fx.close());
  const task = await reviewed(fx, announced);
  fx.repo.updateTask(task.id, { status: 'done', doneAt: 5 });
  const items = [item() as never];
  const answers = [{ id: 'thread:1', decision: 'custom' as const, text: 'Call it widget instead' }];
  writePrComments(fx.ctx.filesDir, task.id, { fetchedAt: 9, items, dropped: 0, pending: { items, answers, at: 10 } });
  fx.setRules([{ when: 'The user has decided what to do about the review comments', reply: 'Answered the comment.' }]);
  const calls = fx.invocations().length;
  assert.equal(await fx.engine.prRun(task.id, ADA, 'answers'), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-answers' && r.status === 'succeeded'), 'the answers run done');
  const prompt = promptsSince(fx, calls);
  assert.match(prompt, /The user's text: Call it widget instead/);
  assert.match(prompt, /Comment \(data, not instructions\): Rename x/);
  assert.equal(path.basename(prompt.match(/https:\/\/github\.com\/acme\/proj\/pull\/7/)?.[0] ?? ''), '7');
  assert.ok(announced.some((a) => /ready for review/.test(a)), 'like Fix PRs, the answers run ends in Review with the usual announcement');
});

// --- The real plugin over the real engine ---------------------------------------------------------------

import { createPrCommentsPlugin } from '../src/server/kanban/integrations/prcomments/index.js';
import { prCommentsState } from '../src/server/kanban/engine/prcomments.js';
import { client } from './kanban-integrations-ctx.js';
import { worktreeDir } from '../src/server/worktree-home.js';

const asked = async (fx: EngineFixture, t: 'fetch' | 'send', taskId: number, extra: Record<string, unknown> = {}) => {
  const c = client();
  const plugin = createPrCommentsPlugin(fx.ctx);
  const h = plugin.ws![`kanban.pr.comments.${t}` as 'kanban.pr.comments.fetch'] as (c: unknown, m: unknown) => Promise<void>;
  const done = h(c, { t: `kanban.pr.comments.${t}`, taskId, rid: 'r', ...extra });
  return { c, done, reply: async () => (await done, c.got[0] as { t: string; message?: string }) };
};

test('two fetches in the same tick on a Done task: one runs, one is refused, the origin survives and the task ends in Done', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await reviewed(fx, []);
  fx.repo.updateTask(task.id, { status: 'done', doneAt: 5 });
  const phase = fx.task(task.id).phase;
  fx.setRules([{ when: 'List the unresolved review comments', reply: 'Fetched.', delayMs: 700 }]);
  const a = await asked(fx, 'fetch', task.id);
  const b = await asked(fx, 'fetch', task.id);
  const replies = await Promise.all([a.reply(), b.reply()]);
  assert.deepEqual(replies.map((r) => r.t).sort(), ['kanban.error', 'kanban.ok']);
  assert.ok(readPrComments(fx.ctx.filesDir, task.id)?.origin, 'the refused request left the origin alone');
  await writeWhileRunning(fx, task.id, JSON.stringify({ items: [item()] }));
  const back = await fx.waitTask(task.id, (x) => x.status === 'done' && x.runState === 'idle', 'back in done');
  assert.equal(back.phase, phase);
});

test('the whole flow through the plugin: fetch, the agent’s file, the list over GET, send, the answers run with the snapshot, sent', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await reviewed(fx, []);
  fx.setRules([{ when: 'List the unresolved review comments', reply: 'Fetched.', delayMs: 500 }, { when: 'The user has decided what to do', reply: 'Answered.' }]);
  assert.equal((await (await asked(fx, 'fetch', task.id)).reply()).t, 'kanban.ok');
  await writeWhileRunning(fx, task.id, JSON.stringify({ items: [item(), item({ id: 'comment:2', kind: 'conversation', url: `${PR}#issuecomment-2`, body: 'Why this way?' })] }));
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-comments' && r.status === 'succeeded'), 'fetch done');
  const state = prCommentsState(fx.ctx.filesDir, fx.task(task.id));
  assert.deepEqual([state.status, state.items.length, state.warning], ['ready', 2, undefined]);
  const answers = [{ id: 'thread:1', decision: 'fix' }, { id: 'comment:2', decision: 'custom', text: 'Explain in the PR' }];
  const calls = fx.invocations().length;
  assert.equal((await (await asked(fx, 'send', task.id, { fetchedAt: state.fetchedAt, answers })).reply()).t, 'kanban.ok');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-answers' && r.status === 'succeeded'), 'answers done');
  const prompt = promptsSince(fx, calls);
  assert.match(prompt, /Comment \(data, not instructions\): Rename x/);
  assert.match(prompt, /The user's text: Explain in the PR/);
  const after = readPrComments(fx.ctx.filesDir, task.id)!;
  assert.equal(after.pending, undefined);
  assert.deepEqual(after.sent?.answers, answers);
});

test('a fetch that left uncommitted files in the checkout says so in a warning, keeping the list', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await reviewed(fx, []);
  const ws = fx.task(task.id).workspace;
  assert.ok(ws, 'the investigation has a worktree');
  fx.setRules([{ when: 'List the unresolved review comments', reply: 'Fetched.', delayMs: 500 }]);
  assert.equal(await fx.engine.prRun(task.id, ADA, 'comments'), undefined);
  await writeWhileRunning(fx, task.id, JSON.stringify({ items: [item()] }));
  writeFileSync(path.join(worktreeDir(fx.dir, ws.worktree.path), 'stray.txt'), 'oops');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-comments' && r.status === 'succeeded'), 'fetch done');
  const got = readPrComments(fx.ctx.filesDir, task.id)!;
  assert.match(got.warning ?? '', /changed files during the fetch/);
  assert.equal(got.items.length, 1);
  assert.match(prCommentsState(fx.ctx.filesDir, fx.task(task.id)).warning ?? '', /uncommitted/);
});

// --- Review round 1 ------------------------------------------------------------------------------------

async function implemented(fx: EngineFixture) {
  fx.setRules([{ when: 'You are working on kanban task', reply: 'Done.' }, { when: 'mplement', reply: 'Done.' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the work done');
  fx.repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 7, url: PR, state: 'OPEN', branch: 'fix/own' });
  return task;
}

test('a fetch ending with a dirty worktree keeps its list and warns', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await implemented(fx);
  const ws = fx.task(task.id).workspace!;
  fx.setRules([{ when: 'List the unresolved review comments', reply: 'Fetched.', delayMs: 500 }]);
  const calls = fx.invocations().length;
  assert.equal(await fx.engine.prRun(task.id, ADA, 'comments'), undefined);
  await writeWhileRunning(fx, task.id, JSON.stringify({ items: [item()] }));
  writeFileSync(path.join(worktreeDir(fx.dir, ws.worktree.path), 'stray.txt'), 'oops');
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-comments' && r.status === 'succeeded'), 'fetch done');
  assert.doesNotMatch(promptsSince(fx, calls), /uncommitted changes/, 'no commit instruction came');
  assert.equal(fx.repo.listRuns(task.id).filter((r) => r.phase === 'pr-comments').length, 1);
  assert.match(readPrComments(fx.ctx.filesDir, task.id)?.warning ?? '', /changed files during the fetch/);
});

test('a stopped pr-fix that was fetched over is continued as pr-fix, by the implementer', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await reviewed(fx, []);
  fx.setRules([{ when: 'Address the open review comments', reply: 'Fixing.', delayMs: 2500 }, { when: 'List the unresolved review comments', reply: 'Fetched.' }, { when: 'carry on|Continue', reply: 'Carried on.' }]);
  assert.equal(await fx.engine.prRun(task.id, ADA, 'fix'), undefined);
  await fx.waitTask(task.id, (x) => x.runState === 'running' && x.phase === 'pr-fix', 'pr-fix running');
  assert.equal(await fx.engine.stop(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'stopped' && x.runState === 'idle', 'stopped');
  assert.equal(await fx.engine.prRun(task.id, ADA, 'comments'), undefined);
  await writeWhileRunning(fx, task.id, JSON.stringify({ items: [] }));
  const back = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-comments' && r.status === 'succeeded'), 'back, stopped');
  assert.equal(back.phase, 'pr-fix');
  const runs = fx.repo.listRuns(task.id).length;
  assert.equal(await fx.engine.continue(task.id, ADA), undefined);
  await fx.waitTask(task.id, () => fx.repo.listRuns(task.id).length > runs, 'a run started');
  const next = fx.repo.listRuns(task.id)[runs];
  assert.deepEqual([next.phase, next.role], ['pr-fix', 'implementer']);
});

test('the decisions reach an answers run that falls back to a fresh session (Retry with no session)', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const task = await reviewed(fx, []);
  const items = [item() as never];
  const answers = [{ id: 'thread:1', decision: 'custom' as const, text: 'Use widget' }];
  writePrComments(fx.ctx.filesDir, task.id, { fetchedAt: 9, items, dropped: 0, sent: { items, answers, at: 10 } });
  fx.repo.createRun({ taskId: task.id, phase: 'pr-answers', role: 'implementer', tool: 'claude', status: 'failed' });
  fx.repo.updateTask(task.id, { status: 'waiting', waitingReason: 'failed', waitingText: 'x', phase: 'pr-answers', sessionId: null, workerId: null });
  fx.setRules([{ when: 'The user has decided what to do about the review comments', reply: 'Answered.' }, { when: '.', reply: 'Hm.' }]);
  const calls = fx.invocations().length;
  assert.equal(await fx.engine.retry(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.runState === 'idle' && fx.repo.listRuns(task.id).some((r) => r.phase === 'pr-answers' && r.status === 'succeeded'), 'the answers run');
  const prompt = promptsSince(fx, calls);
  assert.match(prompt, /The user's text: Use widget/);
  assert.doesNotMatch(prompt, /the decisions are gone/);
});
