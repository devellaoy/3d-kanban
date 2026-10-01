import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Building, type FloorDef } from '../src/server/building.js';
import type { Floor } from '../src/server/floor.js';
import { installKanban, type Kanban } from '../src/server/kanban/index.js';
import type { KanbanCaller, KanbanClient, KanbanContext, KanbanPluginFactory } from '../src/server/kanban/registry.js';
import type { KanbanEngine } from '../src/server/kanban/engine/index.js';
import { archiveOldTasks } from '../src/server/kanban/ws.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';

type Ctx = { after(fn: () => void): void };

/** An engine that does what the real one would to the task's row, and remembers what it was asked. */
function fakeEngine(calls: string[], answers: Partial<Record<string, string>> = {}) {
  return (ctx: KanbanContext): KanbanEngine => {
    const say = (what: string, id: number) => {
      calls.push(`${what} #${id}`);
      return answers[what];
    };
    return {
      async start(id) {
        const err = say('start', id);
        if (err) return err;
        ctx.repo.updateTask(id, { status: 'in_progress', runState: 'running', phase: 'plan', startedAt: Date.now(), flags: { descriptionLocked: true }, workerId: 'w1' });
      },
      async stop(id) {
        say('stop', id);
        ctx.repo.updateTask(id, { status: 'waiting', runState: 'idle', waitingReason: 'stopped' });
      },
      async continue(id, _who, answer, files) {
        calls.push(`continue #${id} ${answer ?? ''}${files ? ` [${files}]` : ''}`.trim());
      },
      retry: async (id) => say('retry', id),
      review: async (id) => say('review', id),
      approvePlan: async (id) => say('approvePlan', id),
      requestPlanChanges: async (id, _who, text, files) => void calls.push(`requestPlanChanges #${id} ${text}${files ? ` [${files}]` : ''}`),
      pr: async (id, _who, mode) => void calls.push(`pr #${id} ${mode}`),
      async sendWorkersHome(id, _who, why) {
        const err = say(`home ${why}`, id);
        if (err) return err;
        ctx.repo.updateTask(id, { workerId: null, reviewerWorkerId: null });
      },
      async commented(id, commentId, who) {
        calls.push(`commented #${id} ${commentId} by ${who.name}`);
      },
      prForWorker: async (floorId, workerId) => say(`prForWorker ${floorId}/${workerId}`, 0),
      begin: () => void calls.push('begin'),
      dispose: () => void calls.push('dispose'),
    };
  };
}

function office(t: Ctx, opts: { answers?: Partial<Record<string, string>>; plugins?: KanbanPluginFactory[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-core-ws-'));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const checkout = (name: string) => {
    const dir = path.join(root, 'acme', name);
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  };
  const defs: FloorDef[] = [
    { id: 'web', name: 'web', repo: 'acme/web', dir: checkout('web'), palette: 0, addedBy: 'Sam', addedAt: 1 },
    { id: 'docs', name: 'docs', repo: 'acme/docs', dir: checkout('docs'), palette: 1, addedBy: 'Sam', addedAt: 1 },
  ];
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(defs));
  const api = checkout('api');
  const building = new Building(dataDir, root);
  const live = new Set<string>();
  const calls: string[] = [];
  const toasts: string[] = [];
  const kanban = installKanban({
    dataDir,
    floors: () => building.list(),
    floor: (id) => (building.list().some((d) => d.id === id) ? ({ id, workers: { get: (w: string) => (live.has(w) ? { id: w } : undefined) } } as unknown as Floor) : undefined),
    saveRepos: (id, repos) => building.setRepos(id, repos),
    saveName: (id, name) => building.setName(id, name),
    officePrompts: () => ({}),
    hookUrl: 'http://127.0.0.1:9',
    toast: (_floor, text) => void toasts.push(text),
    createEngine: fakeEngine(calls, opts.answers),
    plugins: opts.plugins ?? [],
  });
  t.after(() => {
    kanban.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  const client = (name: string, admin: boolean) => {
    const got: KanbanServerMsg[] = [];
    const c: KanbanClient = { clientId: `c${++n}`, name, admin, send: (m) => void got.push(structuredClone(m)) };
    /** Sends a request and waits for its answer. */
    const ask = async (msg: Record<string, unknown>): Promise<KanbanServerMsg> => {
      const rid = `r${++n}`;
      kanban.handleWs(c, { ...msg, rid });
      for (let i = 0; i < 50; i++) {
        const reply = got.find((m) => 'rid' in m && m.rid === rid);
        if (reply) return reply;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error(`no answer to ${JSON.stringify(msg)}`);
    };
    const deltas = (t?: KanbanServerMsg['t']) => got.filter((m) => !('rid' in m && m.rid) && (!t || m.t === t));
    return { c, got, ask, deltas };
  };
  return { kanban, building, dataDir, api, live, calls, toasts, client, root };
}

const okOf = (m: KanbanServerMsg) => {
  assert.equal(m.t, 'kanban.ok', m.t === 'kanban.error' ? m.message : m.t);
  return m as Extract<KanbanServerMsg, { t: 'kanban.ok' }>;
};
const errorOf = (m: KanbanServerMsg, why: RegExp) => {
  assert.equal(m.t, 'kanban.error', JSON.stringify(m));
  assert.match((m as { message: string }).message, why);
};

test('the engine begins once everything is there and stops with the kanban', (t) => {
  const { kanban, calls } = office(t);
  assert.deepEqual(calls, ['begin']);
  kanban.shutdown();
  kanban.shutdown();
  assert.deepEqual(calls, ['begin', 'dispose']);
});

test('subscribing answers with the board, and deltas reach only who subscribed to that project', async (t) => {
  const { client } = office(t);
  const ada = client('Ada', true);
  const bob = client('Bob', false);
  const eve = client('Eve', false);
  const snap = await ada.ask({ t: 'kanban.subscribe', project: null });
  assert.equal(snap.t, 'kanban.snapshot');
  if (snap.t !== 'kanban.snapshot') return;
  assert.deepEqual(snap.projects.map((p) => [p.id, p.open, p.repos.length]), [['web', true, 1], ['docs', true, 1]]);
  assert.deepEqual(snap.me, { admin: true, name: 'Ada' });
  assert.deepEqual(snap.secrets, { jira: { configured: false }, apiKey: { configured: false } });
  assert.equal(snap.settings.archiveAfterDays, 30);
  await bob.ask({ t: 'kanban.subscribe', project: 'docs' });

  const created = okOf(await eve.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'Fix login' } }));
  assert.equal(created.taskId, 1);
  const card = ada.deltas('kanban.task');
  assert.equal(card.length, 1);
  assert.equal(card[0].t === 'kanban.task' && card[0].task.title, 'Fix login');
  assert.equal(bob.deltas('kanban.task').length, 0, 'Bob looks at docs only');
  assert.equal(eve.deltas().length, 0, 'Eve never subscribed');

  const onDocs = okOf(await eve.ask({ t: 'kanban.task.create', task: { project: 'docs', title: 'Write the guide' } }));
  assert.equal(bob.deltas('kanban.task').length, 1);
  assert.equal(ada.deltas('kanban.task').length, 2);
  const bobSnap = await bob.ask({ t: 'kanban.snapshot', project: 'docs' });
  assert.deepEqual(bobSnap.t === 'kanban.snapshot' && bobSnap.tasks.map((c) => c.id), [onDocs.taskId]);

  // Unsubscribed, or gone: nothing more.
  okOf(await bob.ask({ t: 'kanban.unsubscribe' }));
  await eve.ask({ t: 'kanban.task.create', task: { project: 'docs', title: 'Another' } });
  assert.equal(bob.deltas('kanban.task').length, 1);
});

test('a new task takes the defaults, is checked against its project, and can start at once', async (t) => {
  const { client, calls, kanban } = office(t, { answers: {} });
  const ada = client('Ada', false);
  errorOf(await ada.ask({ t: 'kanban.task.create', task: { project: 'nope', title: 'x' } }), /no project nope/);
  errorOf(await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x', repoIds: ['web', 'api'] } }), /api isn't one of the project's repositories/);
  const made = okOf(await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x', repoIds: ['web'], tool: 'codex', tags: ['ui'], review: { rounds: 4 } }, start: true }));
  assert.equal(made.startError, undefined);
  assert.deepEqual(calls.slice(-1), ['start #1']);
  const task = kanban.ctx.repo.getTask(1)!;
  assert.equal(task.tool, 'codex');
  assert.equal(task.createdBy, 'Ada');
  assert.deepEqual(task.repoIds, ['web']);
  assert.deepEqual(task.overrides, { review: { rounds: 4 } });
  assert.equal(task.planApproval, 'auto');
  assert.equal(task.status, 'in_progress');
  assert.equal(kanban.ctx.card(1)?.reviewRounds, 4);
  assert.deepEqual(kanban.ctx.repo.listEvents(1).map((e) => e.kind), ['created']);
});

test('a start the engine refuses is still a created task, with why', async (t) => {
  const { client } = office(t, { answers: { start: 'The office is full' } });
  const made = okOf(await client('Ada', false).ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' }, start: true }));
  assert.equal(made.taskId, 1);
  assert.equal(made.startError, 'The office is full');
});

test('edits: structural fields only in To do, the description locked once started', async (t) => {
  const { client, kanban } = office(t);
  const ada = client('Ada', false);
  await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x', description: 'first' } });
  okOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { description: 'second', tool: 'codex', repoIds: ['web'], review: { rounds: 2 }, implementPermission: 'workspace-write' } }));
  let task = kanban.ctx.repo.getTask(1)!;
  assert.equal(task.description, 'second');
  assert.equal(task.tool, 'codex');
  assert.deepEqual(task.overrides, { review: { rounds: 2 }, implementPermission: 'workspace-write' });
  okOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { review: null, implementPermission: null } }));
  assert.deepEqual(kanban.ctx.repo.getTask(1)!.overrides, {});
  errorOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { repoIds: ['api'] } }), /isn't one of/);
  errorOf(await ada.ask({ t: 'kanban.task.update', id: 9, patch: { title: 'y' } }), /no task #9/);

  await ada.ask({ t: 'kanban.task.start', id: 1 });
  errorOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { description: 'third' } }), /description is locked/);
  // Who carries it out only while no run is going; the rest of how it runs only in To do.
  errorOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { tool: 'claude' } }), /tool can only be changed while no run is going/);
  errorOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { usePlan: false } }), /usePlan can only be changed while the task is in To do/);
  // Sending the same description back (a whole form) is no change.
  okOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { description: 'second', title: 'Better title', tags: ['a'], ticket: 'UYT-9' } }));
  task = kanban.ctx.repo.getTask(1)!;
  assert.equal(task.title, 'Better title');
  assert.equal(task.ticket, 'UYT-9');
  okOf(await ada.ask({ t: 'kanban.task.update', id: 1, patch: { ticket: null } }));
  assert.equal(kanban.ctx.repo.getTask(1)!.ticket, undefined);
});

test('moves are the server’s to allow: start, reset, done, archive and back', async (t) => {
  const { client, kanban, live, calls } = office(t);
  const ada = client('Ada', false);
  await ada.ask({ t: 'kanban.subscribe', project: 'web' });
  const watcher = client('Archivist', false);
  await watcher.ask({ t: 'kanban.subscribe', project: null, includeArchived: true });
  await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' } });
  errorOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'done' }), /only once it has been worked on/);
  okOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'in_progress' }));
  assert.ok(calls.includes('start #1'));
  errorOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'review' }), /stop it first/);
  await ada.ask({ t: 'kanban.task.stop', id: 1 });
  // Its worker is still at the desk, at rest: starting over sends it home first.
  live.add('w1');
  kanban.ctx.repo.updateTask(1, { sessionId: 'sess', reviewRound: 2 });
  okOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'todo' }));
  assert.ok(calls.includes('home reset #1'), 'its workers went home before the reset');
  live.delete('w1');
  let task = kanban.ctx.repo.getTask(1)!;
  assert.equal(task.status, 'todo');
  assert.equal(task.sessionId, undefined);
  assert.equal(task.reviewRound, 0);
  assert.equal(task.workerId, undefined);
  assert.ok(task.startedAt, 'it has been started once: the description stays locked');

  kanban.ctx.repo.updateTask(1, { status: 'review' });
  okOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'done' }));
  assert.ok(kanban.ctx.repo.getTask(1)!.doneAt);
  okOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'archived' }));
  task = kanban.ctx.repo.getTask(1)!;
  assert.equal(task.status, 'archived');
  assert.ok(task.archivedAt);
  // Off the board of whoever isn't looking at the archive; the archive's watcher sees the card.
  const last = ada.deltas().at(-1)!;
  assert.deepEqual(last, { t: 'kanban.task.removed', id: 1, project: 'web' });
  const seen = watcher.deltas().at(-1)!;
  assert.equal(seen.t === 'kanban.task' && seen.task.status, 'archived');
  okOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'done' }));
  assert.equal(kanban.ctx.repo.getTask(1)!.archivedAt, undefined);
  assert.deepEqual(kanban.ctx.repo.listEvents(1).filter((e) => e.kind === 'moved').map((e) => (e.data as { to: string }).to), ['todo', 'done', 'archived', 'done']);
});

test('a reset or a delete the engine refuses (a run is live) leaves the task as it is', async (t) => {
  const { client, kanban } = office(t, { answers: { 'home reset': 'Stop it first: it is running', 'home delete': 'Stop it first: it is running' } });
  const ada = client('Ada', true);
  await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' } });
  kanban.ctx.repo.updateTask(1, { status: 'review' });
  errorOf(await ada.ask({ t: 'kanban.task.move', id: 1, to: 'todo' }), /Stop it first/);
  assert.equal(kanban.ctx.repo.getTask(1)!.status, 'review');
  errorOf(await ada.ask({ t: 'kanban.task.delete', id: 1 }), /Stop it first/);
  assert.ok(kanban.ctx.repo.getTask(1));
});

test('deleting: not while running, workers at rest go home first, only by its maker or an admin', async (t) => {
  const { client, kanban, live, dataDir, calls } = office(t);
  const ada = client('Ada', false);
  const bob = client('Bob', false);
  const boss = client('Boss', true);
  await boss.ask({ t: 'kanban.subscribe', project: null });
  await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' } });
  errorOf(await bob.ask({ t: 'kanban.task.delete', id: 1 }), /Only whoever made it/);
  kanban.ctx.repo.updateTask(1, { runState: 'running' });
  errorOf(await ada.ask({ t: 'kanban.task.delete', id: 1 }), /Stop it first/);
  kanban.ctx.repo.updateTask(1, { runState: 'idle', workerId: 'w2' });
  live.add('w2');
  // Its files go with it.
  const uploads = path.join(dataDir, 'kanban', 'uploads');
  mkdirSync(uploads, { recursive: true });
  const id = 'c'.repeat(32);
  writeFileSync(path.join(uploads, `${id}-a.txt`), 'x');
  kanban.ctx.repo.addAttachment({ id, taskId: 1, name: 'a.txt', mime: 'text/plain', size: 1, stored: `${id}-a.txt`, createdBy: 'Ada', createdAt: 1 });
  assert.equal(kanban.ctx.attachmentFile(id), path.join(uploads, `${id}-a.txt`));
  okOf(await boss.ask({ t: 'kanban.task.delete', id: 1 }));
  assert.ok(calls.includes('home delete #1'), 'its worker at rest went home first');
  live.delete('w2');
  assert.equal(kanban.ctx.repo.getTask(1), undefined);
  assert.equal(existsSync(path.join(uploads, `${id}-a.txt`)), false);
  assert.deepEqual(boss.deltas().at(-1), { t: 'kanban.task.removed', id: 1, project: 'web' });
});

test('a comment is stored with its files, pushed to the board, then handed to the engine', async (t) => {
  const { client, kanban, calls } = office(t);
  const ada = client('Ada', false);
  await ada.ask({ t: 'kanban.subscribe', project: 'web' });
  await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' } });
  const id = 'd'.repeat(32);
  kanban.ctx.repo.addAttachment({ id, name: 'shot.png', mime: 'image/png', size: 1, stored: `${id}-shot.png`, createdBy: 'Ada', createdAt: Date.now() });
  const reply = okOf(await ada.ask({ t: 'kanban.comment.add', id: 1, text: 'Look at this', attachmentIds: [id] }));
  assert.ok(reply.commentId);
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.includes(`commented #1 ${reply.commentId} by Ada`));
  const pushed = ada.deltas('kanban.comment').at(-1)!;
  assert.equal(pushed.t === 'kanban.comment' && pushed.comment.text, 'Look at this');
  assert.deepEqual(pushed.t === 'kanban.comment' && pushed.comment.attachmentIds, [id]);
  assert.equal(kanban.ctx.card(1)?.commentCount, 1);
  errorOf(await ada.ask({ t: 'kanban.comment.add', id: 5, text: 'x' }), /no task #5/);

  // The detail view: the newest comments, and the older ones page by page.
  for (let i = 0; i < 4; i++) kanban.ctx.repo.addComment({ taskId: 1, authorKind: 'agent', authorName: 'Claude', text: `a${i}` });
  const detail = await ada.ask({ t: 'kanban.task.get', id: 1, comments: 2 });
  assert.equal(detail.t, 'kanban.task.detail');
  if (detail.t !== 'kanban.task.detail') return;
  assert.deepEqual(detail.comments.map((c) => c.text), ['a2', 'a3']);
  assert.equal(detail.commentsMore, true);
  assert.deepEqual(detail.attachments.map((a) => a.id), [id]);
  assert.ok(!('stored' in detail.attachments[0]));
  const older = await ada.ask({ t: 'kanban.comments.page', id: 1, before: detail.comments[0].id, limit: 10 });
  assert.deepEqual(older.t === 'kanban.comments' && older.comments.map((c) => c.text), ['Look at this', 'a0', 'a1']);
  const none = await ada.ask({ t: 'kanban.task.get', id: 1, comments: 0 });
  assert.deepEqual(none.t === 'kanban.task.detail' && [none.comments.length, none.commentsMore], [0, true]);
});

test('the process is the engine’s: its answers come back as ok or error', async (t) => {
  const { client, kanban, calls } = office(t, { answers: { retry: 'Nothing to retry' } });
  const ada = client('Ada', false);
  await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' } });
  okOf(await ada.ask({ t: 'kanban.task.continue', id: 1, answer: 'Use Postgres' }));
  okOf(await ada.ask({ t: 'kanban.task.review', id: 1 }));
  okOf(await ada.ask({ t: 'kanban.task.pr', id: 1, mode: 'create' }));
  okOf(await ada.ask({ t: 'kanban.plan.requestChanges', id: 1, text: 'Smaller steps' }));
  okOf(await ada.ask({ t: 'kanban.task.continue', id: 1, answer: 'See file', attachmentIds: ['c'.repeat(32)] }));
  okOf(await ada.ask({ t: 'kanban.plan.requestChanges', id: 1, text: 'As drawn', attachmentIds: ['d'.repeat(32)] }));
  errorOf(await ada.ask({ t: 'kanban.task.retry', id: 1 }), /Nothing to retry/);
  errorOf(await ada.ask({ t: 'kanban.task.stop', id: 2 }), /no task #2/);
  assert.deepEqual(calls.slice(1), ['continue #1 Use Postgres', 'review #1', 'pr #1 create', 'requestPlanChanges #1 Smaller steps', `continue #1 See file [${'c'.repeat(32)}]`, `requestPlanChanges #1 As drawn [${'d'.repeat(32)}]`, 'retry #1']);

  // Approving a plan by id: only the latest version can be.
  const p1 = kanban.ctx.repo.addPlan(1, 'v1');
  const p2 = kanban.ctx.repo.addPlan(1, 'v2');
  errorOf(await ada.ask({ t: 'kanban.plan.approve', id: 1, planId: p1.id }), /newer version/);
  errorOf(await ada.ask({ t: 'kanban.plan.approve', id: 1, planId: 999 }), /no such plan/);
  okOf(await ada.ask({ t: 'kanban.plan.approve', id: 1, planId: p2.id }));
  okOf(await ada.ask({ t: 'kanban.plan.approve', id: 1 }));
  assert.equal(calls.filter((c) => c === 'approvePlan #1').length, 2);
});

test('settings, projects, prompts and secrets are for admins; everyone may read the settings', async (t) => {
  const { client, kanban, building, api, dataDir } = office(t);
  const bob = client('Bob', false);
  const boss = client('Boss', true);
  await bob.ask({ t: 'kanban.subscribe', project: 'docs' });
  const read = await bob.ask({ t: 'kanban.settings.get' });
  assert.equal(read.t, 'kanban.settings');
  // ⚙️ Settings without a board: the settings, the projects and who you are, no cards.
  const meta = await bob.ask({ t: 'kanban.meta.get' });
  assert.equal(meta.t, 'kanban.meta');
  assert.deepEqual(meta.me, { admin: false, name: 'Bob' });
  assert.ok(Array.isArray(meta.projects) && meta.projects.length > 0);
  assert.ok(meta.settings && meta.secrets);
  assert.equal('tasks' in meta, false);
  for (const msg of [
    { t: 'kanban.settings.set', settings: { archiveAfterDays: 3 } },
    { t: 'kanban.project.settings.set', project: 'web', settings: { maxConcurrent: 5 } },
    { t: 'kanban.project.repos.set', project: 'web', repos: [] },
    { t: 'kanban.project.rename', project: 'web', name: 'Shop' },
    { t: 'kanban.project.prompt.set', project: 'web', id: 'kanban.plan', text: 'x' },
    { t: 'kanban.secrets.set', apiKey: 'k'.repeat(20) },
  ]) errorOf(await bob.ask(msg), /Only an admin/);

  okOf(await boss.ask({ t: 'kanban.settings.set', settings: { archiveAfterDays: 9999, review: { rounds: 3 } } }));
  assert.equal(kanban.ctx.settings.get().archiveAfterDays, 3650);
  const pushed = bob.deltas('kanban.settings').at(-1)!;
  assert.equal(pushed.t === 'kanban.settings' && pushed.settings.review.rounds, 3);
  assert.ok(bob.deltas('kanban.projects').length > 0, 'the projects list sums the settings up too');

  errorOf(await boss.ask({ t: 'kanban.project.settings.set', project: 'nope', settings: {} }), /no project nope/);
  okOf(await boss.ask({ t: 'kanban.project.settings.set', project: 'web', settings: { maxConcurrent: 5, planApproval: 'manual' } }));
  assert.equal(kanban.ctx.settings.project('web').maxConcurrent, 5);
  assert.equal(kanban.ctx.settings.planApproval('web'), 'manual');

  errorOf(await boss.ask({ t: 'kanban.project.prompt.set', project: 'web', id: 'kanban.nothing', text: 'x' }), /isn't a kanban prompt/);
  okOf(await boss.ask({ t: 'kanban.project.prompt.set', project: 'web', id: 'kanban.plan', text: 'Plan it our way' }));
  assert.equal(kanban.ctx.settings.project('web').prompts['kanban.plan'], 'Plan it our way');

  // Repositories: checked on disk, saved in floors.json, pushed as the projects list.
  const web = building.list()[0].dir;
  errorOf(await boss.ask({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'web', dir: web, primary: true }, { id: 'api', name: 'API', dir: path.join(api, 'gone'), primary: false }] }), /isn't a folder/);
  const before = bob.deltas('kanban.projects').length;
  okOf(await boss.ask({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'web', dir: web, primary: true }, { id: 'api', name: 'API', dir: api, primary: false }] }));
  assert.deepEqual(kanban.ctx.repos('web').map((r) => r.id), ['web', 'api']);
  const floors = JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[];
  assert.deepEqual(floors[0].repos?.map((r) => r.id), ['web', 'api']);
  const projects = bob.deltas('kanban.projects');
  assert.equal(projects.length, before + 1);
  assert.deepEqual(projects.at(-1)!.t === 'kanban.projects' && projects.at(-1)!.projects[0].repos.map((r) => r.id), ['web', 'api']);
  // Back to just its own checkout: the floor has no list of its own again.
  okOf(await boss.ask({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'web', dir: web, primary: true }] }));
  assert.ok(!('repos' in building.list()[0]));
  // Renaming: the floor's name only; its id stays.
  errorOf(await boss.ask({ t: 'kanban.project.rename', project: 'nope', name: 'Shop' }), /no project nope/);
  errorOf(await boss.ask({ t: 'kanban.project.rename', project: 'web', name: 'DOCS' }), /already a project called DOCS/);
  const beforeRename = bob.deltas('kanban.projects').length;
  okOf(await boss.ask({ t: 'kanban.project.rename', project: 'web', name: '  Shop  ' }));
  assert.equal(building.list()[0].name, 'Shop');
  assert.equal(building.list()[0].id, 'web');
  assert.equal(kanban.ctx.project('web')?.name, 'Shop');
  const renamed = bob.deltas('kanban.projects');
  assert.equal(renamed.length, beforeRename + 1);
  const last = renamed.at(-1)!;
  assert.equal(last.t === 'kanban.projects' && last.projects.find((p) => p.id === 'web')?.name, 'Shop');
  // A saved list's primary, called after the project, takes the new name too; one named otherwise keeps its own.
  okOf(await boss.ask({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'Shop', dir: web, primary: true }, { id: 'api', name: 'API', dir: api, primary: false }] }));
  okOf(await boss.ask({ t: 'kanban.project.rename', project: 'web', name: 'Store' }));
  assert.equal(building.list()[0].repos?.find((r) => r.primary)?.name, 'Store');
  okOf(await boss.ask({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'Front', dir: web, primary: true }, { id: 'api', name: 'API', dir: api, primary: false }] }));
  okOf(await boss.ask({ t: 'kanban.project.rename', project: 'web', name: 'Shop' }));
  assert.equal(building.list()[0].repos?.find((r) => r.primary)?.name, 'Front');
  // Back to just its own checkout under the new name: no list of its own again.
  okOf(await boss.ask({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'Shop', dir: web, primary: true }] }));
  assert.ok(!('repos' in building.list()[0]));

  // A task may now use api... only while it's in the project.
  await boss.ask({ t: 'kanban.task.create', task: { project: 'web', title: 'x' } });
  errorOf(await boss.ask({ t: 'kanban.task.update', id: 1, patch: { repoIds: ['api'] } }), /isn't one of/);

  // Secrets: the answer and every push say only whether they're set.
  const answer = await boss.ask({ t: 'kanban.secrets.set', jira: { site: 'acme.atlassian.net', email: 'boss@acme.fi', token: 'TOPSECRET' }, apiKey: 'API-KEY-0123456789' });
  assert.equal(answer.t, 'kanban.settings');
  assert.deepEqual(answer.t === 'kanban.settings' && answer.secrets, { jira: { configured: true, site: 'acme.atlassian.net' }, apiKey: { configured: true } });
  const everything = JSON.stringify([...boss.got, ...bob.got]);
  assert.ok(!everything.includes('TOPSECRET'));
  assert.ok(!everything.includes('API-KEY-0123456789'));
  assert.ok(!everything.includes('boss@acme.fi'));
  assert.equal(kanban.ctx.secrets.jira()?.token, 'TOPSECRET');
});

test('what the validator refuses, and what no plugin handles, is answered with kanban.error', async (t) => {
  const { client, kanban } = office(t);
  const ada = client('Ada', false);
  errorOf(await ada.ask({ t: 'kanban.task.get', id: 'one' }), /task number/);
  errorOf(await ada.ask({ t: 'kanban.whatever' }), /Unknown kanban message/);
  errorOf(await ada.ask({ t: 'kanban.issues.list', project: 'web' }), /isn't available/);
  errorOf(await ada.ask({ t: 'kanban.pr.bundle', project: 'web', taskId: 1 }), /isn't available/);
  // Without a usable rid it's still answered, just without one.
  kanban.handleWs(ada.c, { t: 'kanban.task.get', id: 'one', rid: 7 });
  assert.equal(ada.got.at(-1)?.t, 'kanban.error');
  assert.ok(!('rid' in ada.got.at(-1)!));
});

test('plugins own their message types and routes; their worker extras are merged', async (t) => {
  const seen: string[] = [];
  const skills: KanbanPluginFactory = () => ({
    name: 'skills',
    ws: {
      'kanban.skills.list': (c, m) => c.send({ t: 'kanban.skills', ...(m.rid ? { rid: m.rid } : {}), skills: [] }),
      // The core already owns this one: the core keeps it.
      'kanban.task.get': () => void seen.push('stolen'),
      'kanban.skills.sync': () => {
        throw new Error('boom');
      },
    },
    http: {
      '/api/kanban/skills': (_req: IncomingMessage, res: ServerResponse) => {
        seen.push('http');
        res.end();
        return true;
      },
    },
    hook: {
      '/office/tasks': (_req: IncomingMessage, _res: ServerResponse, url: URL, who) => {
        seen.push(`hook ${url.pathname} ${who.workerId} ${who.taskId}`);
        return true;
      },
    },
    loopback: { '/api/v1/': () => (seen.push('v1'), true) },
    workerArgs: (taskId, tool, phase) => ['--plugin-dir', `/skills/${taskId}/${tool}/${phase}`],
    workerEnv: () => ({ SKILLS: 'on' }),
    start: () => void seen.push('start'),
    stop: () => void seen.push('stop'),
  });
  const refs: KanbanPluginFactory = () => ({ name: 'refs', workerEnv: () => ({ REFS: '1' }), workerArgs: () => { throw new Error('bad plugin'); } });
  const { client, kanban } = office(t, { plugins: [skills, refs] });
  assert.deepEqual(seen, ['start']);
  const ada = client('Ada', false);
  const listed = await ada.ask({ t: 'kanban.skills.list' });
  assert.equal(listed.t, 'kanban.skills');
  errorOf(await ada.ask({ t: 'kanban.skills.sync' }), /Something went wrong: boom/);
  errorOf(await ada.ask({ t: 'kanban.task.get', id: 1 }), /no task #1/);
  assert.ok(!seen.includes('stolen'));

  const res = { end() {} } as unknown as ServerResponse;
  const req = {} as IncomingMessage;
  const who: KanbanCaller = { name: 'Ada', admin: false };
  assert.equal(await kanban.handleHttp(req, res, new URL('http://x/api/kanban/skills/list'), who), true);
  assert.equal(await kanban.handleHttp(req, res, new URL('http://x/api/kanban/nothing'), who), false);
  assert.equal(await kanban.handleHook(req, res, new URL('http://x/office/tasks/reference?ref=1'), { workerId: 'w1', floorId: 'web', taskId: 4 }), true);
  assert.equal(await kanban.handleLoopback(req, res, new URL('http://x/api/v1/tasks'), ), true);
  assert.equal(await kanban.handleLoopback(req, res, new URL('http://x/api/tasks/reference'), ), false);
  assert.deepEqual(seen.slice(1), ['http', 'hook /office/tasks/reference w1 4', 'v1']);

  // A plugin that throws only loses its own part.
  assert.deepEqual(kanban.ctx.workerExtras(3, 'claude', 'plan'), { args: ['--plugin-dir', '/skills/3/claude/plan'], env: { SKILLS: 'on', REFS: '1' } });
  kanban.shutdown();
  assert.equal(seen.at(-1), 'stop');
});

test('done tasks untouched for archiveAfterDays go to the archive; 0 keeps them', async (t) => {
  const { client, kanban } = office(t);
  const ada = client('Ada', true);
  await ada.ask({ t: 'kanban.subscribe', project: null });
  const day = 24 * 60 * 60_000;
  const now = Date.now();
  for (const title of ['old', 'recent', 'not done']) await ada.ask({ t: 'kanban.task.create', task: { project: 'web', title } });
  kanban.ctx.repo.updateTask(1, { status: 'done', doneAt: now - 31 * day });
  kanban.ctx.repo.updateTask(2, { status: 'done', doneAt: now - 2 * day });
  kanban.ctx.repo.updateTask(3, { status: 'review', updatedAt: now - 90 * day });
  assert.deepEqual(archiveOldTasks(kanban.ctx, now), [1]);
  assert.equal(kanban.ctx.repo.getTask(1)!.status, 'archived');
  assert.equal(kanban.ctx.repo.getTask(1)!.archivedAt, now);
  assert.deepEqual(ada.deltas().at(-1), { t: 'kanban.task.removed', id: 1, project: 'web' });
  assert.deepEqual(archiveOldTasks(kanban.ctx, now), []);
  await ada.ask({ t: 'kanban.settings.set', settings: { archiveAfterDays: 0 } });
  assert.deepEqual(archiveOldTasks(kanban.ctx, now + 400 * day), []);
});

test('the projects list is pushed when the floors change, and only then', async (t) => {
  const { client, kanban, building } = office(t);
  const ada = client('Ada', false);
  await ada.ask({ t: 'kanban.subscribe', project: null });
  kanban.projectsChanged();
  const first = ada.deltas('kanban.projects').length;
  kanban.projectsChanged();
  assert.equal(ada.deltas('kanban.projects').length, first, 'nothing changed');
  building.remove('docs');
  kanban.projectsChanged();
  const last = ada.deltas('kanban.projects').at(-1)!;
  assert.deepEqual(last.t === 'kanban.projects' && last.projects.map((p) => p.id), ['web']);
  kanban.clientGone(ada.c.clientId);
  building.remove('web');
  kanban.projectsChanged();
  assert.equal(ada.deltas('kanban.projects').at(-1), last);
});
