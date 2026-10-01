import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ghAssign, ghClaimIfUnassigned, ghComment, ghComments, ghPeople, ghStateTransition, ghStateTransitions } from '../src/server/kanban/integrations/issues/github-ops.js';
import { jiraAssign, jiraCall, jiraComment, jiraComments, jiraPeople, jiraTransition, jiraTransitions, textToAdf } from '../src/server/kanban/integrations/issues/jira-ops.js';
import { PROJECT_WRITE_SCOPE_ERROR, boardTransitions, projectTransition, resolveBoards } from '../src/server/kanban/integrations/issues/project-ops.js';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { onWallIssues } from '../src/server/kanban/integrations/issues/wall.js';
import type { IssueActIo } from '../src/server/kanban/integrations/issues/source.js';
import type { KanbanContext } from '../src/server/kanban/registry.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

// --- Canned gh and HTTP ---------------------------------------------------------------------------

type GhCall = { args: string[]; env?: Record<string, string> };
const ghStub = (answer: (args: string[]) => string | Error) => {
  const calls: GhCall[] = [];
  const gh = async (args: string[], _cwd: string, _timeout?: number, env?: Record<string, string>) => {
    calls.push({ args, env });
    const out = answer(args);
    if (out instanceof Error) throw out;
    return out;
  };
  return { gh, calls };
};

type HttpCall = { url: string; method: string; body?: any; auth: string };
const fetchStub = (answer: (call: HttpCall) => { status?: number; body?: unknown }) => {
  const calls: HttpCall[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: String((init.headers as Record<string, string>).authorization) };
    calls.push(call);
    const r = answer(call);
    return new Response(r.body === undefined || r.status === 204 ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const JIRA_TOKEN = { site: 'team.atlassian.net', email: 'me@x.fi', token: 'tok' };
const act = (over: Partial<IssueActIo> = {}): IssueActIo => ({ gh: async () => '', fetch: (async () => new Response('{}')) as typeof fetch, cwd: '/tmp', projectRepos: [], jira: JIRA_TOKEN, who: 'Panu', shared: false, ...over });
const SITE = 'team.atlassian.net';

// --- Jira -----------------------------------------------------------------------------------------

test('Jira transitions follow the project’s own workflow, and say which need fields filled in', async () => {
  const { fetch, calls } = fetchStub(() => ({
    body: {
      transitions: [
        { id: '11', name: 'Start', to: { name: 'Backlog', statusCategory: { name: 'To Do' } } },
        { id: '21', name: 'Send to QA', to: { name: 'Ready for QA', statusCategory: { name: 'In Progress' } }, fields: { assignee: { required: true, hasDefaultValue: true, name: 'Assignee' } } },
        { id: '31', name: 'Ship it', to: { name: 'Customer review', statusCategory: { name: 'Done' } }, fields: { resolution: { required: true, hasDefaultValue: false, name: 'Resolution' }, note: { required: false, hasDefaultValue: false, name: 'Note' } } },
      ],
    },
  }));
  const got = await jiraTransitions(act({ fetch }), SITE, 'UYT-12');
  assert.equal(calls[0].url, `https://${SITE}/rest/api/3/issue/UYT-12/transitions?expand=transitions.fields`);
  assert.equal(calls[0].auth, `Basic ${Buffer.from('me@x.fi:tok').toString('base64')}`);
  assert.deepEqual(got, [
    { id: '11', name: 'Start', to: 'Backlog', group: 'To Do' },
    { id: '21', name: 'Send to QA', to: 'Ready for QA', group: 'In Progress' },
    { id: '31', name: 'Ship it', to: 'Customer review', group: 'Done', needs: ['Resolution'] },
  ]);
  await assert.rejects(jiraTransitions(act({ fetch }), SITE, 'UYT-12/../x'), /isn’t a Jira issue key/);
});

test('a Jira transition is checked against the open ones, refused when it needs fields, and POSTed by id', async () => {
  const open = { transitions: [{ id: '21', name: 'Send to QA', to: { name: 'Ready for QA' } }, { id: '31', name: 'Ship it', to: { name: 'Customer review' }, fields: { resolution: { required: true, hasDefaultValue: false, name: 'Resolution' } } }] };
  const { fetch, calls } = fetchStub((c) => (c.method === 'GET' ? { body: open } : { status: 204 }));
  assert.equal(await jiraTransition(act({ fetch }), SITE, 'UYT-12', '21'), 'Ready for QA');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, `https://${SITE}/rest/api/3/issue/UYT-12/transitions`);
  assert.deepEqual(calls[1].body, { transition: { id: '21' } });
  await assert.rejects(jiraTransition(act({ fetch }), SITE, 'UYT-12', '31'), /needs Resolution: do it in Jira/);
  await assert.rejects(jiraTransition(act({ fetch }), SITE, 'UYT-12', '99'), /can’t be moved that way/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'only the first one was sent');
});

test('Jira comments: read oldest first as text, written as rich text with the asker’s name', async () => {
  const adf = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  const { fetch, calls } = fetchStub((c) => (c.method === 'GET' ? { body: { comments: [{ id: '2', author: { displayName: 'Maija' }, body: adf('newer'), created: '2026-09-02' }, { id: '1', author: { displayName: 'Panu' }, body: adf('older'), created: '2026-09-01' }] } } : { status: 201, body: { id: '3' } }));
  const got = await jiraComments(act({ fetch }), SITE, 'UYT-12');
  assert.equal(calls[0].url, `https://${SITE}/rest/api/3/issue/UYT-12/comment?orderBy=-created&maxResults=50`);
  assert.deepEqual(got.map((c) => [c.id, c.author, c.body]), [['1', 'Panu', 'older'], ['2', 'Maija', 'newer']]);
  assert.equal(got[0].url, `https://${SITE}/browse/UYT-12?focusedCommentId=1`);
  await jiraComment(act({ fetch }), SITE, 'UYT-12', 'First line\nsecond line\n\nNew paragraph');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body.body.content, [
    { type: 'paragraph', content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'New paragraph' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '— Panu via Agent Office' }] },
  ]);
  assert.equal(calls[1].body.body.version, 1);
  assert.deepEqual((textToAdf('a\r\n\r\n\r\nb') as { content: unknown[] }).content.length, 2, 'blank lines of any kind split paragraphs');
});

test('Jira people: the assignable users matching the search, app users left out', async () => {
  const { fetch, calls } = fetchStub(() => ({ body: [{ accountId: '71:a', displayName: 'Maija M', avatarUrls: { '48x48': 'https://a/48' } }, { accountId: 'bot', displayName: 'Bot', accountType: 'app' }, { accountId: '71:b', displayName: 'Pekka' }] }));
  const got = await jiraPeople(act({ fetch }), SITE, 'UYT-12', 'ma ja');
  assert.equal(calls[0].url, `https://${SITE}/rest/api/3/user/assignable/search?issueKey=UYT-12&query=ma%20ja&maxResults=20`);
  assert.deepEqual(got, [{ id: '71:a', name: 'Maija M', avatar: 'https://a/48' }, { id: '71:b', name: 'Pekka' }]);
});

test('Jira assign: a PUT of the account id or null, no second read, and `me` is not guessed', async () => {
  const { fetch, calls } = fetchStub(() => ({ status: 204 }));
  assert.equal(await jiraAssign(act({ fetch }), SITE, 'UYT-12', { id: '71:a', name: 'Maija M' }), 'Maija M');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `https://${SITE}/rest/api/3/issue/UYT-12/assignee`);
  assert.deepEqual(calls[0].body, { accountId: '71:a' });
  assert.equal(await jiraAssign(act({ fetch }), SITE, 'UYT-12', { id: '71:b' }), '71:b', 'the id when no name was sent');
  assert.equal(await jiraAssign(act({ fetch }), SITE, 'UYT-12', null), undefined);
  assert.deepEqual(calls[2].body, { accountId: null });
  assert.equal(calls.length, 3, 'only the writes');
  await assert.rejects(jiraAssign(act({ fetch }), SITE, 'UYT-12', { me: true }), /pick yourself in the list/);
});

test('Jira calls: only to the token’s own site, with the 401 text of the source', async () => {
  await assert.rejects(jiraCall(act(), 'evil.example.com', 'GET', '/x'), /token is for team.atlassian.net, not evil.example.com/);
  await assert.rejects(jiraCall(act({ jira: undefined }), SITE, 'GET', '/x'), /Jira isn’t set up/);
  const denied = fetchStub(() => ({ status: 401, body: { errorMessages: ['nope'] } }));
  await assert.rejects(jiraCall(act({ fetch: denied.fetch }), SITE, 'GET', '/x'), /turned the e-mail and API token down \(401\): nope/);
  const bad = fetchStub(() => ({ status: 400, body: { errors: { comment: 'too long' } } }));
  await assert.rejects(jiraCall(act({ fetch: bad.fetch }), SITE, 'GET', '/x'), /Jira said 400: too long/);
});

// --- GitHub repository ----------------------------------------------------------------------------

const ENV = { GH_CONFIG_DIR: '/home/maija/gh' };

test('GitHub comments: the newest fifty by GraphQL, oldest first; a comment goes by -f, signed under the office’s gh only', async () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ id: `IC_${i + 11}`, author: { login: 'u' }, body: `c${i + 11}`, createdAt: '2026-09-01T00:00:00Z', url: `https://github.com/o/r/issues/5#issuecomment-${i + 11}` }));
  const { gh, calls } = ghStub(() => JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { nodes } } } } }));
  const got = await ghComments(act({ gh, env: ENV }), 'o/r', 5);
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'graphql']);
  assert.match(calls[0].args.find((a) => a.startsWith('query='))!, /comments\(last: 50\)/);
  assert.ok(calls[0].args.includes('owner=o') && calls[0].args.includes('name=r') && calls[0].args.includes('number=5'));
  assert.equal(calls[0].env, ENV);
  assert.equal(got.length, 50);
  assert.deepEqual(got[0], { id: 'IC_11', author: 'u', body: 'c11', createdAt: '2026-09-01T00:00:00Z', url: 'https://github.com/o/r/issues/5#issuecomment-11' });
  assert.equal(got.at(-1)!.body, 'c60');
  const calls0 = calls.length;
  await ghComment(act({ gh, env: ENV, shared: false }), 'o/r', 5, '@me is not a file\nsecond line');
  assert.deepEqual(calls[calls0], { args: ['api', '--method', 'POST', 'repos/o/r/issues/5/comments', '-f', 'body=@me is not a file\nsecond line'], env: ENV });
  await ghComment(act({ gh, shared: true }), 'o/r', 5, 'hi');
  assert.equal(calls[calls0 + 1].env, undefined, 'the office’s own gh');
  assert.equal(calls[calls0 + 1].args.at(-1), 'body=hi\n\n— Panu via Agent Office');
});

test('GitHub people: GitHub searches the repository’s assignable users', async () => {
  const { gh, calls } = ghStub(() => JSON.stringify({ data: { repository: { assignableUsers: { nodes: [{ login: 'maija', name: 'Maija M', avatarUrl: 'https://a/m' }, { login: 'maisa', name: null, avatarUrl: '' }] } } } }));
  assert.deepEqual(await ghPeople(act({ gh, env: ENV }), 'o/r', ' ma '), [{ id: 'maija', name: 'Maija M', login: 'maija', avatar: 'https://a/m' }, { id: 'maisa', name: 'maisa', login: 'maisa' }]);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  assert.match(args.find((a) => a.startsWith('query='))!, /assignableUsers\(query: \$q, first: 20\)/);
  assert.ok(args.includes('owner=o') && args.includes('name=r') && args.includes('q=ma'));
  assert.equal(calls[0].env, ENV);
  await ghPeople(act({ gh }), 'o/r');
  assert.ok(!calls[1].args.some((a) => a.startsWith('q=')), 'no search: every assignable user');
});

test('GitHub assign: the current assignees are read fresh and replaced by the one wanted', async () => {
  let assignees = ['old', 'maija'];
  const { gh, calls } = ghStub((args) => (args[0] === 'issue' && args[1] === 'view' ? JSON.stringify({ assignees: assignees.map((login) => ({ login })) }) : args[0] === 'api' ? 'panu\n' : ''));
  const edits = () => calls.filter((c) => c.args[1] === 'edit').map((c) => c.args.slice(2));
  // Someone else: the others come off, the person goes on.
  assert.equal(await ghAssign(act({ gh, env: ENV }), 'o/r', 5, { id: 'pekka' }), 'pekka');
  assert.deepEqual(edits().at(-1), ['5', '-R', 'o/r', '--remove-assignee=old', '--remove-assignee=maija', '--add-assignee=pekka']);
  assert.deepEqual(calls[0], { args: ['issue', 'view', '5', '-R', 'o/r', '--json', 'assignees'], env: ENV }, 'read first, with the person’s sign-in');
  // Already there: only the others come off.
  assert.equal(await ghAssign(act({ gh }), 'o/r', 5, { id: 'MAIJA' }), 'MAIJA');
  assert.deepEqual(edits().at(-1), ['5', '-R', 'o/r', '--remove-assignee=old']);
  // Me: gh's own login.
  assert.equal(await ghAssign(act({ gh }), 'o/r', 5, { me: true }), 'panu');
  assert.deepEqual(edits().at(-1), ['5', '-R', 'o/r', '--remove-assignee=old', '--remove-assignee=maija', '--add-assignee=panu']);
  // Nobody.
  assert.equal(await ghAssign(act({ gh }), 'o/r', 5, null), undefined);
  assert.deepEqual(edits().at(-1), ['5', '-R', 'o/r', '--remove-assignee=old', '--remove-assignee=maija']);
  // Nobody wanted and nobody there: nothing is run.
  assignees = [];
  const before = calls.length;
  await ghAssign(act({ gh }), 'o/r', 5, null);
  assert.equal(calls.length, before + 1, 'only the read');
});

test('GitHub assign me: the login is asked once per sign-in, and with the assignees at the same time', async () => {
  const { gh, calls } = ghStub((args) => (args[0] === 'api' ? 'cache-tester\n' : JSON.stringify({ assignees: [] })));
  const env = { GH_CONFIG_DIR: '/h/cache-test' };
  assert.equal(await ghAssign(act({ gh, env }), 'o/r', 5, { me: true }), 'cache-tester');
  assert.equal(await ghAssign(act({ gh, env }), 'o/r', 6, { me: true }), 'cache-tester');
  assert.equal(calls.filter((c) => c.args[0] === 'api').length, 1, 'asked once');
  assert.equal(calls.filter((c) => c.args[1] === 'view').length, 2);
  assert.ok(calls.slice(0, 2).every((c) => c.args[0] === 'api' || c.args[1] === 'view'), 'both reads before the edit');
  await ghAssign(act({ gh, env: { GH_CONFIG_DIR: '/h/other' } }), 'o/r', 5, { me: true });
  assert.equal(calls.filter((c) => c.args[0] === 'api').length, 2, 'another sign-in, another login');
});

test('GitHub claim: an issue nobody has gets the signed-in person, one with an assignee is left alone', async () => {
  let assignees: string[] = [];
  let state = 'OPEN';
  const { gh, calls } = ghStub((args) => (args[1] === 'view' ? JSON.stringify({ state, assignees: assignees.map((login) => ({ login })) }) : args[0] === 'api' ? 'claimer\n' : ''));
  const env = { GH_CONFIG_DIR: '/h/claim-a' };
  assert.equal(await ghClaimIfUnassigned(act({ gh, env }), 'o/r', 7), 'claimer');
  assert.deepEqual(calls.map((c) => c.args), [['issue', 'view', '7', '-R', 'o/r', '--json', 'assignees,state'], ['api', 'user', '--jq', '.login'], ['issue', 'edit', '7', '-R', 'o/r', '--add-assignee=claimer']]);
  assert.ok(calls.every((c) => c.env === env), 'all under the person’s sign-in');
  assignees = ['maija'];
  calls.length = 0;
  assert.equal(await ghClaimIfUnassigned(act({ gh, env: { GH_CONFIG_DIR: '/h/claim-b' } }), 'o/r', 7), undefined);
  assert.deepEqual(calls.map((c) => c.args[1]), ['view'], 'only the read');
  assignees = [];
  state = 'CLOSED';
  calls.length = 0;
  assert.equal(await ghClaimIfUnassigned(act({ gh, env }), 'o/r', 7), undefined, 'closed (a board’s copy doesn’t say): left alone');
  assert.deepEqual(calls.map((c) => c.args[1]), ['view']);
});

test('GitHub close and reopen; a pull request’s state is left alone', async () => {
  const { gh, calls } = ghStub(() => '');
  assert.equal(await ghStateTransition(act({ gh, env: ENV }), 'o/r', 5, 'gh:close', false), 'Closed');
  assert.deepEqual(calls[0], { args: ['issue', 'close', '5', '-R', 'o/r', '--reason', 'completed'], env: ENV });
  assert.equal(await ghStateTransition(act({ gh }), 'o/r', 5, 'gh:close:not_planned', false), 'Closed (not planned)');
  assert.deepEqual(calls[1].args, ['issue', 'close', '5', '-R', 'o/r', '--reason', 'not planned']);
  assert.equal(await ghStateTransition(act({ gh }), 'o/r', 5, 'gh:reopen', false), 'Open');
  assert.deepEqual(calls[2].args, ['issue', 'reopen', '5', '-R', 'o/r']);
  await assert.rejects(ghStateTransition(act({ gh }), 'o/r', 5, 'gh:close', true), /pull request/);
  await assert.rejects(ghStateTransition(act({ gh }), 'o/r', 5, 'gh:nope', false), /isn’t a way/);
  assert.deepEqual(ghStateTransitions(false, false).map((t) => t.id), ['gh:close', 'gh:close:not_planned']);
  assert.deepEqual(ghStateTransitions(true, false).map((t) => t.id), ['gh:reopen']);
  assert.deepEqual(ghStateTransitions(false, true), []);
  assert.equal(calls.length, 3);
});

// --- GitHub Projects ------------------------------------------------------------------------------

const OPTIONS = [{ id: 'a1', name: 'Inbox' }, { id: 'a2', name: 'Doing' }, { id: 'a3', name: 'Waiting on client' }, { id: 'a4', name: 'Shipped' }];
const board = (over: { owner?: string; number?: number; title?: string; field?: unknown; status?: string; itemId?: string; projectId?: string } = {}) => ({
  id: over.itemId ?? 'PVTI_1',
  status: { name: over.status ?? 'Doing' },
  project: { id: over.projectId ?? 'PVT_1', number: over.number ?? 1, title: over.title ?? 'Roadmap', owner: { login: over.owner ?? 'o' }, field: 'field' in over ? over.field : { id: 'PVTSSF_1', options: OPTIONS } },
});
const issueItems = (...nodes: unknown[]) => JSON.stringify({ data: { repository: { issueOrPullRequest: { projectItems: { nodes } } } } });
const PROJECT_SOURCE = { id: 'p', kind: 'github-project', owner: 'o', number: 1, filters: {} } as Extract<IssueSourceConfig, { kind: 'github-project' }>;

test('a project’s Status options are the issue’s choices; only the project’s own boards count', async () => {
  const { gh, calls } = ghStub(() => issueItems(board(), board({ owner: 'other', number: 7, projectId: 'PVT_7' }), board({ number: 2, projectId: 'PVT_2' })));
  const boards = await resolveBoards(act({ gh, env: ENV }), { repo: 'o/r', number: 5 }, [PROJECT_SOURCE]);
  assert.deepEqual(boards.map((b) => [b.projectId, b.title, b.current]), [['PVT_1', 'Roadmap', 'Doing']]);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  assert.ok(args.includes('owner=o') && args.includes('name=r') && args.includes('number=5'));
  assert.ok(args.includes('-F'), 'the number goes as a number');
  assert.equal(calls[0].env, ENV);
  assert.deepEqual(boardTransitions(boards).map((t) => [t.id, t.name, t.group, t.current]), [
    ['p:PVT_1:PVTI_1:PVTSSF_1:a1', 'Inbox', 'Roadmap', undefined],
    ['p:PVT_1:PVTI_1:PVTSSF_1:a2', 'Doing', 'Roadmap', true],
    ['p:PVT_1:PVTI_1:PVTSSF_1:a3', 'Waiting on client', 'Roadmap', undefined],
    ['p:PVT_1:PVTI_1:PVTSSF_1:a4', 'Shipped', 'Roadmap', undefined],
  ]);
  // No board source: nothing is asked.
  assert.deepEqual(await resolveBoards(act({ gh }), { repo: 'o/r', number: 5 }, []), []);
  assert.equal(calls.length, 1);
});

test('a board without a Status field offers nothing; a draft is found by its item id', async () => {
  const { gh, calls } = ghStub((args) => (args.some((a) => a.startsWith('id=')) ? JSON.stringify({ data: { node: board({ itemId: 'PVTI_9' }) } }) : issueItems(board({ field: {} }))));
  const none = await resolveBoards(act({ gh }), { repo: 'o/r', number: 5 }, [PROJECT_SOURCE]);
  assert.deepEqual(boardTransitions(none), []);
  const draft = await resolveBoards(act({ gh }), { itemId: 'PVTI_9' }, [PROJECT_SOURCE]);
  assert.equal(draft[0].itemId, 'PVTI_9');
  assert.ok(calls[1].args.includes('id=PVTI_9'));
  assert.equal(boardTransitions(draft)[0].id, 'p:PVT_1:PVTI_9:PVTSSF_1:a1');
});

test('moving a board item runs the mutation with the ids of a fresh read; a stale choice is refused', async () => {
  const { gh, calls } = ghStub((args) => (args.some((a) => a.startsWith('query=mutation')) ? '{"data":{}}' : issueItems(board())));
  assert.deepEqual(await projectTransition(act({ gh, env: ENV }), { repo: 'o/r', number: 5 }, [PROJECT_SOURCE], 'p:PVT_1:PVTI_1:PVTSSF_1:a4'), { to: 'Shipped', owner: 'o', number: 1 });
  const mutation = calls.at(-1)!;
  assert.deepEqual(mutation.args.filter((a) => /^(project|item|field|option)=/.test(a)), ['project=PVT_1', 'item=PVTI_1', 'field=PVTSSF_1', 'option=a4']);
  assert.match(mutation.args.find((a) => a.startsWith('query='))!, /updateProjectV2ItemFieldValue/);
  assert.equal(mutation.env, ENV);
  const sent = calls.length;
  for (const id of ['p:PVT_1:PVTI_1:PVTSSF_1:zz', 'p:PVT_9:PVTI_1:PVTSSF_1:a4', 'p:PVT_1:PVTI_1', 'gh:close']) await assert.rejects(projectTransition(act({ gh }), { repo: 'o/r', number: 5 }, [PROJECT_SOURCE], id), /isn’t one of the board’s any more/, id);
  assert.equal(calls.filter((c) => c.args.some((a) => a.startsWith('query=mutation'))).length, 1, 'no more writes');
  assert.ok(calls.length > sent);
});

test('a token without the project scope gets the text that says what to run', async () => {
  const scopes = "Your token has not been granted the required scopes to execute this query. The 'updateProjectV2ItemFieldValue' mutation requires one of the following scopes: ['project']";
  const { gh } = ghStub((args) => (args.some((a) => a.startsWith('query=mutation')) ? new Error(scopes) : issueItems(board())));
  await assert.rejects(projectTransition(act({ gh }), { repo: 'o/r', number: 5 }, [PROJECT_SOURCE], 'p:PVT_1:PVTI_1:PVTSSF_1:a4'), { message: PROJECT_WRITE_SCOPE_ERROR });
  assert.match(PROJECT_WRITE_SCOPE_ERROR, /gh auth refresh -s project/);
  const other = ghStub((args) => (args.some((a) => a.startsWith('query=mutation')) ? new Error('boom') : issueItems(board())));
  await assert.rejects(projectTransition(act({ gh: other.gh }), { repo: 'o/r', number: 5 }, [PROJECT_SOURCE], 'p:PVT_1:PVTI_1:PVTSSF_1:a4'), { message: 'boom' });
});

// --- The plugin: routing by key, identity, the overlay --------------------------------------------

const REPO_SRC: IssueSourceConfig = { id: 'r', kind: 'github-repo', repos: ['o/r'], filters: {} };
const JIRA_SRC: IssueSourceConfig = { id: 'j', kind: 'jira', site: SITE, projectKeys: ['UYT'], filters: {} };
const item = (n: number, title: string) => ({ number: n, title, url: `https://github.com/o/r/issues/${n}`, body: '', state: 'OPEN', assignees: [], labels: [], updatedAt: '2026-09-01T00:00:00Z' });
const projectPage = (status: string, listed = true) =>
  JSON.stringify({
    data: {
      viewer: { login: 'panu' },
      repositoryOwner: {
        projectV2: {
          title: 'Roadmap',
          url: 'https://github.com/orgs/o/projects/1',
          items: {
            pageInfo: { hasNextPage: false },
            nodes: !listed ? [] : [
              { id: 'PVTI_1', isArchived: false, updatedAt: '2026-09-01T00:00:00Z', status: { name: status }, content: { __typename: 'Issue', number: 5, title: 'Five', url: 'https://github.com/o/r/issues/5', body: '', state: 'OPEN', updatedAt: '2026-09-01T00:00:00Z', repository: { nameWithOwner: 'o/r' }, assignees: { nodes: [] }, labels: { nodes: [] } } },
              { id: 'PVTI_2', isArchived: false, updatedAt: '2026-08-01T00:00:00Z', status: { name: 'Inbox' }, content: { __typename: 'DraftIssue', title: 'A draft', body: '', updatedAt: '2026-08-01T00:00:00Z', assignees: { nodes: [] } } },
            ],
          },
        },
      },
    },
  });

/** A project whose repository source and board source both list gh:o/r#5 (the repository's copy wins the dedup). */
function setup(opts: { ghAs?: KanbanContext['ghAs']; status?: () => string; state?: () => string; listed?: () => boolean; hold?: () => Promise<void> | undefined; now?: () => number; sources?: IssueSourceConfig[] } = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })], { ghAs: opts.ghAs });
  ctx.settings.setProject('app', { issueSources: opts.sources ?? [REPO_SRC, PROJECT_SOURCE] });
  const status = opts.status ?? (() => 'Doing');
  const stub = ghStub((args) => {
    const query = args.find((a) => a.startsWith('query=')) ?? '';
    if (args[0] === 'issue' && args[1] === 'view' && args.at(-1) === 'state') return JSON.stringify({ state: opts.state?.() ?? 'OPEN' });
    // A task made from the issue takes it (autoassign.ts): nobody has it, and gh is signed in as panu.
    if (args[0] === 'issue' && args[1] === 'view' && args.at(-1) === 'assignees,state') return JSON.stringify({ assignees: [], state: opts.state?.() ?? 'OPEN' });
    if (args[0] === 'api' && args[1] === 'user') return 'panu\n';
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([item(5, 'Five')]);
    if (query.includes('updateProjectV2ItemFieldValue')) return '{"data":{}}';
    if (query.includes('projectItems')) return issueItems(board({ status: status() }));
    if (query.includes('node(id')) return JSON.stringify({ data: { node: board({ itemId: 'PVTI_2', status: 'Inbox' }) } });
    if (query.includes('viewer')) return projectPage(status(), opts.listed?.() ?? true);
    return '[]';
  });
  const calls = stub.calls;
  // A fetch can be held up by the test (hold returns a promise to wait for).
  const gh: typeof stub.gh = async (...a) => {
    if (a[0][0] === 'api' && a[0].some((x) => x.includes('viewer'))) await opts.hold?.();
    return stub.gh(...a);
  };
  const http = fetchStub(() => ({ body: {} }));
  const issues = createIssues(ctx, { gh, fetch: http.fetch, ...(opts.now ? { now: opts.now } : {}) });
  return { ctx, issues, calls, http, ws: issues.plugin.ws! };
}

const last = <T extends KanbanServerMsg['t']>(c: { got: KanbanServerMsg[] }, t: T) => c.got.at(-1) as Extract<KanbanServerMsg, { t: T }>;

test('the same key listed by a repository and a board: its choices are the board’s Status options plus Close', async () => {
  const { issues, ws, calls } = setup();
  await issues.refresh('app');
  const listed = issues.state('app').items.filter((i) => i.key === 'gh:o/r#5');
  assert.deepEqual(listed.map((i) => i.sourceId), ['r'], 'the list keeps the repository’s copy');
  const c = client(false, 'acc1');
  await ws['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: 'gh:o/r#5', rid: 'r1' });
  const got = last(c, 'kanban.issueTransitions');
  assert.equal(got.rid, 'r1');
  assert.equal(got.cannot, undefined);
  assert.equal(got.current, 'Doing');
  assert.deepEqual(got.transitions.map((t) => t.name), ['Inbox', 'Doing', 'Waiting on client', 'Shipped', 'Close (completed)', 'Close (not planned)']);
  assert.deepEqual(got.transitions.filter((t) => t.group === 'Roadmap').length, 4);
  assert.ok(calls.some((x) => x.args.some((a) => a.startsWith('name=r'))), 'asked by repository and number');
});

test('a draft: the board’s Status works, comments and assignees say why not', async () => {
  const { issues, ws } = setup();
  await issues.refresh('app');
  const key = 'ghp:o/1#PVTI_2';
  assert.ok(issues.state('app').items.some((i) => i.key === key));
  const c = client(false, 'acc1');
  await ws['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: key });
  assert.deepEqual(last(c, 'kanban.issueTransitions').transitions.map((t) => t.name), ['Inbox', 'Doing', 'Waiting on client', 'Shipped']);
  await ws['kanban.issue.comments']!(c, { t: 'kanban.issue.comments', project: 'app', issueKey: key });
  assert.deepEqual(last(c, 'kanban.issueComments'), { t: 'kanban.issueComments', project: 'app', issueKey: key, items: [], cannot: 'Draft issues have no comments' });
  await ws['kanban.issue.people']!(c, { t: 'kanban.issue.people', project: 'app', issueKey: key });
  assert.match(last(c, 'kanban.issuePeople').cannot ?? '', /Convert the draft to an issue on GitHub/);
  await ws['kanban.issue.comment']!(c, { t: 'kanban.issue.comment', project: 'app', issueKey: key, text: 'hi', rid: 'r2' });
  assert.deepEqual(last(c, 'kanban.error'), { t: 'kanban.error', rid: 'r2', message: 'Draft issues have no comments' });
  await ws['kanban.issue.assign']!(c, { t: 'kanban.issue.assign', project: 'app', issueKey: key, to: null });
  assert.match(last(c, 'kanban.error').message, /Convert the draft/);
});

test('only issues on the project’s list; GitHub reads go by the office’s gh without a sign-in, writes are refused', async () => {
  const seen: (string | undefined)[] = [];
  const NO_SIGNIN = 'You have no GitHub sign-in: sign in (☰ → 🔐 Your sign-ins)';
  const { issues, ws, calls } = setup({
    ghAs: (id) => {
      seen.push(id);
      return id === 'nosignin' ? NO_SIGNIN : id === 'acc1' ? { env: { GH_CONFIG_DIR: '/h/acc1' } } : undefined;
    },
  });
  await issues.refresh('app');
  const c = client(false, 'acc1');
  await ws['kanban.issue.comments']!(c, { t: 'kanban.issue.comments', project: 'app', issueKey: 'gh:other/repo#1', rid: 'x' });
  assert.match(last(c, 'kanban.error').message, /isn't among the project's issues/);
  await ws['kanban.issue.comments']!(c, { t: 'kanban.issue.comments', project: 'nope', issueKey: 'gh:o/r#5' });
  assert.match(last(c, 'kanban.error').message, /no project nope/);
  seen.length = 0;
  // Without a sign-in: reads run as the office's gh ...
  const none = client(false, 'nosignin');
  for (const t of ['kanban.issue.comments', 'kanban.issue.transitions', 'kanban.issue.people'] as const) {
    const before = calls.length;
    await ws[t]!(none, { t, project: 'app', issueKey: 'gh:o/r#5' } as never);
    assert.notEqual(none.got.at(-1)!.t, 'kanban.error', t);
    assert.ok(calls.length > before && calls.slice(before).every((x) => x.env === undefined), `${t} ran as the office`);
  }
  // ... writes are refused with the reason, and gh isn't run.
  const before = calls.length;
  await ws['kanban.issue.comment']!(none, { t: 'kanban.issue.comment', project: 'app', issueKey: 'gh:o/r#5', text: 'hi', rid: 'y' });
  assert.deepEqual(last(none, 'kanban.error'), { t: 'kanban.error', rid: 'y', message: NO_SIGNIN });
  await ws['kanban.issue.assign']!(none, { t: 'kanban.issue.assign', project: 'app', issueKey: 'gh:o/r#5', to: null, rid: 'z' });
  assert.equal(last(none, 'kanban.error').message, NO_SIGNIN);
  await ws['kanban.issue.transition']!(none, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'gh:close' });
  assert.equal(last(none, 'kanban.error').message, NO_SIGNIN);
  assert.equal(calls.length, before, 'no gh ran for the writes');
  // With a sign-in, gh runs as them; the shared password (no account) is the office's gh.
  await ws['kanban.issue.comments']!(c, { t: 'kanban.issue.comments', project: 'app', issueKey: 'gh:o/r#5' });
  assert.deepEqual(calls.at(-1)!.env, { GH_CONFIG_DIR: '/h/acc1' });
  await ws['kanban.issue.comments']!(client(), { t: 'kanban.issue.comments', project: 'app', issueKey: 'gh:o/r#5' });
  assert.equal(calls.at(-1)!.env, undefined);
});

test('a status change shows at once everywhere, says who made it, and is put on the issue’s task', async () => {
  const { ctx, issues, ws } = setup({ ghAs: () => undefined, sources: [PROJECT_SOURCE] });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  await ws['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/r#5' });
  const taskId = (c.got.at(-1) as { taskId: number }).taskId;
  let wallHeard = 0;
  const off = onWallIssues('app', () => void wallHeard++);
  ctx.changed.length = 0;
  ctx.sent.length = 0;
  ctx.toasts.length = 0;
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a4', rid: 'w1' });
  off();
  assert.deepEqual(last(c, 'kanban.ok'), { t: 'kanban.ok', rid: 'w1' });
  const pushed = ctx.sent.map((s) => s.msg).find((m) => m.t === 'kanban.issues') as Extract<KanbanServerMsg, { t: 'kanban.issues' }>;
  assert.equal(pushed.items.find((i) => i.key === 'gh:o/r#5')!.status, 'Shipped', 'the kanban list is told');
  assert.ok(wallHeard >= 1, 'the 3D board is told');
  assert.equal(issues.wall('app')!.items.find((i) => i.key === 'gh:o/r#5')!.status, 'Shipped');
  assert.deepEqual(ctx.toasts, [{ floor: 'app', text: '🔀 Tester moved gh:o/r#5 → Shipped', level: 'info' }]);
  assert.ok(ctx.changed.includes(taskId));
  const lines = ctx.repo.listComments(taskId).comments.filter((x) => x.kind === 'status');
  assert.deepEqual(lines.map((x) => [x.authorKind, x.text]), [['system', 'Tester took gh:o/r#5: assigned to panu'], ['system', 'Tester moved gh:o/r#5 → Shipped']]);
});

test('closing, commenting and assigning say who did it; a closed repository issue shows as closed', async () => {
  const { ctx, issues, ws, calls } = setup({ ghAs: () => undefined });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'gh:close:not_planned' });
  assert.deepEqual(calls.at(-1)!.args, ['issue', 'close', '5', '-R', 'o/r', '--reason', 'not planned']);
  assert.equal(issues.state('app').items[0].status, 'OPEN', 'the fetched copy is kept as it is');
  assert.equal(issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.status, 'CLOSED');
  assert.equal(issues.wall('app')!.items[0].state, 'CLOSED', 'and the 3D card is a closed one');
  await ws['kanban.issue.comment']!(c, { t: 'kanban.issue.comment', project: 'app', issueKey: 'gh:o/r#5', text: 'Looks fine' });
  assert.equal(calls.at(-1)!.args.at(-1), 'body=Looks fine\n\n— Tester via Agent Office', 'signed under the office’s gh');
  await ws['kanban.issue.assign']!(c, { t: 'kanban.issue.assign', project: 'app', issueKey: 'gh:o/r#5', to: { id: 'maija' } });
  assert.equal(issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.assignee, 'maija');
  assert.deepEqual(ctx.toasts.map((t) => t.text), ['🔀 Tester moved gh:o/r#5 → Closed (not planned)', '💬 Tester commented on gh:o/r#5', '👤 Tester assigned gh:o/r#5 to maija']);
  await ws['kanban.issue.assign']!(c, { t: 'kanban.issue.assign', project: 'app', issueKey: 'gh:o/r#5', to: null });
  assert.equal('assignee' in issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!, false);
  assert.equal(ctx.toasts.at(-1)!.text, '👤 Tester unassigned gh:o/r#5');
});

test('a fetch that started before a change does not undo it; a later one, or two minutes, does', async () => {
  let clock = 1000;
  let remote = 'Doing';
  const { ctx, issues, ws } = setup({ now: () => clock, status: () => remote, sources: [PROJECT_SOURCE] });
  await issues.refresh('app');
  const shown = () => issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.status;
  assert.equal(shown(), 'Doing');
  const c = client(true, 'acc1');
  const move = () => ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a4' });
  // A fetch starts (it will still answer with the old state), then the change is made, then the fetch ends.
  clock = 2000;
  const slow = issues.refresh('app');
  clock = 3000;
  await move();
  assert.equal(shown(), 'Shipped');
  await slow;
  assert.equal(shown(), 'Shipped', 'the stale answer did not flip it back');
  assert.equal(issues.wall('app')!.items[0].status, 'Shipped');
  // Fetched 5 s after the change: still too soon to have it.
  clock = 8000;
  await issues.refresh('app');
  assert.equal(shown(), 'Shipped');
  // Fetched 10 s after: its answer is the truth now (the board was moved back by someone).
  clock = 13_000;
  await issues.refresh('app');
  assert.equal(shown(), 'Doing');
  // And two minutes without a fetch to confirm it: the change is let go.
  await move();
  assert.equal(shown(), 'Shipped');
  clock += 119_000;
  assert.equal(shown(), 'Shipped');
  clock += 2000;
  assert.equal(shown(), 'Doing');
  void ctx;
  remote = 'Doing';
});

test('a Jira key goes to Jira with the token’s identity, whoever asks', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })], { ghAs: () => 'no GitHub sign-in' });
  ctx.settings.setProject('app', { issueSources: [JIRA_SRC] });
  (ctx as unknown as { secrets: unknown }).secrets = { jira: () => JIRA_TOKEN };
  const http = fetchStub((c) => {
    if (c.url.endsWith('/search/jql')) return { body: { issues: [{ key: 'UYT-12', fields: { summary: 'Jira one', status: { name: 'Backlog' }, updated: '2026-09-01' } }], isLast: true } };
    if (c.url.includes('/transitions') && c.method === 'GET') return { body: { transitions: [{ id: '21', name: 'Send to QA', to: { name: 'Ready for QA' } }] } };
    return { status: 204 };
  });
  const gh = ghStub(() => '');
  const issues = createIssues(ctx, { gh: gh.gh, fetch: http.fetch });
  await issues.refresh('app');
  const c = client(false, 'acc1');
  await issues.plugin.ws!['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: 'UYT-12' });
  const t = last(c, 'kanban.issueTransitions');
  assert.equal(t.current, 'Backlog');
  assert.deepEqual(t.transitions.map((x) => x.id), ['21']);
  await issues.plugin.ws!['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'UYT-12', transitionId: '21' });
  assert.equal(last(c, 'kanban.ok').t, 'kanban.ok');
  assert.equal(issues.message('app').items[0].status, 'Ready for QA');
  await issues.plugin.ws!['kanban.issue.comment']!(c, { t: 'kanban.issue.comment', project: 'app', issueKey: 'UYT-12', text: 'Done here' });
  const posted = http.calls.at(-1)!;
  assert.equal(posted.method, 'POST');
  assert.match(JSON.stringify(posted.body), /Done here.*Tester via Agent Office/);
  assert.equal(gh.calls.length, 0, 'gh is never run for Jira');
  assert.equal(ctx.toasts.at(-1)!.text, '💬 Tester commented on UYT-12');
});

test('moving a board item does not turn the repository’s copy into a closed one', async () => {
  const { issues, ws } = setup({ ghAs: () => undefined });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a3' });
  assert.equal(last(c, 'kanban.ok').t, 'kanban.ok');
  assert.equal(issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.status, 'OPEN');
  assert.equal(issues.wall('app')!.items.find((i) => i.key === 'gh:o/r#5')!.state, 'OPEN');
  await ws['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: 'gh:o/r#5' });
  const names = last(c, 'kanban.issueTransitions').transitions.map((t) => t.name);
  assert.ok(names.includes('Close (completed)') && names.includes('Close (not planned)'));
  assert.ok(!names.includes('Reopen'));
});

test('GitHub “assign to me” needs a sign-in of one’s own, not the office’s', async () => {
  const { gh, calls } = ghStub(() => '');
  await assert.rejects(ghAssign(act({ gh, shared: true }), 'o/r', 5, { me: true }), /needs your own GitHub sign-in/);
  assert.equal(calls.length, 0);
  const { issues, ws } = setup({ ghAs: () => undefined });
  await issues.refresh('app');
  const c = client(true);
  await ws['kanban.issue.assign']!(c, { t: 'kanban.issue.assign', project: 'app', issueKey: 'gh:o/r#5', to: { me: true }, rid: 'm' });
  assert.match(last(c, 'kanban.error').message, /pick a person instead/);
});

test('a settling fetch follows a write by long enough to clear its change', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let clock = 1000;
  const { issues, ws, calls } = setup({ now: () => clock, sources: [PROJECT_SOURCE] });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  clock = 5000;
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a4' });
  const shown = () => issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.status;
  assert.equal(shown(), 'Shipped');
  const listed = () => calls.filter((x) => x.args.some((a) => a.startsWith('query=') && a.includes('viewer'))).length;
  const before = listed();
  mock.timers.tick(11_000);
  assert.equal(listed(), before, 'not yet');
  clock = 5000 + 12_000;
  mock.timers.tick(1000);
  await issues.refresh('app');
  assert.equal(listed(), before + 1, 'one fetch, started 12 s after the write');
  assert.equal(shown(), 'Doing', 'the fetch cleared the change');
  issues.plugin.stop?.();
});

test('closing an issue takes its queued work off the queue: by key, and by number only in the primary repository', async () => {
  for (const [primary, expected] of [['o/r', [5, 'gh:o/r#5']], ['o/app', [undefined, 'gh:o/r#5']]] as const) {
    const { ctx, issues, ws } = setup({ ghAs: () => undefined });
    const dropped: unknown[][] = [];
    ctx.floors.set('app', { def: { repo: primary }, queue: { dropIssue: (...a: unknown[]) => (dropped.push(a), true) } } as never);
    await issues.refresh('app');
    await ws['kanban.issue.transition']!(client(true, 'acc1'), { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'gh:close' });
    assert.deepEqual(dropped, [expected], primary);
    assert.equal(ctx.toasts.at(-1)!.text, '🔀 Tester moved gh:o/r#5 → Closed and took it off the queue');
    // Reopening leaves the queue alone.
    await ws['kanban.issue.transition']!(client(true, 'acc1'), { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'gh:reopen' });
    assert.equal(dropped.length, 1);
  }
});

test('a move on one board does not change the status another board’s copy shows', async () => {
  const A = { ...PROJECT_SOURCE, id: 'a', number: 1 };
  const B = { ...PROJECT_SOURCE, id: 'b', number: 2 };
  const bBoard = board({ number: 2, projectId: 'PVT_2', itemId: 'PVTI_B', status: 'Inbox' });
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })], { ghAs: () => undefined });
  ctx.settings.setProject('app', { issueSources: [A, B] });
  const { gh } = ghStub((args) => {
    const query = args.find((a) => a.startsWith('query=')) ?? '';
    if (query.includes('updateProjectV2ItemFieldValue')) return '{"data":{}}';
    if (query.includes('projectItems')) return issueItems(board(), bBoard);
    return projectPage('Doing');
  });
  const issues = createIssues(ctx, { gh, fetch: fetchStub(() => ({ body: {} })).fetch });
  await issues.refresh('app');
  const shown = () => issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!;
  assert.equal(shown().sourceId, 'a', 'board A’s copy is the one kept');
  const c = client(true, 'acc1');
  const ws = issues.plugin.ws!;
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_2:PVTI_B:PVTSSF_1:a4' });
  assert.equal(last(c, 'kanban.ok').t, 'kanban.ok');
  assert.equal(shown().status, 'Doing', 'B was moved, A’s copy keeps A’s status');
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a4' });
  assert.equal(shown().status, 'Shipped');
});

test('a comment under the office’s gh is signed, and goes on the issue’s task as a status line', async () => {
  const { ctx, issues, ws, calls } = setup({ ghAs: () => undefined });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  await ws['kanban.issues.createTask']!(c, { t: 'kanban.issues.createTask', project: 'app', issueKey: 'gh:o/r#5' });
  const taskId = (c.got.at(-1) as { taskId: number }).taskId;
  ctx.changed.length = 0;
  await ws['kanban.issue.comment']!(c, { t: 'kanban.issue.comment', project: 'app', issueKey: 'gh:o/r#5', text: 'Looks fine', rid: 'c1' });
  assert.deepEqual(last(c, 'kanban.ok'), { t: 'kanban.ok', rid: 'c1' });
  const post = calls.at(-1)!;
  assert.equal(post.env, undefined, 'the office’s gh');
  assert.ok(post.args.at(-1)!.endsWith('\n\n— Tester via Agent Office'));
  const lines = ctx.repo.listComments(taskId).comments.filter((x) => x.kind === 'status');
  assert.deepEqual(lines.map((x) => [x.authorKind, x.text]), [['system', 'Tester took gh:o/r#5: assigned to panu'], ['system', 'Tester commented on gh:o/r#5']], 'the task took the issue first');
  assert.ok(ctx.changed.includes(taskId));
});

test('open or closed is GitHub’s word now: a board’s copy offers Reopen when closed, a repository’s stale one too', async () => {
  let state = 'CLOSED';
  for (const sources of [[PROJECT_SOURCE], [REPO_SRC, PROJECT_SOURCE]]) {
    const { issues, ws, calls } = setup({ ghAs: () => undefined, state: () => state, sources });
    await issues.refresh('app');
    const c = client(true, 'acc1');
    await ws['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: 'gh:o/r#5' });
    const names = last(c, 'kanban.issueTransitions').transitions.map((t) => t.name);
    assert.ok(names.includes('Reopen') && !names.some((n) => n.startsWith('Close')), names.join());
    assert.ok(calls.some((x) => x.args[0] === 'issue' && x.args[1] === 'view' && x.args.at(-1) === 'state'));
    state = 'OPEN';
    await ws['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: 'gh:o/r#5' });
    const open = last(c, 'kanban.issueTransitions').transitions.map((t) => t.name);
    assert.ok(open.includes('Close (completed)') && !open.includes('Reopen'), open.join());
    state = 'CLOSED';
  }
});

test('an issue acted on can be acted on again after the list has lost it (Reopen), for a while', async () => {
  let clock = 1000;
  let state = 'OPEN';
  let listed = true;
  const { ctx, issues, ws, calls } = setup({ ghAs: () => undefined, now: () => clock, state: () => state, listed: () => listed, sources: [PROJECT_SOURCE] });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'gh:close' });
  assert.deepEqual(calls.at(-1)!.args.slice(0, 3), ['issue', 'close', '5']);
  // GitHub closed it; the next fetch no longer lists it.
  state = 'CLOSED';
  listed = false;
  clock = 20_000;
  await issues.refresh('app');
  assert.ok(!issues.message('app').items.some((i) => i.key === 'gh:o/r#5'), 'gone from the list');
  assert.ok(!issues.wall('app')!.items.some((i) => i.key === 'gh:o/r#5'), 'and from the board');
  await ws['kanban.issue.transitions']!(c, { t: 'kanban.issue.transitions', project: 'app', issueKey: 'gh:o/r#5' });
  assert.ok(last(c, 'kanban.issueTransitions').transitions.some((t) => t.id === 'gh:reopen'));
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'gh:reopen', rid: 'ro' });
  assert.deepEqual(last(c, 'kanban.ok'), { t: 'kanban.ok', rid: 'ro' });
  assert.deepEqual(calls.at(-1)!.args.slice(0, 3), ['issue', 'reopen', '5']);
  assert.ok(ctx.toasts.at(-1)!.text.endsWith('→ Open'));
  // Other keys are still refused, and so is this one once the memory has run out.
  await ws['kanban.issue.comments']!(c, { t: 'kanban.issue.comments', project: 'app', issueKey: 'gh:o/r#6' });
  assert.match(last(c, 'kanban.error').message, /isn't among/);
  clock += 31 * 60_000;
  await ws['kanban.issue.comments']!(c, { t: 'kanban.issue.comments', project: 'app', issueKey: 'gh:o/r#5' });
  assert.match(last(c, 'kanban.error').message, /isn't among/);
});

test('the settling fetch waits for one already under way, so one that started late enough always runs', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let clock = 1000;
  let release!: () => void;
  let hold = false;
  const { issues, ws, calls } = setup({ now: () => clock, sources: [PROJECT_SOURCE], hold: () => (hold ? ((hold = false), new Promise<void>((r) => (release = r))) : undefined) });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  clock = 5000;
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a4' });
  const shown = () => issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.status;
  assert.equal(shown(), 'Shipped');
  // A fetch starts (too early to have seen the change) and is still running when the timer fires.
  clock = 6000;
  hold = true;
  const early = issues.refresh('app');
  const fetches = () => calls.filter((x) => x.args.some((a) => a.startsWith('query=') && a.includes('viewer'))).length;
  const was = fetches();
  clock = 17_000;
  mock.timers.tick(12_000);
  assert.equal(fetches(), was, 'the timer started no second fetch beside the held one');
  release();
  await early;
  assert.equal(shown(), 'Shipped', 'the early fetch did not clear the change');
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(fetches(), was + 2, 'a fresh fetch followed it');
  assert.equal(shown(), 'Doing', 'and it, started 12 s after the write, did');
  issues.plugin.stop?.();
});

test('reading an issue does not drop its change, and the lists do not mutate on read', async () => {
  let clock = 1000;
  const { issues, ws } = setup({ now: () => clock, sources: [PROJECT_SOURCE] });
  await issues.refresh('app');
  const c = client(true, 'acc1');
  await ws['kanban.issue.transition']!(c, { t: 'kanban.issue.transition', project: 'app', issueKey: 'gh:o/r#5', transitionId: 'p:PVT_1:PVTI_1:PVTSSF_1:a4' });
  const status = () => issues.message('app').items.find((i) => i.key === 'gh:o/r#5')!.status;
  clock += 121_000;
  assert.equal(status(), 'Doing', 'past its time to live it is not shown');
  clock = 3000;
  assert.equal(status(), 'Shipped', 'reading did not delete it: it shows again when the clock says it is young');
});
