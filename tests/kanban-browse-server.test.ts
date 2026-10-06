import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { wallIssues, wallSourcesChanged } from '../src/server/kanban/integrations/issues/wall.js';
import { PROJECT_SCOPE_ERROR } from '../src/server/kanban/integrations/issues/github-project.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { groupByEpic } from '../src/shared/kanban/browsetree.js';
import { Floor } from '../src/server/floor.js';
import { presenceHandlers } from '../src/server/ws/handlers/presence.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

const SITE = 'team.atlassian.net';
const JIRA_TOKEN = [{ id: 'jira', name: SITE, site: SITE, email: 'me@x.fi', token: 'tok' }];
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
  (ctx as unknown as { secrets: unknown }).secrets = { jiraConnections: () => JIRA_TOKEN };
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
  assert.match(await err('jo'), /No Jira connection for other.atlassian.net/);
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

// --- Pages of stories, and the sub-tasks that match under them -------------------------------------

const EPIC_UP = { key: 'UYT-1', fields: { summary: 'Epic A', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
const STORY_UP = { key: 'UYT-10', fields: { summary: 'Story', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Story', hierarchyLevel: 0 } } };
const SUBTASK = raw('UYT-11', { issuetype: { name: 'Sub-task', hierarchyLevel: -1, subtask: true }, parent: STORY_UP });
const STORY = raw('UYT-10', { parent: EPIC_UP, fixVersions: [{ id: '7', name: '1.0' }], subtasks: [{ key: 'UYT-11', fields: { status: { statusCategory: { key: 'new' } } } }] });
/**
 * A site whose searches answer by what they ask: the sub-tasks of some parents, the stories of a page,
 * which of some keys match, and which sub-tasks match anywhere (their parents are what is wanted).
 * `matching`: the keys the "which match" search finds.
 */
const subtaskSite = (matching: string[] = [], stories: unknown[] = [STORY]) =>
  jiraSite((c) => {
    if (!c.url.endsWith('/search/jql')) return undefined;
    const jql: string = c.body.jql;
    if (jql.includes('parent in (')) return { body: { issues: [SUBTASK], isLast: true } };
    if (jql.includes('not in subTaskIssueTypes')) return { body: { issues: stories, nextPageToken: 'more', isLast: false } };
    if (jql.includes('key in (')) return { body: { issues: matching.map((k) => ({ key: k, fields: {} })), isLast: true } };
    return { body: { issues: [{ key: 'UYT-11', fields: { parent: { key: 'UYT-10' } } }], isLast: true } };
  });
const searches = (http: ReturnType<typeof fetchStub>) => http.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => c.body.jql as string);

test('Jira page: a group’s stories are paged strictly, then one search brings the matching sub-tasks of that page’s stories only', async () => {
  const { ask, http } = setup({ http: subtaskSite() });
  const got = await ask('kanban.browse.page', { scope: 'j', filters: {}, group: '7', epic: 'UYT-1' });
  const [stories, subs] = searches(http);
  assert.equal(searches(http).length, 2, 'the default (Not done) is two searches: no look at unrelated sub-tasks');
  assert.equal(stories, 'project IN ("UYT") AND statusCategory != Done AND issuetype not in subTaskIssueTypes() AND fixVersion = 7 AND parent = "UYT-1" ORDER BY updated DESC');
  assert.equal(subs, 'project IN ("UYT") AND statusCategory != Done AND issuetype in subTaskIssueTypes() AND parent in ("UYT-10") ORDER BY updated DESC');
  assert.deepEqual(got.items.map((i: any) => [i.key, i.context]), [['UYT-10', undefined], ['UYT-11', undefined]], 'a sub-task follows its story');
  assert.equal(got.next, 'more', 'the stories decide the next page');
  assert.deepEqual(groupByEpic(got.items).map((n) => [n.id, n.nodes[0].children.map((c) => c.issue.key)]), [['epic:UYT-1', ['UYT-11']]]);
});

test('Jira page: a page never loses its stories to sub-tasks: only the stories’ own clause pages, and a page with none has no sub-task search', async () => {
  const { ask, http } = setup({ http: subtaskSite([], []) });
  const got = await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' }, group: 'none' });
  assert.deepEqual(got.items, []);
  assert.equal(searches(http).length, 1);
  assert.equal(searches(http)[0], 'project IN ("UYT") AND issuetype not in subTaskIssueTypes() AND fixVersion is EMPTY ORDER BY updated DESC');
});

test('Jira page: a search narrowed beyond the status category lists a story that has a matching sub-task, flagged context, nested under its epic', async () => {
  const { ask, http } = setup({ http: subtaskSite() });
  const got = await ask('kanban.browse.page', { scope: 'j', filters: { issueType: 'Sub-task' } });
  const [lookup, stories, matched, subs] = searches(http);
  assert.equal(lookup, 'project IN ("UYT") AND statusCategory != Done AND issuetype = "Sub-task" AND issuetype in subTaskIssueTypes() ORDER BY updated DESC', 'the matching sub-tasks of the scope say whose parents to list');
  assert.equal(http.calls.filter((c) => c.body?.jql === lookup)[0].body.maxResults, 100);
  assert.ok(stories.includes('((statusCategory != Done AND issuetype = "Sub-task") OR key in ("UYT-10")) AND issuetype not in subTaskIssueTypes()'));
  assert.equal(matched, 'project IN ("UYT") AND statusCategory != Done AND issuetype = "Sub-task" AND key in ("UYT-10") ORDER BY updated DESC');
  assert.ok(subs.includes('parent in ("UYT-10")') && !subs.includes('fixVersion'));
  assert.deepEqual(got.items.map((i: any) => [i.key, i.context]), [['UYT-10', true], ['UYT-11', undefined]]);
  const tree = groupByEpic(got.items);
  assert.deepEqual(tree.map((n) => [n.id, n.items.map((i) => i.key), n.nodes[0].children.map((c) => c.issue.key), n.done, n.total]), [['epic:UYT-1', ['UYT-10'], ['UYT-11'], 0, 0]]);
  // A story that matches itself is not context.
  const own = setup({ http: subtaskSite(['UYT-10']) });
  assert.deepEqual((await own.ask('kanban.browse.page', { scope: 'j', filters: { issueType: 'Sub-task' } })).items.map((i: any) => [i.key, i.context]), [['UYT-10', undefined], ['UYT-11', undefined]]);
});

test('Jira page: searching a sub-task’s key finds it through its story; a group never relaxes', async () => {
  const { ask, http } = setup({ http: subtaskSite() });
  const got = await ask('kanban.browse.page', { scope: 'j', filters: { q: 'UYT-11' }, group: '7' });
  assert.match(searches(http)[0], /key = "UYT-11"/);
  assert.deepEqual(got.items.map((i: any) => i.key), ['UYT-10', 'UYT-11']);
  assert.ok(searches(http).every((j) => !/fixVersion = 7 OR \(/.test(j)) && searches(http)[1].includes('AND fixVersion = 7'));
});

test('Jira page: a status category alone leaves the stories to decide (no sub-task lookup), "all" brings every sub-task of the page', async () => {
  const { ask, http } = setup({ http: subtaskSite() });
  await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'done' } });
  assert.equal(searches(http).length, 2);
  assert.ok(searches(http)[0].includes('statusCategory = Done AND issuetype not in subTaskIssueTypes()') && searches(http)[1].includes('statusCategory = Done AND issuetype in subTaskIssueTypes() AND parent in'));
  http.calls.length = 0;
  await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' } });
  assert.equal(searches(http)[1], 'project IN ("UYT") AND issuetype in subTaskIssueTypes() AND parent in ("UYT-10") ORDER BY updated DESC');
});

test('Jira page: "No epic" does not list the epics, and a site with no Epic type still answers (the clause is retried without)', async () => {
  const EPIC = raw('UYT-1', { issuetype: { name: 'Epic', hierarchyLevel: 1 } });
  const { ask, http } = setup({ http: subtaskSite([], [EPIC, raw('UYT-2')]) });
  const got = await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' }, epic: 'none' });
  assert.ok(searches(http)[0].includes('issuetype != Epic AND parent is EMPTY'));
  assert.deepEqual(got.items.map((i: any) => i.key), ['UYT-2'], 'an epic that gets through (a renamed type) is dropped by its level');
  const noEpic = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? (c.body.jql.includes('!= Epic') ? { status: 400, body: { errorMessages: ['no Epic'] } } : { body: { issues: [raw('UYT-2')], isLast: true } }) : undefined)) });
  assert.deepEqual((await noEpic.ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' }, epic: 'none' })).items.map((i: any) => i.key), ['UYT-2']);
  assert.equal(searches(noEpic.http).length, 3, 'the 400, the retry (stories), the sub-tasks');
});

test('Jira text search: a key-like text of another project (UTF-8) has no key clause; one of the scope’s that Jira refuses is retried without it', async () => {
  const { ask, http } = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? { body: { issues: [], isLast: true } } : undefined)) });
  await ask('kanban.browse.page', { scope: 'j', filters: { q: 'UTF-8' } });
  await ask('kanban.browse.page', { scope: 'j', filters: { q: 'ZZ-1' } });
  assert.ok(searches(http).every((j) => !j.includes('key =')));
  const refusing = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? (c.body.jql.includes('key = "UYT-9"') ? { status: 400, body: {} } : { body: { issues: [raw('UYT-3')], isLast: true } }) : undefined)) });
  const got = await refusing.ask('kanban.browse.page', { scope: 'j', filters: { q: 'UYT-9' } });
  assert.deepEqual(got.items.map((i: any) => i.key), ['UYT-3']);
  assert.ok(searches(refusing.http).some((j) => j.includes('key = "UYT-9"')) && searches(refusing.http).some((j) => j.includes('text ~ "UYT-9"') && !j.includes('key =')));
});

test('Jira text search: a 400 becomes a friendly line, a 429 too', async () => {
  const { ask } = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? { status: c.body.jql.includes('text ~') ? 400 : 429, body: { errorMessages: ['bad'] } } : undefined)) });
  assert.match((await ask('kanban.browse.page', { scope: 'j', filters: { q: 'a[b' } })).message, /couldn’t search for that text/);
  assert.match((await ask('kanban.browse.page', { scope: 'j', filters: {} })).message, /rate-limiting the office/);
});

test('Jira page: the Sprint field id is asked again after a failure, and a failure is never kept', async () => {
  let fieldCalls = 0;
  const { ask, http } = setup({
    http: jiraSite((c) => {
      if (c.url.endsWith('/rest/api/3/field')) return ++fieldCalls === 1 ? { status: 500, body: {} } : undefined;
      return undefined;
    }),
  });
  await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' } });
  assert.ok(!http.calls.find((c) => c.url.endsWith('/search/jql'))!.body.fields.includes('customfield_10020'));
  await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' } });
  assert.ok(http.calls.filter((c) => c.url.endsWith('/search/jql')).at(-1)!.body.fields.includes('customfield_10020'), 'asked again, and found');
  await ask('kanban.browse.page', { scope: 'j', filters: { statusCategory: 'all' } });
  assert.equal(fieldCalls, 2, 'a found one stays');
});

test('Jira count: asked lazily, cached for a minute, and a failed count answers without one', async () => {
  const { ask, http } = setup();
  const count = () => http.calls.filter((c) => c.url.endsWith('/approximate-count'));
  assert.equal((await ask('kanban.browse.count', { scope: 'j', filters: { statusCategory: 'all' }, group: '7' })).count, 12);
  assert.equal(count()[0].body.jql, 'project IN ("UYT") AND issuetype not in subTaskIssueTypes() AND fixVersion = 7');
  await ask('kanban.browse.count', { scope: 'j', filters: { statusCategory: 'all' }, group: '7' });
  assert.equal(count().length, 1, 'the second came from the cache');
  const failing = setup({ http: jiraSite((c) => (c.url.endsWith('/approximate-count') ? { status: 400 } : undefined)) });
  const got = await failing.ask('kanban.browse.count', { scope: 'j', filters: { statusCategory: 'all' }, group: '7' });
  assert.equal(got.t, 'kanban.browseCount');
  assert.equal(got.count, undefined);
});

test('Jira count: a narrowed search in a version or epic group has no count (inherited grouping can’t be counted), a plain one does', async () => {
  const { ask, http } = setup();
  const count = () => http.calls.filter((c) => c.url.endsWith('/approximate-count'));
  for (const where of [{ group: '7' }, { group: 'none' }, { epic: 'UYT-1', group: '7' }, { epic: 'none', group: '7' }]) {
    const got = await ask('kanban.browse.count', { scope: 'j', filters: { statusCategory: 'all', q: 'x' }, ...where });
    assert.equal(got.t, 'kanban.browseCount');
    assert.equal(got.count, undefined);
  }
  assert.equal(count().length, 0);
  assert.equal((await ask('kanban.browse.count', { scope: 'j', filters: { statusCategory: 'all' }, group: '7' })).count, 12);
  assert.equal(count().length, 1);
});

test('Jira count: a search narrowed by the status category alone counts the top-level issues that match, sub-tasks left out', async () => {
  const { ask, http } = setup();
  const count = () => http.calls.filter((c) => c.url.endsWith('/approximate-count'));
  assert.equal((await ask('kanban.browse.count', { scope: 'j', filters: { statusCategory: 'done' }, group: '7' })).count, 12);
  assert.equal(count()[0].body.jql, 'project IN ("UYT") AND statusCategory = Done AND issuetype not in subTaskIssueTypes() AND fixVersion = 7');
  // The default ("Not done") too, and in an epic node.
  assert.equal((await ask('kanban.browse.count', { scope: 'j', filters: {}, group: '7', epic: 'UYT-1' })).count, 12);
  assert.match(count()[1].body.jql, /statusCategory != Done AND issuetype not in subTaskIssueTypes\(\) AND fixVersion = 7 AND parent = "UYT-1"$/);
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

test('tasks: items of a page and the epics they sit under carry the task made from them', async () => {
  const epicUp = { key: 'UYT-1', fields: { summary: 'Epic A', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
  const { ask, ctx } = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? { body: { issues: [raw('UYT-1'), raw('UYT-2', { parent: epicUp })], isLast: true } } : undefined)) });
  assert.equal((await ask('kanban.browse.page', { scope: 'j', filters: {} })).items[1].parent.taskId, undefined);
  const mine = (key: string) => (ctx.repo.findTaskByTicket('app', key) ?? undefined)?.id;
  await ask('kanban.issues.createTask', { issueKey: 'UYT-1' });
  await ask('kanban.issues.createTask', { issueKey: 'UYT-2' });
  const got = await ask('kanban.browse.page', { scope: 'j', filters: {} });
  assert.deepEqual([got.items[0].taskId, got.items[1].taskId, got.items[1].parent.taskId], [mine('UYT-1'), mine('UYT-2'), mine('UYT-1')]);
  assert.ok(mine('UYT-1') !== undefined);
  const kids = await ask('kanban.browse.children', { scope: 'j', issueKey: 'UYT-1' });
  assert.equal(kids.items[1].taskId, mine('UYT-2'));
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

test('Jira options: a site with no Epic type (the epic search is a 400) still gives the other choices, with no epics', async () => {
  const { ask } = setup({ http: jiraSite((c) => (c.url.endsWith('/search/jql') ? { status: 400, body: { errorMessages: ['The value Epic does not exist'] } } : c.url.endsWith('/project/UYT/statuses') ? { body: [{ name: 'Task', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }] }] } : undefined)) });
  const got = await ask('kanban.browse.options', { scope: 'j' });
  assert.equal(got.t, 'kanban.browseOptions', got.message);
  assert.deepEqual([got.options.epics, got.options.issueTypes], [[], ['Task']]);
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

test('load: a key that isn’t found is not asked for again for a minute (Jira), and a gh key is read once for all the boards, not once per board', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { ask, http } = setup({ http: jiraSite((c) => (c.url.includes('/issue/UYT-5?') ? { status: 404, body: {} } : undefined)) });
  const fetched = () => http.calls.filter((c) => c.url.includes('/issue/UYT-5?')).length;
  assert.match((await ask('kanban.issue.comments', { issueKey: 'UYT-5' })).message, /isn't among the project's issues/);
  assert.match((await ask('kanban.issue.comments', { issueKey: 'UYT-5' })).message, /isn't among the project's issues/);
  assert.equal(fetched(), 1);
  t.mock.timers.tick(61_000);
  await ask('kanban.issue.comments', { issueKey: 'UYT-5' });
  assert.equal(fetched(), 2, 'asked again after a minute');

  const BOARD2: IssueSourceConfig = { id: 'p2', kind: 'github-project', owner: 'o', number: 2, filters: {} };
  const off = { id: 'I_5', ...ITEM(5).content, projectItems: { nodes: [] } };
  const gh = ghStub((a) => {
    if (q(a).includes('issueOrPullRequest')) return JSON.stringify({ data: { repository: { issueOrPullRequest: { __typename: 'Issue', ...off } } } });
    if (a[0] === 'issue') return new Error('not found');
    return JSON.stringify({ data: { node: { parent: { projectItems: { nodes: [] } } } } });
  });
  const two = setup({ gh, sources: [BOARD, BOARD2] });
  assert.match((await two.ask('kanban.issue.comments', { issueKey: 'gh:o/r#5' })).message, /isn't among the project's issues/);
  assert.equal(gh.calls.filter((a) => q(a).includes('issueOrPullRequest')).length, 1, 'the issue is read once for two boards');
  assert.equal(gh.calls.filter((a) => q(a).includes('parent {') && !q(a).includes('issueOrPullRequest')).length, 1, 'and so is its parent chain');
  const before = gh.calls.length;
  await two.ask('kanban.issue.comments', { issueKey: 'gh:o/r#5' });
  assert.equal(gh.calls.length, before, 'a miss is remembered');
  // On the second board: found with one read.
  const onSecond = ghStub((a) => (q(a).includes('issueOrPullRequest') ? JSON.stringify({ data: { repository: { issueOrPullRequest: { __typename: 'Issue', ...off, projectItems: { nodes: [{ id: 'PVTI_5', project: { owner: { login: 'o' }, number: 2 }, status: { name: 'Doing' } }] } } } } }) : '[]'));
  const found = setup({ gh: onSecond, sources: [BOARD, BOARD2] });
  assert.equal((await found.ask('kanban.issue.comments', { issueKey: 'gh:o/r#5' })).t, 'kanban.issueComments');
});

test('scopes: a failed GitHub login is asked again at once, a found one is kept for ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let answer: string | Error = new Error('gh is not signed in');
  const gh = ghStub((a) => (a[0] === 'api' && a[1] === 'user' ? answer : '[]'));
  const { ask } = setup({ gh, ghAs: () => ({ env: { GH_CONFIG_DIR: '/h/m' } }) });
  const logins = () => gh.calls.filter((a) => a[0] === 'api' && a[1] === 'user').length;
  assert.equal((await ask('kanban.browse.scopes', {})).me, undefined);
  answer = 'maija\n';
  assert.deepEqual((await ask('kanban.browse.scopes', {})).me, { github: 'maija' }, 'the failure was not kept');
  await ask('kanban.browse.scopes', {});
  assert.equal(logins(), 2);
  t.mock.timers.tick(11 * 60_000);
  answer = 'maija2\n';
  assert.deepEqual((await ask('kanban.browse.scopes', {})).me, { github: 'maija2' }, 'asked again after the time to live');
  assert.equal(logins(), 3);
});

test('Jira people come from the scope’s projects', async () => {
  const { ask, http } = setup({ http: jiraSite((c) => (c.url.includes('multiProjectSearch') ? { body: [{ accountId: '71:a', displayName: 'Maija' }, { accountId: 'b', accountType: 'app' }] } : undefined)) });
  const got = await ask('kanban.browse.people', { scope: 'j', query: 'ma' });
  assert.equal(got.t, 'kanban.issuePeople');
  assert.deepEqual(got.items, [{ id: '71:a', name: 'Maija' }]);
  assert.match(http.calls.at(-1)!.url, /multiProjectSearch\?projectKeys=UYT&query=ma&maxResults=20/);
});

test('a GitHub board’s people in a project that mixes hosts come from its GitHub repository, not an Azure DevOps primary', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repos: [
    { id: 'app', name: 'api', kind: 'git', dir: '/tmp/app', remote: 'azure:contoso/Web/api', primary: true },
    { id: 'web', name: 'web', kind: 'git', dir: '/tmp/web', remote: 'o/r', primary: false },
  ] })]);
  ctx.settings.setProject('app', { issueSources: [BOARD] });
  const gh = ghStub(() => JSON.stringify({ data: { repository: { assignableUsers: { nodes: [{ login: 'maija', name: 'Maija' }] } } } }));
  const issues = createIssues(ctx, { gh: gh.gh as never, fetch: jiraSite().fetch });
  const c = client(true, 'acc1');
  await (issues.plugin.ws as any)['kanban.browse.people'](c, { t: 'kanban.browse.people', project: 'app', rid: 'r1', scope: 'p', query: 'ma' });
  const asked = gh.calls.at(-1)!;
  assert.equal(arg(asked, 'owner'), 'o');
  assert.equal(arg(asked, 'name'), 'r');
  assert.ok(!gh.calls.some((a) => a.some((x) => x.includes('azure:'))), 'gh never hears of the Azure DevOps repository');
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

test('GitHub count asks for the count alone (no items are read), caches it for a minute; a missing scope says what to run', async () => {
  const gh = ghStub(() => boardAnswer([]));
  const { ask } = setup({ gh });
  assert.equal((await ask('kanban.browse.count', { scope: 'p', filters: {}, group: 's:Doing' })).count, 7);
  assert.ok(q(gh.calls[0]).includes('items(query: $q) { totalCount }') && !q(gh.calls[0]).includes('nodes'), 'a count-only query');
  assert.equal(arg(gh.calls[0], 'q'), 'is:open status:"Doing"');
  assert.equal(arg(gh.calls[0], 'first'), undefined);
  assert.equal((await ask('kanban.browse.count', { scope: 'p', filters: {}, group: 's:Doing' })).count, 7);
  assert.equal(gh.calls.length, 1, 'the second came from the cache');
  await ask('kanban.browse.count', { scope: 'p', filters: {}, group: 's:Todo' });
  assert.equal(gh.calls.length, 2, 'another group is another count');
  const denied = setup({ gh: ghStub(() => new Error('Your token has not been granted the required scopes: read:project')) });
  assert.equal((await denied.ask('kanban.browse.page', { scope: 'p', filters: {} })).message, PROJECT_SCOPE_ERROR);
  assert.equal((await denied.ask('kanban.browse.count', { scope: 'p', filters: {} })).message, PROJECT_SCOPE_ERROR);
});

test('the board’s fields and the Jira versions are asked once a minute, not on every groups call; a failure is not kept', async () => {
  let fail = true;
  const gh = ghStub(() => (fail ? new Error('boom') : JSON.stringify({ data: { repositoryOwner: { projectV2: { fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', name: 'Status', options: [{ name: 'Todo' }] }] } } } } })));
  const { ask } = setup({ gh });
  assert.equal((await ask('kanban.browse.groups', { scope: 'p', filters: {} })).t, 'kanban.error');
  fail = false;
  await ask('kanban.browse.groups', { scope: 'p', filters: {} });
  await ask('kanban.browse.groups', { scope: 'p', filters: {} });
  await ask('kanban.browse.options', { scope: 'p' });
  assert.equal(gh.calls.filter((a) => q(a).includes('fields(first')).length, 2, 'one failed, one kept');
  const jira = setup();
  await jira.ask('kanban.browse.groups', { scope: 'j', filters: {} });
  await jira.ask('kanban.browse.groups', { scope: 'j', filters: {} });
  await jira.ask('kanban.browse.options', { scope: 'j' });
  assert.equal(jira.http.calls.filter((c) => c.url.includes('status=unreleased')).length, 1);
  await jira.ask('kanban.browse.groups', { scope: 'j', filters: {}, released: true });
  assert.equal(jira.http.calls.filter((c) => c.url.includes('status=released')).length, 1);
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

test('GitHub groups: a completed iteration named by the filter is its own group', async () => {
  const iter = (title: string, startDate: string) => ({ id: title, title, startDate, duration: 14 });
  const fields = [{ __typename: 'ProjectV2IterationField', name: 'Iteration', configuration: { iterations: [iter('S1', '2026-09-01')], completedIterations: [iter('S0', '2026-08-01')] } }];
  const { ask } = setup({ gh: ghStub(() => JSON.stringify({ data: { repositoryOwner: { projectV2: { fields: { nodes: fields } } } } })) });
  const got = await ask('kanban.browse.groups', { scope: 'p', filters: { iteration: 'S0' } });
  assert.deepEqual(got.groups.map((g: any) => [g.id, g.kind, g.released]), [['i:S0', 'iteration', undefined]]);
  assert.deepEqual((await ask('kanban.browse.groups', { scope: 'p', filters: { iteration: 'S1' } })).groups.map((g: any) => g.id), ['i:S1']);
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

test('GitHub sub-issues that are not board items open and expand when their parents lead to the board; otherwise they are refused', async () => {
  const BOARD_ITEM = { project: { owner: { login: 'o' }, number: 1 } };
  const OTHER = { project: { owner: { login: 'o' }, number: 2 } };
  const sub = (n: number) => ({ __typename: 'Issue', ...ITEM(n).content, body: 'b', projectItems: { nodes: [] } });
  const subIssue = (n: number) => ({ ...ITEM(n).content, projectItems: { nodes: [] } });
  /** `chain`: what the issue's parents are (nearest first), each with the boards it is an item of. */
  const gh = (chain: unknown[][]) => ghStub((a) => {
    const query = q(a);
    if (query.includes('issueOrPullRequest')) return JSON.stringify({ data: { repository: { issueOrPullRequest: sub(30) } } });
    if (query.includes('subIssues')) return JSON.stringify({ data: { node: { projectItems: { nodes: [] }, subIssues: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [subIssue(31)] } } } });
    const nest = (up: unknown[][]): unknown => (up.length ? { projectItems: { nodes: up[0] }, parent: nest(up.slice(1)) } : null);
    return JSON.stringify({ data: { node: { parent: nest(chain) } } });
  });
  const ok = setup({ gh: gh([[OTHER], [], [BOARD_ITEM]]) });
  const opened = await ok.ask('kanban.browse.issue', { scope: 'p', issueKey: 'gh:o/r#30' });
  assert.equal(opened.t, 'kanban.browseIssue', opened.message);
  assert.equal(opened.issue.key, 'gh:o/r#30');
  const kids = await ok.ask('kanban.browse.children', { scope: 'p', issueKey: 'gh:o/r#30', nodeId: 'I_30' });
  assert.deepEqual(kids.items.map((i: any) => i.key), ['gh:o/r#31']);
  // The browsed sub-issue takes the actions too.
  assert.equal((await ok.ask('kanban.issue.comments', { issueKey: 'gh:o/r#30' })).t, 'kanban.issueComments');

  const off = setup({ gh: gh([[OTHER], []]) });
  assert.match((await off.ask('kanban.browse.issue', { scope: 'p', issueKey: 'gh:o/r#30' })).message, /isn't on the board o\/1/);
  assert.match((await off.ask('kanban.browse.children', { scope: 'p', issueKey: 'gh:o/r#30', nodeId: 'I_30' })).message, /isn't on the board/);
  // GitHub nests sub-issues 8 levels deep: a level-6 and a level-8 child reach the board item at the top, a chain longer than that is not followed.
  const up = (hops: number) => [...Array(hops - 1).fill([]), [BOARD_ITEM]];
  for (const hops of [5, 7, 8]) {
    const deep = setup({ gh: gh(up(hops)) });
    assert.equal((await deep.ask('kanban.browse.issue', { scope: 'p', issueKey: 'gh:o/r#30' })).t, 'kanban.browseIssue', `${hops} parent hops`);
  }
  const far = setup({ gh: gh(up(9)) });
  assert.match((await far.ask('kanban.browse.issue', { scope: 'p', issueKey: 'gh:o/r#30' })).message, /isn't on the board/);
  assert.match((await far.ask('kanban.browse.children', { scope: 'p', issueKey: 'gh:o/r#30', nodeId: 'I_30' })).message, /isn't on the board/);
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

test('a browsed issue the source filters keep off the wall is still the floor’s to queue or carry; an arbitrary key is not', async (t) => {
  const { ask, issues } = setup({ sources: [JIRA] });
  issues.plugin.start!();
  t.after(() => issues.plugin.stop!());
  await ask('kanban.browse.issue', { scope: 'j', issueKey: 'UYT-77' });
  assert.deepEqual(wallIssues('app')!.items, [], 'not on the wall');
  const floor = { id: 'app' };
  const cardKey = (v: unknown) => Floor.prototype.cardKey.call(floor as never, v);
  assert.equal(cardKey('UYT-77'), 'UYT-77');
  assert.equal(cardKey('UYT-78'), undefined, 'never browsed');
  assert.equal(cardKey('gh:victim/repo#1'), undefined);
  assert.equal(Floor.prototype.cardKey.call({ id: 'other' } as never, 'UYT-77'), undefined, 'another floor');
  // Carrying keeps the key (queue.add takes the same cardKey before it stores one).
  const peer: any = {};
  const sent: unknown[] = [];
  presenceHandlers.carry({ floorOf: () => ({ cardKey }), broadcast: (m: unknown) => sent.push(m) } as never, { peer } as never, { t: 'carry', issueKey: 'UYT-77', title: 'Seventy-seven' } as never);
  assert.equal(peer.carrying?.key, 'UYT-77');
});
