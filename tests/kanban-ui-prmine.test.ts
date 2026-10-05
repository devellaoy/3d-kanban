import test from 'node:test';
import assert from 'node:assert/strict';
import type { GhPull, SignInState, WorkerInfo } from '../src/shared/protocol.js';
import { emptyNote, loadPrWho, minePredicate, myLogin, noteReady, reviewPredicate, savePrWho, shownWho, tabStop, WHO_TOPICS, type Me } from '../src/client/kanban/prmine.js';
import { openByRepo } from '../src/client/kanban/boardrepos.js';

const pr = (repo: string, number: number, o: Partial<GhPull> = {}) =>
  ({ number, url: `https://github.com/${repo}/pull/${number}`, repo, author: 'office-bot', body: '', state: 'OPEN', headRefName: `b${number}`, ...o }) as GhPull;
const gh = (o: Partial<SignInState>): { github: SignInState } => ({ github: { status: 'ok', how: 'login', ...o } });
const me = (o: Partial<Me> = {}): Me => ({ login: 'ada', name: 'Ada', tasks: [], workers: [], ...o });

test('my login: my own GitHub sign-in, else the office’s gh', () => {
  assert.equal(myLogin(gh({ who: '@ada' }), 'office-bot', true), 'ada');
  assert.equal(myLogin(gh({ who: '@office-bot', how: 'office' }), 'office-bot', true), 'office-bot');
  // The shared password (no account): the office's.
  assert.equal(myLogin(null, 'office-bot', false), 'office-bot');
  assert.equal(myLogin(null, undefined, false), '');
  // An account that hasn't signed in to GitHub doesn't get every office PR as its own…
  assert.equal(myLogin(gh({ status: 'none' }), 'office-bot', true), '');
  // …nor does one whose sign-ins haven't come in yet.
  assert.equal(myLogin(null, 'office-bot', true), '');
});

test('authored by my login counts, ignoring case', () => {
  const is = minePredicate(me());
  assert.ok(is(pr('acme/web', 1, { author: 'Ada' })));
  assert.ok(!is(pr('acme/web', 2)));
  assert.ok(!minePredicate(me({ login: '', name: '' }))(pr('acme/web', 3, { author: '' })));
});

test('a kanban task I made owns it: by link, or by repository and number', () => {
  const tasks = [
    { createdBy: 'Ada', prs: [{ repoId: 'web', repo: 'acme/web', number: 5, url: 'https://github.com/Acme/Web/pull/5', state: 'open' as const }] },
    { createdBy: 'Ada', prs: [{ repoId: 'api', repo: 'acme/api', number: 7, url: '', state: 'open' as const }] },
    { createdBy: 'Bob', prs: [{ repoId: 'web', repo: 'acme/web', number: 9, url: 'https://github.com/acme/web/pull/9', state: 'open' as const }] },
  ];
  const is = minePredicate(me({ tasks }));
  assert.ok(is(pr('acme/web', 5)));
  assert.ok(is(pr('acme/api', 7)));
  assert.ok(!is(pr('acme/web', 9)), 'someone else’s task');
  assert.ok(!is(pr('acme/web', 7)), 'the same number in another repository');
});

test('a worker I hired at a desk, or the office’s "Opened from Agent Office by" line', () => {
  const w = { createdBy: 'Ada', byPerson: true, pr: { number: 3, url: 'https://github.com/acme/web/pull/3' } } as WorkerInfo;
  const is = minePredicate(me({ workers: [w], primary: 'acme/web' }));
  assert.ok(is(pr('acme/web', 3)));
  assert.ok(!minePredicate(me({ workers: [{ ...w, byPerson: undefined }], primary: 'acme/web' }))(pr('acme/web', 3)));
  // GhPull.openedBy: the server reads the footer before it cuts the description.
  assert.ok(is(pr('acme/web', 4, { openedBy: 'Ada' })));
  assert.ok(!is(pr('acme/web', 4, { openedBy: 'Bob' })));
});

test('review requested from my login', () => {
  const is = reviewPredicate('ada');
  assert.ok(is(pr('acme/web', 1, { reviewRequests: ['bob', 'ADA'] })));
  assert.ok(!is(pr('acme/web', 2, { reviewRequests: ['bob'] })));
  assert.ok(!is(pr('acme/web', 3)));
  assert.ok(!reviewPredicate('')(pr('acme/web', 4, { reviewRequests: [''] })));
});

test('the tabs count only what the filter leaves', () => {
  const items = [pr('acme/web', 1, { author: 'ada' }), pr('acme/web', 2), pr('acme/api', 3, { author: 'ada' }), pr('acme/api', 4, { author: 'ada', state: 'MERGED' })];
  const { counts, total } = openByRepo(items.filter(minePredicate(me())));
  assert.equal(total, 2);
  assert.equal(counts.get('acme/web'), 1);
  assert.equal(counts.get('acme/api'), 1);
});

test('the empty note', () => {
  assert.equal(emptyNote('all', '', 0), '');
  assert.equal(emptyNote('mine', '', 2), '');
  assert.equal(emptyNote('mine', '', 0), 'You have no open pull requests');
  assert.equal(emptyNote('mine', 'acme/api', 0), 'You have no open pull requests in api');
  assert.equal(emptyNote('review', '', 0), 'Nothing is waiting for your review');
});

test('the choice is kept in this browser, and survives storage that throws', () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    assert.equal(loadPrWho(), 'all');
    savePrWho('mine');
    assert.equal(loadPrWho(), 'mine');
    store.set('agent-office.board-pulls-who', 'nonsense');
    assert.equal(loadPrWho(), 'all');
    savePrWho('all');
    assert.equal(store.size, 0);
    g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    assert.equal(loadPrWho(), 'all');
    savePrWho('review');
  } finally {
    g.localStorage = before;
  }
});

test('a worker is matched in the PR’s own repository', () => {
  // My worker's own-floor PR is web#7; across repositories it also has api#12.
  const w = {
    createdBy: 'Ada',
    byPerson: true,
    worktree: { path: 'wt', branch: 'office/otto-1', base: 'abc' },
    pr: { number: 7, url: 'https://github.com/acme/web/pull/7' },
    repos: [{ floor: 'api', name: 'api', repo: 'acme/api', dir: '/x/api', path: 'wt/api', branch: 'office/otto-1', base: 'abc', pr: { number: 12, url: 'https://github.com/acme/api/pull/12' } }],
  } as WorkerInfo;
  const is = minePredicate(me({ login: '', workers: [w], primary: 'acme/web' }));
  assert.ok(is(pr('acme/web', 7)));
  assert.ok(!is(pr('acme/api', 7, { headRefName: 'someone-else' })), 'another repository’s #7');
  assert.ok(is(pr('acme/api', 12, { headRefName: 'office/otto-1' })), 'its PR in another repository of its task');
  // A card without `repo` (a one-repository floor) is still placed by its link.
  assert.ok(!is({ ...pr('acme/api', 7, { headRefName: 'x' }), repo: undefined }));
});

test('a GitHub sign-in that comes in late turns the filter on, and the board follows it', () => {
  assert.ok(WHO_TOPICS.includes('signins'));
  // Before the sign-ins arrive an account has no login, so 👀 can't work and All shows…
  const off = (login: string) => ({ review: login ? undefined : 'no login' });
  const before = myLogin(null, 'office-bot', true);
  assert.equal(shownWho('review', off(before)), 'all');
  // …and once they do, the kept 👀 comes back by itself.
  const after = myLogin(gh({ who: '@ada' }), 'office-bot', true);
  assert.equal(shownWho('review', off(after)), 'review');
  assert.ok(reviewPredicate(after)(pr('acme/web', 1, { reviewRequests: ['ada'] })));
});

test('the toggle always has a Tab stop that works', () => {
  assert.equal(tabStop('review', { review: 'no login' }), 'all');
  assert.equal(tabStop('mine', {}), 'mine');
  assert.equal(tabStop('all', { review: 'no login' }), 'all');
  assert.equal(tabStop('review', { all: 'x', review: 'no login' }), 'mine');
});

test('no empty note before the PRs (and, for Mine, the kanban’s tasks) are in', () => {
  const loaded = { loading: false, fetchedAt: 1, items: [] };
  assert.ok(!noteReady('mine', { loading: true, fetchedAt: 0, items: [] }, true), 'first load');
  assert.ok(!noteReady('mine', { ...loaded, error: 'gh failed' }, true), 'a failed load');
  assert.ok(!noteReady('mine', loaded, false), 'the kanban snapshot not answered yet');
  assert.ok(noteReady('mine', loaded, true));
  assert.ok(noteReady('review', loaded, false));
  // A refresh of a list already in keeps the note.
  assert.ok(noteReady('mine', { loading: true, fetchedAt: 1, items: [{}] }, true));
});
