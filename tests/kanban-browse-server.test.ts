import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { wallSourcesChanged } from '../src/server/kanban/integrations/issues/wall.js';
import { PROJECT_SCOPE_ERROR } from '../src/server/kanban/integrations/issues/github-project.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

const SITE = 'team.atlassian.net';
const JIRA_TOKEN = { site: SITE, email: 'me@x.fi', token: 'tok' };
const JIRA: IssueSourceConfig = { id: 'j', kind: 'jira', site: SITE, projectKeys: ['UYT'], filters: {} };
const JIRA_NOKEYS: IssueSourceConfig = { id: 'jn', kind: 'jira', site: SITE, projectKeys: [], filters: {} };
const JIRA_OTHER: IssueSourceConfig = { id: 'jo', kind: 'jira', site: 'other.atlassian.net', projectKeys: ['ZZ'], filters: {} };
const BOARD: IssueSourceConfig = { id: 'p', kind: 'github-project', owner: 'o', number: 1, filters: {} };
const REPO: IssueSourceConfig = { id: 'r', kind: 'github-repo', repos: ['o/r'], filters: {} };

type HttpCall = { url: string; method: string; body?: any };
const fetchStub = (answer: (c: HttpCall) => { status?: number; body?: unknown }) => {
  const calls: HttpCall[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = answer(call);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};
const ghStub = (answer: (args: string[]) => string | Error) => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    const out = answer(args);
    if (out instanceof Error) throw out;
    return out;
  };
  return { gh, calls };
};

const raw = (key: string, fields: Record<string, unknown> = {}) => ({ key, fields: { summary: `S ${key}`, status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Story', hierarchyLevel: 0 }, updated: '2026-09-01', ...fields } });

/** Jira: a site with versions, a sprint field, a search whose pages are keyed by the token, and counts. */
function jiraSite(extra: (c: HttpCall) => { status?: number; body?: unknown } | undefined = () => undefined) {
  return fetchStub((c) => {
    const mine = extra(c);
    if (mine) return mine;
    const u = c.url.replace(`https://${SITE}`, '');
    if (u === '/rest/api/3/field') return { body: [{ id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }] };
    if (u.startsWith('/rest/api/3/project/UYT/version')) {
      if (u.includes('status=released')) return { body: { isLast: true, values: [{ id: '5', name: '0.9', released: true, releaseDate: '2026-01-01' }] } };
      return { body: { isLast: true, values: [{ id: '8', name: '2.0', releaseDate: '2026-12-01' }, { id: '7', name: '1.0', releaseDate: '2026-10-01' }] } };
    }
    if (u === '/rest/api/3/search/approximate-count') return { body: { count: 12 } };
    if (u === '/rest/api/3/search/jql') {
      if (c.body.nextPageToken === 'tok2') return { body: { issues: [raw('UYT-3')], isLast: true } };
      return { body: { issues: [raw('UYT-1', { customfield_10020: [{ id: 3, name: 'Sprint 3', state: 'active' }] }), raw('UYT-2')], nextPageToken: 'tok2', isLast: false } };
    }
    if (u.startsWith('/rest/api/3/issue/UYT-')) return { body: raw(c.url.split('/issue/')[1].split('?')[0], { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body here' }] }] } }) };
    return { status: 404, body: {} };
  });
}

const ITEM = (n: number, over: Record<string, unknown> = {}) => ({ id: `PVTI_${n}`, isArchived: false, updatedAt: '2026-09-01', status: { name: 'Doing' }, content: { __typename: 'Issue', id: `I_${n}`, number: n, title: `Issue ${n}`, url: `https://github.com/o/r/issues/${n}`, state: 'OPEN', updatedAt: '2026-09-01', repository: { nameWithOwner: 'o/r' }, assignees: { nodes: [] }, labels: { nodes: [] }, issueType: { name: 'Bug' }, subIssuesSummary: { total: 2, completed: 1 }, ...over } });
const boardAnswer = (items: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ data: { repositoryOwner: { projectV2: { title: 'Roadmap', url: 'https://github.com/orgs/o/projects/1', items: { totalCount: 7, pageInfo: { hasNextPage: true, endCursor: 'CUR1' }, nodes: items, ...extra } } } } });
const q = (args: string[]) => args.find((a) => a.startsWith('query=')) ?? '';
const arg = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

function setup(opts: { sources?: IssueSourceConfig[]; http?: ReturnType<typeof fetchStub>; gh?: ReturnType<typeof ghStub>; ghAs?: any } = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })], { ghAs: opts.ghAs });
  ctx.settings.setProject('app', { issueSources: opts.sources ?? [JIRA, BOARD, JIRA_NOKEYS, JIRA_OTHER, REPO] });
  (ctx as unknown as { secrets: unknown }).secrets = { jira: () => JIRA_TOKEN };
  const http = opts.http ?? jiraSite();
  const gh = opts.gh ?? ghStub(() => '[]');
  const issues = createIssues(ctx, { gh: gh.gh as never, fetch: http.fetch });
  const ws = issues.plugin.ws!;
  const c = client(true, 'acc1');
  const ask = async (t: string, m: Record<string, unknown>) => {
    c.got.length = 0;
    await (ws as any)[t](c, { t, project: 'app', rid: 'r1', ...m });
    return c.got.at(-1) as any;
  };
  return { ctx, issues, ws, http, gh, c, ask };
}

test('scopes: Jira and board sources are listed, one without project keys is disabled, a repository source is not offered', async () => {
  const { ask } = setup();
  const got = await ask('kanban.browse.scopes', {});
  assert.equal(got.t, 'kanban.browseScopes');
  assert.deepEqual(got.scopes.map((s: any) => [s.id, s.kind, s.disabled]), [['j', 'jira', undefined], ['p', 'github-project', undefined], ['jn', 'jira', 'Add project keys to the Jira source to browse it'], ['jo', 'jira', undefined]]);
  assert.equal(got.me, undefined, 'no gh sign-in of the asker: no "me"');
});

test('scopes: the asker’s own GitHub login is told when gh runs as them', async () => {
  const gh = ghStub((a) => (a[0] === 'api' && a[1] === 'user' ? 'maija\n' : '[]'));
  const { ask } = setup({ gh, ghAs: () => ({ env: { GH_CONFIG_DIR: '/h/m' } }) });
  assert.deepEqual((await ask('kanban.browse.scopes', {})).me, { github: 'maija' });
});

test('scope checks: an unknown scope, a repository scope, a disabled scope and a token for another site are refused', async () => {
  const { ask, http } = setup();
  const err = async (scope: string) => (await ask('kanban.browse.options', { scope })).message as string;
  assert.match(await err('nope'), /isn't a Jira or GitHub project source/);
  assert.match(await err('r'), /isn't a Jira or GitHub project source/);
  assert.match(await err('jn'), /Add project keys/);
  assert.match(await err('jo'), /token is for team.atlassian.net, not other.atlassian.net/);
  assert.equal(http.calls.length, 0, 'nothing went out');
  assert.equal((await ask('kanban.browse.options', { scope: 'j', project: 'zzz' })).t, 'kanban.error');
});

test('Jira groups: unreleased versions oldest first, then the released node and No version', async () => {
  const { ask, http } = setup();
  const got = await ask('kanban.browse.groups', { scope: 'j', filters: {} });
  assert.equal(got.t, 'kanban.browseGroups');
  assert.deepEqual(got.groups.map((g: any) => [g.id, g.title, g.kind]), [['7', '1.0', 'version'], ['8', '2.0', 'version'], ['released', 'Released versions', 'released'], ['none', 'No version', 'none']]);
  assert.match(http.calls.find((c) => c.url.includes('/version'))!.url, /\/project\/UYT\/version\?startAt=0&maxResults=50&orderBy=releaseDate&status=unreleased/);
  const rel = await ask('kanban.browse.groups', { scope: 'j', filters: {}, released: true });
  assert.deepEqual(rel.groups.map((g: any) => [g.id, g.released]), [['5', true]]);
});

test('Jira page: the JQL stays inside the scope, the cursor round-trips, and issues carry the tree fields', async () => {
  const { ask, http } = setup();
  const first = await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' }, group: '7' });
  assert.equal(first.t, 'kanban.browsePage');
  assert.equal(first.next, 'tok2');
  assert.deepEqual(first.items.map((i: any) => i.key), ['UYT-1', 'UYT-2']);
  assert.deepEqual(first.items[0].sprints, [{ id: '3', name: 'Sprint 3', state: 'active' }]);
  const search = http.calls.find((c) => c.url.endsWith('/search/jql'))!;
  assert.equal(search.body.jql, 'project IN ("UYT") AND issuetype not in subTaskIssueTypes() AND fixVersion = 7 ORDER BY updated DESC');
  assert.ok(search.body.fields.includes('customfield_10020') && search.body.maxResults === 50);
  const second = await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' }, group: '7', cursor: 'tok2' });
  assert.deepEqual(second.items.map((i: any) => i.key), ['UYT-3']);
  assert.equal(second.next, undefined);
  assert.equal(http.calls.filter((c) => c.url.endsWith('/search/jql')).at(-1)!.body.nextPageToken, 'tok2');
  const bad = await ask('kanban.browse.page', { scope: 'j', filters: { jql: 'x) OR (project = B' } });
  assert.match(bad.message, /complete expression/);
  assert.match((await ask('kanban.browse.page', { scope: 'j', filters: {}, group: 'released' })).message, /version must be an id/);
});

test('Jira page: an issue of another project is dropped, and one issue of another project is refused', async () => {
  const { ask } = setup({
    http: jiraSite((c) => {
      if (c.url.endsWith('/search/jql')) return { body: { issues: [raw('UYT-1'), raw('OTHER-9', { project: { key: 'OTHER' } }), raw('UYT-2', { project: { key: 'OTHER' } })], isLast: true } };
      if (c.url.includes('/issue/UYT-7')) return { body: raw('UYT-7', { project: { key: 'OTHER' } }) };
      return undefined;
    }),
  });
  assert.deepEqual((await ask('kanban.browse.page', { scope: 'j', filters: {} })).items.map((i: any) => i.key), ['UYT-1']);
  assert.match((await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-7' })).message, /among the source's projects/);
});

test('Jira text search: a 400 becomes a friendly line, a 429 too', async () => {
  const { ask } = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? { status: c.body.jql.includes('text ~') ? 400 : 429, body: { errorMessages: ['bad'] } } : undefined)) });
  assert.match((await ask('kanban.browse.page', { scope: 'j', filters: { q: 'a[b' } })).message, /couldn’t search for that text/);
  assert.match((await ask('kanban.browse.page', { scope: 'j', filters: {} })).message, /rate-limiting the office/);
});

test('Jira count: asked lazily, cached for a minute, and a failed count answers without one', async () => {
  const { ask, http } = setup();
  const count = () => http.calls.filter((c) => c.url.endsWith('/approximate-count'));
  assert.equal((await ask('kanban.browse.count', { scope: 'j', filters: {}, group: '7' })).count, 12);
  assert.equal(count()[0].body.jql, 'project IN ("UYT") AND statusCategory != Done AND issuetype not in subTaskIssueTypes() AND fixVersion = 7');
  await ask('kanban.browse.count', { scope: 'j', filters: {}, group: '7' });
  assert.equal(count().length, 1, 'the second came from the cache');
  const failing = setup({ http: jiraSite((c) => (c.url.endsWith('/approximate-count') ? { status: 400 } : undefined)) });
  const got = await failing.ask('kanban.browse.count', { scope: 'j', filters: {}, group: '7' });
  assert.equal(got.t, 'kanban.browseCount');
  assert.equal(got.count, undefined);
});

test('Jira count: raw JQL gets no count and asks Jira nothing', async () => {
  const { ask, http } = setup();
  const got = await ask('kanban.browse.count', { scope: 'j', filters: { jql: 'summary ~ "x"' }, group: '7' });
  assert.equal(got.t, 'kanban.browseCount');
  assert.equal(got.count, undefined);
  assert.equal(http.calls.filter((c) => c.url.endsWith('/approximate-count')).length, 0);
});

test('Jira children: the sub-tasks of a key, all statuses, inside the scope', async () => {
  const { ask, http } = setup();
  const got = await ask('kanban.browse.children', { scope: 'j', issueKey: 'UYT-1' });
  assert.equal(got.issueKey, 'UYT-1');
  assert.equal(http.calls.find((c) => c.url.endsWith('/search/jql'))!.body.jql, 'project IN ("UYT") AND parent = "UYT-1" ORDER BY updated DESC');
  assert.match((await ask('kanban.browse.children', { scope: 'j', issueKey: 'nokey' })).message, /isn’t a Jira issue key/);
});

test('Jira options: statuses with categories, types, versions and open epics', async () => {
  const { ask } = setup({
    http: jiraSite((c) => {
      if (c.url.endsWith('/project/UYT/statuses')) return { body: [{ name: 'Story', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }] }, { name: 'Bug', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }] }] };
      if (c.url.endsWith('/search/jql')) return { body: { issues: [{ key: 'UYT-5', fields: { summary: 'Big epic' } }] } };
      return undefined;
    }),
  });
  const { options } = await ask('kanban.browse.options', { scope: 'j' });
  assert.deepEqual(options.statuses, [{ name: 'To Do', category: 'new' }, { name: 'Done', category: 'done' }]);
  assert.deepEqual(options.issueTypes, ['Bug', 'Story']);
  assert.deepEqual(options.versions.map((v: any) => v.id), ['7', '8']);
  assert.deepEqual(options.epics, [{ key: 'UYT-5', title: 'Big epic' }]);
});

test('the issue handler: the full record with its task; a browsed key then takes the actions and a task', async () => {
  const { ask, ctx, http } = setup();
  const got = await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-77' });
  assert.equal(got.t, 'kanban.browseIssue');
  assert.equal(got.issue.body, 'Body here');
  assert.equal(got.issue.taskId, undefined);
  assert.match((await ask('kanban.browse.issue', { scope: 'j', issueKey: 'OTHER-1' })).message, /isn't in this source's projects/);
  assert.match((await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-1/../x' })).message, /isn’t a Jira issue key/);
  // Not on the list, but browsed: the actions know it.
  http.calls.length = 0;
  const tr = await ask('kanban.issue.transitions', { issueKey: 'UYT-77' });
  assert.equal(tr.t, 'kanban.issueTransitions');
  assert.ok(http.calls.some((c) => c.url.includes('/issue/UYT-77/transitions')));
  const made = await ask('kanban.issues.createTask', { issueKey: 'UYT-77' });
  assert.equal(made.t, 'kanban.ok');
  assert.equal(ctx.repo.findTaskByTicket('app', 'UYT-77')!.id, made.taskId);
  assert.equal((await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-77' })).issue.taskId, made.taskId);
});

test('a change made through an action also lands on the browsed copy', async () => {
  const http = jiraSite((c) => (c.url.includes('/issue/UYT-77/transitions') ? (c.method === 'GET' ? { body: { transitions: [{ id: '21', name: 'Go', to: { name: 'Doing' } }] } } : { status: 204 }) : undefined));
  const { ask, issues } = setup({ http });
  await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-77' });
  const moved = await ask('kanban.issue.transition', { issueKey: 'UYT-77', transitionId: '21' });
  assert.equal(moved.t, 'kanban.ok', moved.message);
  assert.equal(issues.state('app').items.length, 0, 'it is not on the list');
  // The browsed copy shows the new status to the next action on it (no fetch of the issue itself).
  const before = http.calls.length;
  assert.equal((await ask('kanban.issue.comments', { issueKey: 'UYT-77' })).t, 'kanban.issueComments');
  assert.ok(!http.calls.slice(before).some((c) => c.url.includes('/issue/UYT-77?fields=')), 'found in the browsed cache');
});

test('once the browsed cache has dropped a key, load fetches it again inside the scope; a key outside it is still refused', async () => {
  const { ask, issues, http } = setup();
  // Never browsed: the actions load it fresh (a Jira key of the source's project).
  http.calls.length = 0;
  const tr = await ask('kanban.issue.comments', { issueKey: 'UYT-5' });
  assert.equal(tr.t, 'kanban.issueComments');
  assert.ok(http.calls.some((c) => c.url.includes('/issue/UYT-5?fields=')), 'fetched by key');
  // Browsed, then the sources are saved: the browsed copies are let go, and the key loads again.
  await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-6' });
  issues.plugin.start?.();
  wallSourcesChanged('app');
  issues.plugin.stop?.();
  await issues.refresh('app');
  http.calls.length = 0;
  assert.equal((await ask('kanban.issue.comments', { issueKey: 'UYT-6' })).t, 'kanban.issueComments');
  assert.ok(http.calls.some((c) => c.url.includes('/issue/UYT-6?fields=')), 'fetched again');
  http.calls.length = 0;
  assert.match((await ask('kanban.issue.comments', { issueKey: 'ZZ-1' })).message, /isn't among the project's issues/);
  assert.match((await ask('kanban.issues.createTask', { issueKey: 'QQ-9' })).message, /isn't among the project's issues/);
  assert.ok(!http.calls.some((c) => c.url.includes('/issue/ZZ-1') || c.url.includes('/issue/QQ-9')), 'nothing was fetched outside the scope');
  assert.match((await ask('kanban.issue.comments', { issueKey: 'gh:evil/repo#1' })).message, /isn't among the project's issues/);
});

test('Jira people come from the scope’s projects', async () => {
  const { ask, http } = setup({ http: jiraSite((c) => (c.url.includes('multiProjectSearch') ? { body: [{ accountId: '71:a', displayName: 'Maija' }, { accountId: 'b', accountType: 'app' }] } : undefined)) });
  const got = await ask('kanban.browse.people', { scope: 'j', query: 'ma' });
  assert.equal(got.t, 'kanban.issuePeople');
  assert.deepEqual(got.items, [{ id: '71:a', name: 'Maija' }]);
  assert.match(http.calls.at(-1)!.url, /multiProjectSearch\?projectKeys=UYT&query=ma&maxResults=20/);
});

// --- GitHub ---------------------------------------------------------------------------------------

test('GitHub page: the query variable is sent, the cursor goes both ways, items carry sub-issue counts', async () => {
  const gh = ghStub(() => boardAnswer([ITEM(1), ITEM(2, { parent: { number: 1, title: 'P', repository: { nameWithOwner: 'o/r' } } })]));
  const { ask } = setup({ gh });
  const got = await ask('kanban.browse.page', { scope: 'p', filters: { status: 'In review', assignee: { id: 'maija' } }, group: 'i:Sprint 3', cursor: 'PREV' });
  assert.equal(q(gh.calls[0]).includes('items(first: $first, after: $after, query: $q)'), true);
  assert.equal(arg(gh.calls[0], 'q'), 'is:open status:"In review" assignee:maija iteration:"Sprint 3"');
  assert.equal(arg(gh.calls[0], 'after'), 'PREV');
  assert.equal(arg(gh.calls[0], 'first'), '50');
  assert.deepEqual([got.next, got.total], ['CUR1', 7]);
  assert.deepEqual([got.items[0].key, got.items[0].issueType, got.items[0].childCount, got.items[0].childDone, got.items[0].nodeId], ['gh:o/r#1', 'Bug', 2, 1, 'I_1']);
  assert.deepEqual(got.items[1].parent, { key: 'gh:o/r#1', title: 'P' });
});

test('GitHub count asks for one item and reads totalCount; a missing scope says what to run', async () => {
  const gh = ghStub(() => boardAnswer([ITEM(1)]));
  const { ask } = setup({ gh });
  assert.equal((await ask('kanban.browse.count', { scope: 'p', filters: {}, group: 's:Doing' })).count, 7);
  assert.equal(arg(gh.calls[0], 'first'), '1');
  const denied = setup({ gh: ghStub(() => new Error('Your token has not been granted the required scopes: read:project')) });
  assert.equal((await denied.ask('kanban.browse.page', { scope: 'p', filters: {} })).message, PROJECT_SCOPE_ERROR);
});

test('GitHub groups: iterations (current first, completed under a node) or Status options', async () => {
  const iter = (title: string, startDate: string) => ({ id: title, title, startDate, duration: 14 });
  const answer = (fields: unknown[]) => JSON.stringify({ data: { repositoryOwner: { projectV2: { fields: { nodes: fields } } } } });
  const withIter = setup({ gh: ghStub(() => answer([{ __typename: 'ProjectV2IterationField', name: 'Iteration', configuration: { iterations: [iter('S2', '2026-10-01'), iter('S1', '2026-09-01')], completedIterations: [iter('S0', '2026-08-01')] } }])) });
  assert.deepEqual((await withIter.ask('kanban.browse.groups', { scope: 'p', filters: {} })).groups.map((g: any) => g.id), ['i:S1', 'i:S2', 'completed', 'no:iteration']);
  assert.deepEqual((await withIter.ask('kanban.browse.groups', { scope: 'p', filters: {}, released: true })).groups.map((g: any) => g.id), ['i:S0']);
  const byStatus = setup({ gh: ghStub(() => answer([{ __typename: 'ProjectV2SingleSelectField', name: 'Status', options: [{ name: 'Todo' }, { name: 'Doing' }] }])) });
  assert.deepEqual((await byStatus.ask('kanban.browse.groups', { scope: 'p', filters: {} })).groups.map((g: any) => g.id), ['s:Todo', 's:Doing', 'no:status']);
});

test('GitHub children: only the sub-issues of an issue that is on the board', async () => {
  const sub = (n: number) => ({ id: `I_${n}`, number: n, title: `Sub ${n}`, url: `https://github.com/o/r/issues/${n}`, state: n === 2 ? 'CLOSED' : 'OPEN', updatedAt: 'u', repository: { nameWithOwner: 'o/r' }, assignees: { nodes: [] }, labels: { nodes: [] }, projectItems: { nodes: [{ id: `PVTI_${n}`, project: { owner: { login: 'o' }, number: 1 }, status: { name: 'Done' } }] } });
  const onBoard = { project: { owner: { login: 'o' }, number: 1 } };
  const answer = (items: unknown[]) => JSON.stringify({ data: { node: { projectItems: { nodes: items }, subIssues: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes: [sub(1), sub(2)] } } } });
  const ok = setup({ gh: ghStub(() => answer([onBoard])) });
  const got = await ok.ask('kanban.browse.children', { scope: 'p', issueKey: 'gh:o/r#9', nodeId: 'I_9' });
  assert.deepEqual(got.items.map((i: any) => [i.key, i.status, i.statusCategory]), [['gh:o/r#1', 'Done', undefined], ['gh:o/r#2', 'Done', 'done']]);
  const off = setup({ gh: ghStub(() => answer([{ project: { owner: { login: 'other' }, number: 1 } }])) });
  assert.match((await off.ask('kanban.browse.children', { scope: 'p', issueKey: 'gh:o/r#9', nodeId: 'I_9' })).message, /isn't on the board/);
  assert.match((await ok.ask('kanban.browse.children', { scope: 'p', issueKey: 'gh:o/r#9' })).message, /node id/);
});

test('GitHub issue: its body and Status come from the board item; an issue off the board is refused', async () => {
  const found = (boards: unknown[]) => JSON.stringify({ data: { repository: { issueOrPullRequest: { __typename: 'Issue', ...ITEM(5).content, body: 'Hello', projectItems: { nodes: boards } } } } });
  const board = { id: 'PVTI_5', project: { owner: { login: 'o' }, number: 1 }, status: { name: 'In review' } };
  const { ask } = setup({ gh: ghStub(() => found([board])) });
  const got = await ask('kanban.browse.issue', { scope: 'p', issueKey: 'gh:o/r#5' });
  assert.deepEqual([got.issue.body, got.issue.status, got.issue.nodeId], ['Hello', 'In review', 'I_5']);
  const off = setup({ gh: ghStub(() => found([{ ...board, project: { owner: { login: 'o' }, number: 2 } }])) });
  assert.match((await off.ask('kanban.browse.issue', { scope: 'p', issueKey: 'gh:o/r#5' })).message, /isn't on the board o\/1/);
  assert.match((await ask('kanban.browse.issue', { scope: 'p', issueKey: 'ghp:evil/9#PVTI_1' })).message, /isn't an issue of the board/);
});

test('load: a gh: key of the project’s repository is fetched with gh issue view, one of another repository is not', async () => {
  const view = ghStub((a) => (a[0] === 'issue' && a[1] === 'view' ? JSON.stringify({ number: 8, title: 'Eight', url: 'https://github.com/o/r/issues/8', body: '', state: 'OPEN', assignees: [], labels: [], updatedAt: 'u' }) : '{"data":{}}'));
  const { ask } = setup({ gh: view, sources: [REPO] });
  assert.equal((await ask('kanban.issue.comments', { issueKey: 'gh:o/r#8' })).t, 'kanban.issueComments');
  assert.ok(view.calls.some((a) => a[0] === 'issue' && a[1] === 'view' && a.includes('o/r')));
  view.calls.length = 0;
  assert.match((await ask('kanban.issue.comments', { issueKey: 'gh:evil/x#8' })).message, /isn't among the project's issues/);
  assert.ok(!view.calls.some((a) => a.includes('evil/x')));
});

test('server messages the browse window gets are in the protocol’s union', () => {
  const m: KanbanServerMsg = { t: 'kanban.browseCount', project: 'app', scope: 'j' };
  assert.equal(m.t, 'kanban.browseCount');
});
