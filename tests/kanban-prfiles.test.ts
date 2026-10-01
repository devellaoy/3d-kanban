import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_TOO_LARGE, diffFromFiles, type GhPrFile } from '../src/server/kanban/prfiles.js';

// pulldiff.ts pulls in the markdown renderer, which wants a DOM-ish `window` when it loads (just enough for
// DOMPurify to set up); parseDiff itself needs no DOM.
class Stub {}
(globalThis as { window?: unknown }).window ??= { document: { nodeType: 9, createElement: () => ({}), implementation: { createHTMLDocument() {} } }, Element: Stub, Node: Stub };
const { parseDiff } = await import('../src/client/ui/pulldiff.js');

test('DIFF_TOO_LARGE matches the too-large message and nothing else gh says', () => {
  const big = "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/devellaoy/3d-kanban/pulls/24) PullRequest.diff too_large";
  assert.ok(DIFF_TOO_LARGE.test(big));
  for (const other of ["gh can't find this repository on GitHub", "gh isn't signed in to GitHub", 'timed out']) assert.ok(!DIFF_TOO_LARGE.test(other), other);
});

const patch = '@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three';

test('diffFromFiles reads back through parseDiff', () => {
  const files: GhPrFile[] = [
    { filename: 'a.txt', status: 'added', patch: '@@ -0,0 +1,2 @@\n+x\n+y', additions: 2, deletions: 0 },
    { filename: 'b.txt', status: 'removed', patch: '@@ -1 +0,0 @@\n-gone\n', additions: 0, deletions: 1 },
    { filename: 'c.txt', status: 'modified', patch, additions: 2, deletions: 1 },
    { filename: 'new/d.txt', status: 'renamed', previous_filename: 'old/d.txt', patch: '@@ -5 +5 @@\n-p\n+q', additions: 1, deletions: 1 },
    { filename: 'new/e.txt', status: 'renamed', previous_filename: 'old/e.txt', additions: 0, deletions: 0 },
    { filename: 'big.json', status: 'modified', additions: 5000, deletions: 12 },
  ];
  const d = parseDiff(diffFromFiles(files));
  assert.deepEqual(d.map((f) => f.path), ['a.txt', 'b.txt', 'c.txt', 'new/d.txt', 'new/e.txt', 'big.json']);
  assert.deepEqual(d.map((f) => f.status), ['A', 'D', 'M', 'R', 'R', 'M']);
  assert.deepEqual(d.map((f) => f.oldPath), [undefined, undefined, undefined, 'old/d.txt', 'old/e.txt', undefined]);
  assert.deepEqual(d.map((f) => [f.additions, f.deletions]), [[2, 0], [0, 1], [2, 1], [1, 1], [0, 0], [0, 0]]);
  assert.deepEqual(d[0].lines.filter((l) => l.kind === 'add').map((l) => l.new), [1, 2]);
  assert.equal(d[1].path, 'b.txt');
  assert.deepEqual(d[1].lines.filter((l) => l.kind === 'del').map((l) => l.old), [1]);
  assert.deepEqual(d[2].lines.map((l) => [l.kind, l.old, l.new]), [['hunk', undefined, undefined], ['ctx', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['add', undefined, 3]]);
  assert.deepEqual(d[3].lines.filter((l) => l.kind === 'add').map((l) => l.new), [5]);
  // A pure rename has nothing to show; a file with no patch says how big it is.
  assert.deepEqual(d[4].lines, []);
  assert.deepEqual(d[5].lines, [{ kind: 'note', text: 'Too large to show here (+5000 −12) — open the file on GitHub.' }]);
});

test('a patch without a trailing newline does not run into the next file', () => {
  const d = parseDiff(diffFromFiles([
    { filename: 'a.txt', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
    { filename: 'z.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+z', additions: 1, deletions: 0 },
  ]));
  assert.deepEqual(d.map((f) => [f.path, f.status, f.additions, f.deletions]), [['a.txt', 'M', 1, 1], ['z.txt', 'A', 1, 0]]);
});

test('a file with no patch and no changed lines is binary, not too large', () => {
  const d = parseDiff(diffFromFiles([
    { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
    { filename: 'icon.png', status: 'modified', additions: 0, deletions: 0 },
  ]));
  assert.deepEqual(d.map((f) => [f.path, f.status, f.binary, f.lines.length]), [['logo.png', 'A', true, 0], ['icon.png', 'M', true, 0]]);
});
