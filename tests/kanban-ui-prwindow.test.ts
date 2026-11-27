import test from 'node:test';
import assert from 'node:assert/strict';
import { pullOnBoard } from '../src/client/ui/github/open-pull-model.js';
import type { GhPull } from '../src/shared/protocol.js';

const card = (number: number, url: string, repo?: string) => ({ number, url, ...(repo ? { repo } : {}) }) as GhPull;
const items = [
  card(5, 'https://github.com/acme/app/pull/5'),
  card(5, 'https://github.com/acme/api/pull/5', 'acme/api'),
  card(7, 'https://github.com/acme/api/pull/7', 'acme/api'),
];

test('a pull request of the primary repository is its card, not another repository\'s same number', () => {
  const pr = { number: 5, url: 'https://github.com/acme/app/pull/5', repo: 'acme/app' };
  assert.equal(pullOnBoard(items, 'f1', pr, 'f1'), items[0]);
});

test('a pull request of a named other repository is found', () => {
  assert.equal(pullOnBoard(items, 'f1', { number: 7, url: 'https://github.com/acme/api/pull/7', repo: 'acme/api' }, 'f1'), items[2]);
  assert.equal(pullOnBoard(items, 'f1', { number: 5, url: 'https://github.com/acme/api/pull/5', repo: 'acme/api' }), items[1]);
});

test('the same number in a repository that is not on the board is not returned', () => {
  assert.equal(pullOnBoard(items, 'f1', { number: 7, url: 'https://github.com/acme/web/pull/7', repo: 'acme/web' }), undefined);
});

test('a pull request of another floor, or not on the board, is undefined', () => {
  const pr = { number: 7, url: 'https://github.com/acme/api/pull/7', repo: 'acme/api' };
  assert.equal(pullOnBoard(items, 'f1', pr, 'f2'), undefined);
  assert.equal(pullOnBoard(items, 'f1', { ...pr, number: 99 }, 'f1'), undefined);
});
