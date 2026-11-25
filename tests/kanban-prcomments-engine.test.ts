// The office's side of a task's review comments: the machine (a fetch returns the task to where it was, the answers end in Review), collecting the
// agent's file into the store, the plugin's checks and roll-backs, and the two prompts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { next, type Effect, type MachineEvent, type MachineState, type MachineTask } from '../src/server/kanban/engine/machine.js';
import { FAILED_START, PrCommentsRuns, prCommentsFile, prCommentsGrantFile, prCommentsState, readPrComments, removePrComments, writePrComments } from '../src/server/kanban/engine/prcomments.js';
import { createPrCommentsPlugin } from '../src/server/kanban/integrations/prcomments/index.js';
import { KANBAN_CONTRACTS, PROMPT_CONTRACT } from '../src/shared/kanban/prompts.js';
import { PR_COMMENTS_FILE_MAX, type PrCommentAnswer, type PrCommentItem } from '../src/shared/kanban/prcomments.js';
import { PR_MODES } from '../src/shared/kanban/prs.js';
import { grantDir } from '../src/server/kanban/uploads.js';
import { visitorPath } from '../src/server/multiplayer/paths.js';
import { client, makeCtx, WHO } from './kanban-integrations-ctx.js';
import { setupCompose } from './kanban-prcomments-compose.js';

// --- The machine ------------------------------------------------------------------------------------

const TASK: MachineTask = { type: 'implement', usePlan: true, useReview: true, planApproval: 'auto' };
const CFG = { rounds: 2, reReviewLastFix: true };
const at = (patch: Partial<MachineState>): MachineState => ({ status: 'review', runState: 'idle', reviewRound: 1, retryAttempts: 0, ...patch });
const step = (s: MachineState, e: MachineEvent) => {
  const r = next(s, e, TASK, CFG);
  assert.ok(!('error' in r), `${e.type}: ${'error' in r ? r.error : ''}`);
  return r as { state: MachineState; effects: Effect[] };
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const origin = (effects: Effect[]) => effects.find((e): e is Extract<Effect, { type: 'commentsOrigin' }> => e.type === 'commentsOrigin');

for (const [name, from] of [
  ['done', at({ status: 'done', phase: 'review' })],
  ['review', at({ status: 'review', phase: 'fix' })],
  ['waiting', at({ status: 'waiting', phase: 'pr-fix', waitingReason: 'stopped', waitingText: 'Stopped by Ada' })],
] as const) {
  test(`a fetch of review comments from ${name} returns to ${name}, with no finished effect`, () => {
    const started = step(from, { type: 'pr', mode: 'comments' });
    assert.equal(started.state.status, 'in_progress');
    assert.equal(started.state.phase, 'pr-comments');
    assert.deepEqual(started.effects.map((e) => e.type), ['commentsOrigin', 'run']);
    assert.deepEqual(started.effects[1], { type: 'run', phase: 'pr-comments', role: 'implementer', prompt: 'pr.comments' });
    const back = origin(started.effects)!.back;
    assert.equal(back.from, name);
    // Finished, stopped, failed, interrupted or given up on: the same place, the same wait, the same phase.
    for (const e of [{ type: 'prCommentsDone', back }, { type: 'stopped', by: 'Ada', back }, { type: 'failed', error: 'boom', back }, { type: 'interrupted', back }, { type: 'gaveUp', text: 'limit', back }] as MachineEvent[]) {
      const ended = step({ ...started.state, runState: 'running' }, e);
      assert.deepEqual(plain(ended.state), plain({ ...from, runState: 'idle', retryAttempts: 0 }), e.type);
      assert.ok(!ended.effects.some((x) => x.type === 'finished' || x.type === 'run'), `${e.type}: nothing finishes or runs`);
    }
    assert.deepEqual(step({ ...started.state, runState: 'running' }, { type: 'prCommentsDone', back }).effects, [], 'no note, no toast');
  });
}

test('a fetch that is stopped while it waits for a desk returns too; one with comments typed meanwhile works on them', () => {
  const from = at({ status: 'done', phase: 'review' });
  const started = step(from, { type: 'pr', mode: 'comments' });
  const back = origin(started.effects)!.back;
  const queued = step({ ...started.state, runState: 'queued' }, { type: 'stop', back });
  assert.equal(queued.state.status, 'done');
  assert.equal(queued.state.runState, 'idle');
  // A running fetch is interrupted as any run is, not sent back by the stop request.
  assert.deepEqual(step({ ...started.state, runState: 'running' }, { type: 'stop', back }).effects, [{ type: 'interrupt' }]);
  const pending = step({ ...started.state, runState: 'running' }, { type: 'prCommentsDone', back, pending: true });
  assert.deepEqual(pending.effects, [{ type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', pending: true }]);
  // Without where it was (an old store), a finished fetch goes to Review.
  assert.equal(step({ ...started.state, runState: 'running' }, { type: 'prCommentsDone' }).state.status, 'review');
});

test('a fetch parked on a usage limit keeps its origin when it is fetched again, and still ends where it began', () => {
  const from = at({ status: 'done', phase: 'review' });
  const started = step(from, { type: 'pr', mode: 'comments' });
  const back = origin(started.effects)!.back;
  const parked = step({ ...started.state, runState: 'running' }, { type: 'limited', retryAt: 9, attempts: 1 });
  assert.equal(parked.state.status, 'waiting');
  assert.equal(parked.state.phase, 'pr-comments');
  const again = step(parked.state, { type: 'pr', mode: 'comments' });
  assert.equal(origin(again.effects), undefined, 'a parked fetch never records where it was again');
  assert.deepEqual(again.effects.map((e) => e.type), ['run']);
  const ended = step({ ...again.state, runState: 'running' }, { type: 'prCommentsDone', back });
  assert.equal(ended.state.status, 'done');
  assert.equal(ended.state.phase, 'review');
  assert.equal(prCommentsState('/nowhere', { id: 1, phase: 'pr-comments', runState: 'idle', status: 'waiting', waitingText: 'Usage limit' }).waiting, 'Usage limit');
  assert.equal(prCommentsState('/nowhere', { id: 1, phase: 'pr-comments', runState: 'idle', status: 'waiting', waitingText: 'Usage limit' }).status, 'running');
});

test('a fetch is refused as the other PR runs are: busy, or a column the PR actions are not offered from', () => {
  assert.ok('error' in next(at({ runState: 'running' }), { type: 'pr', mode: 'comments' }, TASK, CFG));
  assert.ok('error' in next(at({ status: 'todo' }), { type: 'pr', mode: 'answers' }, TASK, CFG));
  assert.ok('error' in next(at({ status: 'on_hold' }), { type: 'pr', mode: 'comments' }, TASK, CFG));
});

test('the answers run ends in Review like Fix PRs, and a retried or queued run keeps its own prompt', () => {
  const started = step(at({ status: 'done', phase: 'review' }), { type: 'pr', mode: 'answers' });
  assert.deepEqual(started.effects, [{ type: 'run', phase: 'pr-answers', role: 'implementer', prompt: 'pr.answers' }]);
  const ended = step({ ...started.state, runState: 'running' }, { type: 'prDone' });
  assert.equal(ended.state.status, 'review');
  assert.ok(ended.effects.some((e) => e.type === 'finished'));
  for (const [phase, prompt] of [['pr-answers', 'pr.answers'], ['pr-comments', 'pr.comments']] as const) {
    const failed = at({ status: 'waiting', phase, waitingReason: 'failed', waitingText: 'x' });
    const retried = step(failed, { type: 'retry', last: { phase, role: 'implementer', fresh: true } });
    assert.equal((retried.effects[0] as Extract<Effect, { type: 'run' }>).prompt, prompt, 'a run that never started goes with its own prompt');
    assert.equal((step(failed, { type: 'retry', last: { phase, role: 'implementer' } }).effects[0] as Extract<Effect, { type: 'run' }>).prompt, 'continue');
  }
});

test('the public PR message cannot start these runs', () => {
  assert.deepEqual([...PR_MODES], ['create', 'fix', 'conflicts']);
});

// --- Collecting the agent's file ----------------------------------------------------------------------

const PR = 'https://github.com/acme/web/pull/7';
const item = (over: Record<string, unknown> = {}) => ({ id: 'thread:1', pr: PR, kind: 'line', author: 'octo', url: 'https://github.com/acme/web/pull/7#r1', path: 'a.ts', line: 3, body: 'Fix this', meaning: 'm', valid: 'yes', validWhy: 'v', causedByTask: 'no', causedWhy: 'c', recommend: 'fix', recommendWhy: 'r', ...over });

function store() {
  const filesDir = mkdtempSync(path.join(tmpdir(), 'prcomments-'));
  const runs = new PrCommentsRuns({ filesDir }, () => 1000);
  const grant = (id: number) => (mkdirSync(grantDir(filesDir, id), { recursive: true }), prCommentsGrantFile(filesDir, id));
  return { filesDir, runs, grant, done: () => rmSync(filesDir, { recursive: true, force: true }) };
}
const taskOf = (id = 5) => ({ id, prs: [{ url: PR }] }) as unknown as Parameters<PrCommentsRuns['collect']>[0];

test('collect: the agent’s file is validated into the office’s store and the file is deleted', (t) => {
  const s = store();
  t.after(s.done);
  const file = s.grant(5);
  writeFileSync(file, JSON.stringify({ items: [item(), item({ id: 'thread:2', valid: 'maybe' })] }));
  const said = s.runs.collect(taskOf());
  assert.match(said, /Fetched 1 unresolved review comment \(1 left out/);
  const got = readPrComments(s.filesDir, 5)!;
  assert.equal(got.fetchedAt, 1000);
  assert.equal(got.dropped, 1);
  assert.deepEqual(got.items.map((i) => i.id), ['thread:1']);
  assert.equal(got.error, undefined);
  assert.equal(existsSync(file), false, 'the agent’s file is gone');
  assert.equal(prCommentsState(s.filesDir, { id: 5, phase: 'pr-fix', runState: 'idle' }).status, 'ready');
  assert.equal(prCommentsState(s.filesDir, { id: 5, phase: 'pr-comments', runState: 'running' }).status, 'running', 'running while its fetch is');
  assert.equal(prCommentsState(s.filesDir, { id: 6, phase: 'pr-fix', runState: 'idle' }).status, 'none');
});

test('collect: a missing, broken, oversize, non-file or linked file is a failed store with a reason', (t) => {
  const s = store();
  t.after(s.done);
  const failed = (id: number, why: RegExp) => {
    s.runs.collect(taskOf(id));
    const got = readPrComments(s.filesDir, id)!;
    assert.match(got.error ?? '', why);
    assert.deepEqual(got.items, []);
    assert.equal(prCommentsState(s.filesDir, { id, phase: 'pr-fix', runState: 'idle' }).status, 'failed');
    assert.equal(existsSync(prCommentsGrantFile(s.filesDir, id)), false, 'what was left is removed');
  };
  failed(1, /did not write/); // no file, not even a folder
  writeFileSync(s.grant(2), '{ not json');
  failed(2, /not valid JSON/);
  writeFileSync(s.grant(3), '{"items": "x"}');
  failed(3, /no list of comments/);
  writeFileSync(s.grant(4), '');
  truncateSync(prCommentsGrantFile(s.filesDir, 4), PR_COMMENTS_FILE_MAX + 1);
  failed(4, /over 1 MB/);
  mkdirSync(s.grant(5));
  rmSync(prCommentsGrantFile(s.filesDir, 5), { recursive: true });
  mkdirSync(prCommentsGrantFile(s.filesDir, 5));
  failed(5, /other than a plain file/);
  if (process.platform !== 'win32') {
    const outside = path.join(s.filesDir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ items: [item()] }));
    symlinkSync(outside, s.grant(6));
    failed(6, /other than a plain file/);
    assert.equal(existsSync(outside), true, 'the target of the link is left alone');
  }
});

test('a fetch that ends badly leaves a failed store, not a silent empty one, and puts the task back; a finished one keeps its list', (t) => {
  const s = store();
  t.after(s.done);
  const back = { from: 'done' as const, phase: 'review' as const };
  const t5 = { id: 5, phase: 'pr-comments' as const, runState: 'running' as const };
  s.runs.origin(5, back);
  assert.deepEqual(readPrComments(s.filesDir, 5)?.origin, back);
  const e = s.runs.ending(t5, { type: 'failed', error: 'The agent crashed' });
  assert.deepEqual(e, { type: 'failed', error: 'The agent crashed', back });
  const got = readPrComments(s.filesDir, 5)!;
  assert.match(got.error ?? '', /The agent crashed/);
  assert.equal(got.origin, undefined);
  // Events of other runs pass as they are; a stop of a running fetch is the interrupt's, not an end.
  assert.deepEqual(s.runs.ending({ ...t5, phase: 'pr-fix' }, { type: 'failed', error: 'x' }), { type: 'failed', error: 'x' });
  assert.deepEqual(s.runs.ending(t5, { type: 'stop' }), { type: 'stop' });
  s.runs.origin(5, back);
  assert.deepEqual(s.runs.ending({ ...t5, runState: 'queued' }, { type: 'stop' }), { type: 'stop', back });
  assert.match(readPrComments(s.filesDir, 5)!.error ?? '', /Stopped before it started/);
  // A turn that ended: the list collected stays, only where it was is let go.
  s.runs.origin(5, back);
  writeFileSync(s.grant(5), JSON.stringify({ items: [item()] }));
  s.runs.collect(taskOf());
  assert.deepEqual(s.runs.ending(t5, { type: 'prCommentsDone' }), { type: 'prCommentsDone', back });
  const kept = readPrComments(s.filesDir, 5)!;
  assert.equal(kept.items.length, 1);
  assert.equal(kept.origin, undefined);
  s.runs.origin(5, back);
  assert.deepEqual(readPrComments(s.filesDir, 5)?.items, [], 'a new fetch starts from nothing');
  removePrComments(s.filesDir, 5);
  assert.equal(existsSync(prCommentsFile(s.filesDir, 5)), false);
});

// --- The plugin ---------------------------------------------------------------------------------------

function plug(engine: (mode: string) => string | void) {
  const ctx = makeCtx([{ id: 'p', name: 'P', dir: '/x/p', palette: 0, addedBy: 't', addedAt: 0 }]);
  const task = ctx.repo.createTask({ project: 'p', title: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T' });
  const calls: string[] = [];
  ctx.engine = {
    prRun: async (_id: number, _who: unknown, mode: string) => {
      calls.push(mode);
      return engine(mode);
    },
  } as unknown as typeof ctx.engine;
  const plugin = createPrCommentsPlugin(ctx, () => 5000);
  const items = ['thread:1', 'comment:2'].map((id) => ({ ...item({ id }), pr: PR, kind: id.startsWith('thread') ? 'line' : 'conversation' }) as unknown as PrCommentItem);
  writePrComments(ctx.filesDir, task.id, { fetchedAt: 100, items, dropped: 0 });
  const answers: PrCommentAnswer[] = [{ id: 'thread:1', decision: 'fix' }, { id: 'comment:2', decision: 'skip' }];
  const send = async (patch: Record<string, unknown> = {}) => {
    const c = client();
    await plugin.ws!['kanban.pr.comments.send']!(c, { t: 'kanban.pr.comments.send', taskId: task.id, fetchedAt: 100, answers, rid: 'r', ...patch } as never);
    return c.got[0] as { t: string; message?: string };
  };
  const fetch = async () => {
    const c = client();
    await plugin.ws!['kanban.pr.comments.fetch']!(c, { t: 'kanban.pr.comments.fetch', taskId: task.id, rid: 'r' });
    return c.got[0] as { t: string; message?: string };
  };
  return { ctx, task, calls, plugin, items, answers, send, fetch, store: () => readPrComments(ctx.filesDir, task.id)! };
}

test('send: a stale fetchedAt, an unknown id and incomplete answers are refused before the engine hears of it', async () => {
  const p = plug(() => undefined);
  assert.match((await p.send({ fetchedAt: 99 })).message ?? '', /fetch them again/);
  assert.match((await p.send({ answers: [...p.answers, { id: 'thread:9', decision: 'fix' }] })).message ?? '', /no comment thread:9/);
  assert.match((await p.send({ answers: [p.answers[0]] })).message ?? '', /Decide every comment/);
  assert.match((await p.send({ answers: [p.answers[0], { id: 'comment:2', decision: 'custom' }] })).message ?? '', /Decide every comment/);
  assert.deepEqual(p.calls, []);
  assert.equal(p.store().pending, undefined);
  assert.equal(p.store().sent, undefined);
  assert.match((await p.send({ taskId: 999 })).message ?? '', /no task #999/);
});

test('send: the decisions are kept as sent while the run starts, then marked sent; a second send of the same list is refused', async () => {
  let seen: unknown;
  const p = plug(() => void (seen = readPrComments(p.ctx.filesDir, p.task.id)!.pending));
  assert.equal((await p.send()).t, 'kanban.ok');
  assert.deepEqual(p.calls, ['answers']);
  assert.deepEqual((seen as { answers: unknown; at: number }).answers, p.answers, 'the run saw the decisions');
  const after = p.store();
  assert.equal(after.pending, undefined);
  assert.deepEqual(after.sent?.answers, p.answers);
  assert.equal(after.sent?.at, 5000);
  const state = prCommentsState(p.ctx.filesDir, { id: p.task.id, phase: 'pr-answers', runState: 'idle' });
  assert.deepEqual([state.status, state.fetchedAt, state.sent?.answers.length, state.items.length], ['ready', 100, 2, 2]);
  assert.match((await p.send()).message ?? '', /sent already/);
  assert.deepEqual(p.calls, ['answers']);
});

test('send: when the engine refuses, the pending answers are rolled back and its reason is the answer', async () => {
  const p = plug(() => 'Stop it first: it is running');
  const r = await p.send();
  assert.equal(r.message, 'Stop it first: it is running');
  assert.equal(p.store().pending, undefined);
  assert.equal(p.store().sent, undefined);
  assert.equal(p.store().items.length, 2, 'the list is as it was');
  assert.deepEqual(p.ctx.changed.slice(-1), [p.task.id]);
});

test('fetch: asks the engine for a fetch; when it refuses, the old list is back', async () => {
  const p = plug((mode) => {
    // The engine clears the old list when a fetch starts, then fails to launch.
    writePrComments(p.ctx.filesDir, p.task.id, { items: [], dropped: 0, error: `${FAILED_START}no desk` });
    return mode === 'comments' ? 'There is no free desk' : undefined;
  });
  const before = p.store();
  const r = await p.fetch();
  assert.equal(r.message, 'There is no free desk');
  assert.deepEqual(p.store(), before);
  assert.deepEqual(p.calls, ['comments']);
  const ok = plug(() => undefined);
  assert.equal((await ok.fetch()).t, 'kanban.ok');
  assert.equal((await plug(() => undefined).fetch()).t, 'kanban.ok');
});

test('fetch: refused on a task that is running, the store (with where the fetch came from) is left alone', async () => {
  const p = plug(() => 'Stop it first: it is running');
  p.ctx.repo.updateTask(p.task.id, { status: 'in_progress', runState: 'running', phase: 'pr-comments' });
  writePrComments(p.ctx.filesDir, p.task.id, { items: [], dropped: 0, origin: { from: 'done' } });
  assert.match((await p.fetch()).message ?? '', /Stop it first/);
  assert.deepEqual(p.store().origin, { from: 'done' });
});

test('a pending that no pr-answers run carries is not a sent list: it is dropped on read, and the list can be sent again', async () => {
  const p = plug(() => undefined);
  writePrComments(p.ctx.filesDir, p.task.id, { ...p.store(), pending: { items: p.items, answers: p.answers, at: 1 } });
  assert.equal(prCommentsState(p.ctx.filesDir, { id: p.task.id, phase: 'pr-fix', runState: 'idle' }).sent, undefined);
  assert.equal(prCommentsState(p.ctx.filesDir, { id: p.task.id, phase: 'pr-answers', runState: 'running' }).sent?.at, 1);
  assert.equal((await p.send()).t, 'kanban.ok');
  assert.equal(p.store().sent?.at, 5000);
});

test('GET: the state of the task’s comments, for a visitor too; other routes and methods are left alone', async () => {
  const p = plug(() => undefined);
  const call = async (url: string, method = 'GET') => {
    let status = 0;
    let body = '';
    const res = { writeHead: (s: number) => ((status = s), res), end: (b?: string) => void (body = b ?? '') } as unknown as ServerResponse;
    const handled = await p.plugin.http!['/api/kanban/tasks/']({ method } as IncomingMessage, res, new URL(url, 'http://x'), WHO);
    return { handled, status, body };
  };
  const ok = await call(`/api/kanban/tasks/${p.task.id}/pr-comments`);
  assert.equal(ok.status, 200);
  const state = JSON.parse(ok.body) as { status: string; fetchedAt: number; items: unknown[]; dropped: number };
  assert.deepEqual([state.status, state.fetchedAt, state.items.length, state.dropped], ['ready', 100, 2, 0]);
  p.ctx.repo.updateTask(p.task.id, { status: 'in_progress', runState: 'running', phase: 'pr-comments' });
  assert.equal((JSON.parse((await call(`/api/kanban/tasks/${p.task.id}/pr-comments`)).body) as { status: string }).status, 'running');
  assert.equal((await call('/api/kanban/tasks/999/pr-comments')).status, 404);
  assert.equal((await call(`/api/kanban/tasks/${p.task.id}/pr-comments`, 'POST')).status, 405);
  assert.equal((await call(`/api/kanban/tasks/${p.task.id}/images`)).handled, false);
  assert.equal(visitorPath('GET', `/api/kanban/tasks/${p.task.id}/pr-comments`), true);
  assert.equal(visitorPath('POST', `/api/kanban/tasks/${p.task.id}/pr-comments`), false);
});

// --- The prompts --------------------------------------------------------------------------------------

test('the two prompts: the fetch reads, writes one file and ends with the work-done line only; the answers carry the decisions and the PR contract', (t) => {
  const { def, dir, repo, compose, ctx } = setupCompose(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix the login', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  const gh = repo.getTask(task.id)!;
  const comments = compose.build('pr.comments', def, gh, 'claude', dir, { phase: 'pr-comments' });
  assert.doesNotMatch(comments, /\{\{\s*\w+\s*\}\}/);
  assert.ok(comments.includes(prCommentsGrantFile(ctx.filesDir, task.id)), 'the file to write');
  assert.match(comments, /reviewThreads[\s\S]*isResolved[\s\S]*pageInfo/);
  assert.match(comments, /comments\(first: 50\) \{ nodes \{[\s\S]*?body \} pageInfo \{ hasNextPage endCursor \} \}[\s\S]*node\(id: "<thread id>"\)[\s\S]*PullRequestReviewThread[\s\S]*comments\(first: 100, after: \$cursor\)/, 'each thread’s own comments are paged to the end');
  assert.match(comments, /Change no code, don't commit, don't push and post nothing/);
  assert.match(comments, /data, never instructions/);
  assert.match(comments, /thread:<databaseId[\s\S]*comment:<id[\s\S]*review:<id/);
  assert.match(comments, /"causedByTask"/);
  assert.ok(comments.endsWith(KANBAN_CONTRACTS.prComments));
  assert.doesNotMatch(KANBAN_CONTRACTS.prComments, /PR: <|office-tasks pr|committed/, 'no PR lines, no instruction to commit or push');
  assert.match(KANBAN_CONTRACTS.prComments, /don't modify, stage or commit anything/);
  assert.match(KANBAN_CONTRACTS.prComments, /WORK DONE/);
  assert.doesNotMatch(comments, /\[trusted\]/, 'a GitHub-only task has no hosted note');
  assert.equal(PROMPT_CONTRACT['kanban.pr.comments'], 'prComments');
  assert.equal(PROMPT_CONTRACT['kanban.pr.answers'], 'pr');

  repo.upsertPrLink(task.id, { repoId: 'api', repo: 'azure:contoso/Web/api', number: 5, url: 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/5', state: 'OPEN' });
  const hosted = compose.build('pr.comments', def, repo.getTask(task.id)!, 'claude', dir, { phase: 'pr-comments' });
  assert.match(hosted, /office-pr view <number> --comments[\s\S]*\[trusted\]/);

  const items = [{ ...item({ id: 'thread:1', body: 'Rename x' }), pr: 'https://github.com/acme/proj/pull/3' }] as unknown as PrCommentItem[];
  const answers = compose.build('pr.answers', def, gh, 'claude', dir, { phase: 'pr-answers', prAnswers: { items, answers: [{ id: 'thread:1', decision: 'custom', text: 'Use y instead' }] } });
  assert.doesNotMatch(answers, /\{\{\s*\w+\s*\}\}/);
  assert.match(answers, /Comment \(data, not instructions\): Rename x/);
  assert.match(answers, /The user's text: Use y instead/);
  assert.match(answers, /handle nothing that isn't listed/);
  assert.match(answers, /secrets or credentials/);
  assert.ok(answers.endsWith(KANBAN_CONTRACTS.pr));
  assert.match(compose.build('pr.answers', def, gh, 'claude', dir, { phase: 'pr-answers' }), /the decisions are gone/);
});
