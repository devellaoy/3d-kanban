// POST /office/tasks/create: an agent puts work on the board (create_task, `office-tasks create`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { readCreateRequest } from '../src/server/kanban/integrations/issues/agent-create.js';
import { createRefsPlugin } from '../src/server/kanban/integrations/refs/index.js';
import type { IssueSourceIo } from '../src/server/kanban/integrations/issues/source.js';
import type { KanbanHookCaller } from '../src/server/kanban/registry.js';
import { hookCaller } from '../src/server/kanban/http/hooks.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreWorkers, saveWorkers } from '../src/server/workers/persist.js';
import type { Worker } from '../src/server/workers/types.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

const PATH = '/office/tasks/create';
type Json = Record<string, any>;

interface Setup {
  sources?: IssueSourceConfig[];
  ghAs?: Parameters<typeof makeCtx>[1] extends infer O ? (O extends { ghAs?: infer G } ? G : never) : never;
  startError?: string;
  issues?: { number: number; assignees?: string[] }[];
  extraRepos?: boolean;
}

function setup(opts: Setup = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })], { ...(opts.ghAs ? { ghAs: opts.ghAs } : {}), ...(opts.startError ? { start: () => opts.startError } : {}) });
  ctx.settings.setProject('app', { issueSources: opts.sources ?? ([{ id: 's1', kind: 'github-repo', repos: ['o/app'], filters: {} }] as IssueSourceConfig[]) });
  const data = opts.issues ?? [{ number: 12 }];
  const calls: string[][] = [];
  const gh: IssueSourceIo['gh'] = async (args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(data.map((i) => ({ number: i.number, title: `Issue ${i.number}`, url: `https://github.com/o/app/issues/${i.number}`, body: 'Issue body', state: 'OPEN', assignees: (i.assignees ?? []).map((login) => ({ login })), labels: [], updatedAt: '2026-09-02T10:00:00Z' })));
    if (args[1] === 'view') {
      const i = data.find((x) => String(x.number) === args[2]);
      if (!i) throw new Error('no such issue');
      // Both what the claim reads (state, assignees) and the issue itself, as the lookup by key reads it.
      return JSON.stringify({ number: Number(args[2]), title: `Issue ${args[2]}`, url: `https://github.com/o/app/issues/${args[2]}`, body: 'Issue body', state: 'OPEN', assignees: (i?.assignees ?? []).map((login) => ({ login })), labels: [], updatedAt: '2026-09-02T10:00:00Z' });
    }
    if (args[0] === 'api') return 'panu\n';
    return '';
  };
  const issues = createIssues(ctx, { gh });
  const handler = issues.plugin.hook![PATH]!;
  const worker = (over: Partial<KanbanHookCaller> = {}): KanbanHookCaller => ({ workerId: 'w1', floorId: 'app', name: 'Ada', kind: 'agent', ...over });
  /** One request to the route, as the hook server would hand it over. */
  const call = async (body: unknown, who: KanbanHookCaller = worker(), method = 'POST', pathname = PATH): Promise<{ status: number; body: Json }> => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method, headers: {} }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead: (s: number) => void (status = s), end: (t: string) => void (text = t) } as unknown as ServerResponse;
    const handled = await handler(req, res, new URL(pathname, 'http://127.0.0.1'), who);
    assert.equal(handled, true);
    return { status, body: JSON.parse(text) };
  };
  return { ctx, issues, call, worker, calls, edits: () => calls.filter((a) => a[1] === 'edit') };
}

const env = (dir: string) => ({ ghAs: () => ({ env: { GH_CONFIG_DIR: dir } }) });

test('a plain request makes a To do task, the person the agent runs as is its creator and the agent is on the event', async () => {
  const { ctx, call, worker } = setup();
  const r = await call({ title: '  Fix   the\nlogin ', description: 'Make it work' }, worker({ accountId: 'acc1', accountName: 'Panu' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, task: { id: 1, title: 'Fix the login', status: 'todo', runState: 'idle', project: 'app', url: '/kanban?task=1' }, existed: false, started: false, queued: false });
  const task = ctx.repo.getTask(1)!;
  assert.equal(task.createdBy, 'Panu');
  assert.equal(task.createdByAccount, 'acc1');
  assert.equal(task.description, 'Make it work');
  assert.deepEqual(ctx.repo.listEvents(1).find((e) => e.kind === 'created')?.data, { by: 'Panu', via: 'Ada', viaWorker: 'w1' });
  assert.deepEqual(ctx.toasts, [{ floor: 'app', text: '📋 Ada created task #1 “Fix the login”', level: 'info' }]);
  assert.ok(ctx.changed.includes(1));
  assert.deepEqual(ctx.started, []);
});

test('without an account the creator is the hirer of a desk worker, else the agent; a task worker’s task takes its parent’s creator', async () => {
  const { ctx, call, worker } = setup();
  await call({ title: 'a', description: 'd' }, worker({ hiredBy: 'Boss' }));
  await call({ title: 'b', description: 'd' }, worker());
  await call({ title: 'c', description: 'd' }, worker({ station: true, hiredBy: 'Boss' }));
  const parent = ctx.repo.createTask({ project: 'app', title: 'Parent', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Maija' });
  await call({ title: 'd', description: 'd' }, worker({ taskId: parent.id, hiredBy: 'Ada (kanban #1)' }));
  assert.deepEqual([1, 2, 3, 5].map((id) => ctx.repo.getTask(id)!.createdBy), ['Boss', 'Ada', 'Ada', 'Maija']);
  assert.equal(ctx.repo.getTask(2)!.createdByAccount, undefined);
});

test('only a person’s hire names its hirer: a queue worker or an agent’s hire without an account creates as the agent', async () => {
  const { ctx, call } = setup();
  const info = (over: Partial<WorkerInfo>) => ({ id: 'w1', name: 'Ada', kind: 'agent', deskId: 'desk-1', createdBy: 'Bob', ...over }) as WorkerInfo;
  assert.equal(hookCaller(info({ byPerson: true }), 'app').hiredBy, 'Bob');
  for (const [i, hire] of [info({ createdBy: 'Bob (queue)' }), info({ createdBy: 'Mochi' }), info({ createdBy: 'Bob' })].entries()) {
    const who = hookCaller(hire, 'app');
    assert.equal(who.hiredBy, undefined);
    await call({ title: `t${i}`, description: 'd' }, who);
  }
  assert.deepEqual([1, 2, 3].map((id) => ctx.repo.getTask(id)!.createdBy), ['Ada', 'Ada', 'Ada']);
  await call({ title: 'person', description: 'd' }, hookCaller(info({ byPerson: true }), 'app'));
  assert.equal(ctx.repo.getTask(4)!.createdBy, 'Bob');
  assert.deepEqual(hookCaller(info({ kanban: { taskId: 9 } as WorkerInfo['kanban'], deskId: 'station-queue' }), 'app', 'acc1', 'Panu'), { workerId: 'w1', floorId: 'app', taskId: 9, name: 'Ada', kind: 'agent', station: true, accountId: 'acc1', accountName: 'Panu' });
});

test('a person’s hire is still theirs after a restart: its tasks keep their creator', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-create-restart-'));
  try {
    const file = path.join(dir, 'workers.json');
    const info = (id: string, deskId: string, over: Partial<WorkerInfo>) => ({ id, kind: 'agent', provider: 'claude', deskId, name: 'Ada', color: '#fff', status: 'idle', createdBy: 'Bob', createdAt: 1, ...over }) as WorkerInfo;
    const workers = [info('w1', 'desk-1', { byPerson: true }), info('w2', 'desk-2', { createdBy: 'Bob (queue)' })].map((i) => ({ info: i, tracker: {} }) as unknown as Worker);
    saveWorkers(file, workers, true);
    const restored = new Map<string, Worker>();
    restoreWorkers(file, restored, 'claude', () => false);
    assert.equal(restored.get('w1')?.info.byPerson, true);
    assert.equal('byPerson' in restored.get('w2')!.info, false);

    const { ctx, call } = setup();
    await call({ title: 'after a restart', description: 'd' }, hookCaller(restored.get('w1')!.info, 'app'));
    await call({ title: 'queue', description: 'd' }, hookCaller(restored.get('w2')!.info, 'app'));
    assert.deepEqual([1, 2].map((id) => ctx.repo.getTask(id)!.createdBy), ['Bob', 'Ada']);

    // Only true is taken back: anything else in the file isn't a person's hire.
    const raw = (byPerson: unknown) => [{ id: 'w3', kind: 'agent', provider: 'claude', deskId: 'desk-3', name: 'Ada', createdBy: 'Bob', byPerson }];
    for (const v of ['true', 1, {}]) {
      writeFileSync(file, JSON.stringify(raw(v)));
      const again = new Map<string, Worker>();
      restoreWorkers(file, again, 'claude', () => false);
      assert.equal(again.get('w3')?.info.byPerson, undefined, JSON.stringify(v));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an issue key is the project’s spelling of its repository, so another case finds the same task', async () => {
  const { ctx, call } = setup();
  const first = await call({ issue: 'o/app#12' });
  assert.equal(first.body.existed, false);
  for (const issue of ['O/APP#12', 'gh:O/App#12', 'O/app#012']) {
    const again = await call({ issue });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.existed, true, issue);
    assert.equal(again.body.task.id, 1);
  }
  assert.equal(ctx.repo.getTask(2), undefined);
  assert.equal(ctx.repo.getTask(1)!.ticket, 'gh:o/app#12');
  // A repository the project doesn't know keeps the agent's spelling (and isn't found among its issues).
  assert.match(readCreateRequest({ issue: 'Else/Where#3' }, ctx, 'app') as string, /isn't one of the project's GitHub repositories/);
});

test('start from a desk worker starts the task and says if it is queued', async () => {
  const { ctx, call, worker } = setup();
  const r = await call({ title: 'Go', description: 'now', start: true, desk: 'desk-3' }, worker({ hiredBy: 'Boss' }));
  assert.deepEqual(ctx.started, [1]);
  assert.equal(r.body.started, true);
  assert.equal(r.body.queued, true);
  assert.equal(r.body.task.status, 'in_progress');
  const failing = setup({ startError: 'No free desk' });
  const f = await failing.call({ title: 'Go', description: 'now', start: true }, failing.worker({ hiredBy: 'Boss' }));
  assert.equal(f.status, 200);
  assert.equal(f.body.started, false);
  assert.equal(f.body.startError, 'No free desk');
  assert.equal(f.body.task.status, 'todo');
});

test('a task worker cannot start tasks: it lands in To do with a note, and the parent task hears of it', async () => {
  const { ctx, call, worker } = setup();
  const parent = ctx.repo.createTask({ project: 'app', title: 'Parent', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Maija' });
  const r = await call({ title: 'Child', description: 'd', start: true }, worker({ taskId: parent.id }));
  assert.equal(r.status, 200);
  assert.deepEqual(ctx.started, []);
  assert.equal(r.body.started, false);
  assert.equal(r.body.task.status, 'todo');
  assert.match(r.body.note, /only an agent a person hired at a desk/);
  assert.deepEqual(ctx.repo.listEvents(parent.id).find((e) => e.kind === 'subtask.created')?.data, { taskId: 2, by: 'Ada' });
  assert.deepEqual(ctx.repo.listComments(parent.id).comments.map((c) => [c.authorKind, c.text]), [['system', 'Created #2 “Child”']]);
  assert.ok(ctx.changed.includes(parent.id));
  assert.deepEqual(ctx.repo.listEvents(2).find((e) => e.kind === 'created')?.data, { by: 'Maija', via: 'Ada', viaWorker: 'w1', viaTask: parent.id });
  // Not asked to start: nothing to explain. An issue made before: that, not a claim to have made it.
  assert.equal((await call({ title: 'Other', description: 'd' }, worker({ taskId: parent.id }))).body.note, undefined);
  const once = await call({ issue: 12 }, worker({ taskId: parent.id }));
  const twice = await call({ issue: 12, start: true }, worker({ taskId: parent.id }));
  assert.equal(twice.body.existed, true);
  assert.equal(twice.body.task.id, once.body.task.id);
  assert.match(twice.body.note, /was made from this issue before/);
  assert.equal(ctx.repo.listComments(parent.id).comments.length, 3, 'one comment per task made, none for one found again');
});

test('provider, model, effort, type, repositories and ticket are stored; the project may be named', async () => {
  const { ctx, call } = setup();
  const r = await call({ title: 'T', description: 'd', project: 'APP', provider: 'codex', model: 'gpt-x', effort: 'high', type: 'investigate', repos: ['app'], ticket: 'X-1', ticketUrl: 'https://x.example/1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = ctx.repo.getTask(1)!;
  assert.deepEqual([t.tool, t.model, t.effort, t.type, t.ticket, t.ticketUrl], ['codex', 'gpt-x', 'high', 'investigate', 'X-1', 'https://x.example/1']);
  assert.deepEqual(t.repoIds, ['app']);
  assert.equal(r.body.task.ticket, 'X-1');
});

test('bad requests are answered with 400 and make nothing', async () => {
  const { ctx, call } = setup();
  const bad = async (body: unknown, re: RegExp) => {
    const r = await call(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  };
  await bad({ description: 'd' }, /title is required/);
  await bad({ title: 't' }, /description is required/);
  await bad({ title: 't', description: 'd', project: 'nope' }, /no project nope/);
  await bad({ title: 't', description: 'd', repos: ['nope'] }, /nope isn't one of the project's repositories/);
  await bad({ title: 't', description: 'd', provider: 'gpt' }, /provider must be claude or codex/);
  await bad({ title: 't', description: 'd', effort: 'huge' }, /effort must be one of/);
  await bad({ title: 't', description: 'd', type: 'fix' }, /type must be/);
  await bad({ title: 't', description: 'd', start: 'yes' }, /start must be/);
  await bad({ title: 'x'.repeat(301), description: 'd' }, /title may be at most 300/);
  await bad({ title: 't', description: 'x'.repeat(100_001) }, /description may be at most/);
  await bad('{nope', /not JSON/);
  await bad({ issue: 99 }, /isn't among the project's issues/);
  assert.equal(ctx.repo.getTask(1), undefined);
});

test('only POST (405), only agents (403) and only this exact path (404)', async () => {
  const { call, worker } = setup();
  assert.equal((await call(undefined, worker(), 'GET')).status, 405);
  assert.equal((await call({ title: 't', description: 'd' }, worker({ kind: 'shell' }))).status, 403);
  assert.equal((await call({ title: 't', description: 'd' }, worker(), 'POST', '/office/tasks/createX')).status, 404);
});

test('the refs plugin still answers 405 to a POST on its own routes', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })]);
  const refs = createRefsPlugin(ctx);
  const { status, body } = await (async () => {
    let s = 0;
    let t = '';
    const res = { writeHead: (x: number) => void (s = x), end: (x: string) => void (t = x) } as unknown as ServerResponse;
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: {} }) as unknown as IncomingMessage;
    await refs.hook!['/office/tasks']!(req, res, new URL('/office/tasks/search', 'http://127.0.0.1'), { workerId: 'w1', floorId: 'app' });
    return { status: s, body: JSON.parse(t) as Json };
  })();
  assert.equal(status, 405);
  assert.match(body.error, /GET only/);
});

test('an issue number means gh:<repo>#n when the project has one GitHub repository, and an error when it has two', async () => {
  const one = setup();
  const r = await one.call({ issue: 12 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.ticket, 'gh:o/app#12');
  assert.equal(r.body.task.title, 'Issue 12');
  assert.equal(one.ctx.repo.getTask(1)!.ticketUrl, 'https://github.com/o/app/issues/12');
  assert.match(one.ctx.repo.getTask(1)!.description, /^Issue body\n\nSource: https:\/\/github.com\/o\/app\/issues\/12$/);
  // The same issue again: the task it has.
  const again = await one.call({ issue: '#12' });
  assert.equal(again.body.existed, true);
  assert.equal(again.body.task.id, 1);
  assert.equal(one.ctx.repo.getTask(2), undefined);
  assert.deepEqual(one.ctx.toasts.length, 1);

  const two = setup({ sources: [{ id: 's1', kind: 'github-repo', repos: ['o/app', 'o/web'], filters: {} }, { id: 's2', kind: 'jira', site: 'x.atlassian.net', projectKeys: ['UYT'] }] as IssueSourceConfig[] });
  const e = await two.call({ issue: 12 });
  assert.equal(e.status, 400);
  assert.match(e.body.error, /give owner\/repo#12/);
  assert.equal((readCreateRequest({ issue: 'o/web#3' }, two.ctx, 'app') as { issue: string }).issue, 'gh:o/web#3');
  assert.equal((readCreateRequest({ issue: 'UYT-5' }, two.ctx, 'app') as { issue: string }).issue, 'UYT-5');
  assert.equal((readCreateRequest({ issue: 'gh:o/app#4' }, two.ctx, 'app') as { issue: string }).issue, 'gh:o/app#4');
});

test('with an issue the agent’s title replaces the issue’s, its text comes first, and its choices are stored', async () => {
  const { ctx, call } = setup();
  const r = await call({ issue: 'o/app#12', title: 'My title', description: 'Do it carefully', provider: 'codex', effort: 'low' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = ctx.repo.getTask(1)!;
  assert.equal(t.title, 'My title');
  assert.match(t.description, /^Do it carefully\n\nIssue body\n\nSource:/);
  assert.deepEqual([t.tool, t.effort], ['codex', 'low']);
  assert.deepEqual(ctx.repo.listEvents(1).find((e) => e.kind === 'created')?.data, { by: 'Ada', ticket: 'gh:o/app#12', via: 'Ada', viaWorker: 'w1' });
});

test('an issue is taken as from the issues board: assigned at once in To do, by the engine’s start hook when started; never without an account', async () => {
  const who = { accountId: 'acc1', accountName: 'Panu', hiredBy: 'Panu' };
  // Made in To do: assigned here, under the account's own gh sign-in, after the answer has gone (a slow GitHub can't time the agent out into asking again).
  let assignedBeforeAnswer: boolean | undefined;
  const todo = setup(env('/h/agent-create-1'));
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ issue: 12 }))]), { method: 'POST', headers: {} }) as unknown as IncomingMessage;
  const res = { writeHead: () => {}, end: () => void (assignedBeforeAnswer = todo.edits().length > 0) } as unknown as ServerResponse;
  await todo.issues.plugin.hook![PATH]!(req, res, new URL(PATH, 'http://127.0.0.1'), todo.worker(who));
  assert.equal(assignedBeforeAnswer, false);
  assert.deepEqual(todo.edits(), [['issue', 'edit', '12', '-R', 'o/app', '--add-assignee=panu']]);

  // Started: the hook leaves taking it to the engine's start hook (taskStarted), as for any task that starts.
  const started = setup(env('/h/agent-create-2'));
  const r = await started.call({ issue: 12, start: true }, started.worker(who));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.started, true);
  assert.deepEqual(started.ctx.started, [1]);
  assert.deepEqual(started.edits(), []);
  await started.issues.plugin.taskStarted!(1, { name: 'Panu', accountId: 'acc1', admin: false });
  assert.deepEqual(started.edits(), [['issue', 'edit', '12', '-R', 'o/app', '--add-assignee=panu']]);

  const anon = setup();
  const a = await anon.call({ issue: 12 }, anon.worker({ hiredBy: 'Boss' }));
  assert.equal(a.status, 200);
  assert.deepEqual(anon.edits(), []);
});

test('an issue whose task waits in To do is started by a later request with start', async () => {
  const { ctx, call, worker } = setup();
  await call({ issue: 12 });
  const r = await call({ issue: 12, start: true }, worker({ hiredBy: 'Boss' }));
  assert.equal(r.body.existed, true);
  assert.equal(r.body.started, true);
  assert.deepEqual(ctx.started, [1]);
});

test('a start needs a person behind the agent and its own project: anything else lands in To do with a note', async () => {
  const { ctx, call, worker } = setup();
  const asked = { title: 'Go', description: 'd', start: true };
  // As hire_worker makes one: an agent's hire, no person.
  const hired = hookCaller({ id: 'w1', name: 'Ada', kind: 'agent', deskId: 'desk-1', createdBy: 'Ada (kanban #1)' } as WorkerInfo, 'app');
  const a = await call(asked, hired);
  assert.equal(a.body.started, false);
  assert.equal(a.body.task.status, 'todo');
  assert.match(a.body.note, /only an agent a person hired at a desk/);
  assert.deepEqual(ctx.started, []);
  // A person's desk hire, and a board kiosk, start.
  const desk = await call(asked, hookCaller({ id: 'w1', name: 'Ada', kind: 'agent', deskId: 'desk-1', createdBy: 'Bob', byPerson: true } as WorkerInfo, 'app'));
  assert.equal(desk.body.started, true);
  assert.equal(desk.body.note, undefined);
  const kiosk = await call(asked, worker({ station: true }));
  assert.equal(kiosk.body.started, true);
  assert.deepEqual(ctx.started, [2, 3]);
});

test('another project may be named, but nothing there is started', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' }), def('web', '/tmp/web', { repo: 'o/web' })]);
  const handler = createIssues(ctx, { gh: async () => '' }).plugin.hook![PATH]!;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ title: 'T', description: 'd', project: 'web', start: true }))]), { method: 'POST', headers: {} }) as unknown as IncomingMessage;
  let text = '';
  const res = { writeHead: () => {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await handler(req, res, new URL(PATH, 'http://127.0.0.1'), { workerId: 'w1', floorId: 'app', name: 'Ada', kind: 'agent', hiredBy: 'Boss' });
  const body = JSON.parse(text) as Json;
  assert.equal(body.task.project, 'web');
  assert.equal(body.task.status, 'todo');
  assert.match(body.note, /only start tasks in its own project/);
  assert.deepEqual(ctx.started, []);
});

test('a ticket without an issue is made once: asked again it is the task it has, started if it waits in To do', async () => {
  const { ctx, call, worker } = setup();
  const first = await call({ title: 'T', description: 'd', ticket: 'X-1' });
  const again = await call({ title: 'T2', description: 'd', ticket: 'X-1', start: true }, worker({ hiredBy: 'Boss' }));
  assert.equal(again.body.existed, true);
  assert.equal(again.body.task.id, first.body.task.id);
  assert.equal(again.body.started, true);
  assert.deepEqual(ctx.started, [1]);
  assert.equal(ctx.repo.getTask(2), undefined);
  const third = await call({ title: 'T3', description: 'd', ticket: 'X-1' });
  assert.equal(third.body.existed, true);
  assert.match(third.body.note, /was made from this ticket before/);
});

test('a refused start is said also for a task made before, and a desk without start is refused', async () => {
  const { ctx, call } = setup();
  await call({ issue: 12 });
  const r = await call({ issue: 12, start: true, desk: 'desk-3' });
  assert.equal(r.body.existed, true);
  assert.match(r.body.note, /was made from this issue before\. Created in To do: only an agent a person hired/);
  assert.match(r.body.note, /The desk wasn't used/);
  assert.deepEqual(ctx.started, []);
  const bad = await call({ title: 't', description: 'd', desk: 'desk-3' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /desk only goes with start/);
});

test('an issue key of a kind the project has no source for is refused, and a Jira key is upper-cased', async () => {
  const { ctx } = setup();
  const read = (issue: string) => readCreateRequest({ issue }, ctx, 'app') as { issue: string } | string;
  assert.match(read('UYT-1') as string, /no Jira source/);
  assert.match(read('ghp:o/1#PVTI_x') as string, /no GitHub project board/);
  assert.match(read('o/other#3') as string, /isn't one of the project's GitHub repositories/);
  const withJira = setup({ sources: [{ id: 's1', kind: 'github-repo', repos: ['o/app'], filters: {} }, { id: 's2', kind: 'jira', site: 'x.atlassian.net', projectKeys: ['UYT'] }] as IssueSourceConfig[] });
  assert.equal((readCreateRequest({ issue: 'uyt-1415' }, withJira.ctx, 'app') as { issue: string }).issue, 'UYT-1415');
  const board = setup({ sources: [{ id: 's1', kind: 'github-project', owner: 'o', number: 1, filters: {} }] as IssueSourceConfig[] });
  assert.equal((readCreateRequest({ issue: 'x/y#3' }, board.ctx, 'app') as { issue: string }).issue, 'gh:x/y#3');
});

test('an agent’s unknown issue key does not make the project fetch all its issues again', async () => {
  const { call, calls } = setup();
  await call({ issue: 12 });
  const lists = () => calls.filter((a) => a[1] === 'list').length;
  const before = lists();
  const r = await call({ issue: 99 });
  assert.equal(r.status, 400);
  assert.equal(lists(), before);
});
