// copyTree stands in for fs.cpSync, whose native copy kills the process on a non-ASCII path on Windows (#69).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTree } from '../src/server/kanban/copytree.js';

function tmp(t: TestContext): string {
  // The folder name is what crashed cpSync: C:\Ylimäki Media\…
  const dir = mkdtempSync(path.join(os.tmpdir(), 'Ylimäki copytree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('copies a folder tree through a non-ASCII path', (t) => {
  const dir = tmp(t);
  const from = path.join(dir, 'lähde', '.meeting');
  mkdirSync(path.join(from, 'alikansio'), { recursive: true });
  writeFileSync(path.join(from, 'r1-1-correctness.md'), 'yksi');
  writeFileSync(path.join(from, 'alikansio', 'öö.md'), 'kaksi');
  const to = path.join(dir, 'meetings', '7b762f70');
  copyTree(from, to);
  assert.equal(readFileSync(path.join(to, 'r1-1-correctness.md'), 'utf8'), 'yksi');
  assert.equal(readFileSync(path.join(to, 'alikansio', 'öö.md'), 'utf8'), 'kaksi');
});

test('copies a single file, overwriting, and merges into a folder that is there', (t) => {
  const dir = tmp(t);
  const to = path.join(dir, 'kohde');
  mkdirSync(to);
  writeFileSync(path.join(to, 'vanha.md'), 'pysyy');
  writeFileSync(path.join(to, 'output-pr-8.md'), 'vanha');
  writeFileSync(path.join(dir, 'pr-8.md'), 'uusi');
  copyTree(path.join(dir, 'pr-8.md'), path.join(to, 'output-pr-8.md'));
  assert.equal(readFileSync(path.join(to, 'output-pr-8.md'), 'utf8'), 'uusi');
  assert.equal(readFileSync(path.join(to, 'vanha.md'), 'utf8'), 'pysyy');
});

test('skips what the filter refuses, folders whole', (t) => {
  const dir = tmp(t);
  const from = path.join(dir, 'skill');
  mkdirSync(path.join(from, 'node_modules'), { recursive: true });
  writeFileSync(path.join(from, 'SKILL.md'), 'skill');
  writeFileSync(path.join(from, '.marker.json'), '{}');
  writeFileSync(path.join(from, 'node_modules', 'x.js'), '');
  const to = path.join(dir, 'out');
  copyTree(from, to, (src) => !['.marker.json', 'node_modules'].includes(path.basename(src)));
  assert.ok(existsSync(path.join(to, 'SKILL.md')));
  assert.ok(!existsSync(path.join(to, '.marker.json')));
  assert.ok(!existsSync(path.join(to, 'node_modules')));
});

test('never writes through a link at the destination, as cpSync does not', (t) => {
  const dir = tmp(t);
  const outside = path.join(dir, 'ulkona');
  mkdirSync(outside);
  const from = path.join(dir, 'lähde');
  mkdirSync(from);
  writeFileSync(path.join(from, 'a.md'), 'a');
  // A junction needs no rights on Windows; elsewhere it is a plain folder link.
  const to = path.join(dir, 'kohde');
  symlinkSync(outside, to, 'junction');
  assert.throws(() => copyTree(from, to), /over the link/);
  assert.deepEqual(readdirSync(outside), []);
  copyTree(path.join(from, 'a.md'), to);
  assert.equal(readFileSync(to, 'utf8'), 'a');
  assert.ok(!lstatSync(to).isSymbolicLink());
  assert.deepEqual(readdirSync(outside), []);
});
