import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JQL_BACKSLASH, JQL_FUNCTIONS_ERROR, JQL_INCOMPLETE, browseJql, narrows, narrowsBeyondCategory, checkUserJql, keyLike, keyProject, scopeClause } from '../src/server/kanban/integrations/issues/browse/jql.js';
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

test('user JQL: a backslash outside a literal is refused (Jira reads \\" there too), inside quotes it works', () => {
  const bypass = `summary ~ a\\") OR project = OTHER OR (summary ~ '"\\''`;
  assert.throws(() => checkUserJql(bypass), new RegExp(JQL_BACKSLASH));
  assert.throws(() => jql({ jql: bypass }), /backslash/);
  assert.throws(() => checkUserJql('summary ~ a\\b'), /backslash/);
  checkUserJql('summary ~ "a\\"b" AND text ~ \'c\\\'d\'');
  assert.ok(jql({ statusCategory: 'all', jql: 'summary ~ "a\\"b"' }).includes('(summary ~ "a\\"b")'));
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

test('a board query refuses a double quote', () => {
  assert.throws(() => projectQuery({ status: 'a" OR "b' }), /quotes/);
  assert.throws(() => projectQuery({ labels: ['a"'] }), /quotes/);
  assert.throws(() => projectQuery({ q: 'a"b' }), /quotes/);
  assert.throws(() => projectQuery({}, 'i:a"b'), /quotes/);
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

test('top-level queries are strict: the version and the epic stay as they are, narrowed or not', () => {
  const scope = { projectKeys: ['UYT'] };
  assert.ok(!narrows({ statusCategory: 'all', version: '7', epic: 'none' }) && narrows({}) && narrows({ statusCategory: 'done' }) && narrows({ q: 'x' }) && narrows({ jql: 'a = 1' }) && !narrows({ statusCategory: 'all', labels: [] }));
  assert.ok(!narrowsBeyondCategory({}) && !narrowsBeyondCategory({ statusCategory: 'done' }) && narrowsBeyondCategory({ q: 'x' }) && narrowsBeyondCategory({ issueType: 'Sub-task' }));
  const strict = 'project IN ("UYT") AND issuetype = "Sub-task" AND issuetype not in subTaskIssueTypes() AND fixVersion = 7 AND parent = "UYT-1" ORDER BY updated DESC';
  assert.equal(browseJql(scope, { statusCategory: 'all', issueType: 'Sub-task' }, { topLevel: true, version: '7', epic: 'UYT-1' }), strict);
  assert.ok(!browseJql(scope, { q: 'x' }, { topLevel: true, version: '7', epic: 'UYT-1' }).includes(' OR '), 'a narrowed page doesn’t relax the group');
});

test('"No epic" leaves the epics out (parent is EMPTY is true of them too), unless the site has no Epic type', () => {
  const scope = { projectKeys: ['UYT'] };
  const none = browseJql(scope, { statusCategory: 'all' }, { topLevel: true, epic: 'none' }, false);
  assert.equal(none, 'project IN ("UYT") AND issuetype not in subTaskIssueTypes() AND issuetype != Epic AND parent is EMPTY');
  assert.ok(browseJql(scope, { statusCategory: 'all', epic: 'none' }, { topLevel: true }, false).includes('issuetype != Epic'));
  assert.ok(!browseJql(scope, { statusCategory: 'all' }, { topLevel: true, epic: 'none', lenient: true }, false).includes('Epic'));
  assert.ok(!browseJql(scope, { statusCategory: 'all' }, { topLevel: true, epic: 'UYT-1' }, false).includes('Epic'));
});

test('a text that looks like a key gets the key clause only for one of the scope’s projects (Jira 400s for an unknown one: UTF-8)', () => {
  const scope = { projectKeys: ['UYT', 'app'] };
  assert.ok(keyLike('UYT-12', scope) && keyLike('app-1', scope) && !keyLike('UTF-8', scope) && !keyLike('COVID-19', scope) && !keyLike('uyt 1', scope));
  assert.equal(browseJql(scope, { statusCategory: 'all', q: 'UTF-8' }, {}, false), 'project IN ("UYT", "app") AND text ~ "UTF-8"');
  assert.equal(browseJql(scope, { statusCategory: 'all', q: 'COVID-19' }, {}, false), 'project IN ("UYT", "app") AND text ~ "COVID-19"');
  assert.ok(browseJql(scope, { statusCategory: 'all', q: 'app-3' }, {}, false).includes('key = "APP-3"'));
  assert.ok(!browseJql(scope, { statusCategory: 'all', q: 'uyt-3' }, { lenient: true }, false).includes('key ='), 'the retry leaves it out');
});

test('sub-task queries: the page’s parents only, no version or epic of their own; a story that has a match is "or one of the keys"', () => {
  const scope = { projectKeys: ['UYT'] };
  const f: BrowseFilters = { statusCategory: 'all', issueType: 'Sub-task', version: '7', epic: 'UYT-1' };
  assert.equal(browseJql(scope, f, { subtasksOf: ['UYT-10', 'UYT-11'] }, false), 'project IN ("UYT") AND issuetype = "Sub-task" AND issuetype in subTaskIssueTypes() AND parent in ("UYT-10", "UYT-11")');
  assert.equal(browseJql(scope, { statusCategory: 'all' }, { subtasksOf: [] }, false), 'project IN ("UYT") AND issuetype in subTaskIssueTypes()');
  assert.throws(() => browseJql(scope, f, { subtasksOf: ['x" OR project = B'] }), /isn’t a Jira issue key/);
  assert.equal(browseJql(scope, { statusCategory: 'all', q: 'x', jql: 'a = 1' }, { topLevel: true, orKeys: ['UYT-3'], version: '7' }, false), 'project IN ("UYT") AND ((text ~ "x" AND (a = 1)) OR key in ("UYT-3")) AND issuetype not in subTaskIssueTypes() AND fixVersion = 7');
  assert.equal(browseJql(scope, { statusCategory: 'all' }, { keys: ['UYT-3'] }, false), 'project IN ("UYT") AND key in ("UYT-3")');
});

test('user JQL may call only the allow-listed functions: the others read other projects', () => {
  for (const ok of ['assignee = currentUser()', 'sprint in openSprints()', 'updated > startOfWeek("-1w")', 'issuetype in subTaskIssueTypes()', 'created > now()', 'status in ("A", "B") AND (labels = x OR labels = y)', 'status NOT IN (A)', 'labels = "foo(bar)"', 'summary ~ "a(b"']) assert.doesNotThrow(() => checkUserJql(ok), ok);
  for (const bad of ['issueFunction in linkedIssuesOf("project = B")', 'assignee in membersOf("g")', 'fixVersion in releasedVersions()', 'issue in votedIssues()', 'x = ISSUEFUNCTION  ("a")', '"membersOf"("g")', 'fixVersion in(latestReleasedVersion(B))', 'issue in watchedIssues ()']) assert.throws(() => checkUserJql(bad), (e: Error) => e.message === JQL_FUNCTIONS_ERROR, bad);
  assert.match(JQL_FUNCTIONS_ERROR, /currentUser\(\), .*openSprints\(\)/);
  assert.ok(!/membersOf|releasedVersions/.test(JQL_FUNCTIONS_ERROR));
});

test('a board query refuses an assignee that starts with @ (@me would be the office’s gh), spaces and quotes', () => {
  assert.throws(() => projectQuery({ assignee: { id: '@me' } }), /can’t start with @/);
  assert.throws(() => projectQuery({ assignee: { id: 'a b' } }), /can’t start with @/);
  assert.throws(() => projectQuery({ assignee: { id: 'a"b' } }), /can’t start with @/);
  assert.equal(projectQuery({ assignee: { id: 'maija' } }), 'is:open assignee:maija');
});
