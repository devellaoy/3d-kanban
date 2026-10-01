import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkoutRepo, repoApi, repoFlag } from '../src/server/ghrepo.js';
import { GitHub } from '../src/server/github.js';

/** A checkout of a fork: origin is the fork, upstream the repository it was forked from (gh's own pick). */
function forkCheckout(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-ghrepo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'upstream', 'https://github.com/AgentSystemLabs/agent-office.git');
  git('remote', 'add', 'origin', 'git@github.com:devellaoy/3d-kanban.git');
  return dir;
}

test('a checkout with origin and upstream remotes resolves to origin', () => {
  const dir = forkCheckout();
  try {
    assert.equal(checkoutRepo(dir), 'devellaoy/3d-kanban');
    assert.equal(checkoutRepo(dir, 'upstream'), 'AgentSystemLabs/agent-office');
    assert.deepEqual(repoFlag(checkoutRepo(dir)), ['-R', 'devellaoy/3d-kanban']);
    assert.equal(repoApi(checkoutRepo(dir), 'pulls/3/comments'), 'repos/devellaoy/3d-kanban/pulls/3/comments');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout without a GitHub origin leaves the choice to gh', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-ghrepo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(checkoutRepo(dir), undefined);
    assert.deepEqual(repoFlag(undefined), []);
    assert.equal(repoApi(undefined, 'labels'), 'repos/{owner}/{repo}/labels');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the floor's boards and actions name the checkout's origin in every gh call", { skip: process.platform === 'win32' }, async () => {
  const dir = forkCheckout();
  const bin = mkdtempSync(path.join(tmpdir(), 'kanban-ghbin-'));
  const log = path.join(bin, 'calls');
  // A stand-in gh that writes down its arguments, one call per line, and answers with an empty list.
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s ' "$@" >> '${log}'\necho >> '${log}'\necho '[]'\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  try {
    const github = new GitHub(dir, () => {}, () => {});
    await github.refresh();
    await github.repoLabels();
    assert.equal(await github.claim(4), undefined);
    await github.setLabels('issue', 4, ['bug'], [], undefined);
    const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(calls.length >= 8, calls.join('\n'));
    for (const c of calls) {
      assert.ok(/-R devellaoy\/3d-kanban |repos\/devellaoy\/3d-kanban\//.test(c), `not about origin: gh ${c}`);
      assert.doesNotMatch(c, /agent-office|\{owner\}/);
    }
  } finally {
    process.env.PATH = PATH;
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
