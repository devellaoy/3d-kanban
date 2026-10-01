import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsTarget, keyedComment, groupTransitions, isGithubKey, jiraSite, pinnedMe, transitionLabel } from '../src/client/kanban/issueactionsmodel.js';

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
