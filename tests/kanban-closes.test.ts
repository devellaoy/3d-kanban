import test from 'node:test';
import assert from 'node:assert/strict';
import { closingPr, closingRef, promptIssue } from '../src/shared/kanban/issuecard.js';
import { checkClosing, ensureClosingRef } from '../src/server/kanban/integrations/pulls/closes.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { GhPull, QueueTask } from '../src/shared/protocol.js';
import { Floor } from '../src/server/floor.js';
import { setWallProvider } from '../src/server/kanban/integrations/issues/wall.js';
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
  const worker = { id: 'worker-0', deskId: 'd', status: 'working', name: 'T' } as never;
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
  const task = { id: 1, ticket: 'gh:acme/api#7', status: 'in_progress', runState: 'running' as string, createdByAccount: undefined };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN' };
  const ctx = {
    dataDir: '.',
    repos: () => [{ id: 'api', primary: true, remote: 'acme/api' }],
    repo: { prLinksOfProject: () => [link], listTasks: () => [task], addComment: (c: { text: string }) => void comments.push(c.text) },
    taskChanged() {},
  } as unknown as Parameters<typeof checkClosing>[0];
  let views = 0;
  const io = { run: async () => { views++; throw new Error('nope'); }, defaultBranch: async () => 'main' };
  const checked = new Map<string, number>();
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
  const task = { id: 1, ticket: 'gh:acme/api#7', status: 'in_progress', runState: 'idle', createdByAccount: 'ada' };
  const link = { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', state: 'OPEN' };
  const ctx = {
    dataDir: '.',
    repos: () => [{ id: 'api', primary: true, remote: 'acme/api' }],
    repo: { prLinksOfProject: () => [link], listTasks: () => [task], addComment() {} },
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
  const worker = { id: 'worker-0', deskId: 'd', status: 'working', name: 'T' } as never;
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
