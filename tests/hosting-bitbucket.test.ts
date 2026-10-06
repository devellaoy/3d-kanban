import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_PAGES, bitbucketProvider as bb } from '../src/server/hosting/bitbucket.js';
import type { Fetch, HostAs } from '../src/server/hosting/provider.js';
import { repoRefOf } from '../src/shared/hosting/remote.js';

const as: HostAs = { kind: 'bitbucket', auth: 'Basic x', key: 'acc123456' };
const repo = repoRefOf('bitbucket:acme/widgets')!;
const API = 'https://api.bitbucket.org/2.0/repositories/acme/widgets';

interface Call {
  url: string;
  method: string;
  body?: any;
  auth?: string;
}

/** A fetch that answers by URL (exact, or the first route the URL starts with) and records every call. */
function stub(routes: Record<string, unknown>, status = 200): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
    const key = url in routes ? url : Object.keys(routes).find((k) => url.startsWith(k));
    if (key === undefined) return new Response(JSON.stringify({ error: { message: `no route for ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status });
  };
  return { fetch, calls };
}

const pr = (id: number, state: string, more: any = {}) => ({
  id,
  title: `PR ${id}`,
  state,
  draft: false,
  description: `about ${id}`,
  author: { display_name: 'Ada Lovelace', nickname: 'ada' },
  source: { branch: { name: `feat/${id}` }, commit: { hash: `abc${id}` }, repository: { full_name: 'acme/widgets' } },
  destination: { branch: { name: 'main' }, repository: { full_name: 'acme/widgets' } },
  created_on: '2026-10-01T10:00:00Z',
  updated_on: '2026-10-02T10:00:00Z',
  links: { html: { href: `https://bitbucket.org/acme/widgets/pull-requests/${id}` } },
  ...more,
});

test('listPulls maps open (with participants and statuses), draft, merged and declined pull requests, following next', async () => {
  const { fetch, calls } = stub({
    [`${API}/pullrequests?state=OPEN&pagelen=50`]: { values: [pr(1, 'OPEN'), pr(2, 'OPEN', { draft: true })], next: `${API}/pullrequests?state=OPEN&pagelen=50&page=2` },
    [`${API}/pullrequests?state=OPEN&pagelen=50&page=2`]: { values: [pr(3, 'OPEN', { source: { branch: { name: 'x' }, commit: { hash: 'h3' }, repository: { full_name: 'Someone/widgets' } } })] },
    [`${API}/pullrequests?state=MERGED&pagelen=30`]: { values: [pr(4, 'MERGED')], next: `${API}/pullrequests?state=MERGED&pagelen=30&page=2` },
    [`${API}/pullrequests?state=DECLINED&pagelen=40`]: { values: [pr(5, 'DECLINED', { links: {} })] },
    [`${API}/pullrequests/1/statuses`]: { values: [{ state: 'SUCCESSFUL', name: 'build', url: 'https://ci/1' }, { state: 'FAILED', key: 'lint' }] },
    [`${API}/pullrequests/2/statuses`]: { values: [{ state: 'SUCCESSFUL', name: 'build' }, { state: 'INPROGRESS', name: 'test' }] },
    [`${API}/pullrequests/3/statuses`]: { values: [] },
    [`${API}/pullrequests/1`]: pr(1, 'OPEN', { participants: [{ state: 'approved' }, { state: 'changes_requested' }] }),
    [`${API}/pullrequests/2`]: pr(2, 'OPEN', { participants: [{ state: 'approved', approved: true }, { state: null }] }),
    [`${API}/pullrequests/3`]: pr(3, 'OPEN', { participants: [] }),
  });
  const pulls = await bb.listPulls(repo, as, fetch);
  assert.deepEqual(pulls.map((p) => [p.number, p.state, p.isDraft, p.reviewDecision, p.checks, p.isCrossRepository]), [
    [1, 'OPEN', false, 'CHANGES_REQUESTED', 'fail', false],
    [2, 'OPEN', true, 'APPROVED', 'pending', false],
    [3, 'OPEN', false, '', 'none', true],
    [4, 'MERGED', false, '', 'none', false],
    [5, 'CLOSED', false, '', 'none', false],
  ]);
  const first = pulls[0];
  assert.equal(first.url, 'https://bitbucket.org/acme/widgets/pull-requests/1');
  assert.equal(first.author, 'Ada Lovelace');
  assert.equal(first.headRefName, 'feat/1');
  assert.equal(first.headRefOid, 'abc1');
  assert.equal(first.baseRefName, 'main');
  assert.equal(first.createdAt, '2026-10-01T10:00:00Z');
  assert.equal(first.updatedAt, '2026-10-02T10:00:00Z');
  assert.equal(first.body, 'about 1');
  assert.equal(first.repo, 'bitbucket:acme/widgets');
  assert.deepEqual([first.labels, first.closes, first.additions, first.deletions], [[], [], 0, 0]);
  assert.equal(pulls[4].url, 'https://bitbucket.org/acme/widgets/pull-requests/5', 'falls back to the PR page by its number');
  assert.ok(!calls.some((c) => c.url.includes('MERGED') && c.url.includes('page=2')), 'merged is one page only');
  assert.ok(!calls.some((c) => /pullrequests\/[45]/.test(c.url)), 'closed ones get no extra calls');
  assert.ok(calls.every((c) => c.auth === 'Basic x'));
});

test('listPulls keeps an open pull request whose details fail', async () => {
  const { fetch } = stub({
    [`${API}/pullrequests?state=OPEN&pagelen=50`]: { values: [pr(7, 'OPEN')] },
    [`${API}/pullrequests?state=MERGED&pagelen=30`]: { values: [] },
    [`${API}/pullrequests?state=DECLINED&pagelen=40`]: { values: [] },
  });
  const pulls = await bb.listPulls(repo, as, fetch);
  assert.deepEqual(pulls.map((p) => [p.number, p.reviewDecision, p.checks]), [[7, '', 'none']]);
});

test('listPulls follows next only on the API itself', async () => {
  const { fetch, calls } = stub({
    [`${API}/pullrequests?state=OPEN&pagelen=50`]: { values: [], next: 'https://evil.example/steal' },
    [`${API}/pullrequests?state=MERGED&pagelen=30`]: { values: [] },
    [`${API}/pullrequests?state=DECLINED&pagelen=40`]: { values: [] },
  });
  await bb.listPulls(repo, as, fetch);
  assert.ok(!calls.some((c) => c.url.includes('evil')));
});

test('createPr sends the branches, the draft flag and keeps the source branch; the base is optional', async () => {
  const { fetch, calls } = stub({ [`${API}/pullrequests`]: { id: 42 } });
  const made = await bb.createPr(repo, { head: 'feat/x', base: 'develop', title: 'T', body: 'B', draft: true }, as, fetch);
  assert.deepEqual(made, { number: 42, url: 'https://bitbucket.org/acme/widgets/pull-requests/42' });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { title: 'T', description: 'B', source: { branch: { name: 'feat/x' } }, destination: { branch: { name: 'develop' } }, draft: true, close_source_branch: false });
  await bb.createPr(repo, { head: 'feat/y', title: 'T2', body: 'B2' }, as, fetch);
  assert.deepEqual(calls[1].body, { title: 'T2', description: 'B2', source: { branch: { name: 'feat/y' } }, draft: false, close_source_branch: false });
});

test('findOpenPr asks for the branch with its quotes and backslashes escaped', async () => {
  const { fetch, calls } = stub({ [`${API}/pullrequests?`]: { values: [{ id: 9 }] } });
  const found = await bb.findOpenPr(repo, 'we"ird\\branch', as, fetch);
  assert.deepEqual(found, { number: 9, url: 'https://bitbucket.org/acme/widgets/pull-requests/9' });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('state'), 'OPEN');
  assert.equal(url.searchParams.get('pagelen'), '1');
  assert.equal(url.searchParams.get('q'), 'source.branch.name="we\\"ird\\\\branch"');
  const none = stub({ [`${API}/pullrequests?`]: { values: [] } });
  assert.equal(await bb.findOpenPr(repo, 'main', as, none.fetch), undefined);
});

test('comment posts raw content and answers with its page; comments skip the deleted', async () => {
  const { fetch, calls } = stub({
    // Asked for the newest first.
    [`${API}/pullrequests/3/comments?pagelen=100&sort=-created_on`]: {
      values: [
        { id: 13, user: { nickname: 'eve', uuid: '{eve}' }, content: { raw: 'nit' }, created_on: '2026-10-04', inline: { path: 'src/a.ts', to: 7 } },
        { id: 12, deleted: true, user: { display_name: 'Bob' }, content: { raw: '' } },
        { id: 11, user: { display_name: 'Bob', uuid: '{bob}' }, content: { raw: 'hi' }, created_on: '2026-10-03', links: { html: { href: 'https://bitbucket.org/c/11' } } },
      ],
    },
    [`${API}/pullrequests/3/comments`]: { id: 14, links: { html: { href: 'https://bitbucket.org/c/14' } } },
    // Bob is a member of the workspace; Eve isn't (404).
    ['https://api.bitbucket.org/2.0/workspaces/acme/members/%7Bbob%7D']: { user: { uuid: '{bob}' } },
    [API]: { is_private: false },
  });
  assert.equal(await bb.comment(repo, 3, 'Looks good', as, fetch), 'https://bitbucket.org/c/14');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { content: { raw: 'Looks good' } });
  assert.deepEqual(await bb.comments(repo, 3, as, fetch), [
    { id: '11', author: 'Bob', body: 'hi', createdAt: '2026-10-03', url: 'https://bitbucket.org/c/11', trusted: true },
    { id: '13', author: 'eve', body: 'nit', createdAt: '2026-10-04', path: 'src/a.ts', line: 7, trusted: false },
  ], 'a public repository: a workspace member’s comment is trusted, anybody else’s is not');
});

test('comments on a private repository are trusted from anyone (only people with access can comment); a fork’s author and the reviewers it picked are not trusted for that', async () => {
  const values = { values: [{ id: 1, user: { uuid: '{eve}' }, content: { raw: 'x' }, created_on: '1' }] };
  const priv = stub({ [`${API}/pullrequests/3/comments?pagelen=100&sort=-created_on`]: values, [API]: { is_private: true } });
  assert.equal((await bb.comments(repo, 3, as, priv.fetch))[0].trusted, true);
  // Public, and Eve wrote the fork's pull request and picked her friend as its reviewer: no member, no trust.
  const fork = stub({ [`${API}/pullrequests/3/comments?pagelen=100&sort=-created_on`]: values, [`${API}/pullrequests/3`]: pr(3, 'OPEN', { author: { uuid: '{eve}' }, participants: [{ role: 'REVIEWER', user: { uuid: '{eve}' } }] }), [API]: { is_private: false } });
  assert.equal((await bb.comments(repo, 3, as, fork.fetch))[0].trusted, false);
  const unknown = stub({ [`${API}/pullrequests/3/comments?pagelen=100&sort=-created_on`]: values });
  assert.equal((await bb.comments(repo, 3, as, unknown.fetch))[0].trusted, false, 'a repository that can’t be read counts as public');
});


test('viewPr maps the state, review and a fork; isFork agrees', async () => {
  const fork = pr(8, 'SUPERSEDED', { draft: true, participants: [{ state: 'approved' }], source: { branch: { name: 'theirs' }, repository: { full_name: 'other/widgets' } } });
  const { fetch } = stub({ [`${API}/pullrequests/8`]: fork, [`${API}/pullrequests/9`]: pr(9, 'OPEN') });
  assert.deepEqual(await bb.viewPr(repo, 8, as, fetch), {
    number: 8,
    url: 'https://bitbucket.org/acme/widgets/pull-requests/8',
    title: 'PR 8',
    body: 'about 8',
    state: 'CLOSED',
    isDraft: true,
    headRefName: 'theirs',
    baseRefName: 'main',
    author: 'Ada Lovelace',
    reviewDecision: 'APPROVED',
    isCrossRepository: true,
  });
  assert.equal(await bb.isFork(repo, 8, as, fetch), true);
  assert.equal(await bb.isFork(repo, 9, as, fetch), false);
});

test('checks, defaultBranch and whoAmI', async () => {
  const { fetch } = stub({
    [`${API}/pullrequests/5/statuses`]: { values: [{ state: 'STOPPED', name: 'deploy', url: 'https://ci/5' }, { state: 'INPROGRESS', key: 'k' }] },
    [API]: { mainbranch: { name: 'trunk' } },
    'https://api.bitbucket.org/2.0/user': { nickname: 'ada' },
  });
  assert.deepEqual(await bb.checks(repo, 5, as, fetch), [{ name: 'deploy', state: 'fail', url: 'https://ci/5' }, { name: 'k', state: 'pending' }]);
  assert.equal(await bb.defaultBranch(repo, as, fetch), 'trunk');
  assert.equal(await bb.whoAmI(as, fetch), 'ada');
});

test('updatePr puts only what changed', async () => {
  const { fetch, calls } = stub({ [`${API}/pullrequests/6`]: {} });
  await bb.updatePr(repo, 6, { body: 'new text' }, as, fetch);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `${API}/pullrequests/6`);
  assert.deepEqual(calls[0].body, { description: 'new text' });
  await bb.updatePr(repo, 6, { title: 'T', body: 'B' }, as, fetch);
  assert.deepEqual(calls[1].body, { title: 'T', description: 'B' });
});

test('a 401 is a readable error about the sign-in', async () => {
  const { fetch } = stub({ 'https://api.bitbucket.org/2.0/user': { type: 'error' } }, 401);
  await assert.rejects(bb.whoAmI(as, fetch), /Your Bitbucket sign-in stopped working/);
});

test('comments: every page up to the limit, the newest kept, in order; past the limit it says the oldest are missing', async () => {
  const first = `${API}/pullrequests/3/comments?pagelen=100&sort=-created_on`;
  const page2 = `${API}/pullrequests/3/comments?pagelen=100&sort=-created_on&page=2`;
  const c = (id: number) => ({ id, user: { uuid: '{bob}' }, content: { raw: `c${id}` }, created_on: `2026-10-${String(id).padStart(2, '0')}` });
  const two = stub({ [page2]: { values: [c(2), c(1)] }, [first]: { values: [c(4), c(3)], next: page2 }, [`${API}/pullrequests/3`]: pr(3, 'OPEN', { participants: [] }), [API]: { is_private: true } });
  assert.deepEqual((await bb.comments(repo, 3, as, two.fetch)).map((x) => x.body), ['c1', 'c2', 'c3', 'c4'], 'the second page’s too, oldest first');
  // A conversation longer than the pages read: the newest are there, and the first line says the rest are not.
  const routes: Record<string, unknown> = { [`${API}/pullrequests/3`]: pr(3, 'OPEN', { participants: [] }), [API]: { is_private: true } };
  for (let i = 1; i <= COMMENT_PAGES; i++) {
    const url = i === 1 ? first : `${first}&page=${i}`;
    routes[url] = { values: [c(100 - i)], next: `${first}&page=${i + 1}` };
  }
  const long = await bb.comments(repo, 3, as, stub(routes).fetch);
  assert.equal(long.length, COMMENT_PAGES + 1);
  assert.match(long[0].body, /Only the latest 1000 comments are shown here/);
  assert.equal(long.at(-1)!.body, 'c99', 'the newest last');
});

test('polling: an open PR’s details are kept until it changes (or a while), so an hour of looks stays far under Bitbucket’s limit', async () => {
  const { bitbucketCache, DETAIL_MS, PENDING_MS } = await import('../src/server/hosting/bitbucket.js');
  bitbucketCache.clear();
  let now = 1_000_000;
  bitbucketCache.now = () => now;
  try {
    const open = Array.from({ length: 12 }, (_, i) => pr(i + 1, 'OPEN', { updated_on: 'u1', source: { branch: { name: `b${i}` }, commit: { hash: 'h1' }, repository: { full_name: 'acme/widgets' } } }));
    let state = 'SUCCESSFUL';
    const calls: string[] = [];
    const fetch: Fetch = async (url) => {
      calls.push(url);
      if (url.includes('state=OPEN')) return new Response(JSON.stringify({ values: open }));
      if (url.includes('pullrequests?state=')) return new Response(JSON.stringify({ values: [] }));
      if (url.includes('/statuses')) return new Response(JSON.stringify({ values: [{ name: 'ci', state }] }));
      return new Response(JSON.stringify(pr(1, 'OPEN', { participants: [] })));
    };
    const look = () => bb.listPulls(repo, as, fetch);
    await look();
    assert.equal(calls.length, 3 + 12 * 2, 'the first look asks for every detail');
    calls.length = 0;
    // An hour of looks every 90 seconds while nothing changes.
    for (let t = 1; t <= 40; t++) {
      now += 90_000;
      await look();
    }
    assert.ok(calls.length < 300, `${calls.length} requests in an hour`);
    assert.equal(calls.filter((u) => u.includes('/statuses')).length, Math.floor((40 * 90_000) / DETAIL_MS) * 12, 'details again only after DETAIL_MS');
    // A changed PR is asked again at once.
    calls.length = 0;
    open[0] = { ...open[0], updated_on: 'u2' };
    await look();
    assert.equal(calls.filter((u) => u.includes('/statuses')).length, 1);
    // Running checks are looked at more often.
    bitbucketCache.clear();
    state = 'INPROGRESS';
    await look();
    calls.length = 0;
    now += PENDING_MS + 1;
    await look();
    assert.equal(calls.filter((u) => u.includes('/statuses')).length, 12);
  } finally {
    bitbucketCache.now = () => Date.now();
    bitbucketCache.clear();
  }
});

test('a 429 makes the office wait as Bitbucket asks: nothing goes out until then', async () => {
  const { hostRate } = await import('../src/server/hosting/http.js');
  hostRate.clear();
  let now = 5_000_000;
  hostRate.now = () => now;
  try {
    let sent = 0;
    const fetch: Fetch = async () => (sent++ === 0 ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : new Response(JSON.stringify(pr(3, 'OPEN'))));
    const who: HostAs = { ...as, key: 'rate-test' };
    await assert.rejects(bb.viewPr(repo, 3, who, fetch), /asked the office to slow down \(429\): it tries again in 30 s/);
    now += 10_000;
    await assert.rejects(bb.viewPr(repo, 3, who, fetch), /tries again in 20 s/);
    assert.equal(sent, 1, 'nothing sent while waiting');
    now += 21_000;
    assert.equal((await bb.viewPr(repo, 3, who, fetch)).number, 3);
    assert.equal(sent, 2);
  } finally {
    hostRate.now = () => Date.now();
    hostRate.clear();
  }
});
