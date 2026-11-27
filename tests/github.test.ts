import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MergeWatch, pullCardOf } from '../src/server/github.js';
import type { GhPull } from '../src/shared/protocol.js';

const pull = (number: number, state: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName: `b${number}`, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
  checks: 'none', body: '', closes: [],
});
const numbers = (ps: GhPull[]) => ps.map((p) => p.number);

test('a pull request that was open at the last look and is merged now rings once', () => {
  const w = new MergeWatch();
  assert.deepEqual(numbers(w.look([pull(1, 'OPEN'), pull(2, 'MERGED'), pull(3, 'OPEN')])), [], 'nothing rings on the first look');
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED'), pull(3, 'CLOSED')])), [1]);
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED')])), []);
});

test('a merge from the PR window rings right away, and not again when GitHub catches up', () => {
  const w = new MergeWatch();
  w.look([pull(5, 'OPEN'), pull(6, 'OPEN')]);
  assert.equal(w.ring(5), true);
  assert.equal(w.ring(5), false);
  // A look that started before the merge still says open; the next one says merged.
  assert.deepEqual(numbers(w.look([pull(5, 'OPEN'), pull(6, 'OPEN')])), []);
  assert.deepEqual(numbers(w.look([pull(5, 'MERGED'), pull(6, 'MERGED')])), [6]);
});

test('a board card from gh: the one mapping of `pr list` and `pr view`, marked with its repository only when given', () => {
  const gh = {
    number: 9, title: 'T', state: 'MERGED', isDraft: false, url: 'https://github.com/acme/app/pull/9', author: { login: 'ada' }, labels: [{ name: 'ui', color: 'ff0000' }],
    reviewDecision: 'APPROVED', headRefName: 'feat', headRefOid: 'abc', isCrossRepository: false, baseRefName: 'main', createdAt: 'c', updatedAt: 'u', additions: 3, deletions: 1,
    statusCheckRollup: [], body: 'Fixes it', closingIssuesReferences: [{ number: 4 }, { number: 'x' }], reviewRequests: [{ login: 'bob' }, { name: 'a team' }],
  };
  const primary = pullCardOf(gh);
  assert.equal('repo' in primary, false, 'the floor\'s own board marks no repository');
  assert.deepEqual([primary.number, primary.state, primary.author, primary.headRefOid, primary.additions, primary.closes, primary.reviewRequests], [9, 'MERGED', 'ada', 'abc', 3, [4], ['bob']]);
  assert.deepEqual(primary.labels.map((l) => l.name), ['ui']);
  assert.equal(pullCardOf(gh, 'acme/api').repo, 'acme/api');
});
