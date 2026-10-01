import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Changes, type ChangesTarget } from '../src/server/changes.js';
import { excludeFromGit } from '../src/server/config.js';
import { NOT_GIT } from '../src/server/floor-git.js';
import { GitHub } from '../src/server/github.js';

const skip = process.platform === 'win32';
const MSG = "This folder isn't a git repository";

/** Stand-in git and gh that write each call down on one line (one printf, so lines never interleave) and fail. */
function fakeTools(t: { after(fn: () => void): void }) {
  const bin = mkdtempSync(path.join(tmpdir(), 'office-nongit-bin-'));
  const log = path.join(bin, 'calls');
  for (const tool of ['git', 'gh']) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\nprintf '${tool} %s\\n' "$*" >> '${log}'\nexit 1\n`);
    chmodSync(path.join(bin, tool), 0o755);
  }
  const was = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${was}`;
  t.after(() => {
    process.env.PATH = was;
    rmSync(bin, { recursive: true, force: true });
  });
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

test("Changes never runs git in a folder that isn't a git repository", { skip }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-nongit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = fakeTools(t);
  const target: ChangesTarget = { name: 'W', cwd: dir, rel: '', noGit: MSG };
  const changes = new Changes(dir, undefined, (id) => (id === 'w1' ? target : undefined), () => undefined, { state() {}, toast() {}, refreshGitHub() {} });
  t.after(() => changes.stop());

  assert.equal(await changes.commit('w1', 'msg', 'Sam'), MSG);
  assert.equal(await changes.discard('w1', undefined, 'Sam'), MSG);
  assert.equal(await changes.discard('w1', 'a.txt', 'Sam'), MSG);
  assert.equal(await changes.pullRequest('w1', 'title', 'body', 'Sam'), MSG);
  assert.equal(await changes.diff('w1', 'a.txt'), MSG);
  assert.deepEqual(await changes.file('w1', 'a.png', 'new'), { status: 404, error: MSG });
  changes.watch('w1', 'c1');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls(), []);
});

test("a GitHub for a folder that isn't a git repository refuses every call before gh or git runs", { skip }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-nongit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = fakeTools(t);
  const github = new GitHub(dir, () => {}, () => {}, undefined, false, NOT_GIT);
  // The board refreshes a call starts on its way out (even when it failed) run in the background:
  // each one is kept, so the log is read only once they've all finished.
  const background: Promise<unknown>[] = [];
  const spy = github as unknown as Record<'refreshIssues' | 'refreshPulls', () => Promise<void>>;
  for (const name of ['refreshIssues', 'refreshPulls'] as const) {
    const real = spy[name].bind(github);
    spy[name] = () => {
      const p = real();
      background.push(p);
      return p;
    };
  }

  await github.refresh();
  assert.equal(github.issues.error, NOT_GIT);
  assert.equal(github.pulls.error, NOT_GIT);
  await assert.rejects(github.repoInfo(), { message: NOT_GIT });
  assert.equal(await github.viewer(), '');
  await assert.rejects(github.pullDetail(1), { message: NOT_GIT });
  await assert.rejects(github.pullDiff(1), { message: NOT_GIT });
  await assert.rejects(github.issueDetail(1), { message: NOT_GIT });
  assert.deepEqual(await github.comment('issue', 1, 'hi'), { error: NOT_GIT });
  await assert.rejects(github.review(1, '/tmp/x'), { message: NOT_GIT });
  assert.equal(await github.merge(1, 'squash', false, false), NOT_GIT);
  assert.equal(await github.close('issue', 1, {}), NOT_GIT);
  await assert.rejects(github.repoLabels(), { message: NOT_GIT });
  assert.deepEqual(await github.setLabels('issue', 1, ['bug'], []), { error: NOT_GIT });
  assert.deepEqual(await github.setLabels('pull', 1, [], ['bug']), { error: NOT_GIT });
  assert.equal(await github.claim(1), NOT_GIT);
  // A failed label change refreshes its board: that has to stay off GitHub too.
  assert.ok(background.length >= 2, `${background.length} board refreshes started`);
  await Promise.all(background);
  assert.deepEqual(calls(), []);
  assert.equal(github.issues.error, NOT_GIT);
  assert.equal(github.pulls.error, NOT_GIT);
});

test("a folder inside a git repository gets .agent-office/ in that repository's exclude list", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-nongit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const inner = path.join(root, 'packages', 'inner');
  mkdirSync(inner, { recursive: true });
  excludeFromGit(inner);
  assert.match(readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.agent-office\/$/m);
});
