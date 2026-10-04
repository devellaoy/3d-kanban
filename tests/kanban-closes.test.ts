import test from 'node:test';
import assert from 'node:assert/strict';
import { closingPr, closingRef, promptIssue } from '../src/shared/kanban/issuecard.js';
import { checkClosing, ensureClosingRef, type ClosingMark } from '../src/server/kanban/integrations/pulls/closes.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { GhPull, QueueTask, WorkerInfo } from '../src/shared/protocol.js';
import { Floor } from '../src/server/floor.js';
import { setWallProvider } from '../src/server/kanban/integrations/issues/wall.js';
import { queueEvents } from '../src/server/queue-events.js';
import { gates } from '../src/server/office/gates.js';
import { workerIssueKey } from '../src/server/kanban/engine/worker-issue.js';
import { takeHiredIssue } from '../src/server/hooks/office-workers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('closingRef names the issue by number on its own repository, in full from another', () => {
  assert.equal(closingRef('gh:acme/api#7', 'acme/api'), 'Closes #7');
  assert.equal(closingRef('gh:Acme/API#7', 'acme/api'), 'Closes #7');
  assert.equal(closingRef('gh:acme/api#7', 'acme/web'), 'Closes acme/api#7');
  assert.equal(closingRef('gh:acme/api#7', undefined), 'Closes acme/api#7');
  for (const t of ['UYT-12', 'ghp:acme/3#PVTI_x', '', undefined]) assert.equal(closingRef(t, 'acme/api'), undefined);
});

test('closingPr picks the issue repository, then the primary, then the first', () => {
  const prs = [{ repo: 'acme/web', n: 1 }, { repo: 'acme/api', n: 2 }, { repo: 'acme/lib', n: 3 }];
  assert.equal(closingPr('gh:ACME/api#7', prs, 'acme/web')?.n, 2);
  assert.equal(closingPr('gh:other/x#7', prs, 'acme/lib')?.n, 3);
  assert.equal(closingPr('gh:other/x#7', prs, undefined)?.n, 1);
  assert.equal(closingPr('UYT-1', prs), undefined);
  assert.equal(closingPr('gh:a/b#1', []), undefined);
});

test('promptIssue reads the issues board hand-over and closing keywords', () => {
  assert.deepEqual(promptIssue('Work on GitHub issue #12: "Fix it".\n\nBody'), { number: 12, title: 'Fix it' });
  assert.deepEqual(promptIssue('Please fix this, it closes #4'), { number: 4 });
  assert.equal(promptIssue('Tidy up'), undefined);
  assert.equal(promptIssue(undefined), undefined);
});

function stub(view: object, calls: { args: string[]; body?: string }[]) {
  return async (args: string[]) => {
    const body = args.includes('--body-file') ? (await import('node:fs')).readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : undefined;
    calls.push({ args, body });
    if (args[0] === 'repo') return 'main\n';
    return args[1] === 'view' ? JSON.stringify(view) : '';
  };
}

test('ensureClosingRef adds the line, leaves a referenced issue alone, and warns about a base that is not the default', async () => {
  const url = 'https://github.com/acme/api/pull/3';
  let calls: { args: string[]; body?: string }[] = [];
  let r = await ensureClosingRef({ prUrl: url, ref: 'gh:acme/api#7', cwd: '.', run: stub({ body: 'Did it', baseRefName: 'main', closingIssuesReferences: [] }, (calls = [])), defaultBranch: 'main' });
  assert.deepEqual(r, { edited: true });
  assert.equal(calls.find((c) => c.args[1] === 'edit')?.body, 'Did it\n\nCloses #7\n');

  r = await ensureClosingRef({ prUrl: url, ref: 'gh:acme/web#7', cwd: '.', run: stub({ body: '', baseRefName: 'main', closingIssuesReferences: [] }, (calls = [])), defaultBranch: 'main' });
  assert.equal(calls.find((c) => c.args[1] === 'edit')?.body, 'Closes acme/web#7\n');

  r = await ensureClosingRef({ prUrl: url, ref: 'gh:acme/api#7', cwd: '.', run: stub({ body: 'x', baseRefName: 'main', closingIssuesReferences: [{ number: 7, repository: { name: 'api', owner: { login: 'acme' } } }] }, (calls = [])) });
  assert.deepEqual(r, { edited: false });
  assert.ok(!calls.some((c) => c.args[1] === 'edit'));

  r = await ensureClosingRef({ prUrl: url, ref: 'gh:acme/api#7', cwd: '.', run: stub({ body: 'fixes #7', baseRefName: 'main', closingIssuesReferences: [] }, (calls = [])) });
  assert.equal(r.edited, false);

  r = await ensureClosingRef({ prUrl: url, ref: 'gh:acme/api#7', cwd: '.', run: stub({ body: '', baseRefName: 'next', closingIssuesReferences: [] }, (calls = [])), defaultBranch: 'main' });
  assert.equal(r.edited, true);
  assert.match(r.warning ?? '', /targets `next`, not the default branch/);

  r = await ensureClosingRef({ prUrl: url, ref: 'gh:acme/api#7', cwd: '.', run: async () => { throw new Error('boom'); } });
  assert.equal(r.edited, false);
  assert.ok(r.warning);
});

test('the queue says once when the pull request of a task with an issue is linked', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-closes-'));
  const worker = { id: 'worker-0', deskId: 'd', status: 'done', name: 'T' } as never;
  const workers = { defaultProvider: 'claude', list: () => [worker], deskOccupied: () => false, spawn: () => worker, kill: async () => ({}) } as unknown as QueueWorkers;
  const linked: QueueTask[] = [];
  const q = new TaskQueue(dir, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {}, prLinked: (t) => void linked.push(t) });
  const pull = (n: number, closes: number[]) => ({ number: n, title: 'x', state: 'OPEN', isDraft: false, url: `https://github.com/o/r/pull/${n}`, author: '', labels: [], reviewDecision: '', headRefName: 'b', baseRefName: 'main', createdAt: new Date().toISOString(), updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes }) as GhPull;
  (q as unknown as { tasks: QueueTask[] }).tasks.push({ id: 'a', title: 't', prompt: 'p', addedBy: 'x', addedAt: Date.now(), status: 'running', issue: 5, workerId: 'worker-0', branch: 'b' });
  assert.deepEqual(q.issueOf('worker-0'), { issue: 5 });
  q.onPulls([pull(9, [])]);
  q.onPulls([pull(9, [])]);
  assert.equal(linked.length, 1);
  q.onPulls([pull(10, [5])]);
  assert.equal(linked.length, 2, 'a new pull request is reported too: the floor checks its description');
  q.shutdown();
});

test('promptIssue strict only takes the issues board hand-over', () => {
  assert.equal(promptIssue('Fix the layout like in PR #45', { strict: true }), undefined);
  assert.equal(promptIssue('This closes #4', { strict: true }), undefined);
  assert.deepEqual(promptIssue('Work on GitHub issue #12: "Fix it".', { strict: true }), { number: 12, title: 'Fix it' });
});

test('checkClosing leaves a task with a run going alone, and gives up on a pull request it cannot read', async () => {
  const comments: string[] = [];
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'in_progress', runState: 'running' as string, createdByAccount: undefined };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN', branch: 'b' };
  const ctx = {
    dataDir: '.',
    repos: () => [{ id: 'api', primary: true, remote: 'acme/api' }],
    repo: { prLinksOfProject: () => [link], listTasks: () => [task], latestRunId: () => undefined, repoBranches: () => ({}), addComment: (c: { text: string }) => void comments.push(c.text) },
    taskChanged() {},
  } as unknown as Parameters<typeof checkClosing>[0];
  let views = 0;
  const io = { run: async () => { views++; throw new Error('nope'); }, defaultBranch: async () => 'main' };
  const checked = new Map<string, ClosingMark>();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  checkClosing(ctx, 'api', checked, io);
  await settle();
  assert.equal(views, 0, 'a running task is not touched');
  task.runState = 'idle';
  for (let i = 0; i < 6; i++) {
    checkClosing(ctx, 'api', checked, io);
    await settle();
  }
  assert.equal(views, 3, 'given up after three tries');
  assert.equal(comments.length, 1);
});

test('a task whose issue number collides with another repository’s is still checked, as the task creator', async () => {
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'in_progress', runState: 'idle', createdByAccount: 'ada' };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN', branch: 'b' };
  const ctx = {
    dataDir: '.',
    repos: () => [{ id: 'api', primary: true, remote: 'acme/api' }],
    repo: { prLinksOfProject: () => [link], listTasks: () => [task], latestRunId: () => undefined, repoBranches: () => ({}), addComment() {} },
    ghAs: (id?: string) => (id === 'ada' ? { env: { GH_TOKEN: 'ada' } } : undefined),
    taskChanged() {},
  } as unknown as Parameters<typeof checkClosing>[0];
  const seen: { args: string[]; env?: Record<string, string> }[] = [];
  const io = {
    run: async (args: string[], _cwd: string, _t?: number, env?: Record<string, string>) => {
      seen.push({ args, env });
      // The PR closes acme/web#7: same number, other repository.
      return args[1] === 'view' ? JSON.stringify({ body: 'Closes acme/web#7', baseRefName: 'main', closingIssuesReferences: [{ number: 7, repository: { name: 'web', owner: { login: 'acme' } } }] }) : '';
    },
    defaultBranch: async () => 'main',
  };
  checkClosing(ctx, 'api', new Map(), io);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(seen.some((c) => c.args[1] === 'edit'), 'edited despite the number being closed in another repository');
  assert.ok(seen.length > 0 && seen.every((c) => c.env?.GH_TOKEN === 'ada'), 'every gh call as the creator');
});

test('ensureClosingRef warns about a base that is not the default branch even when the line was there', async () => {
  const run = stub({ body: 'Closes #7', baseRefName: 'develop', closingIssuesReferences: [] }, []);
  const r = await ensureClosingRef({ prUrl: 'https://github.com/acme/api/pull/3', ref: 'gh:acme/api#7', cwd: '.', run, defaultBranch: 'main' });
  assert.equal(r.edited, false);
  assert.match(r.warning ?? '', /targets `develop`/);
});

test('a PR in another repository with the same number does not count as closing the issue', async () => {
  const calls: { args: string[]; body?: string }[] = [];
  const r = await ensureClosingRef({ prUrl: 'https://github.com/acme/api/pull/3', ref: 'gh:acme/api#7', cwd: '.', run: stub({ body: 'Closes acme/web#7', baseRefName: 'main', closingIssuesReferences: [{ number: 7, repository: { name: 'web', owner: { login: 'acme' } } }] }, calls), defaultBranch: 'main' });
  assert.equal(r.edited, true);
  assert.equal(calls.find((c) => c.args[1] === 'edit')?.body, 'Closes acme/web#7\n\nCloses #7\n');
});

test('the queue reports a linked pull request even when GitHub lists the same issue number as closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-closes-'));
  const worker = { id: 'worker-0', deskId: 'd', status: 'done', name: 'T' } as never;
  const workers = { defaultProvider: 'claude', list: () => [worker], deskOccupied: () => false, spawn: () => worker, kill: async () => ({}) } as unknown as QueueWorkers;
  const linked: QueueTask[] = [];
  const q = new TaskQueue(dir, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {}, prLinked: (t) => void linked.push(t) });
  (q as unknown as { tasks: QueueTask[] }).tasks.push({ id: 'a', title: 't', prompt: 'p', addedBy: 'x', addedAt: Date.now(), status: 'running', issueKey: 'gh:acme/api#5', workerId: 'worker-0', branch: 'b' });
  q.onPulls([{ number: 9, title: 'x', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/web/pull/9', author: '', labels: [], reviewDecision: '', headRefName: 'b', baseRefName: 'main', createdAt: new Date().toISOString(), updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [5] } as GhPull]);
  assert.equal(linked.length, 1);
  q.shutdown();
});

test('the queue never has the closing line added to a pull request matched by an issue number only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'queue-closes-'));
  const worker = { id: 'worker-0', deskId: 'd', status: 'working', name: 'T' } as never;
  const workers = { defaultProvider: 'claude', list: () => [worker], deskOccupied: () => false, spawn: () => worker, kill: async () => ({}) } as unknown as QueueWorkers;
  const linked: QueueTask[] = [];
  const q = new TaskQueue(dir, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {}, prLinked: (t) => void linked.push(t) });
  (q as unknown as { tasks: QueueTask[] }).tasks.push({ id: 'a', title: 't', prompt: 'p', addedBy: 'x', addedAt: Date.now(), status: 'running', issue: 7, issueKey: 'gh:acme/api#7', workerId: 'worker-0', branch: 'task-branch' });
  // Another branch's PR that closes acme/web#7: GitHub's `closes` says only 7.
  q.onPulls([{ number: 11, title: 'x', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/api/pull/11', author: '', labels: [], reviewDecision: '', headRefName: 'unrelated-branch', baseRefName: 'main', createdAt: new Date().toISOString(), updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: 'Closes acme/web#7', closes: [7] } as GhPull]);
  assert.equal(linked.length, 0, 'a PR off another branch is never edited');
  q.shutdown();
});

test('claimCard on a project draft moves its Status and assigns nobody', async () => {
  const started: string[][] = [];
  setWallProvider({ started: async (p: string, k: string) => (started.push([p, k]), undefined), refresh() {} } as never);
  const toasts: string[] = [];
  const floor = { id: 'app', ctx: { toast: (_f: unknown, text: string) => toasts.push(text) }, github: { claim: async () => assert.fail('assigned') } };
  assert.equal(await Floor.prototype.claimCard.call(floor as never, undefined, 'ghp:acme/3#PVTI_x'), undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, [['app', 'ghp:acme/3#PVTI_x']]);
  setWallProvider(undefined);
});

test('promptIssue strict keeps the repository of another repository’s card', () => {
  assert.deepEqual(promptIssue('Work on GitHub issue acme/api#7: "Fix it".\n\nRead it first.', { strict: true }), { number: 7, title: 'Fix it', repo: 'acme/api' });
  assert.deepEqual(promptIssue('Work on GitHub issue #7: "Fix it".', { strict: true }), { number: 7, title: 'Fix it' });
});

test('claimCard moves the Status even when the assignment failed', async () => {
  const started: string[][] = [];
  setWallProvider({ started: async (p: string, k: string) => (started.push([p, k]), undefined), refresh() {} } as never);
  const floor = { id: 'app', def: { repo: 'acme/api' }, dir: '.', git: true, cardRef: Floor.prototype.cardRef, ctx: { toast() {} }, github: { claim: async () => 'HTTP 403: no rights to assign' } };
  assert.equal(await Floor.prototype.claimCard.call(floor as never, 7, undefined), 'HTTP 403: no rights to assign');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, [['app', 'gh:acme/api#7']]);
  setWallProvider(undefined);
});

test('a queue task takes its card through takeCard: claimed for the owner, not dropped from the queue, and an account without a gh sign-in moves no Status', async () => {
  const started: unknown[] = [];
  setWallProvider({ started: async (...a: unknown[]) => (started.push(a), undefined), refresh() {} } as never);
  const claimed: unknown[] = [];
  const floor = { id: 'app', def: { repo: 'acme/api' }, dir: '.', git: true, cardRef: Floor.prototype.cardRef, queue: { dropIssue: () => assert.fail('the queue task is the one seated') }, workers: { get: () => undefined }, claimCard: async (...a: unknown[]) => (claimed.push(a), undefined) };
  const events = (ghAs: unknown) => queueEvents(floor as never, { ghAs, toast() {} } as never);
  assert.equal(await events(() => ({ env: { GH_TOKEN: 'ada' } })).claimIssue(7, 'acct'), undefined);
  assert.deepEqual(claimed, [[7, undefined, { env: { GH_TOKEN: 'ada' } }]]);
  const signedOut = events(() => 'Sign in to GitHub first');
  assert.equal(await signedOut.claimIssue(0, 'acct', 'ghp:acme/3#PVTI_x'), 'Sign in to GitHub first');
  assert.equal(await signedOut.claimIssue(7, 'acct'), 'Sign in to GitHub first');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(claimed.length, 1, 'nobody assigned');
  assert.deepEqual(started, [], 'and the office’s gh is not lent for the Status');
  setWallProvider(undefined);
});

test('the queue checks the closing line once its worker is at rest, again after it worked on, and asks again while gh fails', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-closes-'));
  const worker = { id: 'worker-0', deskId: 'd', status: 'working', name: 'T' };
  const workers = { defaultProvider: 'claude', list: () => [worker], deskOccupied: () => false, spawn: () => worker, kill: async () => ({}) } as unknown as QueueWorkers;
  let answer = true;
  let asked = 0;
  const toasts: string[] = [];
  const q = new TaskQueue(dir, workers, false, { update() {}, toast: (t) => void toasts.push(t), claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {}, prLinked: async () => (asked++, answer) });
  (q as unknown as { tasks: QueueTask[] }).tasks.push({ id: 'a', title: 't', prompt: 'p', addedBy: 'x', addedAt: Date.now(), status: 'running', issueKey: 'gh:acme/api#5', workerId: 'worker-0', branch: 'b' });
  const pull = { number: 9, title: 'x', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/api/pull/9', author: '', labels: [], reviewDecision: '', headRefName: 'b', baseRefName: 'main', createdAt: new Date().toISOString(), updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [] } as GhPull;
  const refresh = async () => (q.onPulls([pull]), await new Promise((r) => setTimeout(r, 5)));
  await refresh();
  assert.equal(asked, 0, 'not while the worker may still be writing the description');
  (worker.status = 'done'), q.onWorker({ ...worker } as never);
  await refresh();
  await refresh();
  assert.equal(asked, 1);
  (worker.status = 'working'), q.onWorker({ ...worker } as never);
  await refresh();
  (worker.status = 'done'), q.onWorker({ ...worker } as never);
  await refresh();
  assert.equal(asked, 2, 'its final description is checked again');
  (worker.status = 'working'), q.onWorker({ ...worker } as never);
  await refresh();
  (worker.status = 'done'), q.onWorker({ ...worker } as never);
  answer = false;
  for (let i = 0; i < 5; i++) await refresh();
  assert.equal(asked, 5, 'gh failing is asked about three times');
  assert.equal(toasts.filter((t) => t.includes("Couldn't check")).length, 1);
  q.shutdown();
});

test('a card handed to a worker at its desk is the issue its pull request closes; without a gh sign-in no Status moves', async () => {
  const started: string[] = [];
  setWallProvider({ started: async (_p: string, k: string) => (started.push(k), undefined), refresh() {} } as never);
  const info = { id: 'w1', prompt: 'Work on GitHub issue acme/web#1: "First".' } as Record<string, unknown>;
  const floor = { id: 'app', def: { repo: 'acme/web' }, dir: '.', git: true, cardRef: Floor.prototype.cardRef, queue: { dropIssue() {}, issueOf: () => ({}) }, workers: { get: () => info }, claimCard: async () => assert.fail('assigned') };
  const warned: string[] = [];
  const g = gates({ signins: { ghAs: () => 'Sign in to GitHub first' }, warn: (_c: unknown, e?: string) => e && warned.push(e) } as never);
  g.takeIssue({ accountId: 'acct' } as never, floor as never, undefined, 'gh:acme/api#2', 'w1');
  assert.equal(workerIssueKey({ repo: {} } as never, floor as never, info as never), 'gh:acme/api#2');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, [], 'no Status move under the office’s gh');
  assert.ok(warned.some((w) => w.includes('Sign in to GitHub first')));
  setWallProvider(undefined);
});

test('a kanban PR is checked again after a later run of its task, which may have rewritten the description', async () => {
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'review', runState: 'idle', createdByAccount: undefined };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN', branch: 'b' };
  const runs = [{ id: 10 }];
  const ctx = {
    dataDir: '.',
    repos: () => [{ id: 'api', primary: true, remote: 'acme/api' }],
    repo: { prLinksOfProject: () => [link], listTasks: () => [task], latestRunId: () => runs.at(-1)?.id, repoBranches: () => ({}), addComment() {} },
    taskChanged() {},
  } as unknown as Parameters<typeof checkClosing>[0];
  let body = 'Did things';
  let views = 0;
  const io = {
    run: async (args: string[]) => {
      if (args[1] === 'view') return (args[4].includes('baseRefName') && views++, JSON.stringify({ body, baseRefName: 'main', closingIssuesReferences: [] }));
      if (args[1] === 'edit') body = 'Did things\n\nCloses #7';
      return '';
    },
    defaultBranch: async () => 'main',
  };
  const checked = new Map<string, ClosingMark>();
  const sync = async () => (checkClosing(ctx, 'api', checked, io), await new Promise((r) => setTimeout(r, 20)));
  await sync();
  await sync();
  assert.equal(views, 1, 'once per run');
  assert.match(body, /Closes #7/);
  // Its PR phase writes the description again, without the line.
  body = 'Rewritten';
  runs.push({ id: 11 });
  await sync();
  assert.equal(views, 2);
  assert.match(body, /Closes #7/);
});

test('the queue checks the closing line again after a turn that no PR refresh saw', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-closes-'));
  const worker = { id: 'worker-0', deskId: 'd', status: 'done', name: 'T' } as WorkerInfo;
  const workers = { defaultProvider: 'claude', list: () => [worker], deskOccupied: () => false, spawn: () => worker, kill: async () => ({}) } as unknown as QueueWorkers;
  let asked = 0;
  const q = new TaskQueue(dir, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {}, prLinked: async () => (asked++, true) });
  (q as unknown as { tasks: QueueTask[] }).tasks.push({ id: 'a', title: 't', prompt: 'p', addedBy: 'x', addedAt: Date.now(), status: 'running', issueKey: 'gh:acme/api#5', workerId: 'worker-0', branch: 'b' });
  const pull = { number: 9, title: 'x', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/api/pull/9', author: '', labels: [], reviewDecision: '', headRefName: 'b', baseRefName: 'main', createdAt: new Date().toISOString(), updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [] } as GhPull;
  const refresh = async () => (q.onPulls([pull]), await new Promise((r) => setTimeout(r, 5)));
  await refresh();
  assert.equal(asked, 1);
  // A whole turn between two refreshes: only the worker's own updates see it.
  q.onWorker({ ...worker, status: 'working' });
  q.onWorker({ ...worker, status: 'done' });
  await refresh();
  assert.equal(asked, 2);
  q.shutdown();
});

test('a worker hired for an issue by another agent takes it as a card does; without a gh sign-in nothing is assigned and no Status moves', async () => {
  const started: string[] = [];
  setWallProvider({ started: async (_p: string, k: string) => (started.push(k), undefined), refresh() {} } as never);
  const info = { id: 'w1' } as Record<string, unknown>;
  const claimed: unknown[] = [];
  const dropped: unknown[] = [];
  const floor = { id: 'app', def: { repo: 'acme/api' }, dir: '.', git: true, cardRef: Floor.prototype.cardRef, queue: { dropIssue: (n: number) => dropped.push(n) }, workers: { get: () => info }, claimCard: async (...a: unknown[]) => (claimed.push(a), undefined) };
  const toasts: string[] = [];
  const signedIn = { signins: { ghAs: () => ({ env: { GH_TOKEN: 'ada' } }) }, toastFloor: (_f: unknown, t: string) => void toasts.push(t) };
  takeHiredIssue(signedIn as never, floor as never, 'w1', 4, 'ada');
  assert.deepEqual(claimed, [[4, undefined, { env: { GH_TOKEN: 'ada' } }]], 'through claimCard, which also moves the Status');
  assert.equal(info.issueKey, 'gh:acme/api#4');
  assert.deepEqual(dropped, [4]);
  const signedOut = { signins: { ghAs: () => 'Sign in to GitHub first' }, toastFloor: (_f: unknown, t: string) => void toasts.push(t) };
  takeHiredIssue(signedOut as never, floor as never, 'w1', 5, 'bob');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(claimed.length, 1, 'nobody assigned without a sign-in');
  assert.deepEqual(started, [], 'no Status move under the office’s gh');
  assert.ok(toasts.some((t) => t.includes('Sign in to GitHub first')));
  setWallProvider(undefined);
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const kctx = (task: Record<string, unknown>, link: Record<string, unknown>, extra: Record<string, unknown> = {}, repos = [{ id: 'api', primary: true, remote: 'acme/api' }]) =>
  ({
    dataDir: '.',
    repos: () => repos,
    repo: { prLinksOfProject: () => [link], listTasks: () => [task], latestRunId: () => 1, repoBranches: () => ({}), addComment: (c: { text: string }) => void ((extra.comments as string[] | undefined)?.push(c.text)), },
    ghAs: extra.ghAs,
    taskChanged() {},
  }) as unknown as Parameters<typeof checkClosing>[0];
const viewing = (calls: string[][]) => ({
  run: async (args: string[]) => (calls.push(args), args[1] === 'view' ? JSON.stringify({ body: '', baseRefName: 'main', closingIssuesReferences: [] }) : ''),
  defaultBranch: async () => 'main',
});

test('an account user without a gh sign-in has no pull request edited with the office gh, and the task is told once', async () => {
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'review', runState: 'idle', createdByAccount: 'ada' };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN', branch: 'b' };
  const comments: string[] = [];
  const calls: string[][] = [];
  const checked = new Map<string, ClosingMark>();
  for (let i = 0; i < 2; i++) (checkClosing(kctx(task, link, { comments, ghAs: () => 'Sign in to GitHub first' }), 'api', checked, viewing(calls)), await wait());
  assert.deepEqual(calls, []);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /Sign in to GitHub first/);
  // Shared-password users (ghAs undefined) are the office's gh's owners.
  checkClosing(kctx({ ...task, id: 2 }, { ...link, taskId: 2, url: 'https://github.com/acme/api/pull/4' }, { ghAs: () => undefined }), 'api', checked, viewing(calls));
  await wait();
  assert.ok(calls.some((c) => c[1] === 'edit'));
});

test('only pull requests off the task’s own branches in the project’s repositories are edited', async () => {
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'review', runState: 'idle' };
  const calls: string[][] = [];
  const base = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN' };
  for (const link of [{ ...base, branch: 'other' }, { ...base }, { ...base, branch: 'b', repo: 'evil/api', url: 'https://github.com/evil/api/pull/3' }]) {
    checkClosing(kctx(task, link, {}, [{ id: 'api', primary: true, remote: 'acme/api' }]), 'api', new Map(), viewing(calls));
    await wait();
  }
  assert.deepEqual(calls, [], 'a hand-linked PR, a PR without a branch and one in another repository are left alone');
  checkClosing(kctx(task, { ...base, branch: 'b' }), 'api', new Map(), viewing(calls));
  await wait();
  assert.ok(calls.some((c) => c[1] === 'edit'));
});

test('a description edited while the line is being added is not overwritten', async () => {
  let views = 0;
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ body: 'a', updatedAt: views++ ? 'later' : 'first', baseRefName: 'main', closingIssuesReferences: [] });
    return '';
  };
  const r = await ensureClosingRef({ prUrl: 'https://github.com/acme/api/pull/3', ref: 'gh:acme/api#7', cwd: '.', run, defaultBranch: 'main' });
  assert.deepEqual({ ...r, warning: undefined }, { edited: false, retry: true, warning: undefined });
  assert.match(r.warning ?? '', /description kept changing/);
  assert.ok(!calls.some((c) => c[1] === 'edit'));
});

test('the closing check keeps one mark per pull request and drops the ones it no longer sees', async () => {
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'review', runState: 'idle' };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN', branch: 'b' };
  const checked = new Map<string, ClosingMark>();
  const ctx = kctx(task, link);
  (ctx.repo as { latestRunId: () => number }).latestRunId = () => 1;
  checkClosing(ctx, 'api', checked, viewing([]));
  await wait();
  (ctx.repo as { latestRunId: () => number }).latestRunId = () => 2;
  checkClosing(ctx, 'api', checked, viewing([]));
  await wait();
  assert.equal(checked.size, 1);
  assert.equal(checked.get(link.url)?.runId, 2);
  (ctx.repo as { prLinksOfProject: () => unknown[] }).prLinksOfProject = () => [];
  checkClosing(ctx, 'api', checked, viewing([]));
  assert.equal(checked.size, 0);
});

test('the default branch of a repository is asked for once across checks', async () => {
  let asked = 0;
  const run = async (args: string[]) => (args[0] === 'repo' ? (asked++, 'main\n') : args[1] === 'view' ? JSON.stringify({ body: 'Closes #7', baseRefName: 'main', closingIssuesReferences: [] }) : '');
  for (let i = 0; i < 3; i++) await ensureClosingRef({ prUrl: 'https://github.com/memo/repo/pull/3', ref: 'gh:memo/repo#7', cwd: '.', run });
  assert.equal(asked, 1);
});

test('a draft PR for an issue of another repository closes it by its full reference', async () => {
  const { draftPr } = await import('../src/server/workers/pr.js');
  const info = { name: 'W', deskId: 'd', prompt: 'Work on GitHub issue acme/api#7: "Fix it".', worktree: { branch: 'b' } } as never;
  assert.match(draftPr(info, ['abc123 x'], 'me', 'acme/web').body, /Closes acme\/api#7/);
  assert.match(draftPr(info, ['abc123 x'], 'me', 'acme/web', true).body, /Part of acme\/api#7/);
  const own = { ...(info as object), prompt: 'Work on GitHub issue #7: "Fix it".' } as never;
  assert.match(draftPr(own, ['abc123 x'], 'me', 'acme/web').body, /Closes #7/);
});

test('the queue resets only done on a busy turn, and warns about a PR once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-closes-'));
  const worker = { id: 'worker-0', deskId: 'd', status: 'done', name: 'T' } as WorkerInfo;
  const workers = { defaultProvider: 'claude', list: () => [worker], deskOccupied: () => false, spawn: () => worker, kill: async () => ({}) } as unknown as QueueWorkers;
  let release: (v: boolean) => void = () => undefined;
  let asked = 0;
  const q = new TaskQueue(dir, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {}, prLinked: () => (asked++, new Promise<boolean>((r) => (release = r))) });
  (q as unknown as { tasks: QueueTask[] }).tasks.push({ id: 'a', title: 't', prompt: 'p', addedBy: 'x', addedAt: Date.now(), status: 'running', issueKey: 'gh:acme/api#5', workerId: 'worker-0', branch: 'b' });
  const pull = { number: 9, title: 'x', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/api/pull/9', author: '', labels: [], reviewDecision: '', headRefName: 'b', baseRefName: 'main', createdAt: new Date().toISOString(), updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [] } as GhPull;
  q.onPulls([pull]);
  assert.equal(asked, 1);
  q.onWorker({ ...worker, status: 'working' });
  q.onWorker({ ...worker, status: 'done' });
  q.onPulls([pull]);
  assert.equal(asked, 1, 'a check still going is not started twice');
  release(true);
  await wait(5);
  // A task that left the queue takes its entry along.
  (q as unknown as { tasks: QueueTask[] }).tasks.length = 0;
  q.onPulls([]);
  assert.equal((q as unknown as { closing: Map<string, unknown> }).closing.size, 0);
  q.shutdown();
});

test('the queue toasts a PR’s closing warning once, and not at all with the office gh for an account user', async () => {
  const toasts: string[] = [];
  const calls: unknown[] = [];
  let as: unknown = { env: { GH_TOKEN: 'x' } };
  const floor = { dir: '.', cardRef: () => 'gh:acme/api#7' };
  const ctx = { ghAs: () => as, toast: (_f: unknown, t: string) => void toasts.push(t) };
  const events = queueEvents(floor as never, ctx as never);
  as = 'Sign in to GitHub first';
  for (let i = 0; i < 3; i++) assert.equal(await events.prLinked!({ issue: 7 } as never, { number: 3, url: 'https://github.com/acme/api/pull/3' }), true);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Sign in to GitHub first/);
  assert.deepEqual(calls, []);
});

test('a plain worker’s PR from its worktree branch gets the closing line once per turn, as its owner', async () => {
  const { WorkerCloses } = await import('../src/server/worker-closes.js');
  const info = { id: 'w1', name: 'W', kind: 'agent', status: 'done', deskId: 'd', issueKey: 'gh:acme/api#7', worktree: { branch: 'wb' } } as unknown as WorkerInfo;
  const floor = { dir: '.', def: { repo: 'acme/api' }, workers: { list: () => [info], ownerOf: () => 'ada' }, queue: { state: () => ({ tasks: [] }), issueOf: () => ({}) } };
  const toasts: string[] = [];
  let as: unknown = undefined;
  const w = new WorkerCloses(floor as never, { ghAs: () => as, toast: (_f: unknown, t: string) => void toasts.push(t) } as never);
  const pull = { number: 9, state: 'OPEN', isDraft: false, url: 'https://github.com/memo2/api/pull/9', headRefName: 'wb', closes: [] } as unknown as GhPull;
  as = 'Sign in to GitHub first';
  w.onPulls([pull]);
  await wait(10);
  assert.match(toasts[0] ?? '', /Sign in to GitHub first/);
  w.onPulls([pull]);
  await wait(10);
  assert.equal(toasts.length, 1, 'once');
  (info as { status: string }).status = 'working';
  w.onWorker(info);
  w.onPulls([pull]);
  await wait(10);
  assert.equal(toasts.length, 1, 'not while it works');
  (info as { status: string }).status = 'done';
  w.onWorker(info);
  w.onPulls([{ ...pull, headRefName: 'other' }]);
  await wait(10);
  assert.equal(toasts.length, 1, 'only the worker’s own branch');
  // With a sign-in, the line goes in once per turn.
  as = { env: { GH_TOKEN: 'ada' } };
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const edits = () => calls.filter((c) => c.args[1] === 'edit').length;
  const w2 = new WorkerCloses(floor as never, { ghAs: () => as, toast() {} } as never, async (args, _cwd, _t, env) => (calls.push({ args, env }), args[0] === 'repo' ? 'main' : args[1] === 'view' ? JSON.stringify({ body: 'x', baseRefName: 'main', closingIssuesReferences: [] }) : ''));
  w2.onPulls([pull]);
  await wait(10);
  w2.onPulls([pull]);
  await wait(10);
  assert.equal(edits(), 1);
  assert.ok(calls.every((c) => c.env?.GH_TOKEN === 'ada'));
  w2.onWorker({ ...info, status: 'working' });
  w2.onWorker({ ...info, status: 'done' });
  w2.onPulls([pull]);
  await wait(10);
  assert.equal(edits(), 2, 'again after a new turn');
});

test('a task is told once per pull request that it cannot be edited, not once per run', async () => {
  const task = { id: 1, branch: 'b', ticket: 'gh:acme/api#7', status: 'review', runState: 'idle', createdByAccount: 'ada' };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN', branch: 'b' };
  const comments: string[] = [];
  const ctx = kctx(task, link, { comments, ghAs: () => 'Sign in to GitHub first' });
  const checked = new Map<string, ClosingMark>();
  for (const run of [1, 2, 3]) {
    (ctx.repo as { latestRunId: () => number }).latestRunId = () => run;
    checkClosing(ctx, 'api', checked, viewing([]));
    await wait();
  }
  assert.equal(comments.length, 1);
});

test('a plain worker’s issue goes with its first pull request, and its warnings come once per pull request', async () => {
  const { WorkerCloses } = await import('../src/server/worker-closes.js');
  const info = { id: 'w1', name: 'W', kind: 'agent', status: 'done', deskId: 'd', issueKey: 'gh:acme/api#7', worktree: { branch: 'wb' } } as unknown as WorkerInfo;
  const floor = { dir: '.', def: { repo: 'acme/api' }, workers: { list: () => [info], ownerOf: () => undefined }, queue: { state: () => ({ tasks: [] }), issueOf: () => ({}) } };
  const toasts: string[] = [];
  const calls: string[][] = [];
  const run = async (args: string[]) => (calls.push(args), args[0] === 'repo' ? 'main' : args[1] === 'view' ? JSON.stringify({ body: 'x', baseRefName: 'next', closingIssuesReferences: [] }) : '');
  const w = new WorkerCloses(floor as never, { ghAs: () => undefined, toast: (_f: unknown, t: string) => void toasts.push(t) } as never, run);
  const pull = { number: 9, state: 'OPEN', isDraft: false, url: 'https://github.com/retire/api/pull/9', headRefName: 'wb', closes: [] } as unknown as GhPull;
  for (let turn = 0; turn < 2; turn++) {
    w.onPulls([pull]);
    await wait(10);
    w.onWorker({ ...info, status: 'working' });
    w.onWorker({ ...info, status: 'done' });
  }
  assert.equal(toasts.length, 1, 'the non-default base is told once');
  assert.ok(calls.some((c) => c[1] === 'edit'), 'an ownerless worker is edited with the office gh');
  const edits = () => calls.filter((c) => c[1] === 'edit').length;
  const before = edits();
  w.onPulls([{ ...pull, state: 'MERGED' }]);
  assert.equal(info.issueKey, undefined);
  w.onWorker({ ...info, status: 'working' });
  w.onWorker({ ...info, status: 'done' });
  w.onPulls([{ ...pull, number: 10, url: 'https://github.com/retire/api/pull/10' }]);
  await wait(10);
  assert.equal(edits(), before, 'a later pull request is not edited');
});
