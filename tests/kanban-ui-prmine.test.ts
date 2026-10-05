import test from 'node:test';
import assert from 'node:assert/strict';
import type { GhPull, SignInState, WorkerInfo } from '../src/shared/protocol.js';
import { emptyNote, loadPrWho, minePredicate, myLogin, openedFromOfficeBy, reviewPredicate, savePrWho, type Me } from '../src/client/kanban/prmine.js';
import { openByRepo } from '../src/client/kanban/boardrepos.js';

const pr = (repo: string, number: number, o: Partial<GhPull> = {}) =>
  ({ number, url: `https://github.com/${repo}/pull/${number}`, repo, author: 'office-bot', body: '', state: 'OPEN', headRefName: `b${number}`, ...o }) as GhPull;
const gh = (o: Partial<SignInState>): { github: SignInState } => ({ github: { status: 'ok', how: 'login', ...o } });
const noWorker: Me['workerOf'] = () => undefined;
const me = (o: Partial<Me> = {}): Me => ({ login: 'ada', name: 'Ada', tasks: [], workers: [], workerOf: noWorker, ...o });

test('my login: my own GitHub sign-in, else the office’s gh', () => {
  assert.equal(myLogin(gh({ who: '@ada' }), 'office-bot'), 'ada');
  assert.equal(myLogin(gh({ who: '@office-bot', how: 'office' }), 'office-bot'), 'office-bot');
  assert.equal(myLogin(null, 'office-bot'), 'office-bot');
  assert.equal(myLogin(null, undefined), '');
  // An account that hasn't signed in to GitHub doesn't get every office PR as its own.
  assert.equal(myLogin(gh({ status: 'none' }), 'office-bot'), '');
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
  const w = { createdBy: 'Ada', byPerson: true, pr: { number: 3, url: '' } } as WorkerInfo;
  const is = minePredicate(me({ workers: [w], workerOf: (ws, p) => [...ws].find((x) => x.pr?.number === p.number) }));
  assert.ok(is(pr('acme/web', 3)));
  assert.ok(!minePredicate(me({ workers: [{ ...w, byPerson: undefined }], workerOf: () => ({ ...w, byPerson: undefined }) }))(pr('acme/web', 3)));
  const body = '## Task\n\nfix\n\n_Opened from Agent Office by Ada · Otto at Desk 3_';
  assert.equal(openedFromOfficeBy(body), 'Ada');
  assert.ok(is(pr('acme/web', 4, { body })));
  assert.ok(!is(pr('acme/web', 4, { body: body.replace('Ada', 'Bob') })));
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
