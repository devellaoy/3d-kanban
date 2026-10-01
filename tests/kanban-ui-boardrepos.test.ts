import test from 'node:test';
import assert from 'node:assert/strict';
import { keptRepo, tabRepos } from '../src/client/kanban/boardrepos.js';

const card = (repo: string, n = 1) => ({ url: `https://github.com/${repo}/pull/${n}`, repo });
const configured = ['acme/web', 'acme/api'];

// What boards.ts does for the PR board's tabs.
const shown = (value: string, items: { url: string; repo?: string }[], conf?: string[]) => keptRepo(value, tabRepos(items, conf), conf);

test('a picked repository with cards stays picked', () => {
  assert.equal(shown('acme/api', [card('acme/web'), card('acme/api', 2)], configured), 'acme/api');
});

test('an empty load keeps the choice and lists its tab', () => {
  assert.deepEqual(tabRepos([], configured), ['acme/api', 'acme/web']);
  assert.equal(shown('acme/api', [], configured), 'acme/api');
});

test('a failed load (no cards, or only other repositories) keeps the choice', () => {
  assert.equal(shown('acme/api', [], configured), 'acme/api');
  assert.equal(shown('acme/api', [card('acme/web')], configured), 'acme/api');
});

test('a repository removed from the project falls back to All', () => {
  assert.equal(shown('acme/old', [card('acme/web')], configured), '');
  assert.equal(shown('acme/old', [], configured), '');
});

test('a single-repository floor (no configured list) drops a stale choice', () => {
  assert.equal(shown('acme/old', [card('acme/web')]), '');
  assert.equal(shown('acme/web', [card('acme/web')]), 'acme/web');
});

test('All stays All', () => assert.equal(keptRepo('', ['acme/web'], configured), ''));

test('matching ignores case and returns the list spelling', () => {
  assert.equal(keptRepo('ACME/api', ['acme/api'], configured), 'acme/api');
  assert.deepEqual(tabRepos([card('Acme/Web')], ['acme/web', 'acme/api']), ['acme/api', 'Acme/Web']);
});

test('tabRepos includes configured repositories with no pull requests', () => {
  assert.deepEqual(tabRepos([card('acme/web')], ['acme/docs']), ['acme/docs', 'acme/web']);
  assert.deepEqual(tabRepos([card('acme/web')]), ['acme/web']);
});
