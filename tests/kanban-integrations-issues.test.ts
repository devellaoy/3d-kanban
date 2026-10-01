import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, buildJql, jiraSource, jqlQuote } from '../src/server/kanban/integrations/issues/jira.js';
import { ghIssueArgs, githubRepoSource, parseGhIssues } from '../src/server/kanban/integrations/issues/github-repo.js';
import { PROJECT_SCOPE_ERROR, filterProjectItems, githubProjectSource, parseProjectPage, projectArgs, projectError } from '../src/server/kanban/integrations/issues/github-project.js';
import { createIssues, issueDescription } from '../src/server/kanban/integrations/issues/index.js';
import type { IssueSourceIo } from '../src/server/kanban/integrations/issues/source.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

const io = (over: Partial<IssueSourceIo> = {}): IssueSourceIo => ({ gh: async () => '[]', fetch: (async () => new Response('{}')) as typeof fetch, cwd: '/tmp', projectRepos: [], ...over });

// --- Jira -----------------------------------------------------------------------------------------

test('JQL quotes and escapes every value, and AND-s the extra JQL in parentheses', () => {
  assert.equal(jqlQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(jqlQuote('line\nbreak'), '"line break"');
  const jql = buildJql({ projectKeys: ['UYT', 'ABC'], filters: { assignee: 'me', epic: 'UYT-1', labels: ['x" OR 1=1'], jql: 'priority = High' } });
  assert.equal(jql, 'project IN ("UYT", "ABC") AND assignee = currentUser() AND parent = "UYT-1" AND labels = "x\\" OR 1=1" AND statusCategory != "Done" AND (priority = High) ORDER BY updated DESC');
  assert.match(buildJql({ projectKeys: [], filters: { assignee: '5b10ac8d82e05b22cc7d4ef5', epic: 'E-2' } }, 'Epic Link'), /^assignee = "5b10ac8d82e05b22cc7d4ef5" AND "Epic Link" = "E-2" AND statusCategory != "Done"/);
  assert.match(buildJql({ projectKeys: ['A'], filters: { statusCategoryNot: ['Done', 'In Progress'] } }), /statusCategory NOT IN \("Done", "In Progress"\)/);
  assert.throws(() => buildJql({ projectKeys: ['A'], filters: { jql: 'x = 1 ORDER BY created' } }), /ORDER BY/);
});

test('ADF becomes plain text: paragraphs, headings, lists, code, mentions, links', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'mention', attrs: { text: '@Panu' } }, { type: 'hardBreak' }, { type: 'inlineCard', attrs: { url: 'https://x.io' } }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'let x = 1;' }] },
      { type: 'mediaSingle', content: [{ type: 'media' }] },
    ],
  };
  assert.equal(adfToText(doc), '## Goal\n\nHello @Panu\nhttps://x.io\n\n- one\n- two\n\n1. first\n\n```ts\nlet x = 1;\n```\n\n[attachment]');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText('plain'), 'plain');
});

const JIRA: IssueSourceConfig = { id: 'j', kind: 'jira', site: 'team.atlassian.net', projectKeys: ['UYT'], filters: { epic: 'UYT-1' } };

test('Jira: Basic auth to the site only, pages through nextPageToken, epic falls back to "Epic Link"', async () => {
  const calls: { url: string; body: any; auth: string }[] = [];
  const pages = [
    { issues: [], isLast: true },
    { issues: [{ key: 'UYT-2', fields: { summary: 'Two', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] }, labels: ['a'], status: { name: 'To Do' }, parent: { key: 'UYT-1' }, project: { key: 'UYT' }, updated: '2026-09-01T00:00:00.000+0000', assignee: { displayName: 'P' } } }], nextPageToken: 't2' },
    { issues: [{ key: 'UYT-3', fields: { summary: 'Three' } }], isLast: true },
  ];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
    return new Response(JSON.stringify(pages[calls.length - 1]));
  }) as unknown as typeof globalThis.fetch;
  const got = await jiraSource.list(JIRA, io({ fetch, jira: { site: 'team.atlassian.net', email: 'me@x.fi', token: 'tok' } }));
  assert.equal(calls[0].url, 'https://team.atlassian.net/rest/api/3/search/jql');
  assert.equal(calls[0].auth, `Basic ${Buffer.from('me@x.fi:tok').toString('base64')}`);
  assert.match(calls[0].body.jql, /parent = "UYT-1"/);
  assert.match(calls[1].body.jql, /"Epic Link" = "UYT-1"/, 'no issues under parent: the old field');
  assert.equal(calls[2].body.nextPageToken, 't2');
  assert.deepEqual(got.map((i) => i.key), ['UYT-2', 'UYT-3']);
  assert.deepEqual({ ...got[0], updatedAt: '' }, { source: 'jira', sourceId: 'j', key: 'UYT-2', title: 'Two', url: 'https://team.atlassian.net/browse/UYT-2', body: 'Body', assignee: 'P', labels: ['a'], status: 'To Do', epic: 'UYT-1', project: 'UYT', updatedAt: '' });
  await assert.rejects(jiraSource.list({ ...JIRA, site: 'evil.example.com' }, io({ fetch, jira: { site: 'team.atlassian.net', email: 'e', token: 't' } })), /token is for team.atlassian.net/);
  await assert.rejects(jiraSource.list(JIRA, io()), /Jira isn’t set up/);
  const denied = (async () => new Response(JSON.stringify({ errorMessages: ['nope'] }), { status: 401 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(jiraSource.list({ ...JIRA, filters: {} }, io({ fetch: denied, jira: { site: 'team.atlassian.net', email: 'e', token: 't' } })), /turned the e-mail and API token down \(401\): nope/);
});

// --- GitHub repositories --------------------------------------------------------------------------

const GH_ISSUES = JSON.stringify([
  { number: 12, title: 'Fix login', url: 'https://github.com/o/app/issues/12', body: 'It breaks', state: 'OPEN', assignees: [{ login: 'panu' }], labels: [{ name: 'bug' }], updatedAt: '2026-09-02T10:00:00Z' },
  { title: 'no number' },
]);

test('gh issue list: its arguments from the filters, and its JSON as issues', async () => {
  assert.deepEqual(ghIssueArgs('o/app', { assignee: 'me', labels: ['bug', '-x'], state: 'all' }).slice(0, 6), ['issue', 'list', '-R', 'o/app', '--state', 'all']);
  assert.ok(ghIssueArgs('o/app', { assignee: 'me', labels: ['-x'] }).includes('--assignee=@me'));
  assert.ok(ghIssueArgs('o/app', { labels: ['-x'] }).includes('--label=-x'), 'a value never reads as a flag');
  const got = parseGhIssues('o/app', GH_ISSUES, 's1');
  assert.deepEqual(got, [{ source: 'github-repo', sourceId: 's1', key: 'gh:o/app#12', title: 'Fix login', url: 'https://github.com/o/app/issues/12', body: 'It breaks', assignee: 'panu', labels: ['bug'], status: 'OPEN', repo: 'o/app', updatedAt: '2026-09-02T10:00:00Z' }]);
  assert.throws(() => parseGhIssues('o/app', 'not json'), /isn't JSON/);
  const seen: string[][] = [];
  const all = await githubRepoSource.list({ id: 's', kind: 'github-repo', repos: [], filters: {} }, io({ projectRepos: ['o/app', 'o/api'], gh: async (args) => (seen.push(args), args[3] === 'o/app' ? GH_ISSUES : '[]') }));
  assert.deepEqual(seen.map((a) => a[3]), ['o/app', 'o/api'], "no repositories named: the project's own");
  assert.equal(all.length, 1);
});

// --- GitHub Projects v2 ---------------------------------------------------------------------------

const page = (nodes: unknown[], next?: string) =>
  JSON.stringify({ data: { viewer: { login: 'panu' }, repositoryOwner: { projectV2: { title: 'Board', url: 'https://github.com/orgs/o/projects/3', items: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } } } } });
const item = (id: string, content: object, status?: string, extra: object = {}) => ({ id, isArchived: false, updatedAt: '2026-09-01T00:00:00Z', status: status ? { name: status } : null, iteration: null, content, ...extra });
const issue = (n: number, title: string, assignees: string[] = [], state = 'OPEN') => ({ __typename: 'Issue', number: n, title, url: `https://github.com/o/app/issues/${n}`, body: 'b', state, updatedAt: '2026-09-03T00:00:00Z', repository: { nameWithOwner: 'o/app' }, assignees: { nodes: assignees.map((login) => ({ login })) }, labels: { nodes: [{ name: 'l' }] } });

test('Projects v2: items parsed (issues, drafts), closed and archived left out, filtered by @me and status', async () => {
  const p = parseProjectPage(page([item('PVTI_1', issue(5, 'Five', ['panu']), 'Todo'), item('PVTI_2', { __typename: 'DraftIssue', title: 'Draft', body: 'd', assignees: { nodes: [] } }, 'Todo'), item('PVTI_3', issue(6, 'Closed', [], 'CLOSED')), item('PVTI_4', issue(7, 'Archived'), 'Todo', { isArchived: true })], 'c2'), { id: 'p', owner: 'o', number: 3 });
  assert.equal(p.viewer, 'panu');
  assert.equal(p.next, 'c2');
  assert.deepEqual(p.items.map((i) => i.key), ['gh:o/app#5', 'ghp:o/3#PVTI_2', 'gh:o/app#6']);
  assert.deepEqual(filterProjectItems(p.items, {}).map((i) => i.key), ['gh:o/app#5', 'ghp:o/3#PVTI_2']);
  assert.deepEqual(filterProjectItems(p.items, { assignee: '@me', status: 'todo' }, 'panu').map((i) => i.key), ['gh:o/app#5']);
  assert.ok(!('closed' in filterProjectItems(p.items, {})[0]), 'no internal fields go out');
  assert.ok(projectArgs('o', 3, 'c2').includes('after=c2'));
  assert.ok(projectArgs('o', 3).includes('number=3'));
  let n = 0;
  const all = await githubProjectSource.list({ id: 'p', kind: 'github-project', owner: 'o', number: 3, filters: {} }, io({ gh: async () => (n++ === 0 ? page([item('A', issue(1, 'One'))], 'c') : page([item('B', issue(2, 'Two'))])) }));
  assert.deepEqual(all.map((i) => i.key), ['gh:o/app#1', 'gh:o/app#2'], 'both pages');
});

test('Projects v2: a token without read:project says what to run', async () => {
  const scopes = "Your token has not been granted the required scopes to execute this query. The 'title' field requires one of the following scopes: ['read:project']";
  assert.equal(projectError(new Error(scopes)).message, PROJECT_SCOPE_ERROR);
  assert.match(PROJECT_SCOPE_ERROR, /gh auth refresh -s read:project/);
  assert.equal(projectError(new Error('other')).message, 'other');
  await assert.rejects(githubProjectSource.list({ id: 'p', kind: 'github-project', owner: 'o', number: 3, filters: {} }, io({ gh: async () => Promise.reject(new Error(scopes)) })), { message: PROJECT_SCOPE_ERROR });
  assert.throws(() => parseProjectPage(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: scopes }] }), { id: 'p', owner: 'o', number: 3 }), { message: PROJECT_SCOPE_ERROR });
  assert.throws(() => parseProjectPage(JSON.stringify({ data: { repositoryOwner: { projectV2: null } } }), { id: 'p', owner: 'o', number: 9 }), /no project number 9/);
});

// --- The plugin -----------------------------------------------------------------------------------

test('issues: listed from every source, cached, and made into a task once per ticket', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })]);
  ctx.settings.setProject('app', { issueSources: [{ id: 's1', kind: 'github-repo', repos: ['o/app'], filters: {} }, { id: 'j', kind: 'jira', site: 'x.atlassian.net', projectKeys: ['UYT'], filters: {} }] as IssueSourceConfig[] });
  let ghCalls = 0;
  const issues = createIssues(ctx, { gh: async () => (ghCalls++, GH_ISSUES) });
  const c = client();
  await issues.plugin.ws!['kanban.issues.refresh']!(c, { t: 'kanban.issues.refresh', project: 'app', rid: 'r1' });
  const listed = c.got.at(-1) as Extract<(typeof c.got)[number], { t: 'kanban.issues' }>;
  assert.equal(listed.rid, 'r1');
  assert.deepEqual(listed.items.map((i) => i.key), ['gh:o/app#12']);
  assert.match(listed.error ?? '', /^Jira UYT: Jira isn’t set up/, 'one broken source leaves the others');
  assert.ok(ctx.sent.some((s) => s.msg.t === 'kanban.issues' && s.project === 'app'), 'subscribers hear it');

  await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/app#12', rid: 'r2', start: true });
  const made = c.got.at(-1) as { t: string; taskId: number; existed: boolean };
  assert.equal(made.t, 'kanban.ok');
  assert.equal(made.existed, false);
  const task = ctx.repo.getTask(made.taskId)!;
  assert.equal(task.ticket, 'gh:o/app#12');
  assert.equal(task.ticketUrl, 'https://github.com/o/app/issues/12');
  assert.equal(task.description, 'It breaks\n\nSource: https://github.com/o/app/issues/12');
  assert.deepEqual(ctx.started, [made.taskId]);
  await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/app#12', rid: 'r3' });
  assert.deepEqual(c.got.at(-1), { t: 'kanban.ok', rid: 'r3', taskId: made.taskId, existed: true });
  assert.equal(ctx.repo.listTasks('app').length, 1);
  issues.plugin.ws!['kanban.issues.list']!(c, { t: 'kanban.issues.list', project: 'app' });
  assert.equal((c.got.at(-1) as { items: { taskId?: number }[] }).items[0].taskId, made.taskId, 'the list says which task each became');
  assert.equal(ghCalls, 1, 'fresh enough: no new fetch');
  await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/app#99', rid: 'r4' });
  assert.equal(c.got.at(-1)?.t, 'kanban.error');
  assert.equal(issueDescription({ source: 'jira', key: 'K-1', title: 't', url: 'u', body: '', labels: [], updatedAt: '' }), 'Source: u');
});

// --- A task made from an issue takes it -----------------------------------------------------------

type ClaimIssue = { number: number; assignees?: string[]; state?: string; url?: string };
function claimSetup(opts: { ghAs?: Parameters<typeof makeCtx>[1] extends infer O ? (O extends { ghAs?: infer G } ? G : never) : never; fail?: boolean; login?: string; sources?: IssueSourceConfig[]; issues?: ClaimIssue[]; startError?: string } = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })], { ...(opts.ghAs ? { ghAs: opts.ghAs } : {}), ...(opts.startError ? { start: () => opts.startError } : {}) });
  ctx.settings.setProject('app', { issueSources: opts.sources ?? ([{ id: 's1', kind: 'github-repo', repos: ['o/app'], filters: {} }] as IssueSourceConfig[]) });
  const data = opts.issues ?? [{ number: 1 }];
  const calls: string[][] = [];
  const gh: IssueSourceIo['gh'] = async (args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(data.map((i) => ({ number: i.number, title: `Issue ${i.number}`, url: i.url ?? `https://github.com/o/app/issues/${i.number}`, body: '', state: i.state ?? 'OPEN', assignees: (i.assignees ?? []).map((login) => ({ login })), labels: [], updatedAt: '2026-09-02T10:00:00Z' })));
    if (args[1] === 'view') return JSON.stringify({ assignees: (data.find((i) => String(i.number) === args[2])?.assignees ?? []).map((login) => ({ login })) });
    if (args[0] === 'api') return `${opts.login ?? 'panu'}\n`;
    if (args[1] === 'edit' && opts.fail) throw new Error('gh: forbidden');
    return '';
  };
  const issues = createIssues(ctx, { gh });
  const c = client(true, 'acc1');
  const make = async (key: string, start = false) => {
    await issues.plugin.ws!['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: key, ...(start ? { start: true } : {}) });
    return c.got.at(-1) as { t: string; taskId: number };
  };
  const edits = () => calls.filter((a) => a[1] === 'edit');
  return { ctx, issues, c, make, edits };
}
const env = (dir: string) => ({ ghAs: () => ({ env: { GH_CONFIG_DIR: dir } }) });

test('a task made from an unassigned GitHub issue assigns it to the person, shows it and says so on the task', async () => {
  const { ctx, issues, c, make, edits } = claimSetup(env('/h/claim-1'));
  await issues.refresh('app');
  const made = await make('gh:o/app#1');
  assert.equal(made.t, 'kanban.ok');
  assert.deepEqual(edits(), [['issue', 'edit', '1', '-R', 'o/app', '--add-assignee=panu']]);
  issues.plugin.ws!['kanban.issues.list']!(c, { t: 'kanban.issues.list', project: 'app' });
  assert.equal((c.got.at(-1) as { items: { assignee?: string }[] }).items[0].assignee, 'panu');
  assert.deepEqual(ctx.toasts, [{ floor: 'app', text: '👤 Tester took gh:o/app#1: assigned to panu', level: 'info' }]);
  assert.deepEqual(ctx.repo.listComments(made.taskId).comments.filter((x) => x.kind === 'status').map((x) => x.text), ['Tester took gh:o/app#1: assigned to panu']);
});

test('an issue that has an assignee, a Jira key, a pull request or a closed issue is not assigned', async () => {
  const mixed = [
    { number: 1, assignees: ['maija'] },
    { number: 2, url: 'https://github.com/o/app/pull/2' },
    { number: 3, state: 'CLOSED' },
  ];
  const sources = [{ id: 's1', kind: 'github-repo', repos: ['o/app'], filters: { state: 'all' } }] as IssueSourceConfig[];
  const { ctx, issues, make, edits } = claimSetup({ ...env('/h/claim-2'), issues: mixed, sources });
  await issues.refresh('app');
  for (const n of [1, 2, 3]) assert.equal((await make(`gh:o/app#${n}`)).t, 'kanban.ok');
  assert.deepEqual(edits(), []);
  assert.deepEqual(ctx.toasts, []);
  // Jira: no gh write either (the source isn't even reachable, so the issue is never found: the task isn't made).
  const jira = claimSetup({ sources: [{ id: 'j', kind: 'jira', site: 'x.atlassian.net', projectKeys: ['UYT'], filters: {} }] as IssueSourceConfig[] });
  assert.equal((await jira.make('UYT-1')).t, 'kanban.error');
  assert.deepEqual(jira.edits(), []);
});

test('no GitHub sign-in of the person: no call is made and the task is made all the same', async () => {
  const { ctx, issues, make, edits } = claimSetup({ ghAs: () => 'Sign in to GitHub first' });
  await issues.refresh('app');
  const made = await make('gh:o/app#1');
  assert.equal(made.t, 'kanban.ok');
  assert.ok(ctx.repo.getTask(made.taskId));
  assert.deepEqual(edits(), []);
  assert.deepEqual(ctx.toasts, []);
});

test('a failed assignment is a warning and the task stands', async () => {
  const { ctx, issues, make } = claimSetup({ ...env('/h/claim-3'), fail: true });
  await issues.refresh('app');
  const made = await make('gh:o/app#1');
  assert.equal(made.t, 'kanban.ok');
  assert.ok(ctx.repo.getTask(made.taskId));
  assert.deepEqual(ctx.toasts, [{ floor: 'app', text: '👤 Couldn’t assign gh:o/app#1: gh: forbidden', level: 'warn' }]);
});

test('a sign-in that can’t be got ready is a warning too, after the one answer', async () => {
  const { ctx, issues, c, make, edits } = claimSetup({
    ghAs: () => {
      throw new Error('EACCES: gh home');
    },
  });
  await issues.refresh('app');
  const before = c.got.length;
  const made = await make('gh:o/app#1');
  assert.equal(made.t, 'kanban.ok');
  assert.equal(c.got.length, before + 1, 'answered once, no kanban.error after it');
  assert.deepEqual(edits(), []);
  assert.deepEqual(ctx.toasts, [{ floor: 'app', text: '👤 Couldn’t assign gh:o/app#1: EACCES: gh home', level: 'warn' }]);
});

test('without a sign-in of their own, the office’s gh is who gets the issue', async () => {
  const { issues, make, edits } = claimSetup({ ghAs: () => undefined, login: 'office-bot' });
  await issues.refresh('app');
  await make('gh:o/app#1');
  assert.deepEqual(edits(), [['issue', 'edit', '1', '-R', 'o/app', '--add-assignee=office-bot']]);
});

test('a task whose start failed does not take its issue', async () => {
  const { issues, make, edits } = claimSetup({ ...env('/h/claim-5'), startError: 'No free desk' });
  await issues.refresh('app');
  assert.equal((await make('gh:o/app#1', true)).t, 'kanban.ok');
  assert.deepEqual(edits(), []);
});

test('starting an existing To do task from its issue assigns it too; only naming a task does not', async () => {
  const { ctx, issues, make, edits } = claimSetup({ ...env('/h/claim-4'), issues: [{ number: 1 }, { number: 2 }] });
  await issues.refresh('app');
  // Made without starting: assigned then; make the second one while its issue is read as assigned elsewhere, by hand.
  await make('gh:o/app#1');
  assert.equal(edits().length, 1);
  const todo = ctx.repo.createTask({ project: 'app', title: 'Issue 2', ticket: 'gh:o/app#2', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T' });
  const named = await make('gh:o/app#2');
  assert.equal(named.taskId, todo.id);
  assert.equal(edits().length, 1, 'named only: no write');
  const started = await make('gh:o/app#2', true);
  assert.equal(started.taskId, todo.id);
  assert.equal(edits().length, 2);
  assert.deepEqual(edits()[1], ['issue', 'edit', '2', '-R', 'o/app', '--add-assignee=panu']);
});
