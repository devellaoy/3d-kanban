import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cardId, cardLabel, isPrimaryIssue, labelColor, noteSeed, parseGhKey } from '../src/shared/kanban/issuecard.js';
import { claimGhKey, onWallIssues, toGhIssue, wallChanged, wallIssues, watchWall } from '../src/server/kanban/integrations/issues/wall.js';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { IssueSourceConfig, NormalizedIssue } from '../src/shared/kanban/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

// --- Cards --------------------------------------------------------------------------------------

test('a card is known by its key, else by its number', () => {
  assert.equal(cardId({ number: 12 }), '#12');
  assert.equal(cardId({ number: 12, key: 'gh:o/app#12' }), 'gh:o/app#12');
  assert.equal(cardId({ issue: 0, key: 'UYT-1415' }), 'UYT-1415');
  assert.deepEqual(parseGhKey('gh:o/app#12'), { repo: 'o/app', number: 12 });
  assert.equal(parseGhKey('UYT-1415'), undefined);
  assert.equal(parseGhKey('ghp:o/3#PVTI_1'), undefined);
  assert.equal(parseGhKey('gh:o/app#0'), undefined);
});

test('a card is called #12 on the floor’s repository, api#12 in another, its key otherwise', () => {
  assert.equal(cardLabel({ number: 12 }, 'o/app'), '#12');
  assert.equal(cardLabel({ number: 12, key: 'gh:O/App#12' }, 'o/app'), '#12', 'owner/name in any case');
  assert.equal(cardLabel({ number: 12, key: 'gh:o/api#12' }, 'o/app'), 'api#12');
  assert.equal(cardLabel({ number: 0, key: 'gh:elsewhere/lib#3' }, 'o/app'), 'lib#3');
  assert.equal(cardLabel({ number: 0, key: 'UYT-1415' }, 'o/app'), 'UYT-1415');
  assert.equal(cardLabel({ number: 0, key: 'ghp:o/3#PVTI_lADOABCDEF' }, 'o/app'), 'draft PVTI_lADO…');
  assert.equal(isPrimaryIssue({ number: 12, key: 'gh:o/app#12' }, 'o/app'), true);
  assert.equal(isPrimaryIssue({ number: 0, key: 'UYT-1' }, 'o/app'), false);
  assert.equal(isPrimaryIssue({ number: 7 }, undefined), true, 'upstream’s card: no key, no repository');
});

test('notes keep upstream’s colors for numbers, and steady ones for keys', () => {
  assert.equal(noteSeed({ number: 12, key: 'gh:o/app#12' }), 12);
  assert.equal(noteSeed({ number: 0, key: 'UYT-1' }), noteSeed({ number: 0, key: 'UYT-1' }));
  assert.notEqual(noteSeed({ number: 0, key: 'UYT-1' }), noteSeed({ number: 0, key: 'UYT-2' }));
  assert.equal(labelColor('bug'), labelColor('bug'));
  assert.match(labelColor('bug'), /^hsl\(\d+, 55%, 62%\)$/);
});

// --- Server: the board's cards ------------------------------------------------------------------------

const JIRA_ISSUE: NormalizedIssue = { source: 'jira', key: 'UYT-1415', title: 'Login breaks', url: 'https://x.atlassian.net/browse/UYT-1415', body: 'Steps', assignee: 'Panu', labels: ['backend'], status: 'In Progress', updatedAt: '2026-09-02T10:00:00Z' };

test('an issue of a source becomes a card: a GitHub issue of the project keeps its number', () => {
  const jira = toGhIssue(JIRA_ISSUE, 7, ['o/app']);
  assert.equal(jira.number, 0);
  assert.equal(jira.key, 'UYT-1415');
  assert.equal(jira.state, 'OPEN');
  assert.equal(jira.status, 'In Progress');
  assert.equal(jira.taskId, 7);
  assert.deepEqual(jira.assignees, ['Panu']);
  assert.deepEqual(jira.labels, [{ name: 'backend', color: labelColor('backend') }]);
  assert.equal(jira.repo, undefined);

  const gh: NormalizedIssue = { source: 'github-repo', key: 'gh:o/app#12', title: 'Fix', url: 'u', body: 'b', assignee: 'a, b', labels: [], status: 'OPEN', repo: 'o/app', updatedAt: '' };
  const own = toGhIssue(gh, undefined, ['O/App']);
  assert.equal(own.number, 12);
  assert.equal(own.repo, 'o/app');
  assert.deepEqual(own.assignees, ['a', 'b']);
  assert.equal(own.taskId, undefined);
  assert.equal(toGhIssue({ ...gh, status: 'CLOSED' }).state, 'CLOSED');
  assert.equal(toGhIssue(gh, undefined, []).number, 0, 'a repository outside the project: known by its key only');
  assert.equal(toGhIssue({ ...gh, body: 'x'.repeat(10_000) }).body.length, 2000);
});

test('the board: the sources’ cards while the project has any, upstream’s list without', async (t) => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' }), def('bare', '/tmp/bare')]);
  ctx.settings.setProject('app', { issueSources: [{ id: 's1', kind: 'github-repo', repos: ['o/app', 'o/lib'], filters: {} }] as IssueSourceConfig[] });
  const listed = (repo: string) =>
    JSON.stringify([{ number: 12, title: `Fix ${repo}`, url: `https://github.com/${repo}/issues/12`, body: '', state: 'OPEN', assignees: [], labels: [], updatedAt: repo === 'o/app' ? '2026-09-02T10:00:00Z' : '2026-09-01T10:00:00Z' }]);
  let ghCalls = 0;
  const issues = createIssues(ctx, { gh: async (args) => (ghCalls++, listed(args[args.indexOf('-R') + 1])) });
  issues.plugin.start!();
  t.after(() => issues.plugin.stop!());

  let heard = 0;
  const off = onWallIssues('app', () => heard++);
  assert.equal(wallIssues('bare'), undefined, 'no sources: the floor keeps its own repository’s');
  assert.equal(wallIssues('nope'), undefined);
  assert.deepEqual(wallIssues('app'), { items: [], fetchedAt: 0, loading: true }, 'not fetched yet: loading');

  await issues.refresh('app');
  assert.ok(heard >= 2, 'the floor hears when a refresh starts and ends');
  const board = wallIssues('app')!;
  assert.deepEqual(board.items.map((i) => [i.key, i.number]), [['gh:o/app#12', 12], ['gh:o/lib#12', 0]], 'o/lib isn’t one of the project’s repositories');
  assert.equal(board.loading, false);

  // A task made from a card shows on it.
  const c = client();
  await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/lib#12', rid: 'r1' });
  const made = c.got.at(-1) as { taskId: number };
  assert.equal(wallIssues('app')!.items.find((i) => i.key === 'gh:o/lib#12')!.taskId, made.taskId);

  // Someone on the floor keeps it fresh: a watch when it's due fetches again.
  const before = ghCalls;
  watchWall('app');
  assert.equal(ghCalls, before, 'fresh enough');
  watchWall('bare');

  const n = heard;
  off();
  wallChanged('app');
  assert.equal(heard, n, 'stopped listening');
  issues.plugin.stop!();
  assert.equal(wallIssues('app'), undefined, 'no plugin, no sources’ board');
});

test('a card as a kanban task: at the desk, from the source’s whole text, once per key (archived too)', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })]);
  const opts: unknown[] = [];
  const start = ctx.engine.start;
  ctx.engine.start = (async (id: number, who: unknown, o: unknown) => (opts.push(o), start(id, who as never))) as typeof ctx.engine.start;
  ctx.settings.setProject('app', { issueSources: [{ id: 's1', kind: 'github-repo', repos: ['o/lib'], filters: {} }] as IssueSourceConfig[] });
  const long = `${'x'.repeat(5000)}\n\nAcceptance: it works`;
  const issues = createIssues(ctx, { gh: async () => JSON.stringify([{ number: 3, title: 'Long', url: 'https://github.com/o/lib/issues/3', body: long, state: 'OPEN', assignees: [], labels: [], updatedAt: '2026-09-02T10:00:00Z' }]) });
  const c = client();
  await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/lib#3', start: true, deskId: 'd3', rid: 'r1' });
  const made = c.got.at(-1) as { t: string; taskId: number; existed: boolean };
  assert.equal(made.existed, false);
  assert.deepEqual(opts, [{ deskId: 'd3' }], 'started at the desk');
  assert.match(ctx.repo.getTask(made.taskId)!.description, /Acceptance: it works\n\nSource: /, 'the whole text, not the board’s cut');

  ctx.repo.updateTask(made.taskId, { status: 'archived' });
  await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/lib#3', start: true, deskId: 'd4', rid: 'r2' });
  assert.deepEqual(c.got.at(-1), { t: 'kanban.ok', rid: 'r2', taskId: made.taskId, existed: true });
  assert.equal(ctx.repo.listTasks('app', { includeArchived: true }).length, 1);
  assert.equal(opts.length, 1, 'an archived task isn’t started again');
});

test('a card whose task waits in To do: P starts it at the desk, a failed start says why and can be tried again', async () => {
  let fail = 'No free desk';
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })], { start: () => fail || undefined });
  const opts: unknown[] = [];
  const start = ctx.engine.start;
  ctx.engine.start = (async (id: number, who: unknown, o: unknown) => (opts.push(o), start(id, who as never))) as typeof ctx.engine.start;
  ctx.settings.setProject('app', { issueSources: [{ id: 'j', kind: 'github-repo', repos: ['o/lib'], filters: {} }] as IssueSourceConfig[] });
  const issues = createIssues(ctx, { gh: async () => JSON.stringify([{ number: 4, title: 'Four', url: 'https://github.com/o/lib/issues/4', body: 'b', state: 'OPEN', assignees: [], labels: [], updatedAt: '2026-09-02T10:00:00Z' }]) });
  const c = client();
  const create = async (rid: string, deskId?: string) => {
    await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/lib#4', rid, ...(deskId ? { start: true, deskId } : {}) });
    return c.got.at(-1) as { t: string; taskId: number; existed: boolean; started?: true; startError?: string };
  };
  // Made on the kanban first: it waits in To do.
  const made = await create('r1');
  assert.equal(ctx.repo.getTask(made.taskId)!.status, 'todo');
  assert.equal(opts.length, 0);

  const failed = await create('r2', 'd1');
  assert.deepEqual(failed, { t: 'kanban.ok', rid: 'r2', taskId: made.taskId, existed: true, startError: 'No free desk' });
  assert.deepEqual(opts, [{ deskId: 'd1' }]);
  assert.equal(ctx.repo.getTask(made.taskId)!.status, 'todo', 'still waiting: it can be tried again');

  fail = '';
  const started = await create('r3', 'd2');
  assert.deepEqual(started, { t: 'kanban.ok', rid: 'r3', taskId: made.taskId, existed: true, started: true });
  assert.deepEqual(opts, [{ deskId: 'd1' }, { deskId: 'd2' }]);
  assert.equal(ctx.repo.getTask(made.taskId)!.status, 'in_progress');

  const again = await create('r4', 'd3');
  assert.deepEqual(again, { t: 'kanban.ok', rid: 'r4', taskId: made.taskId, existed: true }, 'under way: only named');
  assert.equal(opts.length, 2, 'not started twice');
  assert.equal(ctx.repo.listTasks('app').length, 1);
});

test('claiming a card: a GitHub issue of any repository by its key, nothing else', async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const run = (async (args: string[], _cwd: string, _t?: number, env?: Record<string, string>) => (calls.push({ args, env }), '')) as Parameters<typeof claimGhKey>[3];
  assert.equal(await claimGhKey('gh:o/lib#12', '/tmp', { GH_TOKEN: 'x' }, run), undefined);
  assert.deepEqual(calls[0], { args: ['issue', 'edit', '12', '-R', 'o/lib', '--add-assignee', '@me'], env: { GH_TOKEN: 'x' } });
  assert.equal(await claimGhKey('UYT-1415', '/tmp', undefined, run), undefined);
  assert.equal(calls.length, 1, 'Jira isn’t assigned');
  const failing = (async () => Promise.reject(new Error('no access'))) as unknown as Parameters<typeof claimGhKey>[3];
  assert.equal(await claimGhKey('gh:o/lib#12', '/tmp', undefined, failing), 'no access');
});

// --- The queue ------------------------------------------------------------------------------------

function queueFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-wall-queue-'));
  const workers: WorkerInfo[] = [];
  const claims: [number, string | undefined][] = [];
  const manager: QueueWorkers = {
    defaultProvider: 'claude',
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, worktree, kind, provider) {
      const w = { id: `w${workers.length}`, deskId, kind, provider, prompt, name: 'Test', color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      return w;
    },
    kill: () => Promise.resolve({}),
  };
  const queues: TaskQueue[] = [];
  const open = () => {
    const q = new TaskQueue(dir, manager, false, {
      update() {}, toast() {}, claimIssue: async (issue, _owner, key) => (claims.push([issue, key]), undefined),
      refreshGitHub() {}, hiringPaused: () => undefined, emptied() {},
    });
    queues.push(q);
    return q;
  };
  return { dir, workers, claims, open, close: () => (queues.forEach((q) => q.shutdown()), rmSync(dir, { recursive: true, force: true })) };
}

test('queue: a card from the issue sources is queued, deduplicated, dropped and claimed by its key', async (t) => {
  const f = queueFixture();
  t.after(() => f.close());
  const q = f.open();
  q.setLimit(0);
  assert.equal(q.add('Work on UYT-1415', 'Tester', 'UYT-1415 Login', undefined, undefined, undefined, undefined, undefined, 'UYT-1415'), undefined);
  assert.equal(q.add('Again', 'Tester', undefined, undefined, undefined, undefined, undefined, undefined, 'UYT-1415'), 'UYT-1415 is already on the queue');
  assert.equal(q.add('Another', 'Tester', undefined, undefined, undefined, undefined, undefined, undefined, 'UYT-2'), undefined);
  assert.equal(q.dropIssue(undefined, 'UYT-2'), true);
  assert.deepEqual(q.state().tasks.map((x) => x.issueKey), ['UYT-1415']);
  q.shutdown();

  const again = f.open();
  assert.equal(again.state().tasks[0].issueKey, 'UYT-1415', 'kept across a restart');
  again.setLimit(1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.claims, [[0, 'UYT-1415']]);
});

test('queue: a saved queue from before keys loads as it was', (t) => {
  const f = queueFixture();
  t.after(() => f.close());
  writeFileSync(path.join(f.dir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [{ id: 'old', title: '#5 Old', prompt: 'Old', issue: 5, status: 'queued' }] }));
  const q = f.open();
  assert.equal(q.state().tasks[0].issue, 5);
  assert.equal(q.state().tasks[0].issueKey, undefined);
  assert.equal(q.dropIssue(5), true);
});
