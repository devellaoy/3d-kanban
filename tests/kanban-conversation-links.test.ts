// A task's conversation: the file paths and URLs its text links (src/client/kanban/mdlinks.ts), the
// office opening such a file only inside the task's folders (src/server/kanban/openfile.ts) and in VS
// Code at its line, and kanban.task.openFile's validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codePath, findPaths, hrefPath, linkPathsAndUrls } from '../src/client/kanban/mdlinks.ts';
import { resolveTaskFile } from '../src/server/kanban/openfile.ts';
import { openInVsCode, type VsCodeDeps } from '../src/server/kanban/vscode.ts';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.ts';

test('paths with a folder are found in text, with their line, and not in URLs, numbers or versions', () => {
  const hits = findPaths('See src/client/kanban/md.ts:42 and (docs/kanban.md#L7), /Users/me/x/y.ts:3:9.');
  assert.deepEqual(
    hits.map((h) => [h.path, h.line]),
    [
      ['src/client/kanban/md.ts', 42],
      ['docs/kanban.md', 7],
      ['/Users/me/x/y.ts', 3],
    ],
  );
  assert.equal(hits[0].text, 'src/client/kanban/md.ts:42');
  assert.deepEqual(findPaths('1/2.5 of v1.2.3, e.g. and/or, see example.com/a.js, docs.github.com/en/x.md or a/b without extension'), []);
  assert.deepEqual(findPaths('./scripts/run.sh').map((h) => h.path), ['./scripts/run.sh']);
});

test('Windows paths are found too: a drive, backslashes, and the line after them', () => {
  assert.deepEqual(
    findPaths('Changed C:\\repo\\src\\app.ts:42, src\\client\\md.ts and D:/w/a.css.').map((h) => [h.text, h.path, h.line]),
    [
      ['C:\\repo\\src\\app.ts:42', 'C:\\repo\\src\\app.ts', 42],
      ['src\\client\\md.ts', 'src\\client\\md.ts', undefined],
      ['D:/w/a.css', 'D:/w/a.css', undefined],
    ],
  );
  assert.deepEqual(codePath('C:\\repo\\src\\app.ts:42'), { index: 0, text: 'C:\\repo\\src\\app.ts:42', path: 'C:\\repo\\src\\app.ts', line: 42 });
  assert.deepEqual(findPaths('a ratio of 1\\2.5 or http:\\x'), []);
});

test('a code span is a path when all of it is one, or a lone source file name', () => {
  assert.deepEqual(codePath('src/a.ts:12'), { index: 0, text: 'src/a.ts:12', path: 'src/a.ts', line: 12 });
  assert.deepEqual(codePath('package.json'), { index: 0, text: 'package.json', path: 'package.json' });
  assert.equal(codePath('foo.bar()'), null);
  assert.equal(codePath('npm run build'), null);
  assert.equal(codePath('see src/a.ts'), null);
});

test('a markdown link to a file is a file, a link to a page is not', () => {
  assert.deepEqual(hrefPath('/repo/src/app.ts:42'), { index: 0, text: '/repo/src/app.ts:42', path: '/repo/src/app.ts', line: 42 });
  assert.deepEqual(hrefPath('src/client/md.ts#L7')?.line, 7);
  assert.equal(hrefPath('README.md')?.path, 'README.md');
  assert.equal(hrefPath('file:///repo/src/a.ts')?.path, '/repo/src/a.ts');
  assert.equal(hrefPath('file:///C:/repo/a.ts')?.path, 'C:/repo/a.ts');
  assert.equal(hrefPath('/repo/node_modules/%40scope/a.ts')?.path, '/repo/node_modules/@scope/a.ts');
  for (const href of ['https://example.com/a.ts', '//cdn.example.com/a.js', '#section', 'mailto:a@b.fi', '/kanban?task=3', '/api/kanban/attachments/ab12.png', '/lite', 'docs/page?x=1']) assert.equal(hrefPath(href), null, href);
});

/** Just enough of an <a> for linkPathsAndUrls: attributes, classes and click listeners. */
class FakeAnchor {
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners: ((e: { preventDefault(): void }) => void)[] = [];
  classList = { add: (c: string) => this.classes.add(c) };
  constructor(href: string, extra: Record<string, string> = {}) {
    this.attrs.set('href', href);
    for (const [k, v] of Object.entries(extra)) this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) {
    if (type === 'click') this.listeners.push(fn);
  }
  /** A click as the browser sends it: whether the default (following the href) was stopped. */
  click(): boolean {
    let prevented = false;
    for (const fn of this.listeners) fn({ preventDefault: () => (prevented = true) });
    return prevented;
  }
}

function withFakeDom(anchors: FakeAnchor[], fn: (root: HTMLElement) => void) {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, NodeFilter: g.NodeFilter };
  g.document = { createTreeWalker: () => ({ nextNode: () => false }) };
  g.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  try {
    fn({ querySelectorAll: (sel: string) => (sel === 'a[href]' ? anchors : []) } as unknown as HTMLElement);
  } finally {
    Object.assign(g, saved);
  }
}

test('clicking a markdown link to a file opens it in VS Code instead of following the href', () => {
  const file = new FakeAnchor('/repo/src/app.ts:42', { target: '_blank', rel: 'noopener noreferrer' });
  const page = new FakeAnchor('https://example.com/a.ts', { target: '_blank' });
  const opened: [string, number | undefined][] = [];
  withFakeDom([file, page], (root) => linkPathsAndUrls(root, (p, line) => opened.push([p, line])));
  assert.equal(file.click(), true, 'the browser must not follow the href');
  assert.deepEqual(opened, [['/repo/src/app.ts', 42]]);
  assert.equal(file.getAttribute('href'), '#');
  assert.equal(file.getAttribute('target'), null);
  assert.ok(file.classes.has('kb-file'));
  // A link to a page is left as it was.
  assert.equal(page.click(), false);
  assert.equal(page.getAttribute('href'), 'https://example.com/a.ts');
  assert.equal(opened.length, 1);
});

test('without opening files (not an admin) a markdown link to a file is plain text, not a 404', () => {
  const file = new FakeAnchor('/repo/src/app.ts:42');
  withFakeDom([file], (root) => linkPathsAndUrls(root));
  assert.equal(file.getAttribute('href'), null);
});

function folders(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kb-openfile-')));
  t.after(() => rmSync(root, { recursive: true, force: true }), 'string');
  const wt = path.join(root, 'wt');
  mkdirSync(path.join(wt, 'src'), { recursive: true });
  writeFileSync(path.join(wt, 'src', 'a.ts'), 'x');
  writeFileSync(path.join(root, 'secret.txt'), 's');
  symlinkSync(path.join(root, 'secret.txt'), path.join(wt, 'link.txt'));
  return { root, wt, list: [{ name: 'wt', dir: wt }] };
}

test('a file opens only from inside the task’s folders', (t) => {
  const { root, wt, list } = folders(t);
  const file = path.join(wt, 'src', 'a.ts');
  assert.deepEqual(resolveTaskFile(list, 'src/a.ts'), { file });
  assert.deepEqual(resolveTaskFile(list, './src/a.ts'), { file });
  assert.deepEqual(resolveTaskFile(list, 'b/src/a.ts'), { file });
  // Written the Windows way, on any machine.
  assert.deepEqual(resolveTaskFile(list, 'src\\a.ts'), { file });
  assert.deepEqual(resolveTaskFile(list, '.\\src\\a.ts'), { file });
  assert.deepEqual(resolveTaskFile(list, file), { file });
  assert.ok('error' in resolveTaskFile(list, '../secret.txt'));
  assert.ok('error' in resolveTaskFile(list, path.join(root, 'secret.txt')));
  // A link out of the folder is followed, and refused.
  assert.ok('error' in resolveTaskFile(list, 'link.txt'));
  // A folder isn't a file.
  assert.ok('error' in resolveTaskFile(list, 'src'));
  assert.match((resolveTaskFile([{ name: 'gone', dir: path.join(root, 'nope') }], 'src/a.ts') as { error: string }).error, /no folder/);
});

function deps(platform: NodeJS.Platform, found: string | null = '/usr/bin/code') {
  const calls: { cmd: string; args: string[] }[] = [];
  const d: VsCodeDeps = {
    platform,
    resolveCommand: () => found,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      return '';
    },
    runVerbatim: async () => '',
    env: { PATH: '/bin' },
  };
  return { d, calls };
}

test('a file at a line opens with code -g, falling back to opening it by name on a Mac', async () => {
  const mac = deps('darwin');
  await openInVsCode('/w/a.ts', mac.d, 12);
  assert.deepEqual(mac.calls, [{ cmd: '/usr/bin/code', args: ['-g', '/w/a.ts:12'] }]);
  const noCode = deps('darwin', null);
  await openInVsCode('/w/a.ts', noCode.d, 12);
  assert.deepEqual(noCode.calls, [{ cmd: 'open', args: ['-a', 'Visual Studio Code', '/w/a.ts'] }]);
});

test('kanban.task.openFile takes a task, a one-line path and an optional line', () => {
  assert.deepEqual(parseKanbanClientMsg({ t: 'kanban.task.openFile', id: 3, path: ' src/a.ts ', line: 4 }), { t: 'kanban.task.openFile', id: 3, path: 'src/a.ts', line: 4 });
  assert.equal(typeof parseKanbanClientMsg({ t: 'kanban.task.openFile', id: 3, path: '' }), 'string');
  assert.equal(typeof parseKanbanClientMsg({ t: 'kanban.task.openFile', id: 3, path: 'a\nb' }), 'string');
  assert.equal(typeof parseKanbanClientMsg({ t: 'kanban.task.openFile', id: 3, path: 'a', line: 0 }), 'string');
});

test('a worker handed an issue is named by the issue, never just "working on an issue"', async () => {
  const { fallbackTask, isGeneric, issueTask, latestIssueTask } = await import('../src/server/tasks.ts');
  assert.deepEqual(fallbackTask('Work on GitHub issue #12: "Fix the login redirect".\n\nRead it first with `gh issue view 12`.'), {
    name: '#12 Fix the login redirect',
    summary: 'Issue #12: Fix the login redirect',
  });
  assert.equal(issueTask('GitHub issue #7: “Dark mode”. Read it first.')?.name, '#7 Dark mode');
  assert.equal(issueTask('Fix the login redirect'), undefined);
  assert.equal(issueTask('fix #12 so that "Save" works'), undefined);
  // The worker moved on from #12 to #34: its issue is the newest one handed over.
  assert.equal(latestIssueTask(['Work on GitHub issue #12: "Fix the login".', 'ok', 'Work on GitHub issue #34: "Dark mode".', 'go on'])?.name, '#34 Dark mode');
  assert.equal(latestIssueTask(['just a prompt']), undefined);
  assert.equal(fallbackTask('please fix the login redirect now').name, 'Fix the login redirect');
  for (const name of ['Working On GitHub Issue', 'Work on issue #12', 'GitHub Issue', 'Handling the task']) assert.ok(isGeneric(name), name);
  for (const name of ['Fix Login Redirect', '#12 Fix Login', 'Review PR #42']) assert.ok(!isGeneric(name), name);
});
