import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoRefOf } from '../src/shared/hosting/remote.js';
import { azureProvider } from '../src/server/hosting/azure.js';
import { azureDescription, latestStatuses } from '../src/server/hosting/azure-map.js';
import { completeWorkItem, linkWorkItemToPr, workItemOf } from '../src/server/hosting/azure-workitems.js';
import type { Fetch, HostAs } from '../src/server/hosting/provider.js';

const as: HostAs = { kind: 'azure', auth: 'Basic x', key: 'acc123456' };
const repo = repoRefOf('azure:contoso/My Project/web app')!;
const API = 'https://dev.azure.com/contoso/My%20Project/_apis/git/repositories/web%20app';
const WEB = 'https://dev.azure.com/contoso/My%20Project/_git/web%20app';

interface Call {
  method: string;
  url: string;
  body?: any;
  type?: string;
}

/** A fetch answering from `routes` (first whose test matches "METHOD url"), recording every call. */
function stub(routes: [RegExp, (call: Call) => unknown, number?][]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, type: headers['content-type'] };
    calls.push(call);
    assert.equal(headers.authorization, 'Basic x');
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    return new Response(JSON.stringify(route[1](call)), { status: route[2] ?? 200 });
  };
  return { fetch, calls };
}

const pr = (id: number, extra: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status: 'active',
  isDraft: false,
  createdBy: { displayName: 'Ada Lovelace' },
  sourceRefName: `refs/heads/feature-${id}`,
  targetRefName: 'refs/heads/main',
  creationDate: '2026-10-01T10:00:00Z',
  lastMergeSourceCommit: { commitId: `abc${id}` },
  description: 'Does things',
  reviewers: [],
  ...extra,
});

test('listPulls maps active, draft, completed and abandoned PRs with votes and checks', async () => {
  const statuses: Record<number, unknown[]> = {
    1: [
      { id: 1, iterationId: 1, state: 'failed', context: { genre: 'ci', name: 'build' } },
      { id: 2, iterationId: 2, state: 'succeeded', context: { genre: 'ci', name: 'build' }, targetUrl: 'https://ci/2' },
    ],
    2: [
      { id: 3, iterationId: 1, state: 'succeeded', context: { genre: 'ci', name: 'build' } },
      { id: 4, iterationId: 1, state: 'failed', context: { name: 'lint' } },
    ],
  };
  const { fetch, calls } = stub([
    [/statuses/, (c) => {
      const n = Number(/pullrequests\/(\d+)\/statuses/.exec(c.url)![1]);
      if (n === 3) throw new Error('boom');
      return { value: statuses[n] ?? [] };
    }],
    [/status=active/, () => ({ value: [
      pr(1, { reviewers: [{ vote: 10 }, { vote: 0, isRequired: true }], labels: [{ name: 'ui', active: true }, { name: 'old', active: false }] }),
      pr(2, { isDraft: true, reviewers: [{ vote: 10 }, { vote: -10 }] }),
      pr(3, { reviewers: [{ vote: 0, isRequired: true }], forkSource: { repository: { id: 'x' } } }),
    ] })],
    [/status=completed/, () => ({ value: [pr(4, { status: 'completed', closedDate: '2026-10-02T00:00:00Z', description: 'x'.repeat(5000) })] })],
    [/status=abandoned/, () => ({ value: [pr(5, { status: 'abandoned' })] })],
  ]);
  const pulls = await azureProvider.listPulls(repo, as, fetch);
  assert.deepEqual(pulls.map((p) => [p.number, p.state, p.isDraft, p.reviewDecision, p.checks]), [
    [1, 'OPEN', false, 'APPROVED', 'pass'],
    [2, 'OPEN', true, 'CHANGES_REQUESTED', 'fail'],
    [3, 'OPEN', false, 'REVIEW_REQUIRED', 'none'],
    [4, 'MERGED', false, '', 'none'],
    [5, 'CLOSED', false, '', 'none'],
  ]);
  const [p1, , p3, p4] = pulls;
  assert.equal(p1.url, `${WEB}/pullrequest/1`);
  assert.equal(p1.headRefName, 'feature-1');
  assert.equal(p1.baseRefName, 'main');
  assert.equal(p1.headRefOid, 'abc1');
  assert.equal(p1.author, 'Ada Lovelace');
  assert.equal(p1.repo, 'azure:contoso/My Project/web app');
  assert.deepEqual(p1.labels, [{ name: 'ui', color: '#888888' }]);
  assert.deepEqual(p1.closes, []);
  assert.equal(p3.isCrossRepository, true);
  assert.equal(p4.updatedAt, '2026-10-02T00:00:00Z');
  assert.equal(p4.body.length, 4000);
  // Statuses only for the open ones.
  assert.equal(calls.filter((c) => c.url.includes('/statuses')).length, 3);
  assert.ok(calls.every((c) => c.url.startsWith(API) && c.url.includes('api-version=7.1')));
  assert.ok(calls.some((c) => c.url.includes('searchCriteria.status=active&$top=150')));
});

test('checks keep the newest status per context', async () => {
  assert.deepEqual(latestStatuses([
    { id: 5, iterationId: 3, state: 'pending', context: { genre: 'ci', name: 'test' } },
    { id: 9, iterationId: 2, state: 'failed', context: { genre: 'ci', name: 'test' } },
  ]).map((s) => s.id), [5]);
  const { fetch } = stub([
    [/statuses/, () => ({ value: [
      { id: 1, iterationId: 1, state: 'pending', context: { genre: 'ci', name: 'test' } },
      { id: 2, iterationId: 2, state: 'failed', context: { genre: 'ci', name: 'test' }, targetUrl: 'https://ci/t' },
      { id: 3, iterationId: 1, state: 'notApplicable', context: { name: 'policy' } },
    ] })],
    [/pullrequests\/7\?/, () => pr(7)],
  ]);
  assert.deepEqual(await azureProvider.checks(repo, 7, as, fetch), [
    { name: 'ci/test', state: 'fail', url: 'https://ci/t' },
    { name: 'policy', state: 'skip' },
  ]);
});

test('createPr sends refs and work items, asks to complete them, and returns the web URL', async () => {
  const { fetch, calls } = stub([
    [/^GET .*repositories\/web%20app\?/, () => ({ id: 'r1', defaultBranch: 'refs/heads/develop' })],
    [/^POST .*\/pullrequests\?/, () => ({ pullRequestId: 42, url: `${API}/pullrequests/42` })],
    [/^PATCH .*\/pullrequests\/42\?/, () => ({ message: 'nope' }), 500],
  ]);
  const made = await azureProvider.createPr(repo, { head: 'feat/x', title: 'T', body: 'B', draft: true, workItems: [12, 13] }, as, fetch);
  assert.deepEqual(made, { number: 42, url: `${WEB}/pullrequest/42` });
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'PATCH']);
  assert.deepEqual(calls[1].body, { sourceRefName: 'refs/heads/feat/x', targetRefName: 'refs/heads/develop', title: 'T', description: 'B', isDraft: true, workItemRefs: [{ id: '12' }, { id: '13' }] });
  assert.deepEqual(calls[2].body, { completionOptions: { transitionWorkItems: true } });
});

test('createPr with a base and no work items makes one call, and cuts a long description short', async () => {
  const { fetch, calls } = stub([[/^POST /, () => ({ pullRequestId: 5 })]]);
  await azureProvider.createPr(repo, { head: 'a', base: 'main', title: 'T', body: 'y'.repeat(4500) }, as, fetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.targetRefName, 'refs/heads/main');
  assert.equal(calls[0].body.workItemRefs, undefined);
  assert.equal(calls[0].body.description.length, 4000);
  assert.equal(calls[0].body.description, azureDescription('y'.repeat(4500)));
  assert.match(calls[0].body.description, /cut short/);
});

test('findOpenPr asks for the active PR from the branch', async () => {
  const { fetch, calls } = stub([[/pullrequests\?/, (c) => ({ value: c.url.includes('feat%2Fx') ? [pr(8)] : [] })]]);
  assert.deepEqual(await azureProvider.findOpenPr(repo, 'feat/x', as, fetch), { number: 8, url: `${WEB}/pullrequest/8` });
  assert.match(calls[0].url, /searchCriteria\.sourceRefName=refs%2Fheads%2Ffeat%2Fx&searchCriteria\.status=active&\$top=1&api-version=7\.1$/);
  assert.equal(await azureProvider.findOpenPr(repo, 'other', as, fetch), undefined);
});

test('comment posts a thread and resolves to its discussion URL', async () => {
  const { fetch, calls } = stub([[/threads/, () => ({ id: 77 })]]);
  assert.equal(await azureProvider.comment(repo, 3, 'Hello', as, fetch), `${WEB}/pullrequest/3?discussionId=77`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${API}/pullrequests/3/threads?api-version=7.1`);
  assert.deepEqual(calls[0].body, { comments: [{ parentCommentId: 0, content: 'Hello', commentType: 1 }], status: 1 });
});

test('comments skip system and deleted ones and keep the file and line', async () => {
  const { fetch } = stub([[/threads/, () => ({ value: [
    { id: 1, comments: [{ id: 1, commentType: 'system', content: 'updated', publishedDate: '2026-10-01T00:00:00Z' }] },
    { id: 2, threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 4 } }, comments: [
      { id: 1, commentType: 'text', content: 'Fix', author: { displayName: 'Bo' }, publishedDate: '2026-10-02T00:00:00Z' },
      { id: 2, commentType: 'text', content: 'gone', isDeleted: true, publishedDate: '2026-10-03T00:00:00Z' },
    ] },
  ] })]]);
  const got = await azureProvider.comments(repo, 3, as, fetch);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, '2.1');
  assert.equal(got[0].author, 'Bo');
  assert.equal(got[0].body, 'Fix');
  assert.equal(got[0].path, 'src/a.ts');
  assert.equal(got[0].line, 4);
});

test('viewPr maps the PR', async () => {
  const { fetch } = stub([[/pullrequests\/9\?/, () => pr(9, { status: 'completed', isDraft: true, reviewers: [{ vote: 5 }] })]]);
  assert.deepEqual(await azureProvider.viewPr(repo, 9, as, fetch), {
    number: 9, url: `${WEB}/pullrequest/9`, title: 'PR 9', body: 'Does things', state: 'MERGED', isDraft: true,
    headRefName: 'feature-9', baseRefName: 'main', author: 'Ada Lovelace', reviewDecision: 'APPROVED', isCrossRepository: false,
  });
});

test('whoAmI asks the organization (a PAT works there, not on the Profiles API), and defaultBranch', async () => {
  const { fetch, calls } = stub([
    [/^GET https:\/\/dev\.azure\.com\/contoso\/_apis\/connectionData$/, () => ({ authenticatedUser: { id: 'u1', descriptor: 'Microsoft.IdentityModel.Claims.ClaimsIdentity;x', providerDisplayName: 'Ada Lovelace', properties: { Account: { $value: 'ada@x' } } } })],
    [/repositories\/web%20app\?/, () => ({ defaultBranch: 'refs/heads/main' })],
  ]);
  assert.equal(await azureProvider.whoAmI(as, fetch, { org: 'contoso' }), 'Ada Lovelace');
  assert.ok(!calls.some((c) => /vssps|profile/.test(c.url)));
  await assert.rejects(azureProvider.whoAmI(as, fetch), /needs the organization/);
  const anon = stub([[/connectionData/, () => ({ authenticatedUser: { id: 'a', descriptor: 'Microsoft.TeamFoundation.UnauthenticatedIdentity;x', providerDisplayName: 'Anonymous' } })]]);
  await assert.rejects(azureProvider.whoAmI(as, anon.fetch, { org: 'contoso' }), /didn't take the token for contoso/);
  assert.equal(await azureProvider.defaultBranch(repo, as, fetch), 'main');
});

test('a token Azure DevOps turns down gives a readable error (401 and 203)', async () => {
  for (const status of [401, 203]) {
    const { fetch } = stub([[/./, () => ({}), status]]);
    await assert.rejects(azureProvider.viewPr(repo, 1, as, fetch), /Your Azure DevOps sign-in stopped working/);
  }
});

const ITEM = 'https://dev.azure.com/contoso/_apis/wit/workitems/12';
const prWithRepo = () => pr(42, { repository: { id: 'repo-guid', project: { id: 'proj-guid' } } });
const LINK = 'vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F42';

test('linkWorkItemToPr adds the ArtifactLink relation', async () => {
  const { fetch, calls } = stub([
    [/pullrequests\/42/, prWithRepo],
    [/^GET .*workitems\/12\?\$expand=relations/, () => ({ id: 12, relations: [{ rel: 'Parent', url: 'x' }] })],
    [/^PATCH .*workitems\/12/, () => ({ id: 12 })],
  ]);
  assert.equal(await linkWorkItemToPr(repo, 42, 12, as, fetch), true);
  const patch = calls.at(-1)!;
  assert.equal(patch.url, `${ITEM}?api-version=7.1`);
  assert.equal(patch.type, 'application/json-patch+json');
  assert.deepEqual(patch.body, [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: LINK, attributes: { name: 'Pull Request' } } }]);
});

test('linkWorkItemToPr does nothing when the link is there', async () => {
  const { fetch, calls } = stub([
    [/pullrequests\/42/, prWithRepo],
    [/^GET .*workitems\/12/, () => ({ id: 12, relations: [{ rel: 'ArtifactLink', url: LINK }] })],
  ]);
  assert.equal(await linkWorkItemToPr(repo, 42, 12, as, fetch), false);
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

const STATES = { value: [
  { name: 'New', category: 'Proposed' },
  { name: 'Active', category: 'InProgress' },
  { name: 'Closed', category: 'Completed' },
  { name: 'Removed', category: 'Removed' },
] };

test('completeWorkItem moves it to the first Completed state', async () => {
  const { fetch, calls } = stub([
    [/^GET .*workitems\/12\?/, () => ({ id: 12, fields: { 'System.State': 'Active', 'System.WorkItemType': 'User Story' } })],
    [/workitemtypes\/User%20Story\/states/, () => STATES],
    [/^PATCH /, () => ({ id: 12 })],
  ]);
  assert.equal(await completeWorkItem('contoso', 'My Project', 12, as, fetch), 'Closed');
  const patch = calls.at(-1)!;
  assert.equal(patch.url, 'https://dev.azure.com/contoso/My%20Project/_apis/wit/workitems/12?api-version=7.1');
  assert.equal(patch.type, 'application/json-patch+json');
  assert.deepEqual(patch.body, [{ op: 'add', path: '/fields/System.State', value: 'Closed' }]);
});

test("completeWorkItem says 'already' for a completed or removed one", async () => {
  for (const state of ['Closed', 'Removed']) {
    const { fetch, calls } = stub([
      [/^GET .*workitems\/12\?/, () => ({ id: 12, fields: { 'System.State': state, 'System.WorkItemType': 'Bug' } })],
      [/states/, () => STATES],
    ]);
    assert.equal(await completeWorkItem('contoso', 'My Project', 12, as, fetch), 'already');
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  }
});

test('workItemOf reads the title, state and kind', async () => {
  const { fetch } = stub([[/workitems\/12/, () => ({ id: 12, fields: { 'System.Title': 'Login', 'System.State': 'New', 'System.WorkItemType': 'Bug' } })]]);
  assert.deepEqual(await workItemOf('contoso', 'My Project', 12, as, fetch), {
    id: 12, title: 'Login', state: 'New', type: 'Bug', url: 'https://dev.azure.com/contoso/My%20Project/_workitems/edit/12',
  });
});

test('checks: the branch policies (build validation, required statuses) with the statuses, on the board and in the window', async () => {
  const projectPr = (id: number) => pr(id, { repository: { id: 'r1', project: { id: 'p-guid' } } });
  const evaluations = [
    { status: 'rejected', configuration: { isEnabled: true, isBlocking: true, type: { id: '0609b952-1397-4640-95ec-e00a01b2c241', displayName: 'Build' }, settings: { displayName: 'PR build', buildDefinitionId: 3 } }, context: { buildId: 77 } },
    { status: 'queued', configuration: { isEnabled: true, type: { id: 'cbdc66da-9728-4af8-aada-9a5a32e4a226', displayName: 'Status' }, settings: { statusGenre: 'sonar', statusName: 'quality' } } },
    { status: 'running', configuration: { isEnabled: true, type: { id: 'cbdc66da-9728-4af8-aada-9a5a32e4a226', displayName: 'Status' }, settings: { statusGenre: 'ci', statusName: 'test' } } },
    { status: 'approved', configuration: { isEnabled: true, type: { id: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', displayName: 'Minimum number of reviewers' }, settings: {} } },
    { status: 'rejected', configuration: { isEnabled: false, type: { id: '0609b952-1397-4640-95ec-e00a01b2c241' }, settings: { displayName: 'Off' } } },
  ];
  const { fetch, calls } = stub([
    [/pullrequests\/7\/statuses/, () => ({ value: [{ id: 1, state: 'succeeded', context: { genre: 'ci', name: 'test' } }] })],
    [/policy\/evaluations/, () => ({ value: evaluations })],
    [/pullrequests\/7\?/, () => projectPr(7)],
    [/searchCriteria\.status=active/, () => ({ value: [projectPr(7)] })],
    [/searchCriteria\.status=/, () => ({ value: [] })],
  ]);
  assert.deepEqual(await azureProvider.checks(repo, 7, as, fetch), [
    { name: 'ci/test', state: 'pass' },
    { name: 'PR build', state: 'fail', url: 'https://dev.azure.com/contoso/My%20Project/_build/results?buildId=77' },
    { name: 'sonar/quality', state: 'pending' },
  ], 'a required status already posted shows once; reviewer and disabled policies are not checks');
  const asked = calls.find((c) => /policy\/evaluations/.test(c.url))!.url;
  assert.match(asked, /artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fp-guid%2F7&/);
  const [card] = await azureProvider.listPulls(repo, as, fetch);
  assert.equal(card.checks, 'fail', 'a failed build validation fails the card too');
  // Evaluations the token can't read leave the statuses.
  const noPolicy = stub([[/statuses/, () => ({ value: [{ id: 1, state: 'succeeded', context: { name: 'x' } }] })], [/policy/, () => ({}), 403], [/pullrequests\/7\?/, () => projectPr(7)]]);
  assert.deepEqual(await azureProvider.checks(repo, 7, as, noPolicy.fetch), [{ name: 'x', state: 'pass' }]);
});
