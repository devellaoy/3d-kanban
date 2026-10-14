import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentMarkdown, attachmentUrl, formatSize, insertAt, isImage, linkedIds, notInText, pastedName, splitTaskRefs, swapMark, uploadingMark } from '../src/client/kanban/attach.js';
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

test('a file goes in as a placeholder at the cursor, and its link takes the placeholder’s place', () => {
  const mark = uploadingMark('shot [1].png');
  assert.match(mark, /^!\[⏳ Uploading shot 1\.png…\]\(#uploading-\d+\)$/);
  assert.notEqual(uploadingMark('shot.png'), uploadingMark('shot.png'), 'two of the same name stay apart');
  const put = insertAt('see this', 4, mark);
  assert.equal(put.text, `see \n${mark}\nthis`);
  // Typed on after the placeholder: the cursor keeps its place relative to the text.
  const typed = `${put.text} and more`;
  const end = typed.length;
  const link = '![shot.png](/api/kanban/attachments/ab12)';
  const r = swapMark(typed, mark, link, [end, end]);
  assert.equal(r?.text, `see \n${link}\nthis and more`);
  assert.deepEqual(r?.sel, [end + link.length - mark.length, end + link.length - mark.length]);
  // A cursor before it stays, one inside it goes after the link.
  assert.deepEqual(swapMark(typed, mark, link, [2, 6])?.sel, [2, 5 + link.length]);
  assert.equal(swapMark('edited away', mark, link, [0, 0]), null);
});

test('a failed upload takes its placeholder and the line it had away', () => {
  const mark = uploadingMark('x.png');
  const text = `a\n${mark}\nb`;
  assert.deepEqual(swapMark(text, mark, '', [text.length, text.length]), { text: 'a\nb', sel: [3, 3] });
  assert.equal(swapMark(`a\n${mark}`, mark, '', [0, 0])?.text, 'a');
  assert.equal(swapMark(mark, mark, '', [0, 0])?.text, '');
});

test('the files sent are the ones the text still links to', () => {
  const text = 'look ![a.png](/api/kanban/attachments/ab12) and [log.txt](/api/mp/visit/sam/api/kanban/attachments/cd%2034)\n![a.png](/api/kanban/attachments/ab12)';
  assert.deepEqual(linkedIds(text), ['ab12', 'cd 34']);
  assert.deepEqual(linkedIds('![⏳ Uploading a.png…](#uploading-3) [x](https://example.com/api/other)'), []);
  const files = [{ id: 'ab12' }, { id: 'zz9' }];
  assert.deepEqual(notInText(files, text), [{ id: 'zz9' }], 'a comment lists only the files its text doesn’t show');
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
