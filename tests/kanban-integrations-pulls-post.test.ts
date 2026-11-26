// Posting a pull-request review on its pull requests (integrations/pulls/postreview.ts, KanbanPullsApi.postReview): the body, the one
// COMMENT review per pull request through gh (a fake one here), a comment elsewhere, and a result per pull request that never throws.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHub } from '../src/server/github.js';
import type { Floor } from '../src/server/floor.js';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { POST_MAX, postReview, reviewBody } from '../src/server/kanban/integrations/pulls/postreview.js';
import { WHO, def, makeCtx } from './kanban-integrations-ctx.js';

const PRS = [
  { repo: 'o/web', number: 3, title: 'Fix login' },
  { repo: 'o/web', number: 4 },
];
const REVIEW = 'src/login.ts:12 never clears the cache.\n\nREVIEW: CHANGES_REQUESTED\nWORK DONE';

test('the body: a header with the verdict, the list of the pull requests when there are several, the text without its verdict and work-done lines', () => {
  assert.equal(reviewBody([PRS[0]], 'Nothing to fix.\n\nREVIEW: APPROVED'), '**Review by Agent Office: approved**\n\nNothing to fix.');
  assert.equal(reviewBody([PRS[0]], REVIEW), '**Review by Agent Office: changes requested**\n\nsrc/login.ts:12 never clears the cache.');
  assert.equal(reviewBody(PRS, 'Fine.\nREVIEW: APPROVED'), '**Review by Agent Office: approved**\n\nThis review covers:\n- o/web#3 Fix login\n- o/web#4\n\nFine.');
  // No verdict line: a review that did not end with one counts as asking for changes, as everywhere.
  assert.match(reviewBody([PRS[0]], 'Unclear.'), /^\*\*Review by Agent Office: changes requested\*\*/);
  assert.match(reviewBody([PRS[0]], 'REVIEW: APPROVED'), /\(The reviewer gave no findings\.\)$/);
});

test('the verdict is the run’s own when it is given, and a review the office kept only the start of says so', () => {
  assert.match(reviewBody([PRS[0]], 'The start of a long review, cut here', { verdict: 'approved', cut: true }), /^\*\*Review by Agent Office: approved\*\*\n\nThe start of a long review, cut here\n\n\(The text of the review was cut here: the office kept only its first part\.\)$/);
  assert.match(reviewBody([PRS[0]], 'No verdict line left.', { verdict: 'changes_requested' }), /changes requested/);
  assert.match(reviewBody([PRS[0]], 'Text.\nREVIEW: APPROVED', { verdict: 'changes_requested' }), /changes requested/, 'what is given wins over the text');
});

test('a very long review is cut under GitHub’s limit, and says so', () => {
  const body = reviewBody(PRS, `${'finding. '.repeat(20_000)}\nREVIEW: APPROVED`);
  assert.ok(body.length <= POST_MAX, `${body.length} characters`);
  assert.ok(POST_MAX < 65_536);
  assert.ok(body.endsWith('(The review is cut off here: it is too long to post.)'));
  assert.match(body, /^\*\*Review by Agent Office: approved\*\*\n\nThis review covers:/);
});

/** A gh that records what it is asked and the body file it is given, and fails for the pull requests `failing` names. */
function fakeGh(failing: number[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-post-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'calls');
  mkdirSync(log);
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const n = (/pulls\\/(\\d+)\\/reviews/.exec(args.join(' ')) || [])[1];
if (!n) { process.stdout.write('[]'); process.exit(0); }
const file = (args.find((a) => a.startsWith('body=@')) || '').slice(6);
fs.writeFileSync(${JSON.stringify(log)} + '/' + n + '.json', JSON.stringify({ args, body: fs.readFileSync(file, 'utf8'), file, env: process.env.FAKE_GH_ACCOUNT || '' }));
if (${JSON.stringify(failing)}.includes(Number(n))) { process.stderr.write('HTTP 422: Unprocessable Entity (pull request is locked)'); process.exit(1); }
process.stdout.write('https://github.com/o/web/pull/' + n + '#pullrequestreview-77\\n');
`,
    { mode: 0o755 },
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const was = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${was}`;
  const calls = () => Object.fromEntries(readdirSync(log).map((f) => [Number(f.replace('.json', '')), JSON.parse(readFileSync(path.join(log, f), 'utf8')) as { args: string[]; body: string; file: string; env: string }]));
  return { calls, done: () => (process.env.PATH = was, rmSync(root, { recursive: true, force: true })) };
}

function floorOf(repo: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-post-floor-'));
  return { floor: { githubFor: () => new GitHub(dir, () => {}, () => {}, { nameWithOwner: repo }) } as unknown as Floor, dir };
}

test('GitHub: one COMMENT review per pull request through gh, the body in a file that is gone afterwards, the account’s own gh', { skip: process.platform === 'win32' }, async () => {
  const gh = fakeGh();
  const { floor, dir } = floorOf('o/web');
  try {
    const ctx = makeCtx([def('web', dir, { repo: 'o/web' })], { ghAs: (id) => (id === 'acc1' ? { env: { ...process.env as Record<string, string>, FAKE_GH_ACCOUNT: 'acc1' } } : undefined) });
    ctx.floors.set('web', floor);
    const got = await postReview(ctx, 'web', PRS, REVIEW, 'acc1');
    assert.deepEqual(got, [
      { repo: 'o/web', number: 3, url: 'https://github.com/o/web/pull/3#pullrequestreview-77' },
      { repo: 'o/web', number: 4, url: 'https://github.com/o/web/pull/4#pullrequestreview-77' },
    ]);
    const calls = gh.calls();
    assert.deepEqual(Object.keys(calls), ['3', '4'], 'once for each pull request');
    for (const n of [3, 4]) {
      const c = calls[n];
      assert.deepEqual(c.args.slice(0, 3), ['api', '--method', 'POST']);
      assert.ok(c.args.includes('repos/o/web/pulls/' + n + '/reviews'), c.args.join(' '));
      assert.ok(c.args.includes('event=COMMENT'), 'only a comment: never an approval or a change request');
      assert.equal(c.body, reviewBody(PRS, REVIEW));
      assert.equal(c.env, 'acc1', 'as the account that asked');
      assert.ok(!c.body.includes('WORK DONE') && !c.body.includes('REVIEW: CHANGES_REQUESTED'));
    }
    assert.ok(calls[3].file && !existsSync(calls[3].file), 'the body went through a file, which is gone afterwards');
  } finally {
    gh.done();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an error is a result for that pull request and the rest go on; nothing ever throws', { skip: process.platform === 'win32' }, async () => {
  const gh = fakeGh([3]);
  const { floor, dir } = floorOf('o/web');
  try {
    const ctx = makeCtx([def('web', dir, { repo: 'o/web' })]);
    ctx.floors.set('web', floor);
    const got = await postReview(ctx, 'web', PRS, REVIEW);
    assert.equal(got[0].number, 3);
    assert.match(got[0].error ?? '', /422|locked/);
    assert.equal(got[0].url, undefined);
    assert.equal(got[1].url, 'https://github.com/o/web/pull/4#pullrequestreview-77');
    // The floor closed, or no board for the repository: an error per pull request, not an exception.
    const shut = makeCtx([def('web', dir, { repo: 'o/web' })]);
    const none = await postReview(shut, 'web', PRS, REVIEW);
    assert.deepEqual(none.map((r) => [r.number, !!r.error]), [[3, true], [4, true]]);
    // An account with no GitHub sign-in: why, per pull request, and gh is not run for it.
    const before = Object.keys(gh.calls()).length;
    const signedOut = makeCtx([def('web', dir, { repo: 'o/web' })], { ghAs: () => 'Sign in to GitHub first' });
    signedOut.floors.set('web', floor);
    assert.deepEqual((await postReview(signedOut, 'web', PRS, REVIEW, 'x')).map((r) => r.error), ['Sign in to GitHub first', 'Sign in to GitHub first']);
    assert.equal(Object.keys(gh.calls()).length, before);
  } finally {
    gh.done();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository on Azure DevOps or Bitbucket gets its board’s review (a comment) with the account, not gh', async () => {
  const seen: unknown[][] = [];
  const hosted = { hosted: { host: 'azure' }, review: async (...args: unknown[]) => (seen.push(args), 'https://dev.azure.com/org/p/_git/r/pullrequest/9?_a=overview#c1') };
  const ctx = makeCtx([def('web', '/tmp/none', { repo: 'o/web' })], { ghAs: () => 'gh must not be asked for a hosted repository' });
  ctx.floors.set('web', { githubFor: () => hosted } as unknown as Floor);
  const got = await postReview(ctx, 'web', [{ repo: 'azure:org/p/r', number: 9 }], 'Fine.\nREVIEW: APPROVED', 'acc7');
  assert.deepEqual(got, [{ repo: 'azure:org/p/r', number: 9, url: 'https://dev.azure.com/org/p/_git/r/pullrequest/9?_a=overview#c1' }]);
  assert.equal(seen[0][0], 9);
  assert.equal(seen[0][2], undefined, 'no gh sign-in');
  assert.equal(seen[0][3], 'acc7', 'the host’s credentials of the account');
});

test('KanbanPullsApi.postReview is the plugin’s, and goes through the project’s floor', async () => {
  const { floor, dir } = floorOf('o/web');
  const gh = fakeGh();
  try {
    const ctx = makeCtx([def('web', dir, { repo: 'o/web' })]);
    ctx.floors.set('web', floor);
    const parts = createPullsParts(ctx);
    const got = await parts.api.postReview!('web', [PRS[0]], 'Ok.\nREVIEW: APPROVED', WHO.accountId);
    assert.equal(got.length, 1);
    assert.equal(got[0].url, 'https://github.com/o/web/pull/3#pullrequestreview-77');
  } finally {
    gh.done();
    rmSync(dir, { recursive: true, force: true });
  }
});
