import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openHosting } from '../src/server/hosting/index.js';
import { azureBoardsSource, azureWorkItem, buildWiql, htmlToText, NO_AZURE_TOKEN, readWorkItems, wiqlQuote } from '../src/server/kanban/integrations/issues/azure-boards.js';
import { azureActAs, azureAssign, azureComment, azureComments, azureTransition, azureTransitions, textToHtml } from '../src/server/kanban/integrations/issues/azure-ops.js';
import { route } from '../src/server/kanban/integrations/issues/actions.js';
import type { IssueSourceIo } from '../src/server/kanban/integrations/issues/source.js';
import type { HostAs } from '../src/server/hosting/provider.js';
import { sanitizeIssueSource } from '../src/server/kanban/settings.js';
import type { IssueSourceConfig, NormalizedIssue } from '../src/shared/kanban/types.js';

type AzureConfig = Extract<IssueSourceConfig, { kind: 'azure-boards' }>;
type HttpCall = { url: string; method: string; body?: any; auth: string; type?: string };

const fetchStub = (answer: (call: HttpCall) => { status?: number; body?: unknown }) => {
  const calls: HttpCall[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call = { url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: String(headers.authorization), type: headers['content-type'] };
    calls.push(call);
    const r = answer(call);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const io = (fetch: typeof globalThis.fetch): IssueSourceIo => ({ gh: async () => '', fetch, cwd: '/tmp', projectRepos: [] });
const config = (filters: AzureConfig['filters'] = {}, over: Partial<AzureConfig> = {}): AzureConfig => ({ id: 'ab1', kind: 'azure-boards', org: 'acme', project: 'My Project', filters, ...over });
const TOKEN = 'x'.repeat(52);
const OFFICE_AUTH = `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`;
const AS: HostAs = { kind: 'azure', auth: OFFICE_AUTH, key: 'acct01' };
const REF = { org: 'acme', project: 'My Project', id: 42 };

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ab-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const withOfficeToken = () => {
  writeFileSync(path.join(dir, 'hosting-secrets.json'), JSON.stringify({ azure: { token: TOKEN, who: 'Office' } }), { mode: 0o600 });
  openHosting(dir);
};
const withoutTokens = () => {
  rmSync(path.join(dir, 'hosting-secrets.json'), { force: true });
  openHosting(dir);
};

// --- WIQL -------------------------------------------------------------------------------------------

test('the WIQL quotes every value and leaves out the closed states by default', () => {
  assert.equal(wiqlQuote("O'Brien"), "'O''Brien'");
  assert.equal(wiqlQuote("a'\n) OR 1=1 --"), "'a'' ) OR 1=1 --'");
  assert.equal(
    buildWiql(config()),
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'My Project' AND [System.State] NOT IN ('Done', 'Closed', 'Removed', 'Completed', 'Cut') ORDER BY [System.ChangedDate] DESC",
  );
});

test('the WIQL has the filters: types, @Me or a name, area path, closed, and the extra condition in parentheses', () => {
  const wiql = buildWiql(config({ types: ['User Story', "Bug's"], assignee: '@me', areaPath: 'My Project\\Team', closed: true, wiql: '[Microsoft.VSTS.Common.Priority] <= 2' }));
  assert.equal(
    wiql,
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'My Project' AND [System.WorkItemType] IN ('User Story', 'Bug''s') AND [System.AssignedTo] = @Me AND [System.AreaPath] UNDER 'My Project\\Team' AND ([Microsoft.VSTS.Common.Priority] <= 2) ORDER BY [System.ChangedDate] DESC",
  );
  assert.match(buildWiql(config({ assignee: "o'neil@x.fi" })), /\[System\.AssignedTo\] = 'o''neil@x\.fi'/);
  assert.throws(() => buildWiql(config({ wiql: "[System.Title] = 'x'; DROP" })), /;/);
  assert.throws(() => buildWiql(config({ wiql: '[System.Id] > 1 ORDER BY [System.Id]' })), /ORDER BY/);
  assert.throws(() => buildWiql(config({ wiql: 'x'.repeat(2001) })), /longer/);
});

// --- Mapping ----------------------------------------------------------------------------------------

test('a work item becomes a NormalizedIssue: its key and page, its HTML as text, tags as labels', () => {
  assert.equal(htmlToText('<div>Hello <b>world</b> &amp; you</div><ul><li>one</li><li>two&#39;s</li></ul><p>a<br>b&nbsp;c &#x263A;</p>'), "Hello world & you\n\n- one\n- two's\n\na\nb c ☺");
  const issue = azureWorkItem(
    {
      id: 42,
      fields: {
        'System.Title': 'Fix login',
        'System.State': 'Active',
        'System.WorkItemType': 'Bug',
        'System.AssignedTo': { displayName: 'Maija Meikäläinen', uniqueName: 'maija@x.fi' },
        'System.Tags': 'ai; backend',
        'System.Description': '<p>Steps</p>',
        'System.ChangedDate': '2026-10-01T10:00:00Z',
      },
    },
    'acme',
    'My Project',
    'ab1',
  );
  assert.deepEqual(issue, {
    source: 'azure-boards',
    sourceId: 'ab1',
    key: 'ab:acme/My Project#42',
    title: 'Fix login',
    url: 'https://dev.azure.com/acme/My%20Project/_workitems/edit/42',
    body: 'Steps',
    assignee: 'Maija Meikäläinen',
    labels: ['ai', 'backend'],
    status: 'Active',
    project: 'My Project',
    updatedAt: '2026-10-01T10:00:00Z',
  });
  assert.equal(azureWorkItem({ fields: {} }, 'acme', 'p'), undefined);
});

// --- Listing ----------------------------------------------------------------------------------------

test('the source asks WIQL for the ids, then reads the work items in batches of 200 with the office’s token', async () => {
  withOfficeToken();
  const ids = Array.from({ length: 450 }, (_, i) => i + 1);
  const { fetch, calls } = fetchStub((c) => {
    if (c.url.includes('/_apis/wit/wiql')) return { body: { workItems: ids.map((id) => ({ id })) } };
    const asked = new URL(c.url).searchParams.get('ids')!.split(',').map(Number);
    return { body: { value: asked.map((id) => ({ id, fields: { 'System.TeamProject': 'My Project', 'System.Title': `T${id}`, 'System.State': 'New', 'System.ChangedDate': '2026-10-01' } })) } };
  });
  const got = await azureBoardsSource.list(config({ types: ['Bug'] }), io(fetch));
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://dev.azure.com/acme/My%20Project/_apis/wit/wiql?$top=500&api-version=7.1');
  assert.match(calls[0].body.query, /^SELECT \[System\.Id\] FROM WorkItems WHERE \[System\.TeamProject\] = 'My Project' AND \[System\.WorkItemType\] IN \('Bug'\)/);
  assert.equal(calls[0].auth, OFFICE_AUTH);
  const reads = calls.slice(1);
  assert.deepEqual(
    reads.map((c) => new URL(c.url).searchParams.get('ids')!.split(',').length),
    [200, 200, 50],
  );
  assert.ok(reads.every((c) => c.method === 'GET' && c.url.startsWith('https://dev.azure.com/acme/_apis/wit/workitems?') && c.url.includes('fields=System.Id,System.TeamProject,System.Title,System.State')));
  assert.equal(got.length, 450);
  assert.equal(got[0].key, 'ab:acme/My Project#1');
});

test('without any Azure DevOps token the source says where to set one', async () => {
  withoutTokens();
  const { fetch, calls } = fetchStub(() => ({ body: {} }));
  await assert.rejects(azureBoardsSource.list(config(), io(fetch)), (err: Error) => err.message === NO_AZURE_TOKEN);
  assert.equal(calls.length, 0);
  assert.throws(() => azureActAs('acct01', true), /Set your Azure DevOps token first/);
});

test('a bad organisation or project name never reaches a URL', async () => {
  withOfficeToken();
  const { fetch, calls } = fetchStub(() => ({ body: {} }));
  await assert.rejects(azureBoardsSource.list(config({}, { org: 'acme/../x' }), io(fetch)), /organisation/);
  await assert.rejects(azureBoardsSource.list(config({}, { project: 'a#b' }), io(fetch)), /project/);
  assert.equal(calls.length, 0);
});

// --- Actions ----------------------------------------------------------------------------------------

test('transitions are the type’s other states; a move PATCHes System.State as JSON patch', async () => {
  const { fetch, calls } = fetchStub((c) => {
    if (c.method === 'PATCH') return { body: { id: 42 } };
    if (c.url.includes('/states?')) return { body: { value: [{ name: 'New', category: 'Proposed' }, { name: 'In Progress', category: 'InProgress' }, { name: 'Done', category: 'Completed' }] } };
    return { body: { id: 42, fields: { 'System.WorkItemType': 'User Story', 'System.State': 'New' } } };
  });
  const got = await azureTransitions({ fetch }, AS, REF);
  assert.equal(calls[1].url, 'https://dev.azure.com/acme/My%20Project/_apis/wit/workitemtypes/User%20Story/states?api-version=7.1');
  assert.equal(got.current, 'New');
  assert.deepEqual(
    got.transitions.map((t) => [t.to, t.group]),
    [
      ['In Progress', 'InProgress'],
      ['Done', 'Completed'],
    ],
  );
  assert.ok(got.transitions.every((t) => /^[\w:@.=-]{1,500}$/.test(t.id)));
  const to = await azureTransition({ fetch }, AS, REF, got.transitions[0].id);
  assert.equal(to, 'In Progress');
  const patch = calls.at(-1)!;
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url, 'https://dev.azure.com/acme/My%20Project/_apis/wit/workitems/42?api-version=7.1');
  assert.equal(patch.type, 'application/json-patch+json');
  assert.deepEqual(patch.body, [{ op: 'add', path: '/fields/System.State', value: 'In Progress' }]);
  await assert.rejects(azureTransition({ fetch }, AS, REF, `abs:${Buffer.from('Gone').toString('hex')}`), /no state Gone/);
});

test('a comment is POSTed as escaped HTML, signed when it goes out under the office’s token; comments read oldest first', async () => {
  assert.equal(textToHtml('a <b>\nc\n\nd & e'), '<p>a &lt;b&gt;<br>c</p><p>d &amp; e</p>');
  const { fetch, calls } = fetchStub((c) =>
    c.method === 'POST'
      ? { body: { id: 7 } }
      : { body: { comments: [{ id: 2, text: '<p>newer</p>', createdBy: { displayName: 'B' }, createdDate: '2026-10-02' }, { id: 1, text: 'older', createdBy: { displayName: 'A' }, createdDate: '2026-10-01' }] } },
  );
  await azureComment({ fetch }, AS, REF, 'Looks good', 'Panu');
  assert.equal(calls[0].url, 'https://dev.azure.com/acme/My%20Project/_apis/wit/workItems/42/comments?api-version=7.1-preview.4');
  assert.deepEqual(calls[0].body, { text: '<p>Looks good</p><p>— Panu via Agent Office</p>' });
  await azureComment({ fetch }, AS, REF, 'Mine');
  assert.deepEqual(calls[1].body, { text: '<p>Mine</p>' });
  const items = await azureComments({ fetch }, AS, REF);
  assert.deepEqual(
    items.map((c) => [c.author, c.body]),
    [
      ['A', 'older'],
      ['B', 'newer'],
    ],
  );
});

test('assigning: a team member by id, nobody, and "me" refused under the office’s token', async () => {
  const { fetch, calls } = fetchStub((c) => {
    if (c.url.includes('/teams/')) return { body: { value: [{ identity: { id: 'aaaa-1111', displayName: 'Maija', uniqueName: 'maija@x.fi' } }] } };
    if (c.url.includes('/_apis/projects/')) return { body: { defaultTeam: { id: 'team-1' } } };
    return { body: { id: 42 } };
  });
  assert.equal(await azureAssign({ fetch }, AS, REF, { id: 'aaaa-1111', name: 'Maija' }), 'Maija');
  assert.deepEqual(calls.at(-1)!.body, [{ op: 'add', path: '/fields/System.AssignedTo', value: 'Maija <maija@x.fi>' }]);
  assert.equal(await azureAssign({ fetch }, AS, REF, null), undefined);
  assert.deepEqual(calls.at(-1)!.body, [{ op: 'add', path: '/fields/System.AssignedTo', value: '' }]);
  await assert.rejects(azureAssign({ fetch }, AS, REF, { id: 'bbbb', name: 'Nobody' }), /isn't on My Project's team/);
  await assert.rejects(azureAssign({ fetch }, { ...AS, key: 'office' }, REF, { me: true }), /pick yourself/);
});

test('assigning "me": who the token is, from the organization (connectionData takes a PAT; the Profiles API does not)', async () => {
  const { fetch, calls } = fetchStub((c) => {
    if (c.url.includes('/_apis/connectionData')) return { body: { authenticatedUser: { id: 'u1', descriptor: 'Microsoft.IdentityModel.Claims.ClaimsIdentity;x', providerDisplayName: 'Maija', properties: { Account: { $value: 'maija@x.fi' } } } } };
    return { body: { id: 42 } };
  });
  assert.equal(await azureAssign({ fetch }, AS, REF, { me: true }), 'Maija');
  assert.ok(calls.some((c) => c.url.startsWith(`https://dev.azure.com/${REF.org}/_apis/connectionData`)));
  assert.ok(!calls.some((c) => /vssps|profile/.test(c.url)));
  assert.deepEqual(calls.at(-1)!.body, [{ op: 'add', path: '/fields/System.AssignedTo', value: 'maija@x.fi' }]);
});

test('an ab: key routes to Azure Boards', () => {
  const issue = { source: 'azure-boards', key: 'ab:acme/My Project#42', title: '', url: '', body: '', labels: [], updatedAt: '' } as NormalizedIssue;
  assert.deepEqual(route([config()], issue), { kind: 'azure', org: 'acme', project: 'My Project', id: 42 });
});

// --- Settings ---------------------------------------------------------------------------------------

test('sanitizeIssueSource keeps a good Azure Boards source and refuses a bad one', () => {
  assert.deepEqual(sanitizeIssueSource({ id: 'ab1', kind: 'azure-boards', org: 'acme', project: 'My Project', filters: { assignee: '@Me', types: ['Bug', '', 3], closed: 'yes', wiql: '[System.Id] > 5', areaPath: '' } }), {
    id: 'ab1',
    kind: 'azure-boards',
    org: 'acme',
    project: 'My Project',
    filters: { assignee: '@Me', types: ['Bug'], wiql: '[System.Id] > 5' },
  });
  assert.deepEqual(sanitizeIssueSource({ id: 'ab1', kind: 'azure-boards', org: 'acme', project: 'P', filters: { closed: true } })?.filters, { closed: true });
  assert.equal(sanitizeIssueSource({ kind: 'azure-boards', org: 'ac/me', project: 'P' }), undefined);
  assert.equal(sanitizeIssueSource({ kind: 'azure-boards', org: 'acme', project: '' }), undefined);
  assert.equal(sanitizeIssueSource({ kind: 'azure-boards', org: 'acme', project: 'a#b' }), undefined);
  assert.equal(sanitizeIssueSource({ kind: 'azure-boards', org: 'acme', project: 'P', filters: { wiql: "x = 'a'; y" } }), undefined);
  assert.equal(sanitizeIssueSource({ kind: 'azure-boards', org: 'acme', project: 'P', filters: { wiql: 'x'.repeat(2001) } }), undefined);
});

test("a work item read by its number is the source's only when it's in the source's project (the ids are the organization's)", async () => {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ value: [
      { id: 123, fields: { 'System.TeamProject': 'Secret Project', 'System.Title': 'Not yours' } },
      { id: 124, fields: { 'System.TeamProject': 'my project', 'System.Title': 'Yours' } },
      { id: 125, fields: { 'System.Title': 'No project said' } },
    ] }));
  }) as unknown as IssueSourceIo['fetch'];
  const got = await readWorkItems({ fetch }, AS, 'acme', 'My Project', [123, 124, 125]);
  assert.deepEqual(got.map((i) => [i.key, i.title]), [['ab:acme/My Project#124', 'Yours']]);
  assert.match(asked[0], /fields=System\.Id,System\.TeamProject,/, 'the project is asked for');
});
