import test from 'node:test';
import assert from 'node:assert/strict';
import { canChangeIssue, pickedPatch, sameIssue, savedText, typedPatch, unlinkPatch } from '../src/client/kanban/issuelinkmodel.js';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';

test('a task’s issue can be changed at every status but the archive', () => {
  for (const status of ['todo', 'in_progress', 'waiting', 'review', 'on_hold', 'done']) assert.equal(canChangeIssue({ status }), true, status);
  assert.equal(canChangeIssue({ status: 'archived' }), false);
});

test('a picked issue sends its key and its own link; a link that isn’t http(s) is left out', () => {
  assert.deepEqual(pickedPatch({ key: 'gh:acme/web#12', url: 'https://github.com/acme/web/issues/12' }), { ticket: 'gh:acme/web#12', ticketUrl: 'https://github.com/acme/web/issues/12' });
  assert.deepEqual(pickedPatch({ key: 'UYT-1', url: 'javascript:alert(1)' }), { ticket: 'UYT-1', ticketUrl: null });
  assert.deepEqual(pickedPatch({ key: 'UYT-1' }), { ticket: 'UYT-1', ticketUrl: null });
});

test('unlinking clears the key and the link', () => {
  assert.deepEqual(unlinkPatch(), { ticket: null, ticketUrl: null });
});

test('a key typed by hand is trimmed, and an empty link clears the one the task had', () => {
  assert.deepEqual(typedPatch('  UYT-7 ', '', { ticket: 'UYT-1', ticketUrl: 'https://jira.example/browse/UYT-1' }), { ticket: 'UYT-7', ticketUrl: null });
  assert.deepEqual(typedPatch('UYT-7', ' https://jira.example/browse/UYT-7 '), { ticket: 'UYT-7', ticketUrl: 'https://jira.example/browse/UYT-7' });
});

test('the old issue’s link never stays under a new key, but the same key can get a new link or keep its own', () => {
  const now = { ticket: 'UYT-1', ticketUrl: 'https://jira.example/browse/UYT-1' };
  assert.deepEqual(typedPatch('UYT-7', now.ticketUrl, now), { ticket: 'UYT-7', ticketUrl: null });
  assert.deepEqual(typedPatch('UYT-1', now.ticketUrl, now), { ticket: 'UYT-1', ticketUrl: now.ticketUrl });
  assert.deepEqual(typedPatch('UYT-1', 'https://other.example/1', now), { ticket: 'UYT-1', ticketUrl: 'https://other.example/1' });
});

test('what can’t be saved is said instead: no key, a link that isn’t http(s), too long', () => {
  assert.match(typedPatch('  ', 'https://x.example') as string, /key/);
  assert.match(typedPatch('UYT-1', 'ftp://x.example') as string, /http\(s\) URL/);
  assert.match(typedPatch('UYT-1', 'https://x.example/a b') as string, /http\(s\) URL/);
  assert.match(typedPatch('K'.repeat(401), '') as string, /too long/);
});

test('a patch that changes nothing isn’t sent, and the toast names what was done', () => {
  assert.equal(sameIssue({ ticket: 'UYT-1' }, { ticket: 'UYT-1', ticketUrl: null }), true);
  assert.equal(sameIssue({ ticket: 'UYT-1', ticketUrl: 'https://a.example' }, { ticket: 'UYT-1', ticketUrl: null }), false);
  assert.equal(sameIssue({}, unlinkPatch()), true);
  assert.equal(savedText({ ticket: 'UYT-1', ticketUrl: null }), 'Issue UYT-1 linked');
  assert.equal(savedText(unlinkPatch()), 'Issue unlinked');
});

test('the office’s parser takes every patch the tab builds', () => {
  const now = { ticket: 'UYT-1', ticketUrl: 'https://jira.example/browse/UYT-1' };
  for (const patch of [pickedPatch({ key: 'gh:acme/web#12', url: 'https://github.com/acme/web/issues/12' }), typedPatch('UYT-7', '', now), unlinkPatch()]) {
    assert.notEqual(typeof patch, 'string');
    const msg = parseKanbanClientMsg({ t: 'kanban.task.update', id: 1, patch });
    assert.deepEqual(msg && 'patch' in msg && msg.patch, patch);
  }
});
