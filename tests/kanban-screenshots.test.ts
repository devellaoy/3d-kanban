// The task's UI images in its pull requests' descriptions (integrations/pulls/screenshots.ts): the block,
// where it goes, that the same images are not put in twice, and that a failure is told once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkScreenshots, ensureScreenshots, imagesDigest, screenshotsBlock, withScreenshots, type ScreenshotMark } from '../src/server/kanban/integrations/pulls/screenshots.js';
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
    repo: { prLinksOfProject: () => links, listTasks: () => [task], repoBranches: () => ({}), addComment: (c: { text: string }) => void comments.push(c.text) },
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
