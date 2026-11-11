import test from 'node:test';
import assert from 'node:assert/strict';
import { toGhIssue } from '../src/shared/kanban/issuecard.js';
import { LIST_BODY, listedBody, actionIssue, actionsTarget, closesOrReopens, keyedComment, safeUrl, shownStatus, groupTransitions, isGithubKey, jiraSite, pinnedMe, transitionLabel } from '../src/client/kanban/issueactionsmodel.js';

test('only a card with a key on a floor with a project gets the issue actions', () => {
  assert.equal(actionsTarget({}, 'demo'), undefined, 'upstream’s key-less issue keeps its own window as it was');
  assert.equal(actionsTarget({ key: '' }, 'demo'), undefined);
  assert.equal(actionsTarget({ key: 'UYT-12' }, null), undefined);
  assert.equal(actionsTarget({ key: 'UYT-12' }, undefined), undefined);
  assert.deepEqual(actionsTarget({ key: 'gh:acme/api#5' }, 'demo'), { project: 'demo', key: 'gh:acme/api#5' });
});

test('GitHub keys assign to {me}, anything else is Jira’s, pinned per site', () => {
  assert.ok(isGithubKey('gh:acme/api#5'));
  assert.ok(isGithubKey('ghp:acme/1#PVTI_x'));
  assert.ok(!isGithubKey('UYT-12'));
  assert.equal(jiraSite('https://acme.atlassian.net/browse/UYT-12'), 'acme.atlassian.net');
  assert.equal(jiraSite('not a url'), '');
  assert.equal(jiraSite(undefined), '');
  // No localStorage here (as in a locked-down browser): nobody is pinned, and nothing throws.
  assert.equal(pinnedMe('acme.atlassian.net'), undefined);
});

test('transitions are grouped in order and say where they lead and what they need', () => {
  const ts = [
    { id: '1', name: 'Start', to: 'In Progress', group: 'To Do' },
    { id: '2', name: 'Done', to: 'Done', group: 'Done', needs: ['Resolution'] },
    { id: '3', name: 'Back', to: 'To Do', group: 'To Do' },
    { id: 'p', name: 'Todo', to: 'Todo', group: 'Roadmap', current: true },
  ];
  assert.deepEqual(groupTransitions(ts).map(([g, items]) => [g, items.map((t) => t.id)]), [['To Do', ['1', '3']], ['Done', ['2']], ['Roadmap', ['p']]]);
  assert.equal(transitionLabel(ts[0]), 'Start → In Progress');
  assert.equal(transitionLabel(ts[1]), 'Done (needs Resolution)');
  assert.equal(transitionLabel(ts[3]), 'Todo ✓');
});

test('a keyed card’s comment goes by kanban.issue.comment; a key-less one keeps upstream’s gh.comment', () => {
  assert.deepEqual(keyedComment({ key: 'gh:o/r#5' }, 'app', 'Looks fine'), { t: 'kanban.issue.comment', project: 'app', issueKey: 'gh:o/r#5', text: 'Looks fine' });
  assert.equal(keyedComment({}, 'app', 'Looks fine'), undefined);
  assert.equal(keyedComment({ key: 'gh:o/r#5' }, null, 'Looks fine'), undefined);
});

test('one view of an issue for the panel, from the kanban’s list or a 3D card; only http(s) links', () => {
  assert.deepEqual(actionIssue({ key: 'UYT-12', url: 'https://acme.atlassian.net/browse/UYT-12', status: 'In Progress', assignee: 'Maija' }), { key: 'UYT-12', url: 'https://acme.atlassian.net/browse/UYT-12', status: 'In Progress', assignee: 'Maija' });
  assert.deepEqual(actionIssue({ key: 'gh:o/r#5', url: 'javascript:alert(1)', assignees: ['a', 'b'] }), { key: 'gh:o/r#5', url: undefined, status: undefined, assignee: 'a, b' });
  assert.equal(actionIssue({ url: '', assignees: [] }).assignee, undefined);
  assert.deepEqual(actionIssue({ key: 'DEV-1', url: '', sourceId: 'src-2' }).sourceId, 'src-2', 'the source it was opened through travels with the actions');
  assert.equal(safeUrl('http://x.test/1'), 'http://x.test/1');
  assert.equal(safeUrl('data:text/html,hi'), '');
  assert.equal(safeUrl(undefined), '');
});

test('the status shown is the choices’ own when they name one; only a close or reopen refetches the window', () => {
  assert.equal(shownStatus('OPEN', 'In Review'), 'In Review', 'a board’s Status, not the repository copy’s OPEN');
  assert.equal(shownStatus('In Progress', undefined), 'In Progress');
  assert.equal(shownStatus(undefined, undefined), '—');
  assert.ok(closesOrReopens('gh:close:not_planned'));
  assert.ok(closesOrReopens('gh:reopen'));
  assert.ok(!closesOrReopens('p:PVT_1:PVTI_1:F:o'));
  assert.ok(!closesOrReopens('31'));
});

test('a 3D card opened through a source hands that source to the actions panel', () => {
  const card = toGhIssue({ source: 'jira', key: 'DEV-1', title: 't', url: 'https://x.atlassian.net/browse/DEV-1', body: '', labels: [], updatedAt: '', sourceId: 'src-2' });
  assert.equal(actionIssue(card).sourceId, 'src-2');
});

test('the issues list cuts a body: a cut copy never replaces a body that was read whole', () => {
  const full = 'x'.repeat(LIST_BODY + 500);
  const cut = full.slice(0, LIST_BODY);
  assert.deepEqual(listedBody(full, true, cut), { body: full, whole: true, stale: false }, 'the same issue, listed cut');
  assert.deepEqual(listedBody(full, true, 'edited'), { body: 'edited', whole: true, stale: false }, 'a short body is whole: the source changed');
  assert.deepEqual(listedBody('', false, 'new'), { body: 'new', whole: true, stale: false });
  // The held body is a list copy itself (the window opened from the list): the newer copy replaces it.
  assert.deepEqual(listedBody(cut, false, 'y' + cut.slice(1)), { body: 'y' + cut.slice(1), whole: false, stale: false });
  assert.deepEqual(listedBody(cut, false, cut), { body: cut, whole: false, stale: false });
});

test('a changed, cut list copy arriving after the whole body was read keeps the whole body and asks for a fresh read', () => {
  const full = 'x'.repeat(LIST_BODY + 500);
  const changed = 'y' + 'x'.repeat(LIST_BODY + 100);
  const got = listedBody(full, true, changed.slice(0, LIST_BODY));
  assert.equal(got.body, full, 'nothing of the whole body is lost to the cut copy');
  assert.equal(got.stale, true, 'the source changed: the whole body is to be read again');
  // Once it has been read whole again, the same list copy is its start and changes nothing.
  assert.deepEqual(listedBody(changed, true, changed.slice(0, LIST_BODY)), { body: changed, whole: true, stale: false });
});

test('a body read whole that grows past the cut is not replaced by its cut copy: it is read whole again', () => {
  const short = 'a'.repeat(3000);
  const grown = short + 'b'.repeat(3000);
  const got = listedBody(short, true, grown.slice(0, LIST_BODY));
  assert.deepEqual(got, { body: short, whole: true, stale: true }, 'whole is known apart from the length: the short body stays until the grown one is read');
  assert.deepEqual(listedBody(grown, true, grown.slice(0, LIST_BODY)), { body: grown, whole: true, stale: false });
  // A body exactly at the cut that was read whole and did not change stays, and nothing is asked.
  const exact = 'c'.repeat(LIST_BODY);
  assert.deepEqual(listedBody(exact, true, exact), { body: exact, whole: true, stale: false });
});
