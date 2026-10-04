import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REF_LIMITS, parseTaskRef, referencedTasks, resolveTaskRef, scanTaskIds, scanTickets, searchTasks, taskBundle } from '../src/server/kanban/integrations/refs/resolve.js';
import { createRefs, createRefsPlugin, plainTerminal, referencedTasksPath } from '../src/server/kanban/integrations/refs/index.js';
import { legacyReferenceAnswer } from '../src/server/kanban/integrations/compat/v1.js';
import { BODY_MAX } from '../src/server/kanban/integrations/util.js';
import type { KanbanTask } from '../src/shared/kanban/types.js';
import { Readable } from 'node:stream';
import { EFFORTS, TASK_TOOLS, UsageError, buildRequest, formatAnswer, main as officeTasks, parseArgs, tasksVisible } from '../bin/office-tasks.js';
import { handleMcp, instructions } from '../bin/office-workers.js';
import { def, makeCtx, type TestCtx } from './kanban-integrations-ctx.js';

function seeded(): TestCtx {
  const ctx = makeCtx([def('app', '/tmp/app-refs', { name: 'App', repo: 'o/app' })]);
  const mk = (title: string, extra: Partial<Parameters<TestCtx['repo']['createTask']>[0]> = {}) =>
    ctx.repo.createTask({ project: 'app', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'u', ...extra });
  mk('Login redirect fix', { ticket: 'UYT-1415', description: 'x'.repeat(REF_LIMITS.description + 500), branch: 'feat/login' }); // #1
  mk('Search: hakulogiikka', { ticket: '14' }); // #2
  mk('Another login thing'); // #3
  for (let i = 0; i < 40; i++) ctx.repo.addComment({ taskId: 1, authorKind: i % 2 ? 'agent' : 'user', authorName: i % 2 ? 'Claude' : 'panu', text: `c${i} ${'y'.repeat(REF_LIMITS.comment)}` });
  ctx.repo.addComment({ taskId: 1, authorKind: 'system', authorName: 'Kanban', text: 'noise' });
  const plan = ctx.repo.addPlan(1, 'The plan');
  ctx.repo.acceptPlan(1, 'panu', plan.id);
  const run = ctx.repo.createRun({ taskId: 1, phase: 'review', round: 1, role: 'reviewer', tool: 'codex' });
  ctx.repo.finishRun(run.id, { status: 'succeeded', verdict: 'approved', summary: 'LGTM' });
  ctx.repo.upsertPrLink(1, { repoId: 'app', repo: 'o/app', number: 5, url: 'https://github.com/o/app/pull/5', state: 'OPEN' });
  return ctx;
}

test('references resolve as ai-kanban did: id, then ticket; text: exact ticket, then title', () => {
  const tasks = [
    { id: 14, title: 'Fourteen', ticket: undefined, updatedAt: 1 },
    { id: 20, title: 'Task about 14 things', ticket: 'UYT-1', updatedAt: 3 },
    { id: 21, title: 'Numbered ticket', ticket: '99', updatedAt: 2 },
    { id: 22, title: 'login page', ticket: undefined, updatedAt: 5 },
    { id: 23, title: 'Login API', ticket: undefined, updatedAt: 4 },
  ] as unknown as KanbanTask[];
  assert.deepEqual(parseTaskRef('tehtävä #14'), { kind: 'id', id: 14 });
  assert.deepEqual(parseTaskRef('Task 14'), { kind: 'id', id: 14 });
  assert.equal(parseTaskRef('  '), undefined);
  assert.deepEqual(resolveTaskRef('#14', tasks).map((t) => t.id), [14]);
  assert.deepEqual(resolveTaskRef('99', tasks).map((t) => t.id), [21], 'no task 99: the ticket 99');
  assert.deepEqual(resolveTaskRef('uyt-1', tasks).map((t) => t.id), [20]);
  assert.deepEqual(resolveTaskRef('LOGIN', tasks).map((t) => t.id), [22, 23], 'newest first');
  assert.deepEqual(resolveTaskRef('7', tasks), [], 'never a title with the number in it');
});

test('references in a text: #N and task words, not PRs or issues; ticket ids of other tasks; at most 3', () => {
  assert.deepEqual(scanTaskIds('Do it like #14 and tehtävässä 17, see task #3. Not PR #39, issue #40, gh 41 or https://github.com/o/r/pull/42, nor v#1.2'), [14, 17, 3]);
  assert.deepEqual(scanTickets('Continue UYT-1415 and ABC-9; not lower-1'), ['UYT-1415', 'ABC-9']);
  const ctx = seeded();
  const all = ctx.repo.listTasks(null, { includeArchived: true });
  assert.deepEqual(referencedTasks('like #1 and #3 and #3 and #2 and #999 and #4', all, 4).map((t) => t.id), [1, 3, 2]);
  assert.deepEqual(referencedTasks('as in UYT-1415', all, 3).map((t) => t.id), [1]);
  assert.deepEqual(referencedTasks('my own #1', all, 1), [], 'never itself');
  assert.deepEqual(searchTasks(all, 'login').map((t) => t.id).sort(), [1, 3], 'finds by title');
  assert.equal(searchTasks(all, 'UYT-1415')[0].id, 1, 'an exact ticket first');
});

test("a task's bundle keeps its parts bounded", () => {
  const ctx = seeded();
  mkdirSync(path.join(ctx.filesDir, 'reports', 'task-1'), { recursive: true });
  writeFileSync(path.join(ctx.filesDir, 'reports', 'task-1', 'report.md'), '# r');
  const b = taskBundle(ctx, ctx.repo.getTask(1)!);
  assert.ok(b.description.length < REF_LIMITS.description + 100);
  assert.match(b.description, /cut: 500 more characters/);
  assert.equal(b.comments.length, REF_LIMITS.comments);
  assert.ok(b.comments.every((c) => c.authorKind !== 'system' && c.text.length < REF_LIMITS.comment + 100));
  assert.equal(b.comments.at(-1)!.text.slice(0, 4), 'c39 ');
  assert.equal(b.acceptedPlan, 'The plan');
  assert.deepEqual(b.runs, [{ phase: 'review', round: 1, status: 'succeeded', verdict: 'approved', summary: 'LGTM', finishedAt: b.runs[0].finishedAt }]);
  assert.deepEqual(b.prs, [{ repo: 'o/app', number: 5, url: 'https://github.com/o/app/pull/5', state: 'OPEN' }]);
  assert.deepEqual(b.repos, [{ id: 'app', name: 'App', branch: 'feat/login', remote: 'o/app' }]);
  assert.deepEqual(b.project, { id: 'app', name: 'App' });
  assert.deepEqual(b.reportFiles, [path.join(ctx.filesDir, 'reports', 'task-1', 'report.md')]);
  assert.ok(JSON.stringify(b).length < 120_000);
});

test('/api/tasks/reference answers in ai-kanban’s shape', () => {
  const ctx = seeded();
  const one = legacyReferenceAnswer(ctx, 'UYT-1415');
  assert.equal(one.ok, true);
  assert.deepEqual(Object.keys(one.match!).sort(), ['branchName', 'comments', 'createdAt', 'description', 'id', 'plan', 'repoId', 'reportDir', 'reportFiles', 'repository', 'runStatus', 'status', 'statusTitle', 'summary', 'taskType', 'ticketId', 'title', 'updatedAt'].sort());
  assert.equal(one.match!.status, 'todo');
  assert.equal(one.match!.plan, 'The plan');
  assert.equal(one.match!.repository, 'App');
  assert.deepEqual(Object.keys(one.match!.comments[0]).sort(), ['author', 'content', 'createdAt']);
  assert.ok(one.match!.comments.every((c) => c.author === 'user' || c.author === 'claude'));
  assert.match(String(one.match!.createdAt), /^\d{4}-\d\d-\d\dT/);
  const many = legacyReferenceAnswer(ctx, 'login');
  assert.equal(many.match, null);
  assert.deepEqual(many.candidates.map((c) => c.id).sort(), [1, 3]);
  assert.deepEqual(Object.keys(many.candidates[0]).sort(), ['id', 'repository', 'status', 'statusTitle', 'taskType', 'ticketId', 'title', 'updatedAt']);
  ctx.repo.updateTask(3, { status: 'archived' });
  assert.equal(legacyReferenceAnswer(ctx, '3').match!.status, 'history');
  assert.deepEqual(legacyReferenceAnswer(ctx, 'nothing like it'), { ok: true, ref: 'nothing like it', match: null, candidates: [] });
});

test('the plan phase gets referenced tasks in a file; none, and there is none', () => {
  const ctx = seeded();
  const refs = createRefs(ctx);
  const file = refs.referencedTasksFile(3, 'Build on #1 (UYT-1415) and tehtävä 2');
  assert.equal(file, referencedTasksPath(ctx.filesDir, 3));
  const md = readFileSync(file!, 'utf8');
  assert.match(md, /## Task #1: Login redirect fix/);
  assert.match(md, /## Task #2: Search/);
  assert.match(md, /### Accepted plan\n\nThe plan/);
  assert.match(md, /Review verdicts: review 1: approved/);
  assert.ok(md.length < 60_000, 'bounded');
  assert.equal(refs.referencedTasksFile(3, 'nothing here, just PR #1'), undefined);
  assert.equal(existsSync(file!), false, 'an old file goes');
});

async function serve(ctx: TestCtx) {
  const plugin = createRefsPlugin(ctx);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const [prefix, h] of Object.entries({ ...plugin.loopback })) if (url.pathname.startsWith(prefix) && (await h(req, res, url))) return;
    for (const [prefix, h] of Object.entries({ ...plugin.hook })) if (url.pathname.startsWith(prefix) && (await h(req, res, url, { workerId: 'w1', floorId: 'app' }))) return;
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('/api/v1: projects, tasks, create idempotent on ticketId, start, and the API key once one is set', async (t) => {
  const ctx = seeded();
  const s = await serve(ctx);
  t.after(s.close);
  const get = async (p: string, headers: Record<string, string> = {}) => {
    const r = await fetch(s.base + p, { headers });
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(s.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const projects = await get('/api/v1/projects');
  assert.equal(projects.body.projects[0].id, 'app');
  const tasks = await get('/api/v1/tasks?ticketId=uyt-1415');
  assert.deepEqual(tasks.body.tasks.map((x: { id: number }) => x.id), [1]);
  assert.equal(tasks.body.total, 1);
  assert.equal((await get('/api/v1/tasks?q=login&status=todo')).body.total, 2);
  assert.equal((await get('/api/v1/tasks?status=bogus')).body.error.code, 'column.unknownStatus');
  assert.equal((await get('/api/v1/tasks/1')).body.task.description.length > 1000, true);
  assert.equal((await get('/api/v1/tasks/999')).status, 404);
  const made = await post('/api/v1/tasks', { title: 'From Jira', description: 'Do it', projectId: 'app', ticketId: 'UYT-2000' });
  assert.equal(made.status, 201);
  assert.equal(made.body.created, true);
  // Nothing is started without a key: any local process could have an agent run as the office's user.
  const keyless = await post('/api/v1/tasks', { title: 'Other', description: 'Do it', projectId: 'app', ticketId: 'UYT-2001', start: true });
  assert.equal(keyless.status, 403);
  assert.equal(keyless.body.error.code, 'api.startNeedsKey');
  assert.equal((await get('/api/v1/tasks?ticketId=UYT-2001')).body.total, 0, 'and nothing was made');
  assert.equal((await post(`/api/v1/tasks/${made.body.task.id}/start`, {})).body.error.code, 'api.startNeedsKey');
  ctx.secrets.set({ apiKey: 'a-very-long-secret-key' });
  const key = { authorization: 'Bearer a-very-long-secret-key' };
  const again = await post('/api/v1/tasks', { title: 'From Jira', description: 'Do it', projectId: 'app', ticketId: 'UYT-2000', start: true }, key);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.task.id, made.body.task.id);
  assert.equal(again.body.started, true, 'a todo task found again is started when asked');
  assert.equal((await post(`/api/v1/tasks/${made.body.task.id}/start`, {}, key)).body.error.code, 'task.alreadyRunning');
  const fresh = await post('/api/v1/tasks', { title: 'T', description: 'D', projectId: 'app' }, key);
  const started = await post(`/api/v1/tasks/${fresh.body.task.id}/start`, {}, key);
  assert.equal(started.body.queued, true);
  assert.equal((await post('/api/v1/tasks', { title: 'T', description: 'D', projectId: 'nope' }, key)).body.error.code, 'project.notFound');
  assert.equal((await post('/api/v1/tasks', { description: 'D', projectId: 'app' }, key)).body.error.code, 'task.titleRequired');
  // The key is kept hashed, and every request needs it.
  assert.notEqual(ctx.secrets.apiKey(), 'a-very-long-secret-key');
  assert.equal((await get('/api/v1/projects')).body.error.code, 'api.missingKey');
  assert.equal((await get('/api/v1/projects', { authorization: 'Bearer wrong' })).body.error.code, 'api.invalidKey');
  assert.equal((await get('/api/v1/projects', { authorization: 'Bearer a-very-long-secret-key' })).status, 200);
  assert.equal((await get('/api/v1/projects', { 'x-api-key': 'a-very-long-secret-key' })).status, 200);
  // The reference endpoint stays keyless, as ai-kanban's skill calls it.
  const ref = await get('/api/tasks/reference?ref=1');
  assert.equal(ref.body.match.id, 1);
  assert.equal((await get('/api/tasks/reference')).status, 400);
  // The office's own endpoints: the bundle, and search.
  const office = await get('/office/tasks/reference?ref=%231');
  assert.equal(office.body.match.title, 'Login redirect fix');
  assert.equal('terminalTail' in office.body.match, false);
  assert.deepEqual((await get('/office/tasks/search?q=login')).body.tasks.map((x: { id: number }) => x.id).sort(), [1, 3]);
});

test('the loopback compatibility routes refuse what a web page could send: another Host, another Origin, a POST that isn’t JSON', async (t) => {
  const ctx = seeded();
  const s = await serve(ctx);
  t.after(s.close);
  const port = Number(new URL(s.base).port);
  /** A raw request, so Host can be anything (fetch always sends the URL's). */
  const raw = (method: string, p: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}'), headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const json = { 'content-type': 'application/json' };
  const task = JSON.stringify({ title: 'T', description: 'D', projectId: 'app' });
  // DNS rebinding: the page's own name in Host, whatever the path.
  for (const host of ['evil.example:' + port, `127.0.0.1:${port + 1}`, 'localhost', `127.0.0.2:${port}`]) {
    const r = await raw('GET', '/api/v1/tasks', { host });
    assert.equal(r.status, 403, host);
    assert.equal(r.body.error.code, 'request.badHost');
  }
  assert.equal((await raw('GET', '/api/tasks/reference?ref=1', { host: 'evil.example' })).status, 403);
  for (const host of [`localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) assert.equal((await raw('GET', '/api/v1/projects', { host })).status, 200, host);
  // CSRF: a forged Origin (or a cross-site fetch's Sec-Fetch-Site), on GET and POST alike.
  for (const origin of ['https://evil.example', 'null', `http://localhost:${port + 1}`, `https://127.0.0.1:${port}`]) {
    const r = await raw('POST', '/api/v1/tasks', { ...json, origin }, task);
    assert.equal(r.status, 403, origin);
    assert.equal(r.body.error.code, 'request.crossOrigin');
  }
  assert.equal((await raw('GET', '/api/tasks/reference?ref=1', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await raw('GET', '/api/v1/tasks', { 'sec-fetch-site': 'cross-site' })).status, 403);
  // A body a page can send without a preflight: text/plain, a form, or no type at all.
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
    const r = await raw('POST', '/api/v1/tasks', type ? { 'content-type': type } : {}, task);
    assert.equal(r.status, 415, type || 'no type');
    assert.equal(r.body.error.code, 'request.notJson');
  }
  assert.equal((await raw('POST', '/api/v1/tasks/1/start', { 'content-type': 'text/plain' })).status, 415);
  // Too big, by its length or by what arrives.
  assert.equal((await raw('POST', '/api/v1/tasks', { ...json, 'content-length': String(BODY_MAX + 1) }, 'x'.repeat(BODY_MAX + 1))).status, 413);
  // A preflight gets no CORS headers, and nothing ever does.
  const pre = await raw('OPTIONS', '/api/v1/tasks', { origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST' });
  assert.equal(pre.status, 405);
  assert.equal(Object.keys(pre.headers).some((h) => h.startsWith('access-control-')), false);
  // The same host, JSON: through.
  const same = await raw('POST', '/api/v1/tasks', { 'content-type': 'application/json; charset=utf-8', origin: `http://127.0.0.1:${port}` }, task);
  assert.equal(same.status, 201);
  assert.equal(same.body.created, true);
  assert.equal(Object.keys(same.headers).some((h) => h.startsWith('access-control-')), false);
});

test('office-tasks: the CLI and the MCP tools, shown to workers told about tasks', async () => {
  const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455/', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
  assert.deepEqual(parseArgs(['get', '#14', '--tail']), { cmd: 'get', ref: '#14', tail: true, json: false });
  assert.deepEqual(parseArgs(['search', 'login', 'bug']), { cmd: 'search', query: 'login bug', json: false });
  assert.throws(() => parseArgs(['get']), /one task/);
  const req = buildRequest('get', { ref: '14', tail: true }, ENV);
  assert.equal(req.url, 'http://127.0.0.1:4455/office/tasks/reference?worker=w1&ref=14&tail=1');
  assert.deepEqual(req.headers, { authorization: 'Bearer tok' });
  assert.equal(buildRequest('get', { ref: 'x y' }, { AIKANBAN_API_BASE: 'http://127.0.0.1:9' }).url, 'http://127.0.0.1:9/api/tasks/reference?ref=x+y', 'outside a worker: the compatibility route');
  const bundle = { id: 14, title: 'T', description: 'D', project: { id: 'p', name: 'P' }, status: 'review', repos: [{ id: 'p', name: 'P', branch: 'b' }], runs: [{ phase: 'review', round: 1, status: 'succeeded', verdict: 'approved' }], comments: [], prs: [], reportFiles: [], acceptedPlan: 'Plan' };
  const out: string[] = [];
  const fetchOk = (async () => new Response(JSON.stringify({ ok: true, match: bundle, candidates: [] }))) as unknown as typeof fetch;
  assert.equal(await officeTasks(['get', '14'], { env: ENV, fetch: fetchOk, out: (s) => out.push(s), err: () => {} }), 0);
  assert.match(out[0], /# Task #14: T[\s\S]*Repository P: branch b[\s\S]*## Accepted plan\n\nPlan[\s\S]*- review 1: succeeded, approved/);
  assert.match(formatAnswer({ match: null, candidates: [{ id: 1, title: 'A', status: 'todo', project: 'p' }, { id: 2, title: 'B', status: 'done', project: 'p' }] }, 'x'), /2 tasks match "x"[\s\S]*#1  A · todo · p/);
  // MCP: listed only to workers the office tells about tasks (AGENT_OFFICE_TASKS, or AIKANBAN_API_BASE), and then they work.
  const plain = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env: ENV, fetch: fetchOk });
  assert.deepEqual(plain.result.tools.map((x: { name: string }) => x.name), ['list_workers', 'hire_worker', 'send_home', 'tell_worker']);
  const kanbanEnv = { ...ENV, AIKANBAN_API_BASE: 'http://127.0.0.1:4455' };
  assert.equal(tasksVisible(kanbanEnv), true);
  const listed = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { env: kanbanEnv, fetch: fetchOk });
  assert.deepEqual(listed.result.tools.map((x: { name: string }) => x.name).slice(-2), ['get_task', 'search_tasks']);
  for (const t of TASK_TOOLS) assert.equal(t.inputSchema.type, 'object');
  const called = await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_task', arguments: { ref: '14' } } }, { env: kanbanEnv, fetch: fetchOk });
  assert.match(called.result.content[0].text, /# Task #14: T/);
  const hidden = await handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_task', arguments: { ref: '14' } } }, { env: ENV, fetch: fetchOk });
  assert.equal(hidden.error.code, -32602);
});

test('office-tasks create: flags, the POST, the answer on stdout and stderr, and the MCP tool', async () => {
  const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455/', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
  assert.deepEqual(
    parseArgs(['create', '--title', 'T', '--project=app', '--repo', 'api', '--repo', 'web', '--issue', '12', '--ticket', 'K-1', '--ticket-url', 'http://x', '--provider', 'codex', '--model', 'm', '--effort', 'high', '--type', 'investigate', '--start', '--desk', 'desk-2', '--prompt', 'D', '--json']),
    { cmd: 'create', json: true, prompt: 'D', title: 'T', project: 'app', ticket: 'K-1', ticketUrl: 'http://x', provider: 'codex', model: 'm', effort: 'high', type: 'investigate', desk: 'desk-2', repos: ['api', 'web'], issue: 12, start: true },
  );
  assert.equal((parseArgs(['create', '--issue', 'o/r#3']) as { issue: unknown }).issue, 'o/r#3');
  assert.equal((parseArgs(['create', '--issue', 'UYT-1415']) as { issue: unknown }).issue, 'UYT-1415');
  for (const bad of [['--effort', 'huge'], ['--provider', 'gpt'], ['--type', 'build'], ['--title'], ['--nope'], ['stray']]) {
    assert.throws(() => parseArgs(['create', ...bad]), UsageError, bad.join(' '));
  }
  const req = buildRequest('create', { body: { title: 'T', description: 'D', repos: ['api'] } }, ENV);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'http://127.0.0.1:4455/office/tasks/create?worker=w1');
  assert.deepEqual(req.headers, { authorization: 'Bearer tok', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(req.body!), { title: 'T', description: 'D', repos: ['api'] });
  assert.equal(req.timeout, 90_000);
  assert.equal(buildRequest('get', { ref: '1' }, ENV).timeout, 15_000);
  assert.throws(() => buildRequest('create', { body: {} }, { AIKANBAN_API_BASE: 'http://127.0.0.1:9' }), /isn't set|aren't set/, 'create needs the worker variables');

  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (extra: object = {}) => ({ ok: true, task: { id: 12, title: 'T', status: 'todo', runState: 'idle', project: 'app', url: '/kanban?task=12' }, existed: false, started: false, queued: false, ...extra });
  const stub = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const run = async (argv: string[], fetchImpl: typeof fetch, stdin = '') => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await officeTasks(argv, { env: ENV, fetch: fetchImpl, stdin: Readable.from([stdin]), out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const made = await run(['create', '--title', 'T', '--repo', 'api'], stub(answer()), 'Do the thing\r\n');
  assert.deepEqual(made, { code: 0, out: '12', err: 'Created task #12 “T” — in To do — /kanban?task=12' });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { title: 'T', repos: ['api'], description: 'Do the thing' });
  assert.equal(calls[0].init.method, 'POST');
  const started = await run(['create', '--title', 'T', '--prompt', 'D', '--start'], stub(answer({ started: true, note: 'N' })));
  assert.equal(started.err, 'Created task #12 “T” — started — /kanban?task=12\nN');
  assert.match((await run(['create', '--title', 'T', '--prompt', 'D', '--start'], stub(answer({ queued: true, startError: 'full' })))).err, /queued[\s\S]*full/);
  assert.match((await run(['create', '--issue', '5', '--prompt', 'D'], stub(answer({ existed: true })))).err, /^Task #12 “T” already existed — in To do/);
  // A start with no room is both: queued is what the agent needs to hear.
  assert.match((await run(['create', '--title', 'T', '--prompt', 'D', '--start'], stub(answer({ started: true, queued: true })))).err, /— queued —/);
  assert.deepEqual(JSON.parse((await run(['create', '--title', 'T', '--prompt', 'D', '--json'], stub(answer()))).out).task, answer().task);
  const noDesc = await run(['create', '--title', 'T'], stub(answer()), '  \n');
  assert.equal(noDesc.code, 2);
  assert.match(noDesc.err, /needs --title and a description/);
  const issueOnly = await run(['create', '--issue', '5'], stub(answer()), '');
  assert.equal(issueOnly.code, 0);
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { issue: 5 });
  // --no-description skips stdin; stdin that never sends anything counts as empty after the idle timeout.
  assert.equal((parseArgs(['create', '--issue', '5', '--no-description']) as { noDescription: unknown }).noDescription, true);
  assert.equal((parseArgs(['create', '--title', 'T', '--effort', 'minimal']) as { effort: unknown }).effort, 'minimal');
  const never = () => new Readable({ read() {} });
  const runIdle = async (argv: string[], stdin: Readable) => {
    const err: string[] = [];
    const code = await officeTasks(argv, { env: ENV, fetch: stub(answer()), stdin, stdinIdleMs: 30, out: () => {}, err: (s) => err.push(s) });
    return { code, err: err.join('\n') };
  };
  const hung = await runIdle(['create', '--title', 'T'], never());
  assert.equal(hung.code, 2);
  assert.match(hung.err, /needs --title and a description/);
  const hungIssue = await runIdle(['create', '--issue', '5'], never());
  assert.equal(hungIssue.code, 0);
  const skipped = await runIdle(['create', '--issue', '5', '--no-description'], never());
  assert.equal(skipped.code, 0);
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { issue: 5 });
  const slow = new Readable({ read() {} });
  setTimeout(() => slow.push('late but started'), 10);
  setTimeout(() => slow.push(null), 80);
  assert.equal((await runIdle(['create', '--title', 'T'], slow)).code, 0);
  assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).description, 'late but started');
  const refused = await run(['create', '--title', 'T', '--prompt', 'D'], stub({ error: 'No such project' }, 404));
  assert.equal(refused.code, 1);

  // The MCP tool: listed (with a schema clients tolerate) and run, only for workers told about tasks.
  const env = { ...ENV, AGENT_OFFICE_TASKS: '1' };
  const tool = TASK_TOOLS.find((t) => t.name === 'create_task')!;
  assert.deepEqual(tool.inputSchema.required, []);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.annotations, { destructiveHint: false, openWorldHint: true });
  const names = async (e: Record<string, string>) =>
    ((await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env: e, fetch: stub({}) })) as { result: { tools: { name: string; description: string }[] } }).result.tools;
  assert.equal((await names(ENV)).some((t) => t.name === 'create_task'), false);
  const visible = await names(env);
  assert.ok(visible.some((t) => t.name === 'create_task'));
  assert.doesNotMatch(visible.find((t) => t.name === 'hire_worker')!.description, /create_task|kanban/, 'the kanban guidance is in the instructions only');
  assert.doesNotMatch(tool.description, /hire_worker/);
  assert.match(tool.description, /without permission prompts, unattended/);
  assert.match(tool.description, /person hired at a desk or a board agent/);
  assert.deepEqual(EFFORTS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual((tool.inputSchema.properties.effort as { enum: string[] }).enum, EFFORTS);
  assert.equal(TASK_TOOLS.length, 3);
  assert.doesNotMatch(instructions(ENV), /create_task/);
  assert.match(instructions(env), /create_task[\s\S]*hire_worker only when explicitly asked/);
  const mcp = (e: Record<string, string>, args: object) =>
    handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_task', arguments: args } }, { env: e, fetch: stub(answer({ queued: true, note: 'Waiting for a desk' })) });
  const res = (await mcp(env, { title: 'T', description: 'D' })) as { result: { content: { text: string }[] } };
  assert.equal(res.result.content[0].text, 'Created task #12 “T” — queued — /kanban?task=12\nWaiting for a desk');
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { title: 'T', description: 'D' });
  assert.equal(((await mcp(ENV, {})) as { error: { code: number } }).error.code, -32602, 'hidden from workers not told about tasks');
});

test("a terminal's saved scrollback, as plain text", () => {
  assert.equal(plainTerminal('\x1b[1;32mgreen\x1b[0m line\r\n\x1b]0;title\x07next\x1b[?25h'), 'green line\nnext');
});

test('the refs plugin allows its MCP tools for claude, and tells codex’s MCP server tasks are there', () => {
  const ctx = seeded();
  const p = createRefsPlugin(ctx);
  assert.deepEqual(p.workerArgs!(1, 'claude', 'plan'), ['--allowedTools', 'mcp__agent-office__get_task,mcp__agent-office__search_tasks']);
  assert.deepEqual(p.workerArgs!(1, 'codex', 'plan'), ['-c', 'mcp_servers.agent-office.env.AIKANBAN_API_BASE="http://127.0.0.1:4555"']);
});
