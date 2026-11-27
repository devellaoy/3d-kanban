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
import { reviewParts } from '../src/server/kanban/integrations/pulls/reviewparts.js';
import { WHO, def, makeCtx } from './kanban-integrations-ctx.js';

const PRS = [
  { repo: 'o/web', number: 3, title: 'Fix login' },
  { repo: 'o/web', number: 4 },
];
const REVIEW = 'src/login.ts:12 never clears the cache.\n\nREVIEW: CHANGES_REQUESTED\nWORK DONE';

test('the body: a header with the verdict, the list of the pull requests when there are several, the text without its verdict and work-done lines', () => {
  assert.equal(reviewBody(PRS[0], [PRS[0]], 'Nothing to fix.\n\nREVIEW: APPROVED'), '**Review: approved**\n\nNothing to fix.');
  assert.equal(reviewBody(PRS[0], [PRS[0]], REVIEW), '**Review: changes requested**\n\nsrc/login.ts:12 never clears the cache.');
  assert.equal(reviewBody(PRS[0], PRS, 'Fine.\nREVIEW: APPROVED'), '**Review: approved**\n\nThis review covers:\n- o/web#3 Fix login\n- o/web#4\n\nFine.');
  // No verdict line: a review that did not end with one counts as asking for changes, as everywhere.
  assert.match(reviewBody(PRS[0], [PRS[0]], 'Unclear.'), /^\*\*Review: changes requested\*\*/);
  assert.match(reviewBody(PRS[0], [PRS[0]], 'REVIEW: APPROVED'), /\(The reviewer gave no findings\.\)$/);
});

test('the verdict is the run’s own when it is given, and a review the office kept only the start of says so', () => {
  assert.match(reviewBody(PRS[0], [PRS[0]], 'The start of a long review, cut here', { verdict: 'approved', cut: true }), /^\*\*Review: approved\*\*\n\nThe start of a long review, cut here\n\n\(The text of the review was cut here: the office kept only its first part\.\)$/);
  assert.match(reviewBody(PRS[0], [PRS[0]], 'No verdict line left.', { verdict: 'changes_requested' }), /changes requested/);
  assert.match(reviewBody(PRS[0], [PRS[0]], 'Text.\nREVIEW: APPROVED', { verdict: 'changes_requested' }), /changes requested/, 'what is given wins over the text');
});

test('the fixed lines follow the language: Finnish ones, English for a language the office has none for', () => {
  const fi = reviewBody(PRS[0], PRS, 'Fine.\nREVIEW: APPROVED', { language: ' finnish ', cut: true });
  assert.match(fi, /^\*\*Katselmointi: hyväksytty\*\*\n\nTämä katselmointi kattaa:\n- o\/web#3 Fix login/);
  assert.ok(fi.endsWith('(Katselmoinnin teksti katkaistiin tästä: toimisto säilytti vain sen alkuosan.)'));
  assert.match(reviewBody(PRS[0], [PRS[0]], REVIEW, { language: 'Finnish' }), /^\*\*Katselmointi: muutoksia pyydetty\*\*/);
  assert.equal(reviewBody(PRS[0], [PRS[0]], REVIEW, { language: 'Klingon' }), reviewBody(PRS[0], [PRS[0]], REVIEW));
});

test('a very long review is cut under GitHub’s limit, and says so', () => {
  const body = reviewBody(PRS[0], PRS, `${'finding. '.repeat(20_000)}\nREVIEW: APPROVED`);
  assert.ok(body.length <= POST_MAX, `${body.length} characters`);
  assert.ok(POST_MAX < 65_536);
  assert.ok(body.endsWith('(The review is cut off here: it is too long to post.)'));
  assert.match(body, /^\*\*Review: approved\*\*\n\nThis review covers:/);
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
if (args[0] === 'pr' && args[1] === 'comment') {
  const bf = args[args.indexOf('--body-file') + 1];
  const attached = args.flatMap((a, i) => (a === '--attach' ? [args[i + 1]] : []));
  fs.writeFileSync(${JSON.stringify(log)} + '/comment-' + args[2] + '.json', JSON.stringify({ args, body: fs.readFileSync(bf, 'utf8'), attached: attached.filter((f) => fs.existsSync(f)).map((f) => require('path').basename(f)) }));
  process.stdout.write('Created\\nhttps://github.com/o/web/pull/' + args[2] + '#issuecomment-5\\n');
  process.exit(0);
}
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
  const calls = () => Object.fromEntries(readdirSync(log).filter((f) => /^\d+\.json$/.test(f)).map((f) => [Number(f.replace('.json', '')), JSON.parse(readFileSync(path.join(log, f), 'utf8')) as { args: string[]; body: string; file: string; env: string }]));
  const comment = (n: number) => JSON.parse(readFileSync(path.join(log, `comment-${n}.json`), 'utf8')) as { args: string[]; body: string; attached: string[] };
  return { calls, comment, done: () => (process.env.PATH = was, rmSync(root, { recursive: true, force: true })) };
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
      assert.equal(c.body, reviewBody(PRS[0], PRS, REVIEW));
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

const SPLIT = [
  'Intro for everyone.',
  '## o/web#3: CHANGES REQUESTED',
  'src/login.ts:12 never clears the cache.',
  'Pictures: login-after.png, nope.png, ../../etc/passwd, web/login-after.png',
  '## **o/web#4**: APPROVED',
  'Nothing wrong.',
  '',
  'REVIEW: CHANGES_REQUESTED',
].join('\n');
const IMAGES = [
  { name: 'login-after.png', file: '/x/login-after.png', size: 1, mtime: 1 },
  { name: 'web/login-after.png', file: '/x/web/login-after.png', size: 1, mtime: 1 },
] as never[];

test('several pull requests: each body has only its own part, its own verdict, and no list of the ones covered', () => {
  const three = reviewBody(PRS[0], PRS, SPLIT);
  assert.equal(three, '**Review: changes requested**\n\nIntro for everyone.\n\nsrc/login.ts:12 never clears the cache.');
  assert.equal(reviewBody(PRS[1], PRS, SPLIT), '**Review: approved**\n\nIntro for everyone.\n\nNothing wrong.');
  // A reply with a part for only some of the pull requests (a cut one, say) is posted whole on each, with the list.
  const some = reviewBody(PRS[1], PRS, '## o/web#3\nA.\nREVIEW: APPROVED');
  assert.ok(some.includes('This review covers:') && some.endsWith('## o/web#3\nA.'), some);
  assert.equal(reviewBody(PRS[1], PRS, 'Same for both.\nREVIEW: APPROVED'), reviewBody(PRS[0], PRS, 'Same for both.\nREVIEW: APPROVED'));
  assert.match(reviewBody(PRS[1], PRS, 'Same for both.\nREVIEW: APPROVED'), /This review covers:/);
});

test('reviewParts: a heading in a code fence or naming another number is no part, and a part heading is no verdict line', () => {
  const fenced = reviewParts(PRS, 'Look:\n```\n## o/web#3: APPROVED\nPictures: a.png\n```\n## o/web#33: APPROVED');
  assert.equal(fenced.split, false);
  assert.deepEqual(fenced.common.pictures, []);
  // The heading is not the verdict line: the run's verdict still comes from REVIEW:, and the part's from its heading.
  assert.match(reviewBody(PRS[0], PRS, '## o/web#3: APPROVED\nFine.\n## o/web#4\nBroken.\nREVIEW: CHANGES_REQUESTED'), /^\*\*Review: approved\*\*\n\nFine\.$/);
  assert.match(reviewBody(PRS[1], PRS, '## o/web#3: APPROVED\nFine.\n## o/web#4\nBroken.\nREVIEW: CHANGES_REQUESTED'), /^\*\*Review: changes requested\*\*\n\nBroken\.$/, 'a heading without a verdict leaves the overall one');
  // Only the label alone (with its verdict) is a part's heading: a finding's own title that names a pull request is text, and one pull request is never split.
  const titled = '## o/web#3: CHANGES REQUESTED\n### o/web#4 breaks the approved flag\nDetails.\n## `o/web#4`: APPROVED\nNone.';
  assert.ok(reviewBody(PRS[0], PRS, titled).endsWith('### o/web#4 breaks the approved flag\nDetails.'));
  assert.equal(reviewBody(PRS[1], PRS, titled), '**Review: approved**\n\nNone.');
  assert.match(reviewBody(PRS[0], [PRS[0]], '## o/web#3: APPROVED\nBad.\nREVIEW: CHANGES_REQUESTED'), /^\*\*Review: changes requested\*\*\n\n## o\/web#3: APPROVED/);
  // A before picture is never attached, and a finding that starts with the word is no pictures line.
  const pics = reviewBody(PRS[0], [PRS[0]], '- Pictures: are not lazy loaded.\nPictures: login-before.png, login-after.png', { images: [...IMAGES, { name: 'login-before.png', file: '/x/login-before.png', size: 1, mtime: 1 }] as never[] });
  assert.ok(pics.includes('- Pictures: are not lazy loaded.') && pics.endsWith('\n\n![login-after.png](./login-after.png)'), pics);
});

test('pictures: only names that are images of the task go at the end as references, the Pictures line is taken out', () => {
  const body = reviewBody(PRS[0], PRS, SPLIT, { images: IMAGES });
  assert.ok(!/Pictures:/i.test(body) && !body.includes('passwd') && !body.includes('nope'));
  assert.ok(body.endsWith('\n\n![login-after.png](./login-after.png)\n![web/login-after.png](./web.login-after.png)'), body);
  assert.ok(!reviewBody(PRS[1], PRS, SPLIT, { images: IMAGES }).includes('!['), 'the other pull request’s part named none');
  assert.ok(!reviewBody(PRS[0], PRS, SPLIT).includes('!['), 'no images, no references');
});

test('GitHub: pictures go as attachments of a conversation comment; without them, or when gh fails, a COMMENT review without the block', { skip: process.platform === 'win32' }, async () => {
  const gh = fakeGh();
  const { floor, dir } = floorOf('o/web');
  try {
    const ctx = makeCtx([def('web', dir, { repo: 'o/web' })]);
    ctx.floors.set('web', floor);
    const imgDir = mkdtempSync(path.join(tmpdir(), 'kanban-post-img-'));
    writeFileSync(path.join(imgDir, 'login-after.png'), 'x');
    const images = [{ name: 'login-after.png', file: path.join(imgDir, 'login-after.png'), size: 1, mtime: 1 }];
    const got = await postReview(ctx, 'web', PRS, 'A.\n## o/web#3: CHANGES REQUESTED\nBug.\nPictures: login-after.png\n## o/web#4: APPROVED\nOk.', undefined, { verdict: 'changes_requested', images: images as never });
    // #3's part names the picture; #4's part names none and is posted as a review.
    assert.deepEqual(got.map((r) => [r.number, r.url, r.note]), [[3, 'https://github.com/o/web/pull/3#issuecomment-5', undefined], [4, 'https://github.com/o/web/pull/4#pullrequestreview-77', undefined]]);
    const c = gh.comment(3);
    assert.deepEqual(c.attached, ['login-after.png']);
    assert.ok(c.args.includes('--repo') && c.args.includes('o/web') && c.body.endsWith('![login-after.png](./login-after.png)'));
    rmSync(imgDir, { recursive: true, force: true });
  } finally {
    gh.done();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a board that cannot attach: the review is posted without the pictures and the result says so', async () => {
  const bodies: string[] = [];
  const board = { review: async (_n: number, file: string, _as: unknown, _o: unknown, attach?: string[]) => { if (attach?.length) throw new Error('unknown flag: --attach\nusage'); bodies.push(readFileSync(file, 'utf8')); return 'https://github.com/o/web/pull/3#r'; } };
  const ctx = makeCtx([def('web', '/tmp/none', { repo: 'o/web' })]);
  ctx.floors.set('web', { githubFor: () => board } as unknown as Floor);
  const imgDir = mkdtempSync(path.join(tmpdir(), 'kanban-post-img-'));
  writeFileSync(path.join(imgDir, 'a.png'), 'x');
  const got = await postReview(ctx, 'web', [PRS[0]], 'Bug.\nPictures: a.png', undefined, { verdict: 'changes_requested', images: [{ name: 'a.png', file: path.join(imgDir, 'a.png'), size: 1, mtime: 1 }] as never });
  rmSync(imgDir, { recursive: true, force: true });
  assert.deepEqual(got, [{ repo: 'o/web', number: 3, url: 'https://github.com/o/web/pull/3#r', note: 'the pictures could not be attached: unknown flag: --attach' }]);
  assert.equal(bodies[0], '**Review: changes requested**\n\nBug.');
});
