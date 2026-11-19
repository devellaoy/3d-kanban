// GET /office/tasks/issue: an agent reads its task's Jira ticket (get_issue, `office-tasks issue`). Jira is a fetch stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { ISSUE_READ_LIMITS, ISSUE_READ_NOTICE } from '../src/server/kanban/integrations/issues/agent-read.js';
import { jiraReadAdvertised, jiraReadScope, jiraReadSource } from '../src/server/kanban/integrations/issues/agent-read-scope.js';
import { officeTasks } from '../src/server/kanban/http/hooks.js';
import type { KanbanHookCaller } from '../src/server/kanban/registry.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

const PATH = '/office/tasks/issue';
type Json = Record<string, any>;
const SITE = 'team.atlassian.net';
const OTHER = 'other.atlassian.net';
const CONNS = [
  { id: 'c1', name: 'Team', site: SITE, email: 'me@x.fi', token: 'tok-secret-1' },
  { id: 'c2', name: 'Other', site: OTHER, email: 'you@y.fi', token: 'tok-secret-2' },
];
const jira = (projectKeys: string[], site = SITE, id = 's1'): IssueSourceConfig => ({ id, kind: 'jira', site, projectKeys, filters: {} });

type HttpCall = { url: string; method: string; auth: string };
type Reply = { status?: number; body?: unknown } | Error;

const adf = (t: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const issueJson = (key: string, over: Json = {}) => ({
  key,
  fields: { summary: `Title of ${key}`, description: adf('The description'), assignee: { displayName: 'Ada' }, labels: ['a', 'b'], status: { name: 'In Progress' }, issuetype: { name: 'Story' }, project: { key: key.split('-')[0] }, updated: '2026-09-02T10:00:00.000+0000', ...over },
});
const comment = (i: number, text = `comment ${i}`) => ({ id: String(i), author: { displayName: `Person ${i}` }, body: adf(text), created: `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00.000+0000` });

interface Setup {
  sources?: IssueSourceConfig[];
  connections?: typeof CONNS;
  jira?: (call: HttpCall) => Reply | undefined;
  comments?: unknown[];
  children?: unknown[];
  childrenNext?: string;
  issue?: Json;
}

function setup(opts: Setup = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' }), def('other', '/tmp/other')]);
  ctx.settings.setProject('app', { issueSources: opts.sources ?? [jira(['UYT'])] });
  (ctx as unknown as { secrets: unknown }).secrets = { jiraConnections: () => opts.connections ?? CONNS };
  const calls: HttpCall[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, method: String(init.method), auth: String((init.headers as Record<string, string>).authorization) };
    calls.push(call);
    const r: Reply =
      opts.jira?.(call) ??
      (url.includes('/comment?') ? { body: { comments: [...(opts.comments ?? [comment(1), comment(2)])].reverse() } } : url.includes('/search/jql') ? { body: { issues: opts.children ?? [], ...(opts.childrenNext ? { nextPageToken: opts.childrenNext } : {}) } } : url.includes('/rest/api/3/issue/') ? { body: opts.issue ?? issueJson(decodeURIComponent(url.split('/issue/')[1].split(/[?/]/)[0])) } : { status: 404, body: {} });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  const handler = createIssues(ctx, { fetch }).plugin.hook![PATH]!;
  const task = (over: Partial<Parameters<typeof ctx.repo.createTask>[0]> = {}) =>
    ctx.repo.createTask({ project: 'app', title: 'T', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'x', ...over });
  const worker = (over: Partial<KanbanHookCaller> = {}): KanbanHookCaller => ({ workerId: 'w1', floorId: 'app', name: 'Ada', kind: 'agent', ...over });
  const call = async (ref?: string, who: KanbanHookCaller = worker(), method = 'GET', pathname = PATH): Promise<{ status: number; body: Json; text: string }> => {
    let status = 0;
    let text = '';
    const res = { writeHead: (s: number) => void (status = s), end: (t: string) => void (text = t) } as unknown as ServerResponse;
    const q = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
    assert.equal(await handler({ method, headers: {} } as unknown as IncomingMessage, res, new URL(pathname + q, 'http://127.0.0.1'), who), true);
    // No secret leaves the office, whatever the answer.
    for (const c of CONNS) for (const s of [c.token, c.email, Buffer.from(`${c.email}:${c.token}`).toString('base64')]) assert.ok(!text.includes(s), `${s} in the answer`);
    assert.ok(!/authorization|basic /i.test(text));
    return { status, body: JSON.parse(text), text };
  };
  return { ctx, calls, call, task, worker };
}

test('without a ref the caller’s own ticket is read: exactly three Jira calls, no field call, and the answer has its shape', async () => {
  const { calls, call, task, worker } = setup({
    comments: [comment(1, 'first'), comment(2, 'second')],
    children: [{ key: 'UYT-8', fields: { summary: 'Child', status: { name: 'To Do' }, issuetype: { name: 'Sub-task' } } }],
    issue: issueJson('UYT-7', { parent: { key: 'UYT-1', fields: { summary: 'Epic', status: { name: 'Open' }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } } }),
  });
  const t = task({ ticket: 'UYT-7', ticketUrl: `https://${SITE}/browse/UYT-7` });
  const r = await call(undefined, worker({ taskId: t.id }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    notice: ISSUE_READ_NOTICE,
    issue: { key: 'UYT-7', title: 'Title of UYT-7', url: `https://${SITE}/browse/UYT-7`, status: 'In Progress', issueType: 'Story', assignee: 'Ada', labels: ['a', 'b'], parent: { key: 'UYT-1', title: 'Epic', status: 'Open' }, updatedAt: '2026-09-02T10:00:00.000+0000', body: 'The description' },
    comments: [
      { author: 'Person 1', createdAt: '2026-09-01T10:01:00.000+0000', body: 'first' },
      { author: 'Person 2', createdAt: '2026-09-01T10:02:00.000+0000', body: 'second' },
    ],
    children: [{ key: 'UYT-8', title: 'Child', status: 'To Do', issueType: 'Sub-task' }],
    notes: [],
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url.startsWith(`https://${SITE}/rest/api/3/`) && !c.url.includes('/field')));
  assert.equal(calls[0].url, `https://${SITE}/rest/api/3/issue/UYT-7?fields=summary,description,assignee,labels,status,parent,project,updated,issuetype`);
  assert.equal(calls[0].auth, `Basic ${Buffer.from('me@x.fi:tok-secret-1').toString('base64')}`);
});

test('a Jira key as ref reads that ticket; a task ref reads that task’s ticket', async () => {
  const { calls, call, task, worker } = setup();
  const mine = task({ ticket: 'UYT-7', ticketUrl: `https://${SITE}/browse/UYT-7` });
  const other = task({ title: 'Other work', ticket: 'UYT-9' });
  const byKey = await call('uyt-12', worker({ taskId: mine.id }));
  assert.equal(byKey.status, 200);
  assert.equal(byKey.body.issue.key, 'UYT-12');
  const byTask = await call(`#${other.id}`, worker({ taskId: mine.id }));
  assert.equal(byTask.status, 200);
  assert.equal(byTask.body.issue.key, 'UYT-9');
  assert.equal(calls.length, 6);
  // A worker with no task asks by key.
  assert.equal((await call('UYT-3')).status, 200);
});

test('comments: the newest 30 stay, each is cut, the total budget drops the oldest first, commentsCut says so', async () => {
  const many = Array.from({ length: 40 }, (_, i) => comment(i + 1));
  const a = setup({ comments: many });
  const t = a.task({ ticket: 'UYT-7' });
  const r = await a.call(undefined, a.worker({ taskId: t.id }));
  assert.equal(r.body.comments.length, ISSUE_READ_LIMITS.comments);
  assert.equal(r.body.comments[0].body, 'comment 11');
  assert.equal(r.body.comments.at(-1).body, 'comment 40');
  assert.equal(r.body.commentsCut, true);

  const b = setup({ comments: Array.from({ length: 20 }, (_, i) => comment(i + 1, `${i + 1} ${'x'.repeat(5000)}`)) });
  const t2 = b.task({ ticket: 'UYT-7' });
  const r2 = (await b.call(undefined, b.worker({ taskId: t2.id }))).body;
  assert.ok(r2.comments.every((c: Json) => c.body.length < 2100 && c.body.includes('… (cut:')));
  const total = r2.comments.reduce((n: number, c: Json) => n + c.body.length, 0);
  assert.ok(total <= ISSUE_READ_LIMITS.commentsTotal);
  assert.ok(r2.comments.length < 20);
  assert.ok(r2.comments.at(-1).body.startsWith('20 '));
  assert.equal(r2.commentsCut, true);

  // Few comments: not cut. A full page of 50 from Jira may have more behind it.
  const c = setup({ comments: [comment(1)] });
  assert.equal((await c.call('UYT-1')).body.commentsCut, undefined);
  const d = setup({ comments: Array.from({ length: 50 }, (_, i) => comment(i + 1, 'y')) });
  const r4 = (await d.call('UYT-1')).body;
  assert.equal(r4.commentsCut, true);
  assert.equal(r4.comments.length, 30);
});

test('bodyCut when the description is as long as the office keeps, labels are limited', async () => {
  const { call } = setup({ issue: issueJson('UYT-1', { description: adf('z'.repeat(30_000)), labels: Array.from({ length: 40 }, (_, i) => `l${i}`) }) });
  const r = (await call('UYT-1')).body;
  assert.equal(r.issue.body.length, 20_000);
  assert.equal(r.issue.bodyCut, true);
  assert.equal(r.issue.labels.length, ISSUE_READ_LIMITS.labels);
  const short = (await setup().call('UYT-1')).body;
  assert.equal(short.issue.bodyCut, undefined);
});

test('children: only the ones a source of the project covers, at most 50, childrenMore; a parent outside it is its key alone', async () => {
  const kids = [...Array.from({ length: 60 }, (_, i) => ({ key: `UYT-${100 + i}`, fields: { summary: `k${i}` } })), { key: 'SECRET-1', fields: { summary: 'Not yours' } }];
  const { call } = setup({ children: kids, issue: issueJson('UYT-7', { parent: { key: 'SECRET-5', fields: { summary: 'Hidden title', status: { name: 'Open' } } } }) });
  const r = (await call('UYT-7')).body;
  assert.equal(r.children.length, 50);
  assert.ok(r.children.every((c: Json) => c.key.startsWith('UYT-')));
  assert.equal(r.childrenMore, true);
  assert.deepEqual(r.issue.parent, { key: 'SECRET-5' });
  assert.ok(!r.children.some((c: Json) => c.title === 'Not yours') && !JSON.stringify(r).includes('Hidden title'));
  // Jira says there is more.
  const more = setup({ childrenNext: 'next', children: [{ key: 'UYT-2', fields: { summary: 'a' } }] });
  assert.equal((await more.call('UYT-7')).body.childrenMore, true);
});

test('refusals send nothing to Jira: no ticket, free text, uncovered key, another project’s task, other kinds, no connection', async () => {
  const { calls, call, task, worker } = setup();
  const none = task();
  const free = task({ title: 'Free', ticket: '1234' });
  const foreign = task({ project: 'other', title: 'Foreign', ticket: 'UYT-50' });
  const gh = task({ title: 'Gh', ticket: 'gh:o/app#12' });
  const draft = task({ title: 'Draft', ticket: 'ghp:o/1#PVTI_x' });
  const ab = task({ title: 'Work item', ticket: 'ab:org/proj#7' });
  // A task whose ticket is `1234` must not make `1234` read another task's ticket as a reference.
  const target = task({ title: 'Target', ticket: 'UYT-60' });
  assert.equal(target.id, 7);

  const as = (t: { id: number }) => worker({ taskId: t.id });
  let r = await call(undefined, as(none));
  assert.deepEqual([r.status, r.body.error], [409, `Task #${none.id} has no ticket linked`]);
  r = await call(undefined, worker());
  assert.equal(r.status, 400);
  r = await call(undefined, as(free));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /doesn't read that kind of ticket for agents/);
  assert.match(r.body.error, /description holds its copy/);
  r = await call(undefined, as(gh));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /gh issue view 12 -R o\/app --comments/);
  r = await call(undefined, as(draft));
  assert.equal(r.status, 422);
  r = await call(undefined, as(ab));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /description holds its copy/);
  r = await call('gh:o/app#3', as(none));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /gh issue view 3 -R o\/app --comments/);
  assert.equal((await call('ghp:o/1#x', as(none))).status, 422);
  assert.equal((await call('ab:org/proj#7', as(none))).status, 422);
  r = await call('OTHER-1', as(none));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isn't inside one of the project's Jira sources/);
  r = await call(`#${foreign.id}`, as(none));
  assert.equal(r.status, 403);
  // Another task's free-text ticket is classified, not fed back as a reference.
  r = await call(`#${free.id}`, as(none));
  assert.equal(r.status, 422);
  // No task, no match, several matches: 409 with the candidates in the error text.
  assert.equal((await call('#999', as(none))).status, 409);
  r = await call('Nonesuch', as(none));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No task matches/);
  task({ title: 'Twin one' });
  task({ title: 'Twin two' });
  r = await call('Twin', as(none));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Twin one/);
  assert.match(r.body.error, /Twin two/);
  assert.equal(calls.length, 0);

  // The key's project is in a source, but the site has no connection.
  const lone = setup({ connections: [] });
  const r2 = await lone.call('UYT-1');
  assert.equal(r2.status, 409);
  assert.match(r2.body.error, /No Jira connection for team\.atlassian\.net/);
  assert.equal(lone.calls.length, 0);
  // No Jira source at all.
  const noSource = setup({ sources: [] });
  assert.equal((await noSource.call('UYT-1')).status, 403);
  assert.equal(noSource.calls.length, 0);
  assert.equal((await call('x'.repeat(301))).status, 400);
});

test('several sites: the ticket’s own link picks the site and its connection; a moved issue is refused', async () => {
  const a = setup({ sources: [jira(['UYT'], SITE, 's1'), jira(['OTH'], OTHER, 's2')] });
  const t = a.task({ ticket: 'OTH-1', ticketUrl: `https://${OTHER}/browse/OTH-1` });
  const r = await a.call(undefined, a.worker({ taskId: t.id }));
  assert.equal(r.status, 200);
  assert.ok(a.calls.every((c) => c.url.startsWith(`https://${OTHER}/`)));
  assert.equal(a.calls[0].auth, `Basic ${Buffer.from('you@y.fi:tok-secret-2').toString('base64')}`);

  // The issue answers under a key the source doesn't cover: refused, and only the one call was made.
  const moved = setup({ issue: issueJson('ELSE-5') });
  const m = await moved.call('UYT-5');
  assert.equal(m.status, 403);
  assert.match(m.body.error, /ELSE-5/);
  assert.equal(moved.calls.length, 1);
});

test('Jira 401, 500, 429 and a timeout are said with a status and a message, no secret', async () => {
  const fail = (reply: Reply) => setup({ jira: (c) => (c.url.includes('/issue/UYT-1?') ? reply : undefined) });
  let s = fail({ status: 401, body: { errorMessages: ['no'] } });
  let r = await s.call('UYT-1');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /turned the e-mail and API token down \(401\)/);
  s = fail({ status: 500, body: {} });
  r = await s.call('UYT-1');
  assert.deepEqual([r.status, r.body.error], [502, 'Jira said 500']);
  s = fail({ status: 429, body: {} });
  r = await s.call('UYT-1');
  assert.deepEqual([r.status, r.body.error], [502, 'Jira is rate-limiting the office: try again in a minute']);
  s = fail(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  r = await s.call('UYT-1');
  assert.deepEqual([r.status, r.body.error], [504, "Jira didn't answer within 30 s"]);
  s = fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal((await s.call('UYT-1')).status, 504);
});

test('a failing comment or child read does not fail the read: it is a note', async () => {
  const s = setup({ jira: (c) => (c.url.includes('/comment?') ? { status: 429, body: {} } : c.url.includes('/search/jql') ? { status: 500, body: {} } : undefined) });
  const r = await s.call('UYT-1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.comments, []);
  assert.deepEqual(r.body.children, []);
  assert.deepEqual(r.body.notes, ["Comments couldn't be read: Jira is rate-limiting the office: try again in a minute", "Child issues couldn't be read: Jira said 500"]);
  const t = setup({ jira: (c) => (c.url.includes('/comment?') ? Object.assign(new Error('x'), { name: 'TimeoutError' }) : undefined) });
  assert.deepEqual((await t.call('UYT-1')).body.notes, ["Comments couldn't be read: Jira didn't answer within 30 s"]);
});

test('only GET, only exactly /office/tasks/issue', async () => {
  const s = setup();
  assert.equal((await s.call('UYT-1', s.worker(), 'POST')).status, 405);
  assert.equal((await s.call('UYT-1', s.worker(), 'GET', '/office/tasks/issueX')).status, 404);
  assert.equal((await s.call('UYT-1', s.worker(), 'GET', '/office/tasks/issue/x')).status, 404);
  assert.equal(s.calls.length, 0);
});

test('authentication: a wrong token is 401 on the hook route and Jira is not asked', async () => {
  const s = setup();
  let handled = 0;
  const ctx = {
    kanban: { handleHook: async () => (handled++, true) },
    workerFloor: () => ({ id: 'app', workers: { authenticate: (_id: string, token: string) => (token === 'good' ? { id: 'w1', name: 'Ada', kind: 'agent', deskId: 'x' } : undefined), ownerOf: () => undefined } }),
    accounts: { get: () => undefined },
  };
  let status = 0;
  const res = { writeHead: (n: number) => void (status = n), end: () => {} } as unknown as ServerResponse;
  const req = (token: string) => ({ method: 'GET', headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;
  await officeTasks(ctx as never, req('bad'), res, new URL(`${PATH}?worker=w1&ref=UYT-1`, 'http://127.0.0.1'));
  assert.equal(status, 401);
  assert.equal(handled, 0);
  assert.equal(s.calls.length, 0);
  await officeTasks(ctx as never, req('good'), res, new URL(`${PATH}?worker=w1`, 'http://127.0.0.1'));
  assert.equal(handled, 1);
});

// --- the open source's scope, the site pin, error texts --------------------------------------------

test('an open source covers only the Jira projects the project’s tasks have tickets in', async () => {
  // A task-less worker, no ticket anywhere: HR-1 is refused and Jira is not asked.
  const a = setup({ sources: [jira([])] });
  const r = await a.call('HR-1');
  assert.equal(r.status, 403);
  assert.equal(a.calls.length, 0);
  // Tasks with tickets elsewhere in the project make their Jira projects known; HR still is not.
  const b = setup({ sources: [jira([])], children: [{ key: 'UYT-8', fields: { summary: 'Same project' } }, { key: 'HR-9', fields: { summary: 'Other project' } }] });
  const t = b.task({ ticket: 'UYT-7', ticketUrl: `https://${SITE}/browse/UYT-7` });
  b.task({ title: 'Archived', ticket: 'ABC-1' });
  const own = await b.call(undefined, b.worker({ taskId: t.id }));
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.children.map((c: Json) => c.key), ['UYT-8']);
  const calls = b.calls.length;
  assert.equal((await b.call('HR-1')).status, 403);
  assert.equal(b.calls.length, calls);
  // A sibling in the same Jira project, and one in another project the tasks use.
  assert.equal((await b.call('UYT-99')).status, 200);
  assert.equal((await b.call('abc-5')).status, 200);
  // The parent in another Jira project is its key alone.
  const c = setup({ sources: [jira([])], issue: issueJson('UYT-7', { parent: { key: 'HR-5', fields: { summary: 'Hidden' } } }) });
  c.task({ ticket: 'UYT-7' });
  const r3 = (await c.call('UYT-7')).body;
  assert.deepEqual(r3.issue.parent, { key: 'HR-5' });
});

test('a ticket link on a site with no source is refused, not read from another site', async () => {
  const sources = [jira(['UYT'])];
  const s = setup({ sources });
  const url = `https://${OTHER}/browse/UYT-12`;
  const t = s.task({ ticket: 'UYT-12', ticketUrl: url });
  const r = await s.call(undefined, s.worker({ taskId: t.id }));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /UYT-12's link is on other\.atlassian\.net, where the project has no Jira source that covers it/);
  assert.equal(s.calls.length, 0);
  assert.equal(jiraReadAdvertised(sources, CONNS, 'UYT-12', url, ['UYT-12']), false);
  assert.equal(jiraReadAdvertised(sources, CONNS, 'UYT-12', `https://${SITE}/browse/UYT-12`, ['UYT-12']), true);
  // The same through a task ref.
  const u = s.task({ title: 'Ref' });
  assert.equal((await s.call(`#${t.id}`, s.worker({ taskId: u.id }))).status, 403);
  // A bare key: the own link is only a hint, ignored when no source is on its site.
  const r2 = await s.call('UYT-3', s.worker({ taskId: t.id }));
  assert.equal(r2.status, 200);
  assert.ok(s.calls.length === 3 && s.calls.every((c) => c.url.startsWith(`https://${SITE}/`)));
  // ... and used when a source covering the key is on its site (a key two sites both cover can't be configured, so it only picks the same one).
  const m = setup({ sources: [jira(['UYT'], SITE, 's1'), jira(['OTH'], OTHER, 's2')] });
  const w = m.task({ ticket: 'OTH-1', ticketUrl: `https://${OTHER}/browse/OTH-1` });
  const rr = await m.call('UYT-2', m.worker({ taskId: w.id }));
  assert.equal(rr.status, 200, rr.text);
  assert.ok(m.calls.every((c) => c.url.startsWith(`https://${SITE}/`)));
});

test('a network failure says where; a long Jira error is clipped', async () => {
  const a = setup({ jira: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });
  const r = await a.call('UYT-1');
  assert.deepEqual([r.status, r.body.error], [502, `Couldn't reach Jira at ${SITE}`]);
  const b = setup({ jira: (c) => (c.url.includes('/issue/UYT-1?') ? { status: 400, body: { errorMessages: ['E'.repeat(5000)] } } : undefined) });
  const r2 = await b.call('UYT-1');
  assert.equal(r2.status, 502);
  assert.ok(r2.body.error.length <= 500 && r2.body.error.startsWith('Jira said 400: EEE'));
  // A secret in Jira's own words doesn't pass either.
  const c = setup({ jira: (x) => (x.url.includes('/issue/UYT-1?') ? { status: 400, body: { errorMessages: ['bad tok-secret-1'] } } : undefined) });
  assert.equal((await c.call('UYT-1')).status, 502);
});

// --- jiraReadScope / jiraReadSource / jiraReadAdvertised ------------------------------------------------

test('jiraReadSource: covered, named before open, the link’s site, and the connection', () => {
  const named = jira(['UYT'], SITE, 'named');
  const scoped = (...s: IssueSourceConfig[]) => jiraReadScope(s, ['XYZ-1']);
  const src = (r: unknown) => r as { id?: string; status?: number; error?: string };
  assert.match(src(jiraReadSource([], CONNS, 'UYT-1')).error!, /isn't inside one of the project's Jira sources: nothing was asked of Jira/);
  assert.match(src(jiraReadSource(scoped(named), CONNS, 'nope')).error!, /isn't a Jira issue key/);
  assert.match(src(jiraReadSource(scoped(jira(['ABC'])), CONNS, 'UYT-1')).error!, /isn't inside/);
  // An open source is only for the known Jira projects; the named one wins for its own.
  const open = jira([], SITE, 'open');
  assert.equal(src(jiraReadSource(scoped(open, named), CONNS, 'uyt-1')).id, 'named');
  assert.equal(src(jiraReadSource(scoped(open, named), CONNS, 'XYZ-1')).id, 'open');
  assert.equal(src(jiraReadSource(scoped(open, named), CONNS, 'HR-1')).status, 403);
  assert.deepEqual(jiraReadScope([open], []), []);
  // The same key through a source on each site: the link's site decides, a link elsewhere is refused.
  const a = jira(['UYT'], SITE, 'a');
  const b = jira(['UYT'], OTHER, 'b');
  assert.equal(src(jiraReadSource([a, b] as never, CONNS, 'UYT-1')).id, 'a');
  assert.equal(src(jiraReadSource([a, b] as never, CONNS, 'UYT-1', `https://${OTHER.toUpperCase()}/browse/UYT-1`)).id, 'b');
  assert.equal(src(jiraReadSource([a, b] as never, CONNS, 'UYT-1', 'not a url')).id, 'a');
  const away = src(jiraReadSource([a, b] as never, CONNS, 'UYT-1', 'https://elsewhere.example/x'));
  assert.equal(away.status, 403);
  assert.match(away.error!, /link is on elsewhere\.example/);
  // No connection, a removed one, one for another site: the reason, never a throw.
  assert.match(src(jiraReadSource([a] as never, [], 'UYT-1')).error!, /No Jira connection for team\.atlassian\.net/);
  assert.match(src(jiraReadSource([{ ...a, connection: 'gone' }] as never, CONNS, 'UYT-1')).error!, /was removed/);
  assert.match(src(jiraReadSource([{ ...a, connection: 'c2' }] as never, CONNS, 'UYT-1')).error!, /is for other\.atlassian\.net/);
  assert.equal(src(jiraReadSource([{ ...a, connection: 'c1' }] as never, CONNS, 'UYT-1')).id, 'a');
});

test('jiraReadAdvertised: a named project, or an open source on the ticket’s own site', () => {
  const open = jira([]);
  const named = jira(['UYT']);
  const adv = (s: IssueSourceConfig[], conns: typeof CONNS, ticket: string | undefined, url?: string) => jiraReadAdvertised(s, conns, ticket, url, [ticket]);
  assert.equal(adv([named], CONNS, 'UYT-1'), true);
  assert.equal(adv([open], CONNS, 'UYT-1'), false);
  assert.equal(adv([open], CONNS, 'UYT-1', `https://${SITE}/browse/UYT-1`), true);
  assert.equal(adv([open], CONNS, 'UYT-1', `https://${OTHER}/browse/UYT-1`), false);
  assert.equal(adv([named], CONNS, 'UYT-1', `https://${OTHER}/browse/UYT-1`), false);
  assert.equal(adv([named], CONNS, '1234'), false);
  assert.equal(adv([named], CONNS, undefined), false);
  assert.equal(adv([jira(['ABC'])], CONNS, 'UYT-1'), false);
  assert.equal(adv([named], [], 'UYT-1'), false);
  assert.equal(adv([{ id: 'g', kind: 'github-repo', repos: [], filters: {} }], CONNS, 'UYT-1'), false);
});
