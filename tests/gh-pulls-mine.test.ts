// What the PR board's 👤 Mine / 👀 To review filter needs from the server's PR list (gh:devellaoy/3d-kanban#123).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHub } from '../src/server/github.js';
import { officePrFooter, openedFromOfficeBy } from '../src/shared/officepr.js';

test('the footer the office drafts reads back as who had it opened', () => {
  assert.equal(openedFromOfficeBy(`## Task\n\nfix\n\n${officePrFooter('Ada', 'Otto', 'Desk 3')}`), 'Ada');
  assert.equal(openedFromOfficeBy('no footer here'), undefined);
});

test("the PR list keeps who opened a long PR, its review requests and the office's gh login", { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-ghmine-'));
  const bin = mkdtempSync(path.join(tmpdir(), 'kanban-ghmine-bin-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:devellaoy/3d-kanban.git'], { cwd: dir });
  // A description well past the 4000 characters the list keeps, with the footer last.
  const body = `## Task\n\n${'x'.repeat(5000)}\n\n${officePrFooter('Ada', 'Otto', 'Desk 3')}`;
  const pull = { number: 7, title: 'T', state: 'OPEN', url: 'https://github.com/devellaoy/3d-kanban/pull/7', author: { login: 'office-bot' }, labels: [], body, headRefName: 'b', baseRefName: 'main', createdAt: '', updatedAt: '', reviewRequests: [{ login: 'ada' }, { name: 'core-team', slug: 'core-team' }] };
  writeFileSync(path.join(dir, 'open.json'), JSON.stringify([pull]));
  // A stand-in gh: the open PRs, the office's login, and an empty list for anything else.
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\ncase "$*" in\n  *"pr list"*"--state open"*) cat '${path.join(dir, 'open.json')}' ;;\n  "api user"*) echo office-bot ;;\n  *) echo '[]' ;;\nesac\n`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  try {
    const github = new GitHub(dir, () => {}, () => {});
    await github.refresh();
    const [pr] = github.pulls.items;
    assert.equal(pr.body.length, 4000);
    assert.equal(pr.openedBy, 'Ada');
    assert.deepEqual(pr.reviewRequests, ['ada']);
    assert.equal(github.pulls.viewer, 'office-bot');
    assert.equal((github.issues as { viewer?: string }).viewer, undefined);
  } finally {
    process.env.PATH = PATH;
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
