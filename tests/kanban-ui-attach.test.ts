import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentMarkdown, attachmentUrl, formatSize, insertAt, isImage, pastedName, splitTaskRefs } from '../src/client/kanban/attach.js';
import { boardRepos, inRepo, repoOfItem } from '../src/client/kanban/boardrepos.js';

test('attachments: pictures show inline in markdown, other files are links', () => {
  assert.equal(attachmentUrl('abc123'), '/api/kanban/attachments/abc123');
  assert.equal(attachmentMarkdown({ id: 'ab12', name: 'shot.png', mime: 'image/png' }), '![shot.png](/api/kanban/attachments/ab12)');
  assert.equal(attachmentMarkdown({ id: 'ab12', name: 'log [1].txt', mime: 'text/plain' }), '[log 1.txt](/api/kanban/attachments/ab12)');
  assert.equal(isImage('image/jpeg'), true);
  assert.equal(isImage('image/svg+xml'), false, 'SVG can carry script');
});

test('file sizes', () => {
  assert.equal(formatSize(812), '812 B');
  assert.equal(formatSize(14 * 1024), '14 kB');
  assert.equal(formatSize(3.25 * 1024 * 1024), '3.3 MB');
  assert.equal(formatSize(25 * 1024 * 1024), '25 MB');
  assert.equal(formatSize(-1), '');
});

test('a pasted picture gets a name with the time in it', () => {
  assert.equal(pastedName('image/png', new Date(2026, 8, 30, 14, 5, 9)), 'pasted-2026-09-30-140509.png');
  assert.match(pastedName('application/x-thing'), /\.bin$/);
});

test('an attachment goes in on a line of its own, where the cursor is', () => {
  assert.deepEqual(insertAt('', 0, 'X'), { text: 'X', cursor: 1 });
  assert.deepEqual(insertAt('ab', 1, 'X'), { text: 'a\nX\nb', cursor: 3 });
  assert.deepEqual(insertAt('line\n', 5, 'X'), { text: 'line\nX', cursor: 6 });
  assert.equal(insertAt('abc', 99, 'X').text, 'abc\nX');
});

test('#123 references are split out, but not inside words, URLs or PR#12', () => {
  assert.deepEqual(splitTaskRefs('see #14 and #3.'), ['see ', { task: 14, text: '#14' }, ' and ', { task: 3, text: '#3' }, '.']);
  assert.deepEqual(splitTaskRefs('#7'), [{ task: 7, text: '#7' }]);
  assert.deepEqual(splitTaskRefs('PR#12 or http://x/#12 or a#1'), ['PR#12 or http://x/#12 or a#1']);
  assert.deepEqual(splitTaskRefs('no refs'), ['no refs']);
});

test('a board item’s repository: its own field, else from its URL', () => {
  assert.equal(repoOfItem({ url: 'https://github.com/acme/web/pull/12' }), 'acme/web');
  assert.equal(repoOfItem({ url: 'https://github.com/acme/web/issues/3' }), 'acme/web');
  assert.equal(repoOfItem({ url: 'https://github.com/acme/web/pull/12', repo: 'acme/api' }), 'acme/api');
  assert.equal(repoOfItem({ url: 'nonsense' }), '');
  const items = [{ url: 'https://github.com/acme/web/pull/1' }, { url: 'https://github.com/acme/api/pull/2' }, { url: 'https://github.com/acme/web/pull/3' }];
  assert.deepEqual(boardRepos(items), ['acme/api', 'acme/web']);
  assert.equal(inRepo(items, 'acme/web').length, 2);
  assert.equal(inRepo(items, '').length, 3);
});
