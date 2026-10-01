import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JQL_INCOMPLETE, browseJql, checkUserJql, keyProject, scopeClause } from '../src/server/kanban/integrations/issues/browse/jql.js';
import { projectQuery } from '../src/server/kanban/integrations/issues/browse/projectquery.js';
import { parseBrowseFilters, parseBrowseMsg } from '../src/shared/kanban/browse.js';
import type { BrowseFilters } from '../src/shared/kanban/browse.js';

const SCOPE = { projectKeys: ['UYT', 'APP'] };
const jql = (f: BrowseFilters = {}, where = {}, order = true) => browseJql(SCOPE, f, where, order);
const SCOPE_JQL = 'project IN ("UYT", "APP")';

test('the scope comes first, always, and the default is everything not done, newest first', () => {
  assert.equal(jql(), `${SCOPE_JQL} AND statusCategory != Done ORDER BY updated DESC`);
  assert.equal(jql({}, {}, false), `${SCOPE_JQL} AND statusCategory != Done`, 'a count takes no ORDER BY');
  assert.ok(jql({ q: 'x', jql: 'a = 1', labels: ['l'], assignee: { any: true } }, { parent: 'UYT-1' }).startsWith(`${SCOPE_JQL} AND `));
});

test('a source with no project keys is not browsable: no scope, no query', () => {
  assert.throws(() => browseJql({ projectKeys: [] }, {}), /Add project keys/);
  assert.throws(() => scopeClause({ projectKeys: [] }), /Add project keys/);
  assert.equal(keyProject('uyt-12'), 'UYT');
});

test('each filter is its JQL clause', () => {
  const one = (f: BrowseFilters, where = {}) => jql(f, where).replace(`${SCOPE_JQL} AND `, '').replace(' ORDER BY updated DESC', '');
  assert.equal(one({ q: 'login bug' }), 'text ~ "login bug" AND statusCategory != Done');
  assert.equal(one({ q: 'uyt-12' }), '(text ~ "uyt-12" OR key = "UYT-12") AND statusCategory != Done');
  assert.equal(one({ statusCategory: 'new' }), 'statusCategory = "To Do"');
  assert.equal(one({ statusCategory: 'indeterminate' }), 'statusCategory = "In Progress"');
  assert.equal(one({ statusCategory: 'done' }), 'statusCategory = Done');
  assert.equal(jql({ statusCategory: 'all' }, {}, false), SCOPE_JQL, 'all: only the scope');
  assert.equal(one({ statusCategory: 'all', status: 'In Review' }), 'status = "In Review"');
  assert.equal(one({ statusCategory: 'all', issueType: 'Bug' }), 'issuetype = "Bug"');
  assert.equal(one({ statusCategory: 'all', labels: ['a', 'b c'] }), 'labels = "a" AND labels = "b c"');
  assert.equal(one({ statusCategory: 'all', version: '10001' }), 'fixVersion = 10001');
  assert.equal(one({ statusCategory: 'all', version: 'none' }), 'fixVersion is EMPTY');
  assert.equal(one({ statusCategory: 'all', sprint: 'open' }), 'sprint in openSprints()');
  assert.equal(one({ statusCategory: 'all', sprint: '42' }), 'sprint = 42');
  assert.equal(one({ statusCategory: 'all', epic: 'UYT-5' }), 'parent = "UYT-5"');
  assert.equal(one({ statusCategory: 'all', epic: 'none' }), 'parent is EMPTY');
  assert.equal(one({ statusCategory: 'all', assignee: { id: '71:a-b' } }), 'assignee = "71:a-b"');
  assert.equal(one({ statusCategory: 'all', assignee: { none: true } }), 'assignee is EMPTY');
  assert.equal(one({ statusCategory: 'all', assignee: { any: true } }), 'assignee is not EMPTY');
  assert.equal(one({ statusCategory: 'all', jql: 'priority = High' }), '(priority = High)');
});

test('where in the tree: top level leaves sub-tasks out, a version, an epic, a parent', () => {
  const f: BrowseFilters = { statusCategory: 'all' };
  assert.equal(jql(f, { topLevel: true, version: '7', epic: 'UYT-5' }, false), `${SCOPE_JQL} AND issuetype not in subTaskIssueTypes() AND fixVersion = 7 AND parent = "UYT-5"`);
  assert.equal(jql(f, { version: 'none', epic: 'none' }, false), `${SCOPE_JQL} AND fixVersion is EMPTY AND parent is EMPTY`);
  assert.equal(jql(f, { parent: 'UYT-9' }, false), `${SCOPE_JQL} AND parent = "UYT-9"`);
  assert.throws(() => jql(f, { version: 'released' }), /version must be an id/);
  assert.throws(() => jql(f, { epic: 'UYT-5" OR project = B' }), /isn’t a Jira issue key/);
  assert.throws(() => jql(f, { parent: 'x y' }), /isn’t a Jira issue key/);
});

test('values are quoted: quotes, backslashes and line breaks cannot end the string', () => {
  const q = jql({ statusCategory: 'all', status: 'a" OR project = B OR "b', labels: ['x\\', 'l1\nl2'], q: 'say "hi" \\' });
  assert.ok(q.includes('status = "a\\" OR project = B OR \\"b"'));
  assert.ok(q.includes('labels = "x\\\\"'));
  assert.ok(q.includes('labels = "l1 l2"'));
  assert.ok(q.includes('text ~ "say \\"hi\\" \\\\"'));
  assert.ok(!q.includes('\n'));
});

test('user JQL cannot break out of the scope: unbalanced parentheses and quotes are refused', () => {
  for (const bad of ['x) OR (project = B', 'a = 1) OR (project = B', ') OR project = B', '(a = 1', 'a = "b', "a = 'b", 'a = "b\\"', 'a = 1 ORDER BY created', 'a = 1 order   by x']) {
    assert.throws(() => checkUserJql(bad), /complete expression|ORDER BY/, bad);
    assert.throws(() => jql({ jql: bad }), /complete expression|ORDER BY/, bad);
  }
  assert.throws(() => checkUserJql('x) OR (project = B'), new RegExp(JQL_INCOMPLETE.replace(/[()]/g, '\\$&')));
  // Parentheses and ORDER BY inside a literal are only text.
  for (const good of ['summary ~ ") OR (project = B"', "summary ~ 'a ) b'", 'summary ~ "order by x"', '(a = 1 OR b = 2) AND c = "d\\"e)"', 'priority in (High, Low)']) checkUserJql(good);
  assert.equal(jql({ statusCategory: 'all', jql: 'a = 1 OR b = 2' }), `${SCOPE_JQL} AND (a = 1 OR b = 2) ORDER BY updated DESC`, 'AND-ed in parentheses');
});

// --- GitHub ---------------------------------------------------------------------------------------

test('a board query: the filters and the group in the board’s own syntax', () => {
  assert.equal(projectQuery({}), 'is:open');
  assert.equal(projectQuery({ statusCategory: 'done' }), 'is:closed');
  assert.equal(projectQuery({ statusCategory: 'all' }), '');
  assert.equal(projectQuery({ statusCategory: 'new' }), 'is:open');
  assert.equal(projectQuery({ status: 'In review', iteration: 'Sprint 3', issueType: 'Bug', labels: ['a b'], assignee: { id: 'maija' }, q: 'login' }), 'is:open status:"In review" iteration:"Sprint 3" type:"Bug" label:"a b" assignee:maija "login"');
  assert.equal(projectQuery({ assignee: { none: true }, statusCategory: 'all' }), 'no:assignee');
  assert.equal(projectQuery({ assignee: { any: true }, statusCategory: 'all' }), 'has:assignee');
  assert.equal(projectQuery({}, 'i:Sprint 3'), 'is:open iteration:"Sprint 3"');
  assert.equal(projectQuery({}, 's:🏗 In progress'), 'is:open status:"🏗 In progress"');
  assert.equal(projectQuery({}, 'no:iteration'), 'is:open no:iteration');
  assert.equal(projectQuery({}, 'no:status'), 'is:open no:status');
  assert.throws(() => projectQuery({}, 'x'), /isn’t a group/);
});

test('a board query refuses a double quote, and never uses @me', () => {
  assert.throws(() => projectQuery({ status: 'a" OR "b' }), /quotes/);
  assert.throws(() => projectQuery({ labels: ['a"'] }), /quotes/);
  assert.throws(() => projectQuery({ q: 'a"b' }), /quotes/);
  assert.throws(() => projectQuery({}, 'i:a"b'), /quotes/);
  assert.ok(!projectQuery({ assignee: { id: 'maija' } }).includes('@me'));
});

// --- The parser -----------------------------------------------------------------------------------

const parse = (r: Record<string, unknown>) => parseBrowseMsg(r.t as 'kanban.browse.page', r);
const BASE = { t: 'kanban.browse.page', project: 'app', scope: 'src1' };

test('the parser rebuilds good messages and drops what it does not know', () => {
  assert.deepEqual(parse({ ...BASE, filters: { q: ' hi ', labels: ['a'], x: 1, assignee: { id: '71:a', name: 'M' }, version: '10', epic: 'UYT-1', sprint: 'open' }, group: '10', epic: 'none', cursor: 'abc=_-', junk: 1 }), {
    t: 'kanban.browse.page',
    project: 'app',
    scope: 'src1',
    filters: { q: 'hi', labels: ['a'], assignee: { id: '71:a', name: 'M' }, version: '10', epic: 'UYT-1', sprint: 'open' },
    group: '10',
    epic: 'none',
    cursor: 'abc=_-',
  });
  assert.deepEqual(parse({ ...BASE }), { t: 'kanban.browse.page', project: 'app', scope: 'src1', filters: {} });
  assert.deepEqual(parseBrowseFilters({ assignee: { none: true } }), { assignee: { none: true } });
});

test('the parser rejects a bad cursor, over-long values and values that could break a query', () => {
  const refuse = (r: Record<string, unknown>, why: RegExp) => assert.throws(() => parse({ ...BASE, ...r }), why);
  refuse({ cursor: 'a b' }, /cursor/);
  refuse({ cursor: 'x"y' }, /cursor/);
  refuse({ cursor: 'a'.repeat(4001) }, /cursor/);
  refuse({ cursor: 5 }, /cursor/);
  refuse({ filters: { q: 'a'.repeat(201) } }, /too long/);
  refuse({ filters: { jql: 'a'.repeat(2001) } }, /too long/);
  refuse({ filters: { status: 'a'.repeat(201) } }, /too long/);
  refuse({ filters: { status: 'a"b' } }, /quotes/);
  refuse({ filters: { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) } }, /at most 20/);
  refuse({ filters: { statusCategory: 'bogus' } }, /statusCategory must be one of/);
  refuse({ filters: { version: 'x' } }, /version must be/);
  refuse({ filters: { epic: 'UYT-1" OR 1=1' } }, /epic must be/);
  refuse({ filters: { sprint: '1 OR 1' } }, /sprint must be/);
  refuse({ filters: { assignee: { id: 'a b' } } }, /person id/);
  refuse({ filters: { assignee: 'me' } }, /assignee must be/);
  refuse({ filters: 'x' }, /filters must be/);
  refuse({ group: 'a"b' }, /quotes/);
  refuse({ group: '' }, /can’t be empty|can't be empty/);
  refuse({ epic: 'x y' }, /epic must be/);
  refuse({ scope: 'a b' }, /scope must be/);
  refuse({ project: 'App' }, /project must be/);
  assert.throws(() => parseBrowseMsg('kanban.browse.issue', { t: 'kanban.browse.issue', project: 'app', scope: 's', issueKey: 'k'.repeat(401) }), /too long/);
  assert.throws(() => parseBrowseMsg('kanban.browse.children', { t: 'kanban.browse.children', project: 'app', scope: 's', issueKey: 'A-1', nodeId: 'a b' }), /nodeId/);
});
