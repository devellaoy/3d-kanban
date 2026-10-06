import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickJiraConnection, type JiraConnection } from '../src/server/kanban/integrations/issues/jira-auth.js';
import { route } from '../src/server/kanban/integrations/issues/actions.js';
import { jiraSource } from '../src/server/kanban/integrations/issues/jira.js';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { setWallProvider } from '../src/server/kanban/integrations/issues/wall.js';
import type { IssueSourceIo } from '../src/server/kanban/integrations/issues/source.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

const conn = (id: string, site: string, name = id): JiraConnection => ({ id, name, site, email: `${id}@x.fi`, token: `tok-${id}` });
const basic = (c: JiraConnection) => `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`;

// --- Picking ----------------------------------------------------------------------------------------

test('the picker: the first connection for the site, the named one when a source names it, and a readable error otherwise', () => {
  const a = conn('a', 'a.atlassian.net', 'Customer A');
  const b1 = conn('b1', 'b.atlassian.net');
  const b2 = conn('b2', 'B.atlassian.net');
  const list = [a, b1, b2];
  assert.equal(pickJiraConnection(list, { site: 'a.atlassian.net' }), a);
  assert.equal(pickJiraConnection(list, { site: 'b.atlassian.net' }), b1, 'two on one site: the first');
  assert.equal(pickJiraConnection(list, { site: 'b.atlassian.net', connection: 'b2' }), b2, 'unless the source chose');
  assert.equal(pickJiraConnection(list, { site: 'A.ATLASSIAN.NET' }), a, 'the site in any case');
  assert.throws(() => pickJiraConnection(list, { site: 'a.atlassian.net', connection: 'gone' }), /connection this source uses was removed: pick another in 📁 Projects → Issue sources/);
  assert.throws(() => pickJiraConnection(list, { site: 'b.atlassian.net', connection: 'a' }), /The Jira connection Customer A is for a.atlassian.net, not b.atlassian.net/);
  assert.throws(() => pickJiraConnection(list, { site: 'c.atlassian.net' }), /No Jira connection for c.atlassian.net: an admin adds one in ⚙️ Settings → 🗂️ Kanban/);
  assert.throws(() => pickJiraConnection([], { site: 'a.atlassian.net' }), /No Jira connection for a.atlassian.net/);
});

test('a source naming a connection of another site never reaches the network', async () => {
  let fetched = 0;
  const io: IssueSourceIo = { gh: async () => '', fetch: (async () => (fetched++, new Response('{}'))) as typeof fetch, cwd: '/tmp', projectRepos: [], jira: [conn('a', 'a.atlassian.net'), conn('b', 'b.atlassian.net')] };
  const source = (site: string, connection?: string): IssueSourceConfig => ({ id: 's', kind: 'jira', site, projectKeys: ['X'], filters: {}, ...(connection ? { connection } : {}) });
  await assert.rejects(jiraSource.list(source('b.atlassian.net', 'a'), io), /is for a.atlassian.net, not b.atlassian.net/);
  await assert.rejects(jiraSource.list(source('b.atlassian.net', 'gone'), io), /was removed/);
  await assert.rejects(jiraSource.list(source('c.atlassian.net'), io), /No Jira connection for c.atlassian.net/);
  assert.equal(fetched, 0);
});

// --- Two sites in one project -------------------------------------------------------------------------

interface Call { host: string; path: string; method: string; auth: string; body?: any }

/** A Jira per site: AAA-1 on a, BBB-1 on b (or whatever the source's key is), answering what the actions ask. */
function jiras() {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = { host: u.host, path: u.pathname + u.search, method: String(init.method), auth: String((init.headers as Record<string, string>).authorization), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = u.host.startsWith('a.') ? 'AAA' : u.host.startsWith('b.') ? 'BBB' : 'CCC';
    const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
    if (u.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: `${key}-1`, fields: { summary: `On ${u.host}`, status: { name: 'To Do' }, project: { key }, updated: '2026-09-01' } }], isLast: true });
    if (u.pathname === '/rest/api/3/field') return json([]);
    if (u.pathname.endsWith('/approximate-count')) return json({ count: 3 });
    if (u.pathname === '/rest/api/3/myself') return json({ displayName: `Ada on ${u.host}`, accountId: `acc-${key}` });
    if (u.pathname.endsWith('/transitions') && call.method === 'GET') return json({ transitions: [{ id: '21', name: 'Go', to: { name: 'Doing' } }] });
    if (u.pathname.endsWith('/assignable/search')) return json([{ accountId: 'u1', displayName: 'Maija' }]);
    return json({}, 204);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const last = <T extends KanbanServerMsg['t']>(c: { got: KanbanServerMsg[] }, t: T) => c.got.at(-1) as Extract<KanbanServerMsg, { t: T }>;

function setup(sources: (ids: Record<string, string>) => IssueSourceConfig[], hold: { gate?: Promise<void> } = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' })]);
  const ids: Record<string, string> = {};
  for (const [name, site] of [['ca', 'a.atlassian.net'], ['cb', 'b.atlassian.net'], ['cb2', 'b.atlassian.net']]) {
    ctx.secrets.setJiraConnection({ name, site, email: `${name}@x.fi`, token: `tok-${name}` });
    ids[name] = ctx.secrets.jiraConnections().find((c) => c.name === name)!.id;
  }
  ctx.settings.setProject('app', { issueSources: sources(ids) });
  const http = jiras();
  const held = (async (u: string, init: RequestInit) => {
    if (String(u).endsWith('/approximate-count') && hold.gate) await hold.gate;
    return http.fetch(u, init);
  }) as unknown as typeof fetch;
  const issues = createIssues(ctx, { gh: (async () => '[]') as never, fetch: held });
  const ws = issues.plugin.ws! as Record<string, (c: unknown, m: unknown) => Promise<void> | void>;
  const c = client(true, 'acc1');
  const ask = async (t: string, m: Record<string, unknown>) => {
    c.got.length = 0;
    await ws[t](c, { t, project: 'app', rid: 'r1', ...m });
    return c.got.at(-1) as any;
  };
  const authOf = (name: string) => basic({ ...conn(name, ''), email: `${name}@x.fi`, token: `tok-${name}` });
  return { ctx, ids, http, issues, ask, c, authOf };
}

test('a project with Jira on two sites: every call goes to its own site with its own connection', async () => {
  const { ids, http, issues, ask, authOf } = setup((i) => [
    { id: 'sa', kind: 'jira', site: 'a.atlassian.net', connection: i.ca, projectKeys: ['AAA'], filters: {} },
    { id: 'sb', kind: 'jira', site: 'b.atlassian.net', connection: i.cb2, projectKeys: ['BBB'], filters: {} },
  ]);
  const expectHost = (from: number, host: string, auth: string) => {
    const made = http.calls.slice(from);
    assert.ok(made.length > 0);
    for (const c of made) assert.deepEqual([c.host, c.auth], [host, auth], `${c.method} ${c.path}`);
  };

  // The list: one search per source.
  await issues.refresh('app');
  assert.deepEqual(issues.message('app').items.map((i) => [i.key, i.sourceId]).sort(), [['AAA-1', 'sa'], ['BBB-1', 'sb']]);
  for (const c of http.calls) assert.equal(c.auth, c.host.startsWith('a.') ? authOf('ca') : authOf('cb2'), `search of ${c.host} uses the source's connection (cb2, not the first on b)`);
  assert.deepEqual(new Set(http.calls.map((c) => c.host)), new Set(['a.atlassian.net', 'b.atlassian.net']));

  // The actions: by the issue's key, to the site and connection of the source that lists it.
  for (const [key, host, auth] of [['AAA-1', 'a.atlassian.net', authOf('ca')], ['BBB-1', 'b.atlassian.net', authOf('cb2')]] as const) {
    let n = http.calls.length;
    assert.equal((await ask('kanban.issue.transitions', { issueKey: key })).t, 'kanban.issueTransitions');
    expectHost(n, host, auth);
    n = http.calls.length;
    assert.equal((await ask('kanban.issue.transition', { issueKey: key, transitionId: '21' })).t, 'kanban.ok');
    expectHost(n, host, auth);
    assert.ok(http.calls.slice(n).some((c) => c.method === 'POST' && c.path.endsWith('/transitions')));
    n = http.calls.length;
    assert.equal((await ask('kanban.issue.comment', { issueKey: key, text: 'Hi' })).t, 'kanban.ok');
    expectHost(n, host, auth);
    assert.ok(http.calls.slice(n).some((c) => c.method === 'POST' && c.path.endsWith('/comment')));
    n = http.calls.length;
    assert.equal((await ask('kanban.issue.comments', { issueKey: key })).t, 'kanban.issueComments');
    expectHost(n, host, auth);
    n = http.calls.length;
    assert.equal((await ask('kanban.issue.people', { issueKey: key, query: 'ma' })).t, 'kanban.issuePeople');
    expectHost(n, host, auth);
    n = http.calls.length;
    assert.equal((await ask('kanban.issue.assign', { issueKey: key, to: { id: 'u1', name: 'Maija' } })).t, 'kanban.ok');
    expectHost(n, host, auth);
    assert.ok(http.calls.slice(n).some((c) => c.method === 'PUT' && c.path.endsWith('/assignee')));
  }

  // A browse page.
  for (const [scope, host, auth] of [['sa', 'a.atlassian.net', authOf('ca')], ['sb', 'b.atlassian.net', authOf('cb2')]] as const) {
    const n = http.calls.length;
    assert.equal((await ask('kanban.browse.page', { scope, filters: { statusCategory: 'all' } })).t, 'kanban.browsePage');
    expectHost(n, host, auth);
  }
  void ids;
});

test('a removed connection fails only the sources that name it, and sends nothing to their site', async () => {
  const { ctx, ids, http, issues, ask, authOf } = setup((i) => [
    { id: 'sa', kind: 'jira', site: 'a.atlassian.net', connection: i.ca, projectKeys: ['AAA'], filters: {} },
    { id: 'sb', kind: 'jira', site: 'b.atlassian.net', connection: i.cb, projectKeys: ['BBB'], filters: {} },
  ]);
  await issues.refresh('app');
  const n = http.calls.length;
  // Another connection's removal: the source that names it fails to list, the other goes on.
  ctx.secrets.removeJiraConnection(ids.cb);
  await issues.refresh('app');
  assert.deepEqual(issues.message('app').items.map((i) => i.key), ['AAA-1']);
  assert.match(issues.message('app').error ?? '', /connection this source uses was removed/);
  assert.ok(!http.calls.slice(n).some((c) => c.host === 'b.atlassian.net'), 'nothing went to b');
  assert.ok(http.calls.slice(n).every((c) => c.auth === authOf('ca')));
  const m = http.calls.length;
  assert.equal((await ask('kanban.issue.comment', { issueKey: 'BBB-1', text: 'Hi' })).t, 'kanban.error');
  assert.equal(http.calls.length, m, 'and nothing was sent for its issue');
});

test('routing an issue: its own source, else the source whose projects hold its key, else the first Jira source', () => {
  const src = (id: string, site: string, keys: string[], connection?: string): IssueSourceConfig => ({ id, kind: 'jira', site, projectKeys: keys, filters: {}, ...(connection ? { connection } : {}) });
  const sources = [src('sa', 'a.atlassian.net', ['AAA'], 'ca'), src('sb', 'b.atlassian.net', ['BBB'], 'cb')];
  const issue = (key: string, sourceId?: string) => ({ source: 'jira' as const, key, title: '', url: '', body: '', labels: [], updatedAt: '', ...(sourceId ? { sourceId } : {}) });
  assert.deepEqual(route(sources, issue('AAA-9', 'sb')), { kind: 'jira', site: 'b.atlassian.net', connection: 'cb' }, 'the source that listed it');
  assert.deepEqual(route(sources, issue('bbb-9')), { kind: 'jira', site: 'b.atlassian.net', connection: 'cb' }, 'the key’s project');
  assert.deepEqual(route(sources, issue('ZZZ-1')), { kind: 'jira', site: 'a.atlassian.net', connection: 'ca' }, 'the first');
  assert.deepEqual(route([src('s', 'c.atlassian.net', [])], issue('ZZZ-1')), { kind: 'jira', site: 'c.atlassian.net' });
  assert.equal(route([], issue('ZZZ-1')), 'The project has no Jira source');

  // The issue's own site decides: a source on another site is never a fallback.
  const at = (key: string, host: string, sourceId?: string) => ({ ...issue(key, sourceId), url: `https://${host}/browse/${key}` });
  assert.deepEqual(route(sources, at('AAA-12', 'a.atlassian.net', 'sa')), { kind: 'jira', site: 'a.atlassian.net', connection: 'ca' }, 'happy path');
  assert.deepEqual(route(sources, at('AAA-12', 'A.atlassian.net', 'sb')), { kind: 'jira', site: 'a.atlassian.net', connection: 'ca' }, 'a source id of another site is not taken');
  const noA = "AAA-12's Jira source (on a.atlassian.net) is no longer one of the project's: re-add it to act on the issue";
  assert.equal(route([sources[1]], at('AAA-12', 'a.atlassian.net', 'sa')), noA, 'its source was removed');
  assert.equal(route([src('sa', 'b.atlassian.net', ['AAA'], 'cb'), sources[1]], at('AAA-12', 'a.atlassian.net', 'sa')), noA, 'its source id now names another site');
});

// --- The WS handlers ----------------------------------------------------------------------------------

test('the connection handlers: admins only, the answer is the list without e-mail or token, test asks Jira who the connection is', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' }), def('docs', '/tmp/docs')]);
  const http = jiras();
  const issues = createIssues(ctx, { gh: (async () => '[]') as never, fetch: http.fetch });
  const ws = issues.plugin.ws! as Record<string, (c: unknown, m: unknown) => Promise<void> | void>;
  const boss = client(true);
  const guest = client(false);
  const call = async (c: ReturnType<typeof client>, t: string, m: Record<string, unknown>) => {
    c.got.length = 0;
    await ws[t](c, { t, rid: 'r', ...m });
    return c.got.at(-1) as any;
  };

  const denied = await call(guest, 'kanban.secrets.jira.set', { name: 'X', site: 'a.atlassian.net', email: 'e', token: 't' });
  assert.equal(denied.t, 'kanban.error');
  assert.deepEqual(ctx.secrets.jiraConnections(), []);

  const added = await call(boss, 'kanban.secrets.jira.set', { name: 'Customer A', site: 'a.atlassian.net', email: 'boss@a.fi', token: 'TOPSECRET' });
  assert.equal(added.t, 'kanban.settings');
  assert.equal(added.rid, 'r');
  const id = ctx.secrets.jiraConnections()[0].id;
  assert.deepEqual(added.secrets, { jira: [{ id, name: 'Customer A', site: 'a.atlassian.net', configured: true }], apiKey: { configured: false } });
  const pushed = ctx.sent.filter((s) => s.msg.t === 'kanban.settings');
  assert.equal(pushed.length, 1, 'everyone is told');
  assert.ok(!JSON.stringify([boss.got, ctx.sent]).includes('TOPSECRET'));
  assert.ok(!JSON.stringify([boss.got, ctx.sent]).includes('boss@a.fi'));

  // A bad edit is an error and changes nothing.
  assert.match((await call(boss, 'kanban.secrets.jira.set', { id, name: 'Customer A', site: 'b.atlassian.net' })).message, /needs the API token again/);
  assert.match((await call(boss, 'kanban.secrets.jira.set', { id: 'nope', name: 'x', site: 'a.atlassian.net' })).message, /No such Jira connection/);
  assert.equal(ctx.secrets.jiraConnections()[0].site, 'a.atlassian.net');

  // Test: who Jira says it is, with that connection's own login.
  assert.equal((await call(guest, 'kanban.secrets.jira.test', { id })).t, 'kanban.error');
  const tested = await call(boss, 'kanban.secrets.jira.test', { id });
  assert.deepEqual(tested, { t: 'kanban.secrets.jiraTested', rid: 'r', id, name: 'Ada on a.atlassian.net', accountId: 'acc-AAA' });
  assert.deepEqual([http.calls.at(-1)!.host, http.calls.at(-1)!.path, http.calls.at(-1)!.auth], ['a.atlassian.net', '/rest/api/3/myself', basic(ctx.secrets.jiraConnections()[0])]);
  assert.match((await call(boss, 'kanban.secrets.jira.test', { id: 'nope' })).message, /No such Jira connection/);

  // A Jira that turns the login down is an error with Jira's words.
  const refusing = createIssues(ctx, { gh: (async () => '[]') as never, fetch: (async () => new Response(JSON.stringify({ errorMessages: ['nope'] }), { status: 401 })) as typeof fetch });
  boss.got.length = 0;
  await (refusing.plugin.ws as any)['kanban.secrets.jira.test'](boss, { t: 'kanban.secrets.jira.test', rid: 'r2', id });
  assert.match((boss.got.at(-1) as any).message, /turned the e-mail and API token down \(401\): nope/);

  // Remove.
  assert.equal((await call(guest, 'kanban.secrets.jira.remove', { id })).t, 'kanban.error');
  assert.equal(ctx.secrets.jiraConnections().length, 1);
  const removed = await call(boss, 'kanban.secrets.jira.remove', { id });
  assert.deepEqual(removed.secrets.jira, []);
  assert.match((await call(boss, 'kanban.secrets.jira.remove', { id })).message, /No such Jira connection/);
});

test('saving a connection makes the projects with a Jira source fetch their issues again', async () => {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/r' }), def('docs', '/tmp/docs')]);
  ctx.settings.setProject('app', { issueSources: [{ id: 'sa', kind: 'jira', site: 'a.atlassian.net', projectKeys: ['AAA'], filters: {} }] });
  const http = jiras();
  const issues = createIssues(ctx, { gh: (async () => '[]') as never, fetch: http.fetch });
  issues.plugin.start?.();
  try {
    const boss = client(true);
    await issues.refresh('app');
    assert.match(issues.message('app').error ?? '', /No Jira connection for a.atlassian.net/);
    await (issues.plugin.ws as any)['kanban.secrets.jira.set'](boss, { t: 'kanban.secrets.jira.set', name: 'A', site: 'a.atlassian.net', email: 'e', token: 't', rid: 'r' });
    // The new connection is tried now, without waiting for the next round.
    for (let i = 0; i < 50 && !issues.message('app').items.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(issues.message('app').items.map((i) => i.key), ['AAA-1']);
    assert.equal(issues.message('app').error, undefined);
  } finally {
    issues.plugin.stop?.();
    setWallProvider(undefined);
  }
});

test('saving a connection clears what Browse cached, so the next count is asked again', async () => {
  const { ctx, http, ask, issues } = setup((i) => [{ id: 'sa', kind: 'jira', site: 'a.atlassian.net', connection: i.ca, projectKeys: ['AAA'], filters: {} }]);
  const counts = () => http.calls.filter((c) => c.path.endsWith('/approximate-count')).length;
  const count = () => ask('kanban.browse.count', { scope: 'sa', filters: { statusCategory: 'all' }, group: 'none' });
  assert.equal((await count()).count, 3);
  await count();
  assert.equal(counts(), 1, 'the second came from the cache');
  const id = ctx.secrets.jiraConnections()[0].id;
  await (issues.plugin.ws as any)['kanban.secrets.jira.set'](client(true), { t: 'kanban.secrets.jira.set', id, name: 'A', site: 'a.atlassian.net', token: 'new-token', rid: 'r' });
  await count();
  assert.equal(counts(), 2, 'asked again with the new token');
  assert.equal(http.calls.at(-1)!.auth, basic(ctx.secrets.jiraConnections()[0]));
  await (issues.plugin.ws as any)['kanban.secrets.jira.remove'](client(true), { t: 'kanban.secrets.jira.remove', id, rid: 'r' });
  assert.match((await count()).message, /was removed/);
});

test('two sources on one site with different connections: an action goes through the source it came through, else through the listed copy', async () => {
  const { http, issues, ask, authOf } = setup((i) => [
    { id: 'sb', kind: 'jira', site: 'b.atlassian.net', connection: i.cb, projectKeys: ['BBB'], filters: {} },
    { id: 'sb2', kind: 'jira', site: 'b.atlassian.net', connection: i.cb2, projectKeys: ['BBB'], filters: {} },
    { id: 'sa', kind: 'jira', site: 'a.atlassian.net', connection: i.ca, projectKeys: ['AAA'], filters: {} },
  ]);
  await issues.refresh('app');
  assert.equal(issues.message('app').items.find((i) => i.key === 'BBB-1')!.sourceId, 'sb', 'the list keeps the first source’s copy');
  const authOfLast = (n: number) => new Set(http.calls.slice(n).map((c) => c.auth));
  let n = http.calls.length;
  assert.equal((await ask('kanban.issue.comment', { issueKey: 'BBB-1', text: 'Hi' })).t, 'kanban.ok');
  assert.deepEqual(authOfLast(n), new Set([authOf('cb')]), 'no source: the listed copy');
  n = http.calls.length;
  assert.equal((await ask('kanban.issue.comment', { issueKey: 'BBB-1', text: 'Hi', source: 'sb2' })).t, 'kanban.ok');
  assert.deepEqual(authOfLast(n), new Set([authOf('cb2')]), 'the source it was opened through');
  n = http.calls.length;
  assert.equal((await ask('kanban.issue.assign', { issueKey: 'BBB-1', source: 'sb2', to: { id: 'u1' } })).t, 'kanban.ok');
  assert.deepEqual(authOfLast(n), new Set([authOf('cb2')]));
  // A source of another site, one that isn't the project's, and one that doesn't cover the key's project are refused, and nothing is sent.
  n = http.calls.length;
  assert.match((await ask('kanban.issue.comment', { issueKey: 'BBB-1', text: 'Hi', source: 'sa' })).message, /sa isn't a Jira source for BBB-1 on b.atlassian.net/);
  assert.match((await ask('kanban.issue.comment', { issueKey: 'BBB-1', text: 'Hi', source: 'nope' })).message, /nope isn't one of the project's issue sources/);
  assert.equal(http.calls.length, n);
});

test('a count read before a connection changed is not kept: the next one is asked again with the new login', async () => {
  const hold: { gate?: Promise<void> } = {};
  const { ctx, http, ask, issues } = setup((i) => [{ id: 'sa', kind: 'jira', site: 'a.atlassian.net', connection: i.ca, projectKeys: ['AAA'], filters: {} }], hold);
  const counts = () => http.calls.filter((c) => c.path.endsWith('/approximate-count'));
  const count = () => ask('kanban.browse.count', { scope: 'sa', filters: { statusCategory: 'all' }, group: 'none' });
  let release!: () => void;
  hold.gate = new Promise<void>((r) => (release = r));
  const old = count();
  const id = ctx.secrets.jiraConnections()[0].id;
  await (issues.plugin.ws as any)['kanban.secrets.jira.set'](client(true), { t: 'kanban.secrets.jira.set', id, name: 'A', site: 'a.atlassian.net', token: 'new-token', rid: 'r' });
  hold.gate = undefined;
  release();
  await old;
  assert.equal((await count()).count, 3);
  assert.equal(counts().length, 2, 'the old read did not fill the new cache');
  assert.equal(counts().at(-1)!.auth, basic(ctx.secrets.jiraConnections()[0]));
});
