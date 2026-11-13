import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghAssetId, ghAssetIds, ghAssetUrl, isGhAssetId } from '../src/shared/ghassets.js';
import { GH_ASSET_MAX_BYTES, GhAssets } from '../src/server/ghassets.js';
import { visitorPath } from '../src/server/multiplayer/paths.js';

const ID = '0a1b2c3d-1111-4222-8333-444455556666';
const TOKEN = 'gho_SECRETTOKEN123';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('attachment ids: only the exact user-attachments/assets address', () => {
  assert.ok(isGhAssetId(ID) && !isGhAssetId(`${ID}/x`) && !isGhAssetId('nope'));
  assert.equal(ghAssetId(ghAssetUrl(ID)), ID);
  assert.equal(ghAssetId(`https://github.com/user-attachments/assets/${ID.toUpperCase()}`), ID, 'lower-cased');
  assert.equal(ghAssetId(`https://github.com/user-attachments/files/${ID}`), undefined);
  assert.equal(ghAssetId(`https://evil.example/user-attachments/assets/${ID}`), undefined);
  assert.equal(ghAssetId(`https://github.com/user-attachments/assets/${ID}?x=1`), undefined);
  assert.equal(ghAssetId(`https://github.com.evil.example/user-attachments/assets/${ID}`), undefined);
  const other = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
  assert.deepEqual(ghAssetIds(`![a](https://github.com/user-attachments/assets/${ID}) text https://github.com/user-attachments/files/${other} <img src="https://github.com/user-attachments/assets/${other}">`), [ID, other]);
});

test('GhAssets.note and has: only ids seen in texts, and the oldest drop past the cap', () => {
  const a = new GhAssets();
  assert.equal(a.has(ID), false);
  a.note(undefined, `see ${ghAssetUrl(ID)}`);
  assert.ok(a.has(ID) && a.has(ID.toUpperCase()));
  assert.equal(a.has('99999999-aaaa-4bbb-8ccc-dddddddddddd'), false);
  const first = '00000000-0000-4000-8000-000000000000';
  a.note(ghAssetUrl(first));
  for (let i = 1; i <= 5000; i++) a.note(ghAssetUrl(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
  assert.equal(a.has(first), false, 'oldest dropped');
  assert.ok(a.has('00000000-0000-4000-8000-000000005000'));
});

type Call = { url: string; init: RequestInit };
const run = async (args: string[]) => {
  assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
  return `${TOKEN}\n`;
};
const stub = (answer: (n: number, c: Call) => Response) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(calls.length, { url, init });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const image = (type = 'image/png', body: Buffer | string = png) => new Response(body, { status: 200, headers: { 'content-type': type } });
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

test('a private repository’s picture: the token goes to github.com only, the signed address gets none', async () => {
  const s = stub((n) => (n === 1 ? redirect('https://private-user-images.githubusercontent.com/1/x.png?jwt=abc') : image()));
  const got = await new GhAssets().fetch(ID, run, '/tmp', s.fetchImpl);
  assert.deepEqual(got, { type: 'image/png', body: png });
  assert.equal(s.calls[0].url, ghAssetUrl(ID));
  assert.equal(s.calls[0].init.redirect, 'manual');
  assert.equal(header(s.calls[0].init, 'authorization'), `token ${TOKEN}`);
  assert.equal(s.calls[1].url, 'https://private-user-images.githubusercontent.com/1/x.png?jwt=abc');
  assert.equal(header(s.calls[1].init, 'authorization'), null);
  assert.equal(s.calls[1].init.redirect, 'error');
});

test('a public repository’s picture comes from the S3 host; the content type may carry a charset', async () => {
  const s = stub((n) => (n === 1 ? redirect('https://github-production-user-asset-6210df.s3.amazonaws.com/1/x.jpg') : image('image/jpeg; charset=binary')));
  const got = await new GhAssets().fetch(ID, run, '/tmp', s.fetchImpl);
  assert.ok('type' in got && got.type === 'image/jpeg');
  assert.equal(header(s.calls[1].init, 'authorization'), null);
  const direct = await new GhAssets().fetch(ID, run, '/tmp', stub(() => image('image/webp')).fetchImpl);
  assert.ok('type' in direct && direct.type === 'image/webp', 'a direct image answer is fine too');
});

test('hosts GitHub does not use for pictures are refused, with no second request', async () => {
  for (const to of ['https://evil.example/x.png', 'http://private-user-images.githubusercontent.com/x.png', 'https://githubusercontent.com.evil.example/x.png', 'https://evil.s3.amazonaws.com/x.png', 'https://github-production-user-asset-1.s3.amazonaws.com.evil.example/x.png', 'https://private-user-images.githubusercontent.com:8443/x.png']) {
    const s = stub(() => redirect(to));
    const got = await new GhAssets().fetch(ID, run, '/tmp', s.fetchImpl);
    assert.ok('status' in got && got.status === 502, to);
    assert.equal(s.calls.length, 1, to);
  }
});

test('wrong type, SVG, oversize, not found and failures are refused, and the token never appears in an error', async () => {
  const via = (res: () => Response) => stub((n) => (n === 1 ? redirect('https://private-user-images.githubusercontent.com/x') : res()));
  const types = ['text/html', 'image/svg+xml', 'application/octet-stream', ''];
  const results = [];
  for (const t of types) results.push(await new GhAssets().fetch(ID, run, '/tmp', via(() => image(t, 'x')).fetchImpl));
  results.push(await new GhAssets().fetch(ID, run, '/tmp', via(() => image('image/png', Buffer.alloc(GH_ASSET_MAX_BYTES + 1))).fetchImpl));
  results.push(await new GhAssets().fetch(ID, run, '/tmp', via(() => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(GH_ASSET_MAX_BYTES + 1) } })).fetchImpl));
  results.push(await new GhAssets().fetch(ID, run, '/tmp', stub(() => new Response('no', { status: 404 })).fetchImpl));
  results.push(await new GhAssets().fetch(ID, run, '/tmp', via(() => new Response('no', { status: 500 })).fetchImpl));
  results.push(await new GhAssets().fetch(ID, run, '/tmp', stub(() => new Response('x', { status: 200 })).fetchImpl));
  results.push(await new GhAssets().fetch(ID, run, '/tmp', stub(() => { throw new Error(`boom ${TOKEN}`); }).fetchImpl));
  results.push(await new GhAssets().fetch(ID, async () => { throw new Error(`gh said ${TOKEN}`); }, '/tmp', stub(() => image()).fetchImpl));
  results.push(await new GhAssets().fetch(ID, async () => '  \n', '/tmp', stub(() => image()).fetchImpl));
  assert.deepEqual(results.map((r) => ('status' in r ? r.status : 200)), [415, 415, 415, 415, 413, 413, 404, 502, 415, 502, 502, 502]);
  for (const r of results) assert.ok('status' in r && !r.error.includes(TOKEN), JSON.stringify(r));
});

test('a visitor is never given an attached picture (it would come with someone else’s GitHub access)', () => {
  assert.ok(!visitorPath('GET', '/api/gh/asset'));
  assert.ok(visitorPath('GET', '/api/gh/pull'));
});

test('the same picture asked for at once is fetched once', async () => {
  let tokens = 0;
  const counted = async (args: string[]) => (tokens++, run(args));
  const s = stub((n) => (n === 1 ? redirect('https://private-user-images.githubusercontent.com/1/x.png?jwt=abc') : image()));
  const a = new GhAssets();
  const got = await Promise.all([1, 2, 3].map(() => a.fetch(ID, counted, '/tmp', s.fetchImpl)));
  assert.ok(got.every((g) => 'body' in g));
  assert.equal(tokens, 1);
  assert.equal(s.calls.length, 2);
  // Afterwards it is fetched anew (nothing is kept).
  const again = stub((n) => (n === 1 ? redirect('https://private-user-images.githubusercontent.com/1/x.png?jwt=abc') : image()));
  await a.fetch(ID, counted, '/tmp', again.fetchImpl);
  assert.equal(tokens, 2);
});

// The route: a picture's address in a text is only a reference (anyone who may comment can write another
// repository's there), so who gets the bytes is GitHub's call with the asker's own sign-in.
const ask = async (session: object, signin: unknown, query = `id=${ID}&floor=f&repo=acme/app`) => {
  const assets = new GhAssets();
  assets.note(ghAssetUrl(ID));
  const asked: unknown[] = [];
  const board = { assets, asset: async (_id: string, as?: unknown) => (asked.push(as ?? 'office'), { type: 'image/png', body: png }) };
  const ctx = { floors: new Map([['f', { githubFor: () => board }]]), signins: { ghAs: () => signin, githubLogin: () => undefined } };
  const out = { status: 0, body: '' as string | Buffer };
  const res = { writeHead: (s: number) => ((out.status = s), res), setHeader() {}, end: (b?: string | Buffer) => void (out.body = b ?? '') };
  const { githubRoutes } = await import('../src/server/http/routes/github.js');
  await githubRoutes.github.handle(ctx as never, { res, url: new URL(`http://office/api/gh/asset?${query}`), path: '/api/gh/asset', session } as never);
  return { status: out.status, asked };
};

test('the picture route fetches with the asker’s own GitHub sign-in, never lending the office’s', async () => {
  const mine = { key: 'u1', env: { GH_CONFIG_DIR: '/homes/u1/gh' } };
  // Nobody signed in to an account (the office's own people), or an account an admin lets act as the office.
  assert.deepEqual(await ask({}, undefined), { status: 200, asked: ['office'] });
  assert.deepEqual(await ask({ account: { id: 'u1' } }, undefined), { status: 200, asked: ['office'] });
  // An account with its own sign-in: GitHub answers for that person's access.
  assert.deepEqual(await ask({ account: { id: 'u1' } }, mine), { status: 200, asked: [mine] });
  // An account that hasn't signed in to GitHub gets nothing, and neither does a visitor from another office.
  assert.deepEqual(await ask({ account: { id: 'u2' } }, 'Sign in to GitHub first'), { status: 403, asked: [] });
  assert.deepEqual(await ask({ visitor: { login: 'guest' } }, undefined), { status: 403, asked: [] });
  // An id the office never showed in that repository, and a bad one.
  assert.equal((await ask({}, undefined, 'id=99999999-aaaa-4bbb-8ccc-dddddddddddd&floor=f')).status, 404);
  assert.equal((await ask({}, undefined, 'id=nope&floor=f')).status, 400);
});

test('one person’s fetch under way is never another’s answer', async () => {
  const a = new GhAssets();
  const runs: string[] = [];
  const as = (who: string) => async (args: string[]) => (runs.push(who), run(args));
  const s = stub((n) => (n % 2 ? redirect('https://private-user-images.githubusercontent.com/1/x.png?jwt=abc') : image()));
  await Promise.all([a.fetch(ID, as('office'), '/tmp', s.fetchImpl), a.fetch(ID, as('u1'), '/tmp', s.fetchImpl, 'account:u1'), a.fetch(ID, as('u1'), '/tmp', s.fetchImpl, 'account:u1')]);
  assert.deepEqual(runs.sort(), ['office', 'u1']);
});
