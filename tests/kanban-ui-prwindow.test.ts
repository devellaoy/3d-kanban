import test from 'node:test';
import assert from 'node:assert/strict';
import { pullOnBoard, pullStep, resolvePull } from '../src/client/ui/github/open-pull-model.js';
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

const floors = [{ id: 'f1' }, { id: 'f2' }];
const api7 = { number: 7, url: 'https://github.com/acme/api/pull/7', repo: 'acme/api' };

test('a pull request on this floor\'s board opens from its card', () => {
  assert.deepEqual(pullStep(items, 'f1', floors, api7, 'f1', true), { step: 'board', card: items[2] });
});

test('a pull request of another open floor goes there first, whatever this floor\'s board holds', () => {
  assert.deepEqual(pullStep(items, 'f1', floors, api7, 'f2', true), { step: 'go', floor: 'f2' });
  // Under All projects the page may be on no floor yet.
  assert.deepEqual(pullStep(items, null, floors, api7, 'f2', true), { step: 'go', floor: 'f2' });
});

test('after going, the pull request of that floor not on its board is fetched as one card', () => {
  assert.deepEqual(pullStep([], 'f2', floors, api7, 'f2', true), { step: 'fetch' });
});

test('a merged pull request that dropped out of the board\'s history is fetched, not sent to its host', () => {
  assert.deepEqual(pullStep(items, 'f1', floors, { ...api7, number: 99, url: 'https://github.com/acme/api/pull/99' }, 'f1', false), { step: 'fetch' });
  // One of a repository the board does not list at all.
  assert.deepEqual(pullStep(items, 'f1', floors, { number: 7, url: 'https://github.com/acme/web/pull/7', repo: 'acme/web' }, 'f1', false), { step: 'fetch' });
});

test('another floor\'s pull request opens on its host when that floor is not open or the page cannot travel', () => {
  assert.equal(pullStep(items, 'f1', floors, api7, 'f9', true).step, 'host');
  assert.equal(pullStep(items, 'f1', floors, api7, 'f2', false).step, 'host');
});

// --- resolvePull: the whole way to a card, with the page, the trip and the read stood in for.

const dropped = { number: 99, url: 'https://github.com/acme/app/pull/99', repo: 'acme/app' };
const fetched = card(99, 'https://github.com/acme/app/pull/99');
const twoFloors = [{ id: 'f1' }, { id: 'f2' }];

test('a merged pull request no longer on the board opens from the one card read from the office, with no trip', async () => {
  const calls: string[] = [];
  const got = await resolvePull(dropped, 'f1', {
    page: () => ({ items, floor: 'f1', floors: twoFloors }),
    go: async () => (calls.push('go'), true),
    fetch: async () => (calls.push('fetch'), fetched),
  });
  assert.deepEqual(got, { card: fetched });
  assert.deepEqual(calls, ['fetch']);
});

test('a task of another project (All projects): the page goes to its floor first, then reads the card there', async () => {
  const calls: string[] = [];
  let floor = 'f1';
  const got = await resolvePull(dropped, 'f2', {
    // The other floor's board is not read yet when the page arrives.
    page: () => ({ items: floor === 'f1' ? items : [], floor, floors: twoFloors }),
    go: async (to) => (calls.push(`go ${to}`), (floor = to), true),
    fetch: async () => (calls.push(`fetch on ${floor}`), fetched),
  });
  assert.deepEqual(got, { card: fetched });
  assert.deepEqual(calls, ['go f2', 'fetch on f2']);
});

test('after the trip the other floor\'s own board card is used when it has one', async () => {
  let floor = 'f1';
  const there = [card(99, 'https://github.com/acme/app/pull/99')];
  const got = await resolvePull(dropped, 'f2', {
    page: () => ({ items: floor === 'f1' ? items : there, floor, floors: twoFloors }),
    go: async (to) => ((floor = to), true),
    fetch: async () => assert.fail('the board has it'),
  });
  assert.deepEqual(got, { card: there[0] });
});

test('a trip that fails, a page that cannot travel and a read that fails each say why instead of a card', async () => {
  const page = () => ({ items, floor: 'f1', floors: twoFloors });
  const noFetch = async () => assert.fail('nothing to read');
  assert.deepEqual(await resolvePull(dropped, 'f2', { page, go: async () => false, fetch: noFetch }), { why: 'the page could not get to that project’s floor' });
  assert.deepEqual(await resolvePull(dropped, 'f2', { page, fetch: noFetch }), { why: 'this page cannot go to another floor' });
  const failed = await resolvePull(dropped, 'f1', { page, fetch: async () => Promise.reject(new Error('no such PR')) });
  assert.deepEqual(failed, { why: 'the office could not read it (no such PR)' });
});
