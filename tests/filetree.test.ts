// The folder tree of a changed-file list (ui/filetree.ts), shared by the PR window and the task's Changes view.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, dirsAbove, treeOrder, treeRows, type TreeDir } from '../src/client/ui/filetree.js';

const f = (path: string) => ({ path });
const names = <T>(d: TreeDir<T>) => d.dirs.map((x) => x.name);

test('a chain of single-child folders is one folder, keyed by the deepest path', () => {
  const t = buildTree([f('src/client/ui/a.ts'), f('src/client/ui/b.ts')]);
  assert.equal(t.dirs.length, 1);
  assert.equal(t.dirs[0].name, 'src/client/ui');
  assert.equal(t.dirs[0].path, 'src/client/ui');
  assert.equal(t.dirs[0].files.length, 2);
});

test('the root is not squashed away, and a folder with files of its own is not joined to its child', () => {
  const t = buildTree([f('a/b/c.ts')]);
  assert.equal(t.name, '');
  assert.equal(t.path, '');
  assert.deepEqual(names(t), ['a/b']);
  const u = buildTree([f('a/x.ts'), f('a/b/c.ts')]);
  assert.deepEqual(names(u), ['a']);
  assert.deepEqual(names(u.dirs[0]), ['b']);
});

test('root-level files stay in the root', () => {
  const t = buildTree([f('README.md'), f('src/a.ts')]);
  assert.deepEqual(t.files.map((x) => x.path), ['README.md']);
  assert.deepEqual(names(t), ['src']);
});

test('folders are sorted by name and files by path', () => {
  const t = buildTree([f('z.ts'), f('b/x.ts'), f('a/y.ts'), f('a.ts'), f('b/a.ts')]);
  assert.deepEqual(names(t), ['a', 'b']);
  assert.deepEqual(t.files.map((x) => x.path), ['a.ts', 'z.ts']);
  assert.deepEqual(t.dirs[1].files.map((x) => x.path), ['b/a.ts', 'b/x.ts']);
});

test('treeOrder lists folders before files, depth first', () => {
  const t = buildTree([f('z.ts'), f('b/x.ts'), f('a/y.ts'), f('a/q/r.ts'), f('a/p.ts')]);
  assert.deepEqual(treeOrder(t).map((x) => x.path), ['a/q/r.ts', 'a/p.ts', 'a/y.ts', 'b/x.ts', 'z.ts']);
});

const shape = (rows: ReturnType<typeof treeRows<{ path: string }>>) => rows.map((r) => `${r.depth}${r.kind === 'dir' ? `d:${r.dir.path}${r.shut ? '!' : ''}` : `f:${r.file.path}`}`);
const sample = () => buildTree([f('top.ts'), f('a/x.ts'), f('a/b/y.ts'), f('a/b/z.ts'), f('c/d/e.ts'), f('c/g.ts')]);

test('treeRows with nothing collapsed shows every folder, its content one level deeper, root files last', () => {
  assert.deepEqual(shape(treeRows(sample(), new Set())), ['0d:a', '1d:a/b', '2f:a/b/y.ts', '2f:a/b/z.ts', '1f:a/x.ts', '0d:c', '1d:c/d', '2f:c/d/e.ts', '1f:c/g.ts', '0f:top.ts']);
});

test('treeRows hides what is inside a collapsed folder and marks it shut', () => {
  assert.deepEqual(shape(treeRows(sample(), new Set(['a/b']))), ['0d:a', '1d:a/b!', '1f:a/x.ts', '0d:c', '1d:c/d', '2f:c/d/e.ts', '1f:c/g.ts', '0f:top.ts']);
});

test('a collapsed outer folder hides the inner ones whatever their own state', () => {
  assert.deepEqual(shape(treeRows(sample(), new Set(['a', 'a/b']))), ['0d:a!', '0d:c', '1d:c/d', '2f:c/d/e.ts', '1f:c/g.ts', '0f:top.ts']);
  assert.deepEqual(shape(treeRows(sample(), new Set(['a']))).slice(0, 2), ['0d:a!', '0d:c']);
});

test('dirsAbove gives the folder keys outermost first', () => {
  const t = sample();
  assert.deepEqual(dirsAbove(t, 'a/b/y.ts'), ['a', 'a/b']);
  assert.deepEqual(dirsAbove(t, 'c/g.ts'), ['c']);
  const squashed = buildTree([f('src/client/ui/a.ts')]);
  assert.deepEqual(dirsAbove(squashed, 'src/client/ui/a.ts'), ['src/client/ui']);
});

test('dirsAbove is empty for a root-level file and for a path that is not in the tree', () => {
  const t = sample();
  assert.deepEqual(dirsAbove(t, 'top.ts'), []);
  assert.deepEqual(dirsAbove(t, 'nope/none.ts'), []);
});

test('buildTree does not change its input', () => {
  const input = [f('z.ts'), f('b/x.ts'), f('a/y.ts')];
  const copy = input.map((x) => ({ ...x }));
  buildTree(input);
  assert.deepEqual(input, copy);
});

test('any file shape with a path works', () => {
  const t = buildTree([{ path: 'a/b.ts', additions: 3 }, { path: 'a/c.ts', additions: 5 }]);
  assert.equal(treeOrder(t).reduce((n, x) => n + x.additions, 0), 8);
  const rows = treeRows(t, new Set());
  const file = rows.find((r) => r.kind === 'file');
  assert.equal(file?.kind === 'file' ? file.file.additions : -1, 3);
});
