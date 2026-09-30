import test from 'node:test';
import assert from 'node:assert/strict';
import { findItem, ghKey, ghLabel, ghRepoField, ghUrl, ghWaiter, namedRepo, ownPullRepo, repoOfItem, sameItem, workerForRepoPull } from '../src/client/kanban/ghrepo.js';
import { repoOfItem as boardRepoOfItem } from '../src/client/kanban/boardrepos.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const pr = (repo: string | undefined, number: number, headRefName = `b${number}`) => ({
  number,
  headRefName,
  url: `https://github.com/${repo ?? 'acme/web'}/pull/${number}`,
  ...(repo ? { repo } : {}),
});

function worker(id: string, over: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, deskId: `d-${id}`, status: 'idle', createdBy: 'Ada', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over } as WorkerInfo;
}

test('ghUrl adds ?repo= (URL-encoded) only for a repository, after any query already there', () => {
  assert.equal(ghUrl('/api/gh/pull?number=5'), '/api/gh/pull?number=5');
  assert.equal(ghUrl('/api/gh/pull?number=5', undefined), '/api/gh/pull?number=5');
  assert.equal(ghUrl('/api/gh/pull?number=5', ''), '/api/gh/pull?number=5');
  assert.equal(ghUrl('/api/gh/pull?number=5', 'acme/api'), '/api/gh/pull?number=5&repo=acme%2Fapi');
  assert.equal(ghUrl('/api/gh/labels', 'acme/my repo'), '/api/gh/labels?repo=acme%2Fmy%20repo');
});

test('ghRepoField spreads a repo into a WS message only when there is one', () => {
  assert.deepEqual({ t: 'gh.merge', number: 5, ...ghRepoField(undefined) }, { t: 'gh.merge', number: 5 });
  assert.deepEqual({ t: 'gh.merge', number: 5, ...ghRepoField('acme/api') }, { t: 'gh.merge', number: 5, repo: 'acme/api' });
});

test('waiter keys tell the same number in two repositories apart', () => {
  assert.equal(ghKey('pull', 5), 'pull:5');
  assert.equal(ghKey('pull', 5, 'Acme/API'), 'pull:5@acme/api');
  assert.notEqual(ghKey('pull', 5, 'acme/api'), ghKey('pull', 5, 'acme/web'));
  assert.notEqual(ghKey('pull', 5), ghKey('issue', 5));
});

test('a reply finds its waiter by repository when it names one, else by kind and number', () => {
  const waiters = new Map<string, string>([
    [ghKey('pull', 5, 'acme/api'), 'api'],
    [ghKey('issue', 5), 'issue'],
  ]);
  // Upstream's replies carry no repository.
  assert.equal(ghWaiter(waiters, 'pull', 5), 'api');
  assert.equal(ghWaiter(waiters, 'issue', 5), 'issue');
  assert.equal(ghWaiter(waiters, 'pull', 6), undefined);
  assert.equal(ghWaiter(waiters, 'pull', 55), undefined, 'pull:55 is not pull:5');
  // A reply that names its repository.
  assert.equal(ghWaiter(waiters, 'pull', 5, 'ACME/api'), 'api');
  assert.equal(ghWaiter(waiters, 'pull', 5, 'acme/web'), undefined);
  assert.equal(ghWaiter(waiters, 'issue', 5, 'acme/web'), 'issue', 'a request sent without a repository still hears back');
});

test('namedRepo reads a repo only when there is a non-empty string', () => {
  assert.equal(namedRepo({ t: 'gh.merged', number: 5 }), undefined);
  assert.equal(namedRepo({ repo: '' }), undefined);
  assert.equal(namedRepo({ repo: 7 }), undefined);
  assert.equal(namedRepo({ repo: 'acme/api' }), 'acme/api');
});

test('ghLabel names the repository in a window title only when there is one', () => {
  assert.equal(ghLabel(5), '#5');
  assert.equal(ghLabel(5, 'acme/api'), 'api#5');
});

test('repoOfItem is the same helper on the board', () => {
  assert.equal(boardRepoOfItem, repoOfItem);
  assert.equal(repoOfItem({ url: 'https://github.com/acme/api/pull/5' }), 'acme/api');
  assert.equal(repoOfItem({ url: 'x', repo: 'acme/web' }), 'acme/web');
});

test('sameItem and findItem match number and repository, set or read off the URL', () => {
  const items = [pr('acme/web', 5), pr('acme/api', 5), pr(undefined, 7)];
  assert.equal(sameItem(items[0], items[1]), false);
  assert.equal(sameItem(items[1], { ...items[1], repo: undefined }), true, 'the URL says which repository');
  assert.equal(findItem(items, 5, 'acme/api'), items[1]);
  assert.equal(findItem(items, 5, 'ACME/WEB'), items[0]);
  assert.equal(findItem(items, 7, 'acme/web'), items[2], 'a card with no repo field is read off its URL');
  assert.equal(findItem(items, 5), items[0], 'no repository: by number, as upstream');
  assert.equal(findItem(items, 5, 'acme/docs'), undefined);
});

test("a worker's own-floor PR is in the repository of its URL, else the floor's", () => {
  assert.equal(ownPullRepo({ url: 'https://github.com/acme/web/pull/5' }, 'acme/other'), 'acme/web');
  assert.equal(ownPullRepo({ url: '' }, 'acme/web'), 'acme/web');
  assert.equal(ownPullRepo({ url: '' }), undefined);
});

test("workerForRepoPull doesn't take another repository's PR with the same number", () => {
  const web = worker('w', { pr: { number: 5, url: 'https://github.com/acme/web/pull/5' }, worktree: { path: 'wt/w', branch: 'fix-w', base: 'x' } });
  const both = worker('b', {
    worktree: { path: 'wt/b', branch: 'fix-b', base: 'x' },
    pr: { number: 9, url: 'https://github.com/acme/web/pull/9' },
    repos: [{ floor: 'web~api', name: 'api', repo: 'acme/api', dir: '/code/api', path: 'ws/api', branch: 'fix-b', base: 'y', pr: { number: 5, url: 'https://github.com/acme/api/pull/5' } }],
  } as Partial<WorkerInfo>);
  const workers = [web, both];
  assert.equal(workerForRepoPull(workers, pr('acme/web', 5), 'acme/web', 'acme/web'), web);
  assert.equal(workerForRepoPull(workers, pr('acme/api', 5), 'acme/api', 'acme/web'), both, 'the api #5 is the multi-repo worker’s');
  assert.equal(workerForRepoPull(workers, pr('acme/api', 12, 'fix-b'), 'acme/api', 'acme/web'), both, 'by the branch it works on in that repository');
  assert.equal(workerForRepoPull(workers, pr('acme/api', 13, 'fix-w'), 'acme/api', 'acme/web'), undefined, 'a web-only worker’s branch name in api is someone else’s');
  assert.equal(workerForRepoPull(workers, pr('acme/web', 14, 'fix-w'), 'acme/web', 'acme/web'), web);
  assert.equal(workerForRepoPull(workers, pr('acme/docs', 5), 'acme/docs', 'acme/web'), undefined);
});
