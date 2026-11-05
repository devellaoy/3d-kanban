// A task's conversation: the file paths and URLs its text links (src/client/kanban/mdlinks.ts), the
// office opening such a file only inside the task's folders (src/server/kanban/openfile.ts) and in VS
// Code at its line, and kanban.task.openFile's validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codePath, findPaths } from '../src/client/kanban/mdlinks.ts';
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
