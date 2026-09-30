// Regressions: the primary repository's GitHub remote. A floor that knows its repository
// (FloorDef.repo) fixes the primary's remote to it, and saving another is refused; a floor that
// doesn't (a local checkout) takes the remote saved for the primary, and every kanban consumer of the
// primary's owner/name (the issue sources' repositories, the PR bundle, pr_links matching, the
// prompts' repository lists) gets it through projectRepos.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { primaryRepo, projectRepos, validateProjectRepos } from '../src/server/kanban/projects.js';
import type { ProjectRepoInput } from '../src/shared/kanban/protocol.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { ADA, engineFixture } from './kanban-engine-fixture.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

function checkout(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-primary-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'web');
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

test("a floor with its own repository: the primary's remote is fixed to it, and another is refused", (t) => {
  const dir = checkout(t);
  const d = def('web', dir, { repo: 'acme/web' });
  const primary = (remote?: string): ProjectRepoInput[] => [{ id: 'web', name: 'web', dir, primary: true, ...(remote !== undefined ? { remote } : {}) }];
  assert.equal(validateProjectRepos(d, primary('acme/other')), "The floor's own repository is acme/web; add another repository instead, or re-add the floor");
  assert.match(String(validateProjectRepos(d, primary('https://github.com/someone/web.git'))), /floor's own repository is acme\/web/);
  for (const same of ['acme/web', 'ACME/Web', 'https://github.com/acme/web.git', '', undefined]) {
    const ok = validateProjectRepos(d, primary(same));
    assert.ok(Array.isArray(ok), `${String(same)}: ${String(ok)}`);
    assert.equal(ok[0].remote, 'acme/web', `${String(same)}: the floor's, as it names it`);
  }
  // And a primary saved with another remote before (floors.json edited by hand) still reads as the floor's.
  assert.equal(projectRepos({ ...d, repos: [{ id: 'web', name: 'web', kind: 'git', dir, remote: 'acme/other', primary: true }] })[0].remote, 'acme/web');
});

test("a floor without a repository: the primary's saved remote is the project's, for the issue sources and the PR bundle", async (t) => {
  const dir = checkout(t);
  const bare: FloorDef = def('web', dir);
  const checked = validateProjectRepos(bare, [{ id: 'web', name: 'web', dir, primary: true, remote: 'https://github.com/acme/local' }]);
  assert.ok(Array.isArray(checked), String(checked));
  assert.equal(checked[0].remote, 'acme/local');
  assert.notDeepEqual(checked[0], primaryRepo(bare), 'not the plain floor: the list is saved');
  const local: FloorDef = { ...bare, repos: checked };
  assert.equal(projectRepos(local)[0].remote, 'acme/local', 'read back from the saved list');
  // Nothing saved: no remote, as before.
  assert.equal(projectRepos(bare)[0].remote, undefined);

  const ctx = makeCtx([local]);
  // The issue sources' repositories: a github-repo source that names none takes the project's.
  ctx.settings.setProject('web', { issueSources: [{ id: 's1', kind: 'github-repo', repos: [], filters: {} }] as IssueSourceConfig[] });
  const issueCalls: string[][] = [];
  const issues = createIssues(ctx, { gh: async (args) => (issueCalls.push(args), '[]') });
  await issues.plugin.ws!['kanban.issues.refresh']!(client(), { t: 'kanban.issues.refresh', project: 'web', rid: 'r' });
  assert.deepEqual(issueCalls.map((a) => a[3]), ['acme/local']);

  // The PR bundle looks the saved remote up.
  const prCalls: string[][] = [];
  const parts = createPullsParts(ctx, {
    gh: async (args) => {
      prCalls.push(args);
      return JSON.stringify([{ number: 5, title: 'Login', url: 'https://github.com/acme/local/pull/5', state: 'OPEN', isDraft: false, headRefName: 'feat/login' }]);
    },
  });
  const bundle = await parts.api.bundle('web', { branch: 'feat/login' });
  assert.ok(Array.isArray(bundle), String(bundle));
  assert.deepEqual(bundle.map((p) => `${p.repo}#${p.number}:${p.repoId}`), ['acme/local#5:web']);
  assert.ok(prCalls.some((a) => a[0] === 'pr' && a[1] === 'list' && a.includes('acme/local')), JSON.stringify(prCalls));
  // And a review of it is checked against it.
  const ok = await parts.checkReview({ project: 'web', prs: [{ repo: 'acme/local', number: 5 }] });
  assert.ok(typeof ok === 'object', String(ok));
});

test("a floor without a repository: the engine's prompts and PR matching use the primary's saved remote", async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  delete (fx.def as { repo?: string }).repo;
  fx.def.repos = [{ id: 'proj', name: 'Proj', kind: 'git', dir: fx.dir, remote: 'acme/local', primary: true }];
  fx.setRules([
    { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
    { when: 'Review these pull requests', reply: 'Fine.\n\nREVIEW: APPROVED' },
  ]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const before = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  // The phase prompt's repository list names it.
  const implement = fx.invocations().find((i) => i.prompt && /Implement kanban task/.test(i.prompt))!;
  assert.match(implement.prompt!, /Proj \(acme\/local\)/);

  // A PR in that repository from the task's branch is the task's: the review goes into it.
  const got = await fx.engine.reviewPrs({ project: 'proj', prs: [{ repo: 'acme/local', number: 5, branch: before.branch } as never], taskId: task.id }, ADA);
  assert.ok(typeof got !== 'string', String(got));
  if (typeof got === 'string') return;
  assert.equal(got.taskId, task.id, 'matched to the task by the saved remote');
});
