// The task's Changes view (kanban/changesview.ts) without the DOM (kanban/changesmodel.ts): one row
// shape for upstream's live files and the office's, the modes a repository offers, the repository ↔
// floor id mapping of upstream's Changes messages, when the live data can stand in, and the PR badge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { changesModes, floorOfRepo, liveFloor, liveRow, liveStale, prOfRepo, readsHttp, repoOfFloor, sortRepos, stepRow, taskRow } from '../src/client/kanban/changesmodel.js';
import { parseRepoFloorId, repoFloorId } from '../src/shared/kanban/repofloor.js';
import { repoFloorId as serverRepoFloorId } from '../src/server/kanban/projects.js';
import type { ChangedFile, WorkerRepo } from '../src/shared/protocol.js';

const live = (over: Partial<ChangedFile>): ChangedFile => ({ path: 'a.ts', status: 'M', additions: 1, deletions: 2, binary: false, uncommitted: false, sig: 's1', ...over });
const repo = (floor: string, pr?: number): WorkerRepo => ({ floor, name: floor, dir: '/x', path: 'x', branch: 'b', base: 'c', ...(pr ? { pr: { number: pr, url: 'u' } } : {}) });

test('live and task files become the same row', () => {
  assert.deepEqual(liveRow(live({})), { path: 'a.ts', letter: 'M', tone: 'M', word: 'modified', additions: 1, deletions: 2, binary: false, uncommitted: false, sig: 's1' });
  // An untracked file shows as added, as upstream's window has it.
  const u = liveRow(live({ status: '?', uncommitted: true }));
  assert.equal(u.letter, 'A');
  assert.equal(u.tone, 'A');
  assert.equal(u.word, 'new file');
  assert.equal(u.uncommitted, true);
  assert.equal(liveRow(live({ status: 'R', from: 'old.ts' })).from, 'old.ts');

  assert.deepEqual(taskRow({ path: 'b.ts', status: 'added', additions: 3, deletions: 0 }), { path: 'b.ts', letter: 'A', tone: 'A', word: 'added', additions: 3, deletions: 0, binary: false, uncommitted: false });
  const c = taskRow({ path: 'c.ts', oldPath: 'b.ts', status: 'copied', additions: 0, deletions: 0, binary: true }, true);
  assert.equal(c.letter, 'C');
  assert.equal(c.tone, 'R');
  assert.equal(c.from, 'b.ts');
  assert.equal(c.binary, true);
  assert.equal(c.uncommitted, true);
  assert.equal(taskRow({ path: 'd', status: 'untracked', additions: 0, deletions: 0 }).word, 'new file');
  assert.equal(taskRow({ path: 'd', status: 'unmerged', additions: 0, deletions: 0 }).letter, 'U');
  assert.equal(taskRow({ path: 'd', status: 'typechange', additions: 0, deletions: 0 }).tone, 'T');
});

test('Uncommitted is offered only with a worktree that has some, or while it is on screen', () => {
  assert.deepEqual(changesModes(null, 'all'), ['all', 'commits']);
  assert.deepEqual(changesModes(0, 'all'), ['all', 'commits']);
  assert.deepEqual(changesModes(3, 'commits'), ['all', 'commits', 'uncommitted']);
  assert.deepEqual(changesModes(0, 'uncommitted'), ['all', 'commits', 'uncommitted']);
  // No worktree any more: gone even when it was on screen.
  assert.deepEqual(changesModes(null, 'uncommitted'), ['all', 'commits']);
});

test('the primary repository is the floor itself; the others go by <floor>~<repo>, as on the server', () => {
  assert.equal(repoFloorId('web', 'api'), 'web~api');
  assert.equal(serverRepoFloorId('web', 'api'), repoFloorId('web', 'api'));
  assert.deepEqual(parseRepoFloorId('web~api'), { floor: 'web', repo: 'api' });
  assert.equal(parseRepoFloorId('web'), undefined);
  assert.equal(floorOfRepo('web', 'web'), undefined);
  assert.equal(floorOfRepo('web', 'api'), 'web~api');
  assert.equal(repoOfFloor('web'), 'web');
  assert.equal(repoOfFloor('web', 'web'), 'web');
  assert.equal(repoOfFloor('web', 'web~api'), 'api');
  // Another project's floor id isn't one of this task's repositories.
  assert.equal(repoOfFloor('web', 'shop~api'), 'web');
  assert.equal(repoOfFloor('web', 'shop'), 'web');
  for (const id of ['web', 'api']) assert.equal(repoOfFloor('web', floorOfRepo('web', id)), id);
});

test('the primary repository comes first', () => {
  assert.deepEqual(sortRepos([{ id: 'api' }, { id: 'web', primary: true }, { id: 'docs' }]).map((r) => (r as { id: string }).id), ['web', 'api', 'docs']);
});

test('live data stands in only for a worker on this floor with the repository in its workspace', () => {
  assert.equal(liveFloor(undefined, 'web', 'web'), null);
  assert.deepEqual(liveFloor({}, 'web', 'web'), { floor: undefined });
  assert.equal(liveFloor({}, 'web', 'api'), null);
  assert.equal(liveFloor({ repos: [repo('web~docs')] }, 'web', 'api'), null);
  assert.deepEqual(liveFloor({ repos: [repo('web~api')] }, 'web', 'api'), { floor: 'web~api' });
});

test('a repository tab’s PR: the task’s own link first, else the one opened from the desk', () => {
  const w = { pr: { number: 4, url: 'u' }, repos: [repo('web~api', 9)] };
  assert.equal(prOfRepo('web', 'web', [{ repoId: 'web', number: 12 }], w), 12);
  assert.equal(prOfRepo('web', 'web', [], w), 4);
  assert.equal(prOfRepo('web', 'api', undefined, w), 9);
  assert.equal(prOfRepo('web', 'docs', undefined, w), undefined);
  assert.equal(prOfRepo('web', 'api', [{ repoId: 'web', number: 12 }], undefined), undefined);
});

test('j/k move through the files and stop at the ends', () => {
  const rows = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  assert.equal(stepRow(rows, 'a', 1), 'b');
  assert.equal(stepRow(rows, 'c', 1), 'c');
  assert.equal(stepRow(rows, 'a', -1), 'a');
  assert.equal(stepRow(rows, null, 1), 'a');
  assert.equal(stepRow([], 'a', 1), null);
});

test('Per commit and Uncommitted read the office’s answers even while the worker is followed live', () => {
  // Uncommitted is the worktree against HEAD; the live data is measured from the branch's base.
  assert.equal(readsHttp('all', true), false);
  assert.equal(readsHttp('uncommitted', true), true);
  assert.equal(readsHttp('commits', true), true);
  assert.equal(readsHttp('all', false), true);
});

test('a live state that moved the branch makes the commits stale, an amend included', () => {
  const s = (head: string, ahead = 2, subject = 'fix') => ({ head, ahead, subject });
  assert.deepEqual(liveStale(null, s('a')), { commits: false, whole: false });
  // An edit in the worktree: the worktree's work is read again, the commits stay.
  assert.deepEqual(liveStale(s('a'), s('a')), { commits: false, whole: true });
  // `git commit --amend --no-edit`: same count, same subject, a new HEAD.
  assert.deepEqual(liveStale(s('a'), s('b')), { commits: true, whole: true });
  assert.deepEqual(liveStale(s('a'), s('a', 3)), { commits: true, whole: true });
  assert.deepEqual(liveStale(s('a'), s('a', 2, 'other')), { commits: true, whole: true });
});
