import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { kanbanDbPath, openKanbanDb } from '../src/server/kanban/db/open.js';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from '../src/server/kanban/db/migrations.js';
import { KanbanRepository, TASK_EVENTS_CAP, publicAttachment, toCard, type NewTask } from '../src/server/kanban/db/repository.js';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-core-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repoOn(t: { after(fn: () => void): void }) {
  const db = openKanbanDb(':memory:');
  t.after(() => db.close());
  return new KanbanRepository(db);
}

const task = (over: Partial<NewTask> = {}): NewTask => ({ project: 'web', title: 'Fix the login', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada', ...over });

test('the database is made, migrated and set up in the office data dir', (t) => {
  const dataDir = path.join(scratch(t), '.agent-office');
  const file = kanbanDbPath(dataDir);
  assert.equal(file, path.join(dataDir, 'kanban.sqlite'));
  const db = openKanbanDb(file);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
  for (const name of ['tasks', 'task_repos', 'comments', 'runs', 'plans', 'attachments', 'task_events', 'pr_links', 'legacy_map', 'meta']) assert.ok(tables.includes(name), name);
  new KanbanRepository(db).createTask(task());
  db.close();
  // Opened again: nothing re-applied, the data's still there.
  const again = openKanbanDb(file);
  assert.deepEqual(migrate(again), []);
  assert.equal(new KanbanRepository(again).getTask(1)?.title, 'Fix the login');
  again.close();
});

test('migrations run once each, in order, and a database from a newer build is refused', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const seen: number[] = [];
  const list = [
    { version: 1, name: 'one', up: () => void seen.push(1) },
    { version: 2, name: 'two', up: (d: Database.Database) => (seen.push(2), d.exec('CREATE TABLE x (a)')) },
  ];
  assert.deepEqual(migrate(db, list.slice(0, 1)), [1]);
  assert.deepEqual(migrate(db, list), [2]);
  assert.deepEqual(migrate(db, list), []);
  assert.deepEqual(seen, [1, 2]);
  // A failing migration leaves the version where it was.
  const broken = [...list, { version: 3, name: 'bad', up: () => { throw new Error('nope'); } }];
  assert.throws(() => migrate(db, broken), /nope/);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  db.pragma('user_version = 99');
  assert.throws(() => migrate(db, MIGRATIONS), /newer than this build knows/);
});

test('tasks are created with defaults, read back, changed and cleared', (t) => {
  const repo = repoOn(t);
  const a = repo.createTask(task({ repoIds: ['web', 'api'], tags: ['x'], overrides: { review: { rounds: 3 } } }));
  assert.equal(a.id, 1);
  assert.equal(a.status, 'todo');
  assert.equal(a.runState, 'idle');
  assert.equal(a.type, 'implement');
  assert.equal(a.description, '');
  assert.deepEqual(a.repoIds, ['web', 'api']);
  assert.deepEqual(a.tags, ['x']);
  assert.deepEqual(a.pendingMessages, []);
  assert.deepEqual(a.prs, []);
  assert.equal(a.model, undefined);
  assert.ok(!('model' in a), 'unset optional fields are left out');
  const b = repo.createTask(task({ project: 'api', title: 'Other' }));
  assert.equal(b.id, 2);
  assert.equal(b.repoIds, null);

  const changed = repo.updateTask(1, { model: 'opus', status: 'in_progress', runState: 'running', workspace: { worktree: { path: '/w', branch: 'b' } as never }, pendingMessages: [{ commentId: 1, text: 'hi', by: 'Ada', at: 1 }] });
  assert.equal(changed?.model, 'opus');
  assert.equal(changed?.status, 'in_progress');
  assert.equal(changed?.workspace?.worktree.path, '/w');
  assert.equal(changed?.pendingMessages.length, 1);
  assert.ok(changed!.updatedAt >= a.updatedAt);
  const cleared = repo.updateTask(1, { model: null, workspace: null, pendingMessages: null, repoIds: null });
  assert.equal(cleared?.model, undefined);
  assert.equal(cleared?.workspace, undefined);
  assert.deepEqual(cleared?.pendingMessages, []);
  assert.equal(cleared?.repoIds, null);
  assert.equal(repo.updateTask(99, { title: 'x' }), undefined);

  assert.deepEqual(repo.listTasks('web').map((x) => x.id), [1]);
  assert.deepEqual(repo.listTasks(null).map((x) => x.id).sort(), [1, 2]);
  repo.updateTask(2, { status: 'archived' });
  assert.deepEqual(repo.listTasks(null).map((x) => x.id), [1]);
  assert.deepEqual(repo.listTasks(null, { includeArchived: true }).map((x) => x.id).sort(), [1, 2]);
  assert.deepEqual(repo.tasksWhere({ status: ['archived'] }).map((x) => x.id), [2]);
  assert.deepEqual(repo.tasksWhere({ runState: ['running'] }).map((x) => x.id), [1]);
});

test('a hand-edited row with broken JSON still reads', (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  repo.db.prepare(`UPDATE tasks SET tags = 'not json', flags = '[', overrides = 'null', pending_messages = '{}' WHERE id = 1`).run();
  const got = repo.getTask(1)!;
  assert.deepEqual(got.tags, []);
  assert.deepEqual(got.flags, {});
  assert.deepEqual(got.overrides, {});
  assert.deepEqual(got.pendingMessages, []);
});

test('imported tasks keep their ids, and the sequence carries on past them', (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  const kept = repo.insertTaskWithId(106, task({ title: 'Old one', legacy: { source: 'ai-kanban', id: 106, migratedAt: 5 } }));
  assert.equal(kept.id, 106);
  assert.deepEqual(kept.legacy, { source: 'ai-kanban', id: 106, migratedAt: 5 });
  assert.equal(repo.findTaskByLegacy('ai-kanban', 106)?.id, 106);
  assert.throws(() => repo.insertTaskWithId(106, task()), /already exists/);
  assert.throws(() => repo.insertTaskWithId(0, task()), /positive whole numbers/);
  // A lower free id is still fine, and doesn't pull the sequence back.
  assert.equal(repo.insertTaskWithId(50, task()).id, 50);
  assert.equal(repo.nextTaskId(), 107);
  assert.equal(repo.createTask(task()).id, 107);
  repo.bumpNextTaskId(300);
  assert.equal(repo.nextTaskId(), 300);
  repo.bumpNextTaskId(10);
  assert.equal(repo.nextTaskId(), 300, 'never lowered');
  // Deleting the newest doesn't hand its id out again.
  repo.bumpNextTaskId(1);
  assert.equal(repo.createTask(task()).id, 300);
  repo.deleteTask(300);
  assert.equal(repo.createTask(task()).id, 301);
});

test('a system comment repeating the last one is not added again; people can repeat themselves', (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  const sys = { taskId: 1, authorKind: 'system' as const, authorName: 'Kanban', kind: 'status' as const, text: 'No free worktree' };
  const first = repo.addComment(sys);
  assert.equal(first.deduped, false);
  const again = repo.addComment(sys);
  assert.equal(again.deduped, true);
  assert.equal(again.comment.id, first.comment.id);
  assert.equal(repo.countComments(1), 1);
  // Something else in between: the line is news again.
  repo.addComment({ taskId: 1, authorKind: 'agent', authorName: 'Claude', tool: 'claude', text: 'Done' });
  assert.equal(repo.addComment(sys).deduped, false);
  const user = { taskId: 1, authorKind: 'user' as const, authorName: 'Ada', text: 'again' };
  repo.addComment(user);
  assert.equal(repo.addComment(user).deduped, false);
  assert.equal(repo.countComments(1), 5);
});

test('comments come in pages, oldest first, and carry their attachments', (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  for (let i = 1; i <= 7; i++) repo.addComment({ taskId: 1, authorKind: 'user', authorName: 'Ada', text: `c${i}` });
  const newest = repo.listComments(1, { limit: 3 });
  assert.deepEqual(newest.comments.map((c) => c.text), ['c5', 'c6', 'c7']);
  assert.equal(newest.more, true);
  const older = repo.listComments(1, { before: newest.comments[0].id, limit: 3 });
  assert.deepEqual(older.comments.map((c) => c.text), ['c2', 'c3', 'c4']);
  const oldest = repo.listComments(1, { before: older.comments[0].id, limit: 3 });
  assert.deepEqual(oldest.comments.map((c) => c.text), ['c1']);
  assert.equal(oldest.more, false);

  repo.addAttachment({ id: 'a'.repeat(32), name: 'x.png', mime: 'image/png', size: 3, stored: `${'a'.repeat(32)}-x.png`, createdBy: 'Ada', createdAt: 1 });
  const c = repo.addComment({ taskId: 1, authorKind: 'user', authorName: 'Ada', text: 'see' }).comment;
  repo.linkAttachments(['a'.repeat(32)], 1, c.id);
  assert.deepEqual(repo.getComment(c.id)?.attachmentIds, ['a'.repeat(32)]);
});

test("a task's history is capped, the oldest lines going first", (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  for (let i = 0; i < 12; i++) repo.appendEvent(1, 'tick', { i }, 1000 + i, 5);
  const events = repo.listEvents(1);
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => (e.data as { i: number }).i), [7, 8, 9, 10, 11]);
  assert.ok(TASK_EVENTS_CAP >= 1000);
  const plain = repo.appendEvent(1, 'no-data');
  assert.ok(!('data' in plain));
});

test('runs, plans, pull requests and repository branches', (t) => {
  const repo = repoOn(t);
  repo.createTask(task({ repoIds: ['web'] }));
  const run = repo.createRun({ taskId: 1, phase: 'plan', tool: 'claude' });
  assert.equal(run.status, 'running');
  assert.equal(repo.activeRun(1)?.id, run.id);
  assert.deepEqual(repo.runningRuns().map((r) => r.id), [run.id]);
  repo.finishRun(run.id, { status: 'succeeded', summary: 'ok' });
  assert.equal(repo.activeRun(1), undefined);
  assert.equal(repo.getRun(run.id)?.summary, 'ok');
  assert.ok(repo.getRun(run.id)?.finishedAt);

  const p1 = repo.addPlan(1, 'first');
  const p2 = repo.addPlan(1, 'second');
  assert.equal(repo.getPlan(p1.id)?.status, 'superseded');
  assert.equal(p2.version, 2);
  assert.equal(repo.acceptPlan(1, 'Ada')?.id, p2.id);
  assert.equal(repo.acceptedPlan(1)?.text, 'second');
  assert.equal(repo.acceptPlan(2, 'Ada', p2.id), undefined, "another task's plan can't be accepted for it");
  repo.setPlanFeedback(p2.id, 'shorter');
  assert.equal(repo.getPlan(p2.id)?.feedback, 'shorter');

  repo.upsertPrLink(1, { repoId: 'web', repo: 'acme/web', number: 4, url: 'https://github.com/acme/web/pull/4', state: 'OPEN', branch: 'b' });
  const prs = repo.upsertPrLink(1, { repoId: 'web', repo: 'acme/web', number: 4, url: 'https://github.com/acme/web/pull/4', state: 'MERGED' });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].state, 'MERGED');
  assert.equal(prs[0].branch, 'b', 'a branch once known stays');
  assert.deepEqual(repo.tasksOfPr('ACME/web', 4), [1]);

  repo.setRepoBranch(1, 'web', 'gh-12/login');
  repo.setRepoBranch(1, 'api', 'gh-12/login');
  assert.deepEqual(repo.repoBranches(1), { web: 'gh-12/login', api: 'gh-12/login' });
  assert.deepEqual(repo.getTask(1)?.repoIds, ['web'], 'a branch outside the subset is not in it');
  repo.setTaskRepos(1, ['api']);
  assert.deepEqual(repo.getTask(1)?.repoIds, ['api']);
  assert.deepEqual(repo.repoBranches(1), { web: 'gh-12/login', api: 'gh-12/login' }, 'branches survive a change of subset');

  // Everything of a task goes with it.
  assert.equal(repo.deleteTask(1), true);
  for (const table of ['runs', 'plans', 'pr_links', 'task_repos', 'comments', 'task_events']) assert.equal((repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
});

test("attachments can't be pulled over from another task, and unattached ones are orphans", (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  repo.createTask(task());
  const id = 'b'.repeat(32);
  repo.addAttachment({ id, name: 'log.txt', mime: 'text/plain', size: 1, stored: `${id}-log.txt`, createdBy: 'Ada', createdAt: 10 });
  assert.deepEqual(repo.orphanAttachments(11).map((a) => a.id), [id]);
  assert.equal(repo.linkAttachments([id, 'c'.repeat(32)], 1).length, 1);
  assert.equal(repo.linkAttachments([id], 2).length, 0);
  assert.equal(repo.getAttachment(id)?.taskId, 1);
  assert.deepEqual(repo.orphanAttachments(11), []);
  assert.ok(!('stored' in publicAttachment(repo.getAttachment(id)!)));
  repo.deleteTask(1);
  assert.equal(repo.getAttachment(id), undefined);
});

test('cards count comments per task and take review rounds from the settings', (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  repo.createTask(task({ useReview: false }));
  repo.createTask(task({ project: 'api' }));
  repo.addComment({ taskId: 1, authorKind: 'user', authorName: 'Ada', text: 'a' });
  repo.addComment({ taskId: 1, authorKind: 'user', authorName: 'Ada', text: 'b' });
  repo.addComment({ taskId: 3, authorKind: 'user', authorName: 'Ada', text: 'c' });
  const review = () => ({ rounds: 3, tool: 'codex' as const });
  const cards = repo.listCards('web', {}, review);
  const one = cards.find((c) => c.id === 1)!;
  assert.equal(one.commentCount, 2);
  assert.equal(one.reviewRounds, 3);
  assert.equal(one.reviewTool, 'codex');
  const two = cards.find((c) => c.id === 2)!;
  assert.equal(two.commentCount, 0);
  assert.equal(two.reviewRounds, 0);
  assert.equal(two.reviewTool, undefined);
  assert.ok(!('description' in one));
  assert.equal(repo.card(3, review)?.commentCount, 1);
  assert.equal(toCard(repo.getTask(1)!, 0).reviewRounds, 0);
});

test('legacy bookkeeping and tickets', (t) => {
  const repo = repoOn(t);
  repo.createTask(task({ ticket: 'UYT-1415' }));
  assert.equal(repo.findTaskByTicket('web', 'UYT-1415')?.id, 1);
  assert.equal(repo.findTaskByTicket('api', 'UYT-1415'), undefined);
  repo.mapLegacy('ai-kanban', 'comment', 5, 9);
  repo.mapLegacy('ai-kanban', 'comment', 5, 10);
  assert.equal(repo.lookupLegacy('ai-kanban', 'comment', '5'), '10');
  repo.setMigratedAt(1, 77);
  assert.equal(repo.db.prepare('SELECT migrated_at AS m FROM tasks WHERE id = 1').get() && (repo.db.prepare('SELECT migrated_at AS m FROM tasks WHERE id = 1').get() as { m: number }).m, 77);
});

test('a run launch that cannot be read launches nothing, and the latest run is read without the whole history', (t) => {
  const repo = repoOn(t);
  repo.createTask(task());
  const queued = { phase: 'implement', role: 'implementer', prompt: 'restarted' } as const;
  const good = repo.createRun({ taskId: 1, phase: 'implement', tool: 'claude', launch: queued });
  assert.deepEqual(repo.runLaunch(good.id), queued);
  const bad = (launch: string) => {
    const run = repo.createRun({ taskId: 1, phase: 'pr-review', tool: 'claude' });
    (repo as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db.prepare('UPDATE runs SET launch = ? WHERE id = ?').run(launch, run.id);
    return repo.runLaunch(run.id);
  };
  assert.equal(bad('{not json'), undefined);
  assert.equal(bad('null'), undefined);
  assert.equal(bad(JSON.stringify({ phase: 'implement', role: 'implementer' })), undefined, 'no prompt');
  assert.equal(bad(JSON.stringify({ phase: 4, role: 'implementer', prompt: 'x' })), undefined);
  assert.equal(repo.lastRun(1)?.phase, 'pr-review');
  assert.equal(repo.lastRun(1, 'implement')?.id, good.id);
  assert.equal(repo.lastRun(1, 'plan'), undefined);
  assert.equal(repo.lastRun(2), undefined);
});
