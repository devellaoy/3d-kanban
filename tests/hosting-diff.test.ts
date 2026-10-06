// A pull request's diff on Azure DevOps and Bitbucket, read from the host (no fetch into a
// checkout): Azure DevOps' built from the changed files' blobs (unidiff.ts), Bitbucket's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRefOf } from '../src/shared/hosting/remote.js';
import { azureProvider } from '../src/server/hosting/azure.js';
import { bitbucketProvider } from '../src/server/hosting/bitbucket.js';
import { unifiedHunks } from '../src/server/hosting/unidiff.js';
import type { Fetch, HostAs } from '../src/server/hosting/provider.js';
import { main } from '../bin/office-pr.js';

const AZ: HostAs = { kind: 'azure', auth: 'Basic az', key: 'acc123456' };
const BB: HostAs = { kind: 'bitbucket', auth: 'Basic bb', key: 'acc123456' };

test('unifiedHunks: what patch applies back, with git’s notes and numbering', () => {
  assert.equal(unifiedHunks('a\nb\nc\n', 'a\nb\nc\n'), '');
  assert.equal(unifiedHunks('', 'x\ny\n'), '@@ -0,0 +1,2 @@\n+x\n+y\n');
  assert.equal(unifiedHunks('x\n', ''), '@@ -1,1 +0,0 @@\n-x\n');
  assert.equal(unifiedHunks('a\nb', 'a\nb\n'), '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
  // Far apart changes are two hunks; patch takes them back to the new text.
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = before.replace('line 2\n', 'line two\n').replace('line 27\n', 'line 27\nadded\n');
  const hunks = unifiedHunks(before, after);
  assert.equal(hunks.match(/^@@/gm)?.length, 2);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unidiff-'));
  writeFileSync(path.join(dir, 'f'), before);
  writeFileSync(path.join(dir, 'p'), `--- a/f\n+++ b/f\n${hunks}`);
  execFileSync('patch', ['-s', path.join(dir, 'f'), path.join(dir, 'p')]);
  assert.equal(readFileSync(path.join(dir, 'f'), 'utf8'), after);
});

test("Azure DevOps: the latest iteration's files against the merge base, from their blobs", async () => {
  const repo = repoRefOf('azure:contoso/Web/api')!;
  const blobs: Record<string, string> = { old1: 'a\nb\n', new1: 'a\nB\n', new2: 'fresh\n', old3: 'gone\n', bin: 'x\0y' };
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    if (/\/iterations\?/.test(url)) return new Response(JSON.stringify({ value: [{ id: 1 }, { id: 3 }, { id: 2 }] }));
    if (/\/iterations\/3\/changes\?/.test(url)) {
      return new Response(JSON.stringify({ changeEntries: [
        { changeType: 'edit', item: { path: '/src/a.ts', objectId: 'new1', originalObjectId: 'old1', gitObjectType: 'blob' } },
        { changeType: 'add', item: { path: '/src/new.ts', objectId: 'new2', gitObjectType: 'blob' } },
        { changeType: 'delete', item: { path: '/old.txt', originalObjectId: 'old3', gitObjectType: 'blob' } },
        { changeType: 'rename, edit', originalPath: '/img/a.png', item: { path: '/img/b.png', objectId: 'bin', originalObjectId: 'bin', gitObjectType: 'blob' } },
        { changeType: 'add', item: { path: '/src', isFolder: true } },
      ] }));
    }
    const m = /\/blobs\/([^?]+)\?/.exec(url);
    if (m) return new Response(blobs[m[1]]);
    return new Response('{"message":"no"}', { status: 404 });
  };
  const diff = await azureProvider.diff(repo, 7, AZ, fetch);
  assert.equal(
    diff,
    [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' a', '-b', '+B',
      'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,1 @@', '+fresh',
      'diff --git a/old.txt b/old.txt', 'deleted file mode 100644', '--- a/old.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-gone',
      'diff --git a/img/a.png b/img/b.png', 'rename from img/a.png', 'rename to img/b.png', 'Binary files a/img/a.png and b/img/b.png differ',
      '',
    ].join('\n'),
  );
  assert.ok(asked.every((u) => u.includes('api-version=7.1')));
  assert.ok(asked.some((u) => /\/iterations\/3\/changes\?\$top=2000&\$compareTo=0&api-version=7\.1/.test(u)), 'the latest iteration');
});

test('unifiedHunks: a big file with changes everywhere shows as taken out and put in, without a long search', () => {
  const a = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const b = a.replace(/line (\d*7)\n/g, 'changed $1\n');
  const at = Date.now();
  const hunks = unifiedHunks(a, b);
  assert.ok(Date.now() - at < 2000, `took ${Date.now() - at} ms`);
  assert.equal(hunks.match(/^@@/gm)?.length, 1, 'one hunk: the old lines out, the new in');
});

test('Azure DevOps: blobs past the file cap are named, not read; the diff is kept per iteration', async () => {
  const { azureDiffCache } = await import('../src/server/hosting/azure-diff.js');
  azureDiffCache.clear();
  const repo = repoRefOf('azure:contoso/Web/big')!;
  let iteration = 1;
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    if (/\/iterations\?/.test(url)) return new Response(JSON.stringify({ value: [{ id: iteration }] }));
    if (/\/changes\?/.test(url)) {
      return new Response(JSON.stringify({ changeEntries: [
        { changeType: 'add', item: { path: '/huge.txt', objectId: 'huge', gitObjectType: 'blob' } },
        { changeType: 'add', item: { path: '/small.txt', objectId: 'small', gitObjectType: 'blob' } },
      ] }));
    }
    if (url.includes('/blobs/huge')) return new Response('x'.repeat(2 * 1024 * 1024));
    if (url.includes('/blobs/small')) return new Response('hi\n');
    return new Response('{"message":"no"}', { status: 404 });
  };
  const diff = await azureProvider.diff(repo, 1, AZ, fetch);
  assert.match(diff, /diff --git a\/huge\.txt b\/huge\.txt\nnew file mode 100644\n\\ Too big to show here/);
  assert.match(diff, /\+\+\+ b\/small\.txt\n@@ -0,0 \+1,1 @@\n\+hi\n/);
  const blobs = () => asked.filter((u) => u.includes('/blobs/')).length;
  assert.equal(await azureProvider.diff(repo, 1, AZ, fetch), diff);
  assert.equal(blobs(), 2, 'the same iteration: kept');
  iteration = 2;
  await azureProvider.diff(repo, 1, AZ, fetch);
  assert.equal(blobs(), 4, 'a new push: read again');
});

test('Bitbucket: its own diff, following its redirect on its own API only', async () => {
  const repo = repoRefOf('bitbucket:acme/widget')!;
  const seen: string[] = [];
  const answer = (location: string): Fetch => async (url, init) => {
    seen.push(url);
    assert.equal((init?.headers as Record<string, string>).authorization, 'Basic bb');
    if (url.endsWith('/pullrequests/3/diff')) return new Response(null, { status: 302, headers: { location } });
    return new Response('diff --git a/x b/x\n');
  };
  assert.equal(await bitbucketProvider.diff(repo, 3, BB, answer('/2.0/repositories/acme/widget/diff/acme/widget:aaa%0Dbbb?from_pullrequest_id=3')), 'diff --git a/x b/x\n');
  assert.equal(seen.at(-1), 'https://api.bitbucket.org/2.0/repositories/acme/widget/diff/acme/widget:aaa%0Dbbb?from_pullrequest_id=3');
  seen.length = 0;
  await assert.rejects(bitbucketProvider.diff(repo, 3, BB, answer('https://evil.example/steal')));
  assert.equal(seen.length, 1, 'the token never went to another host');
});

test('office-pr diff asks the office and runs no git that writes', async () => {
  const gitCalls: string[][] = [];
  const asked: string[] = [];
  const out: string[] = [];
  const env = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:1', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 't' };
  const fetch = (async (url: string) => {
    asked.push(new URL(url).pathname);
    return new Response(JSON.stringify(url.includes('/view') ? { ok: true, pr: { number: 4 }, checks: [] } : { ok: true, diff: 'diff --git a/x b/x\n' }));
  }) as typeof globalThis.fetch;
  const git = (args: string[]) => (gitCalls.push(args), args[0] === 'rev-parse' ? '/w/api' : 'feat/x');
  assert.equal(await main(['diff', '4'], { env, fetch, git, out: (s) => out.push(s), err: () => {}, cwd: '/w/api' }), 0);
  assert.deepEqual(asked, ['/office/pr/view', '/office/pr/diff']);
  assert.deepEqual(out, ['diff --git a/x b/x\n']);
  assert.deepEqual(gitCalls.map((a) => a[0]), ['rev-parse'], 'no fetch, no diff in the checkout');
});
