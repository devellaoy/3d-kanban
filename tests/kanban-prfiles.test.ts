import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_TOO_LARGE, diffFromFiles, pullDiffOrFiles, resetPrFilesCache, type GhPrFile } from '../src/server/kanban/prfiles.js';

// pulldiff.ts pulls in the markdown renderer, which wants a DOM-ish `window` when it loads (just enough for
// DOMPurify to set up); parseDiff itself needs no DOM.
class Stub {}
(globalThis as { window?: unknown }).window ??= { document: { nodeType: 9, createElement: () => ({}), implementation: { createHTMLDocument() {} } }, Element: Stub, Node: Stub };
const { parseDiff } = await import('../src/client/ui/github/pulldiff.js');

test('DIFF_TOO_LARGE matches the too-large message and nothing else gh says', () => {
  const big = "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/devellaoy/3d-kanban/pulls/24) PullRequest.diff too_large";
  assert.ok(DIFF_TOO_LARGE.test(big));
  assert.ok(!DIFF_TOO_LARGE.test('gh: HTTP 406: Not Acceptable'));
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

test('a file with no patch and no changed lines gets a neutral note, not a binary claim', () => {
  const d = parseDiff(diffFromFiles([
    { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
    { filename: 'icon.png', status: 'modified', additions: 0, deletions: 0 },
    { filename: 'dir/.gitkeep', status: 'added', additions: 0, deletions: 0 },
  ]));
  const note = { kind: 'note', text: 'No text changes to show (binary, empty or mode-only) — open the file on GitHub.' };
  assert.deepEqual(d.map((f) => [f.path, f.status, f.binary, f.lines]), [['logo.png', 'A', false, [note]], ['icon.png', 'M', false, [note]], ['dir/.gitkeep', 'A', false, [note]]]);
});

test('a copied file is a new file with a note saying where from', () => {
  const d = parseDiff(diffFromFiles([
    { filename: 'b.txt', status: 'copied', previous_filename: 'a\nb.txt', patch: '@@ -0,0 +1 @@\n+x', additions: 1, deletions: 0 },
  ]));
  assert.deepEqual(d.map((f) => [f.path, f.status, f.additions]), [['b.txt', 'A', 1]]);
  assert.deepEqual(d[0].lines[0], { kind: 'note', text: 'Copied from a\\nb.txt' });
});

test('a PR with more files than GitHub lists ends with a visible note', () => {
  const d = parseDiff(diffFromFiles([{ filename: 'a.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+x', additions: 1, deletions: 0 }], 3001));
  assert.equal(d.length, 2);
  assert.equal(d[1].path, '⋯ 3000 more files not listed by GitHub');
  assert.deepEqual(d[1].lines, [{ kind: 'note', text: 'GitHub lists only the first 1 of 3001 files — open the pull request on GitHub for the rest.' }]);
  assert.equal(parseDiff(diffFromFiles([{ filename: 'a.txt', status: 'added', additions: 0, deletions: 0 }], 1)).length, 1);
});

test('a note-only file hashes differently when its counts change', () => {
  const h = (n: number) => parseDiff(diffFromFiles([{ filename: 'big.json', status: 'modified', additions: n, deletions: 1 }]))[0].hash;
  assert.notEqual(h(5000), h(5001));
  assert.equal(h(5000), h(5000));
});

const TOO_BIG = new Error('HTTP 406: Sorry, the diff exceeded the maximum number of files (300). PullRequest.diff too_large');
function fakeGh(sha: () => string) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const api = args[1];
    calls.push(api.endsWith('/pulls/7') ? 'meta' : 'files');
    if (api.endsWith('/pulls/7')) return JSON.stringify({ sha: sha(), files: 1 });
    return JSON.stringify({ filename: 'a.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+' + sha(), additions: 1, deletions: 0 }) + '\n';
  };
  return { run, calls };
}

test('pullDiffOrFiles passes a normal diff through', async () => {
  resetPrFilesCache();
  const { run, calls } = fakeGh(() => 's1');
  assert.equal(await pullDiffOrFiles(run, 'o/r', 7, '/x', async () => 'plain'), 'plain');
  assert.deepEqual(calls, []);
});

test('pullDiffOrFiles builds from the files API when too large, then reuses it per head sha', async () => {
  resetPrFilesCache();
  let sha = 's1';
  const { run, calls } = fakeGh(() => sha);
  let diffCalls = 0;
  const diff = async () => { diffCalls++; throw TOO_BIG; };
  const first = await pullDiffOrFiles(run, 'o/r', 7, '/x', diff);
  assert.match(first, /\+s1/);
  assert.deepEqual(calls, ['meta', 'files']);
  assert.equal(await pullDiffOrFiles(run, 'o/r', 7, '/x', diff), first);
  assert.deepEqual(calls, ['meta', 'files', 'meta']);
  assert.equal(diffCalls, 1);
  sha = 's2';
  assert.match(await pullDiffOrFiles(run, 'o/r', 7, '/x', diff), /\+s2/);
  assert.deepEqual(calls, ['meta', 'files', 'meta', 'meta', 'files']);
});

test('pullDiffOrFiles rethrows other errors', async () => {
  resetPrFilesCache();
  const { run, calls } = fakeGh(() => 's1');
  await assert.rejects(pullDiffOrFiles(run, 'o/r', 7, '/x', async () => { throw new Error('timed out'); }), /timed out/);
  assert.deepEqual(calls, []);
});

test('pullDiffOrFiles turns a maxBuffer overflow into a friendly message', async () => {
  resetPrFilesCache();
  const run = async (args: string[]) => {
    if (args[1].endsWith('/pulls/7')) return JSON.stringify({ sha: 's1', files: 1 });
    throw new Error('stdout maxBuffer length exceeded');
  };
  await assert.rejects(pullDiffOrFiles(run, 'o/r', 7, '/x', async () => { throw TOO_BIG; }), /too big to show here — open it on GitHub/);
});

test('a file name that looks like diff headers stays one file with its own name', () => {
  const evil = 'x.txt\ndiff --git a/spoof.txt b/spoof.txt\n--- a/spoof.txt\n+++ b/spoof.txt\n@@ -1 +1 @@\n-a\n+b';
  const odd = 'say "hi"\\there\t.md';
  const text = diffFromFiles([
    { filename: evil, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 },
    { filename: `new ${odd}`, previous_filename: odd, status: 'renamed', additions: 0, deletions: 0 },
    { filename: 'img\n.png', status: 'added', additions: 0, deletions: 0 },
    { filename: 'ä ö.txt', status: 'removed', patch: '@@ -1 +0,0 @@\n-x', additions: 0, deletions: 1 },
  ]);
  assert.ok(!text.split('\n').some((l) => l === 'diff --git a/spoof.txt b/spoof.txt'), 'the name never starts a line of its own');
  const d = parseDiff(text);
  assert.deepEqual(d.map((f) => [f.path, f.oldPath, f.status, f.binary]), [
    [evil, undefined, 'M', false],
    [`new ${odd}`, odd, 'R', false],
    ['img\n.png', undefined, 'A', false],
    ['ä ö.txt', undefined, 'D', false],
  ]);
  assert.deepEqual(d[0].lines.filter((l) => l.kind !== 'hunk').map((l) => [l.kind, l.text]), [['del', 'old'], ['add', 'new']]);
});

test("parseDiff reads git's own octal quoting of a non-ASCII name", () => {
  const d = parseDiff('diff --git "a/\\303\\244.txt" "b/\\303\\244.txt"\n--- "a/\\303\\244.txt"\n+++ "b/\\303\\244.txt"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(d.map((f) => [f.path, f.additions, f.deletions]), [['ä.txt', 1, 1]]);
});
