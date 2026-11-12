// The task's UI images in its pull requests' descriptions (integrations/pulls/screenshots.ts): the block,
// where it goes, that the same images are not put in twice, and that a failure is told once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkScreenshots, editTimeout, ensureScreenshots, imagesDigest, screenshotsBlock, withScreenshots, withoutScreenshots, type ScreenshotMark } from '../src/server/kanban/integrations/pulls/screenshots.js';
import { listUiImages } from '../src/server/kanban/engine/uitesting.js';

const URL_ = 'https://github.com/acme/api/pull/3';

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-shots-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(dir, n), c);
  return { dir, images: listUiImages(dir) };
}

/** A gh that shows `view` (or what `body()` says now) and records what it is asked, with the body file read at the call. */
function fakeGh(view: () => object, calls: { args: string[]; body?: string; dirEntries?: string[] }[], fail?: (args: string[]) => Error | undefined) {
  return async (args: string[]) => {
    const file = args.includes('--body-file') ? args[args.indexOf('--body-file') + 1] : undefined;
    calls.push({ args, body: file ? readFileSync(file, 'utf8') : undefined, dirEntries: file ? readdirSync(path.dirname(file)) : undefined });
    const err = fail?.(args);
    if (err) throw err;
    return args[1] === 'view' ? JSON.stringify(view()) : '';
  };
}

test('the block names each subject with Before and After, a lone after on its own, and its digest', () => {
  const { images } = folder({ 'login-before.png': 'a', 'login-after.png': 'bb', 'menu-after.jpg': 'c' });
  const { digest, text } = screenshotsBlock(images);
  assert.match(text, new RegExp(`^<!-- agent-office:screenshots ${digest} -->\n## Screenshots\n`));
  assert.ok(text.endsWith('<!-- /agent-office:screenshots -->'));
  assert.ok(text.indexOf('![login before](./login-before.png)') < text.indexOf('![login after](./login-after.png)'));
  assert.ok(text.includes('![menu after](./menu-after.jpg)') && !text.includes('menu before'));
  assert.equal(digest, imagesDigest(images));
  assert.notEqual(digest, imagesDigest(images.slice(1)));
  assert.notEqual(digest, imagesDigest(images.map((i) => ({ ...i, mtime: i.mtime + 1 }))));
});

test('withScreenshots appends at the end, or replaces the block that is there', () => {
  const a = screenshotsBlock(folder({ 'a-after.png': 'x' }).images).text;
  const b = screenshotsBlock(folder({ 'b-after.png': 'x' }).images).text;
  assert.equal(withScreenshots('Did it\n', a), `Did it\n\n${a}\n`);
  assert.equal(withScreenshots('', a), `${a}\n`);
  assert.equal(withScreenshots(`Intro\n\n${a}\n\nFooter`, b), `Intro\n\n${b}\n\nFooter`);
  assert.ok(!withScreenshots(`Intro\n\n${a}`, b).includes('a-after'));
});

test('ensureScreenshots writes the body beside the images and attaches each one, then removes the file', async () => {
  const { dir, images } = folder({ 'login-before.png': 'a', 'login-after.png': 'b' });
  const calls: { args: string[]; body?: string; dirEntries?: string[] }[] = [];
  const r = await ensureScreenshots({ prUrl: URL_, images, dir, cwd: '.', run: fakeGh(() => ({ body: 'Did it', updatedAt: 't1' }), calls) });
  assert.deepEqual(r, { edited: true });
  const edit = calls.find((c) => c.args[1] === 'edit')!;
  assert.deepEqual(edit.args.slice(0, 3), ['pr', 'edit', URL_]);
  assert.deepEqual(edit.args.filter((a, i) => edit.args[i - 1] === '--attach'), images.map((i) => path.join(dir, i.name)));
  assert.equal(edit.args.filter((a) => a === '--attach').length, 2);
  const file = edit.args[edit.args.indexOf('--body-file') + 1];
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^\./);
  assert.ok(edit.body!.startsWith('Did it\n\n<!-- agent-office:screenshots '));
  assert.ok(edit.body!.includes('(./login-before.png)'));
  assert.ok(!existsSync(file), 'the temporary file is gone');
  assert.deepEqual(listUiImages(dir).map((i) => i.name), images.map((i) => i.name));
});

test('the same digest is no call, another digest replaces the block', async () => {
  const { dir, images } = folder({ 'a-after.png': 'x' });
  const { digest, text } = screenshotsBlock(images);
  // gh has rewritten the references to uploaded addresses: only the marker says what is in there.
  const uploaded = `Did it\n\n<!-- agent-office:screenshots ${digest} -->\n## Screenshots\n\n![a after](https://github.com/user-attachments/assets/1)\n<!-- /agent-office:screenshots -->\n`;
  let calls: { args: string[]; body?: string }[] = [];
  let r = await ensureScreenshots({ prUrl: URL_, images, dir, cwd: '.', run: fakeGh(() => ({ body: uploaded, updatedAt: 't' }), (calls = [])) });
  assert.equal(r.edited, false);
  assert.ok(!calls.some((c) => c.args[1] === 'edit'));
  writeFileSync(path.join(dir, 'b-after.png'), 'y');
  r = await ensureScreenshots({ prUrl: URL_, images: listUiImages(dir), dir, cwd: '.', run: fakeGh(() => ({ body: uploaded, updatedAt: 't' }), (calls = [])) });
  assert.equal(r.edited, true);
  const body = calls.find((c) => c.args[1] === 'edit')!.body!;
  assert.ok(body.startsWith('Did it\n\n<!--') && body.includes('(./b-after.png)') && body.includes('(./a-after.png)'));
  assert.equal(body.split('agent-office:screenshots').length, 3, 'one block, not two');
  assert.ok(!text.includes('user-attachments'));
});

test('a description edited meanwhile is looked at again, not overwritten', async () => {
  const { dir, images } = folder({ 'a-after.png': 'x' });
  const calls: { args: string[] }[] = [];
  let views = 0;
  const r = await ensureScreenshots({ prUrl: URL_, images, dir, cwd: '.', run: fakeGh(() => ({ body: 'x', updatedAt: `t${views++}` }), calls) });
  assert.equal(r.edited, false);
  assert.equal(r.retry, true);
  assert.ok(!calls.some((c) => c.args[1] === 'edit'));
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.')), []);
});

test('a gh that fails (no --attach, no access) is a warning and the file is still removed', async () => {
  const { dir, images } = folder({ 'a-after.png': 'x' });
  const r = await ensureScreenshots({ prUrl: URL_, images, dir, cwd: '.', run: fakeGh(() => ({ body: '', updatedAt: 't' }), [], (a) => (a[1] === 'edit' ? new Error('unknown flag: --attach') : undefined)) });
  assert.equal(r.edited, false);
  assert.match(r.warning ?? '', /unknown flag: --attach.*gh 2\.99/);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.')), []);
});

const run = { id: 1 };

function board(opts: { runState?: string; flags?: Record<string, boolean>; url?: string; state?: string; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-shots-ctx-'));
  const dir = path.join(root, 'grants', 'task-1', 'ui');
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(opts.files ?? { 'a-before.png': 'x', 'a-after.png': 'y' })) writeFileSync(path.join(dir, n), c);
  const task = { id: 1, branch: 'b', status: 'review', runState: opts.runState ?? 'idle', flags: opts.flags ?? { prRequested: true }, createdByAccount: undefined };
  const links = [
    { taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: opts.url ?? URL_, state: opts.state ?? 'OPEN', branch: 'b' },
    { taskId: 1, repoId: 'web', repo: 'acme/web', number: 4, url: 'https://github.com/acme/web/pull/4', state: 'OPEN', branch: 'b' },
  ];
  const comments: string[] = [];
  const ctx = {
    dataDir: root,
    filesDir: root,
    repos: () => [{ id: 'api', primary: true, remote: 'acme/api' }, { id: 'web', primary: false, remote: 'acme/web' }],
    repo: { prLinksOfProject: () => links, listTasks: () => [task], repoBranches: () => ({}), latestRunId: () => run.id, addComment: (c: { text: string }) => void comments.push(c.text) },
    taskChanged() {},
  } as unknown as Parameters<typeof checkScreenshots>[0];
  return { ctx, dir, task, comments };
}
const settle = () => new Promise((r) => setTimeout(r, 40));

test('every open GitHub pull request of the task gets the images, once for the same images', async () => {
  const { ctx } = board();
  const calls: { args: string[] }[] = [];
  const marks = new Map<string, ScreenshotMark>();
  const io = { run: fakeGh(() => ({ body: 'Did it', updatedAt: 't' }), calls) };
  checkScreenshots(ctx, 'api', marks, io);
  await settle();
  const edits = () => calls.filter((c) => c.args[1] === 'edit').map((c) => c.args[2]);
  assert.deepEqual(edits().sort(), [URL_, 'https://github.com/acme/web/pull/4']);
  for (let i = 0; i < 3; i++) {
    checkScreenshots(ctx, 'api', marks, io);
    await settle();
  }
  assert.equal(edits().length, 2, 'no more calls for the same images');
  assert.equal(calls.length, 2 * 3, 'a read, a re-read and the edit per pull request, once');
});

test('a lone after picture counts', async () => {
  const { ctx } = board({ files: { 'new-view-after.png': 'x' } });
  const calls: { args: string[]; body?: string }[] = [];
  checkScreenshots(ctx, 'api', new Map(), { run: fakeGh(() => ({ body: '', updatedAt: 't' }), calls) });
  await settle();
  assert.equal(calls.filter((c) => c.args[1] === 'edit').length, 2);
});

test('nothing for a task with a run going, no office PR, no images, a closed or non-GitHub pull request', async () => {
  const cases = [
    board({ runState: 'running' }),
    board({ flags: {} }),
    board({ files: {} }),
    board({ state: 'MERGED' }),
    board({ url: 'https://dev.azure.com/org/p/_git/r/pullrequest/3' }),
  ];
  for (const [i, c] of cases.entries()) {
    const calls: { args: string[] }[] = [];
    checkScreenshots(c.ctx, 'api', new Map(), { run: fakeGh(() => ({ body: '', updatedAt: 't' }), calls) });
    await settle();
    // The second pull request of the board is a GitHub one: only the cases about the whole task must see no call.
    const expected = i === 3 || i === 4 ? 1 : 0;
    assert.equal(calls.filter((x) => x.args[1] === 'edit').length, expected, `case ${i}`);
  }
});

test('a failure is told on the task once, and not tried again for the same images', async () => {
  const { ctx, dir, comments } = board();
  const calls: { args: string[] }[] = [];
  const marks = new Map<string, ScreenshotMark>();
  const io = { run: fakeGh(() => ({ body: '', updatedAt: 't' }), calls, (a) => (a[1] === 'edit' ? new Error('unknown flag: --attach') : undefined)) };
  for (let i = 0; i < 4; i++) {
    checkScreenshots(ctx, 'api', marks, io);
    await settle();
  }
  assert.equal(calls.filter((c) => c.args[1] === 'edit').length, 2, 'one try per pull request');
  assert.equal(comments.length, 2);
  assert.match(comments[0], /--attach/);
  // Other images are a new try.
  writeFileSync(path.join(dir, 'c-after.png'), 'z');
  checkScreenshots(ctx, 'api', marks, io);
  await settle();
  assert.equal(calls.filter((c) => c.args[1] === 'edit').length, 4);
});

test('a concurrent edit is read again on the next refresh, three tries at most', async () => {
  const { ctx } = board({ files: { 'a-after.png': 'x' } });
  const calls: { args: string[] }[] = [];
  const marks = new Map<string, ScreenshotMark>();
  let n = 0;
  const io = { run: fakeGh(() => ({ body: 'x', updatedAt: `t${n++}` }), calls) };
  for (let i = 0; i < 6; i++) {
    checkScreenshots(ctx, 'api', marks, io);
    await settle();
  }
  assert.ok(!calls.some((c) => c.args[1] === 'edit'));
  assert.equal(calls.filter((c) => c.args[1] === 'view').length, 2 * 2 * 3, 'two reads per try, three tries, two pull requests');
});

test('a block with the digest but local references left (a partial upload) is not done, and is edited again', async () => {
  const { dir, images } = folder({ 'a-after.png': 'x', 'b-after.png': 'y' });
  const { digest } = screenshotsBlock(images);
  const partial = `Did it\n\n<!-- agent-office:screenshots ${digest} -->\n## Screenshots\n\n![a after](https://github.com/user-attachments/assets/1)\n![b after](./b-after.png)\n<!-- /agent-office:screenshots -->\n`;
  const calls: { args: string[]; body?: string }[] = [];
  const r = await ensureScreenshots({ prUrl: URL_, images, dir, cwd: '.', run: fakeGh(() => ({ body: partial, updatedAt: 't' }), calls) });
  assert.equal(r.edited, true);
  assert.equal(calls.filter((c) => c.args[1] === 'edit').length, 1);
  // Only the block counts: a local reference elsewhere in the description is the author's.
  const other = `See ![x](./x.png)\n\n<!-- agent-office:screenshots ${digest} -->\n![a after](https://github.com/user-attachments/assets/1)\n<!-- /agent-office:screenshots -->`;
  assert.equal((await ensureScreenshots({ prUrl: URL_, images, dir, cwd: '.', run: fakeGh(() => ({ body: other, updatedAt: 't' }), []) })).edited, false);
});

test('the upload timeout grows with the images and stays bounded', () => {
  const img = (size: number) => ({ name: 'a-after.png', kind: 'after' as const, subject: 'a', size, mtime: 1 });
  assert.ok(editTimeout([img(1)]) < editTimeout(Array.from({ length: 10 }, () => img(5 * 1024 * 1024))));
  assert.equal(editTimeout(Array.from({ length: 40 }, () => img(20 * 1024 * 1024))), 600_000);
  assert.ok(editTimeout([img(1)]) >= 60_000);
});

test('two floors sharing the marks: a persistent failure is tried and told once per pull request', async () => {
  const mk = (project: string, n: number) => {
    const c = board();
    const links = [{ taskId: 1, repoId: 'api', repo: 'acme/api', number: n, url: `https://github.com/acme/api/pull/${n}`, state: 'OPEN', branch: 'b' }];
    (c.ctx as unknown as { repo: { prLinksOfProject: () => unknown } }).repo.prLinksOfProject = () => links;
    return { ...c, project, url: links[0].url };
  };
  const one = mk('floor-a', 10);
  const two = mk('floor-b', 20);
  const calls: { args: string[] }[] = [];
  const io = { run: fakeGh(() => ({ body: '', updatedAt: 't' }), calls, (x) => (x[1] === 'edit' ? new Error('unknown flag: --attach') : undefined)) };
  const marks = new Map<string, ScreenshotMark>();
  for (let i = 0; i < 4; i++) {
    checkScreenshots(one.ctx, 'floor-a', marks, io);
    await settle();
    checkScreenshots(two.ctx, 'floor-b', marks, io);
    await settle();
  }
  const edited = calls.filter((c) => c.args[1] === 'edit').map((c) => c.args[2]).sort();
  assert.deepEqual(edited, [one.url, two.url]);
  assert.equal(one.comments.length, 1);
  assert.equal(two.comments.length, 1);
});

/** A pull request with a description of its own: `edit` applies the body file, as gh does (uploads rewrite `./name`), or fails as `mode` says. */
function livePr(body: string, mode: { v: 'ok' | 'partial' | 'fail' } = { v: 'ok' }) {
  const st = { body, rev: 0, views: 0, edits: [] as string[][] };
  const run = async (args: string[]) => {
    if (args[1] === 'view') {
      st.views++;
      return JSON.stringify({ body: st.body, updatedAt: `r${st.rev}` });
    }
    st.edits.push(args);
    if (mode.v === 'fail') throw new Error('unknown flag: --attach');
    let next = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
    const attached = args.filter((a, i) => args[i - 1] === '--attach').length;
    let n = 0;
    next = next.replace(/\]\(\.\/([^)]+)\)/g, (all, name) => (mode.v === 'partial' && n++ >= 1 ? all : `](https://github.com/user-attachments/assets/${name})`));
    void attached;
    st.body = next;
    st.rev++;
    if (mode.v === 'partial') throw new Error('upload of one file failed');
    return '';
  };
  return { st, run };
}
const refresh = async (ctx: Parameters<typeof checkScreenshots>[0], marks: Map<string, ScreenshotMark>, run: (a: string[]) => Promise<string>) => {
  checkScreenshots(ctx, 'api', marks, { run });
  await settle();
};
/** The board with one pull request, so the counts are per pull request. */
function oneBoard(opts: Parameters<typeof board>[0] = {}) {
  const b = board(opts);
  const only = [{ taskId: 1, repoId: 'api', repo: 'acme/api', number: 3, url: URL_, state: 'OPEN', branch: 'b' }];
  (b.ctx as unknown as { repo: { prLinksOfProject: () => unknown } }).repo.prLinksOfProject = () => only;
  return b;
}

test('a new run that rewrote the description without the block gets it back; an intact block costs a view and no edit', async () => {
  const { ctx, comments } = oneBoard();
  const pr = livePr('Did it');
  const marks = new Map<string, ScreenshotMark>();
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 1);
  assert.equal(comments.length, 1);
  await refresh(ctx, marks, pr.run);
  const views = pr.st.views;
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.views, views, 'same run, same images: nothing asked');
  // A new run ends; the PR agent rewrote the description, the block is gone.
  run.id++;
  pr.st.body = 'Rewritten by the agent';
  pr.st.rev++;
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 2);
  assert.match(pr.st.body, /^Rewritten by the agent\n\n<!-- agent-office:screenshots /);
  assert.equal(comments.length, 2);
  // Another run that left the block alone: a view, no edit, no comment.
  run.id++;
  const before = pr.st.views;
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.views, before + 1);
  assert.equal(pr.st.edits.length, 2);
  assert.equal(comments.length, 2);
  run.id = 1;
});

test('a partial upload is finished on a later refresh, with one Added comment', async () => {
  const { ctx, comments } = oneBoard();
  const mode = { v: 'partial' as 'ok' | 'partial' | 'fail' };
  const pr = livePr('Did it', mode);
  const marks = new Map<string, ScreenshotMark>();
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 1);
  assert.equal(comments.length, 0, 'not told while it is still being tried');
  assert.match(pr.st.body, /\]\(\.\/a-/);
  mode.v = 'ok';
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 2);
  assert.ok(!pr.st.body.includes('](./'));
  assert.equal(comments.length, 1);
  assert.match(comments[0], /^Added 2 screenshots/);
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 2);
});

test('a partial upload that never completes is tried a few times and told once', async () => {
  const { ctx, comments } = oneBoard();
  const pr = livePr('Did it', { v: 'partial' });
  const marks = new Map<string, ScreenshotMark>();
  for (let i = 0; i < 8; i++) await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 3);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /could not be uploaded/);
});

test('a total failure (the description unchanged) is told once and not retried', async () => {
  const { ctx, comments } = oneBoard();
  const pr = livePr('Did it', { v: 'fail' });
  const marks = new Map<string, ScreenshotMark>();
  for (let i = 0; i < 5; i++) await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 1);
  assert.equal(comments.length, 1);
});

test('removing every image takes the block out, keeping the text around it; later refreshes ask nothing', async () => {
  const { ctx, dir, comments } = oneBoard();
  const human = 'Intro text\n\nMore\n';
  const pr = livePr(human);
  const marks = new Map<string, ScreenshotMark>();
  await refresh(ctx, marks, pr.run);
  assert.ok(pr.st.body.includes('agent-office:screenshots'));
  pr.st.body += '\nFooter by a person\n';
  for (const n of readdirSync(dir)) rmSync(path.join(dir, n));
  await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.body, 'Intro text\n\nMore\n\nFooter by a person\n'.replace('More\n\n', 'More\n\n'));
  const last = pr.st.edits.at(-1)!;
  assert.ok(!last.includes('--attach'));
  assert.match(comments.at(-1)!, /^Took the screenshots out of the description of /);
  const [edits, views, n] = [pr.st.edits.length, pr.st.views, comments.length];
  for (let i = 0; i < 3; i++) await refresh(ctx, marks, pr.run);
  assert.deepEqual([pr.st.edits.length, pr.st.views, comments.length], [edits, views, n]);
});

test('with no images and no block of ours nothing is edited, and with no images folder nothing is asked', async () => {
  const { ctx } = oneBoard({ files: {} });
  const pr = livePr('Just text');
  const marks = new Map<string, ScreenshotMark>();
  for (let i = 0; i < 3; i++) await refresh(ctx, marks, pr.run);
  assert.equal(pr.st.edits.length, 0);
  assert.equal(pr.st.views, 1, 'one view per run');
  const never = oneBoard({ files: {} });
  rmSync(path.dirname(path.dirname(never.dir)), { recursive: true });
  const gh2 = livePr('x');
  await refresh(never.ctx, new Map(), gh2.run);
  assert.equal(gh2.st.views, 0);
});

test('withoutScreenshots keeps what is around the block byte for byte', () => {
  const b = screenshotsBlock(folder({ 'a-after.png': 'x' }).images).text;
  assert.equal(withoutScreenshots(`Intro\n\n${b}\n`), 'Intro\n');
  assert.equal(withoutScreenshots(`Intro\n\n${b}\n\nFooter\n`), 'Intro\n\nFooter\n');
  assert.equal(withoutScreenshots(`${b}\n`), '');
  assert.equal(withoutScreenshots('No block\n\n'), 'No block\n\n');
  // Spaces are Markdown: an indented code block after the block stays code, a hard break before it stays a break.
  assert.equal(withoutScreenshots(`Intro\n\n${b}\n\n    npm run build\n    npm test\n`), 'Intro\n\n    npm run build\n    npm test\n');
  assert.equal(withoutScreenshots(`${b}\n\n    code first\n`), '    code first\n');
  assert.equal(withoutScreenshots(`Line one  \nline two  \n\n${b}\n`), 'Line one  \nline two  \n');
  assert.equal(withoutScreenshots(`Intro  \r\n\r\n${b}\r\n\r\n    code\r\n`), 'Intro  \n\n    code\r\n');
});
