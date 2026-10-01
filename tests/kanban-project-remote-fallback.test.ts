// A project's other git repository with no saved GitHub repository follows its checkout's origin
// (github.com only); a saved one wins, the primary is unchanged, and the settings form is told the
// detected one as `detectedRemote` so saving doesn't pin it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectInfo, projectRepos, repoSources } from '../src/server/kanban/projects.js';
import type { KanbanSettings } from '../src/shared/kanban/types.js';
import { def } from './kanban-integrations-ctx.js';

function repo(t: { after(fn: () => void): void }, origin?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-remote-fallback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
}

function project(primary: string, other: string, remote?: string) {
  return def('web', primary, {
    repos: [
      { id: 'web', name: 'web', kind: 'git', dir: primary, primary: true },
      { id: 'api', name: 'api', kind: 'git', dir: other, primary: false, ...(remote ? { remote } : {}) },
    ],
  });
}

test("another git repository follows its checkout's origin; a saved remote wins", (t) => {
  const web = repo(t, 'https://github.com/acme/web.git');
  const api = repo(t, 'https://github.com/acme/api.git');
  const d = project(web, api);
  const [primary, other] = projectRepos(d);
  assert.equal(primary.remote, undefined, 'the primary is unchanged');
  assert.equal(other.remote, 'acme/api');
  assert.equal(projectRepos(project(web, repo(t, 'https://github.com/acme/api.git'), 'acme/pinned'))[1].remote, 'acme/pinned');
});

test('a non-GitHub origin or none leaves the remote unset', (t) => {
  const web = repo(t);
  assert.equal(projectRepos(project(web, repo(t, 'https://gitlab.com/acme/api.git')))[1].remote, undefined);
  assert.equal(projectRepos(project(web, repo(t)))[1].remote, undefined);
});

test('repoSources and projectInfo', (t) => {
  const web = repo(t);
  const api = repo(t, 'git@github.com:acme/api.git');
  const d = project(web, api);
  assert.equal(repoSources(d, null)[0].repo, 'acme/api');
  const settings = { projects: {}, defaults: { planApproval: 'manual' }, review: { rounds: 1 } } as unknown as KanbanSettings;
  const info = projectInfo(d, settings, true).repos[1];
  assert.equal(info.detectedRemote, 'acme/api');
  assert.equal('remote' in info, false);
  const saved = projectInfo(project(web, repo(t, 'https://github.com/acme/api.git'), 'acme/pinned'), settings, true).repos[1];
  assert.equal(saved.remote, 'acme/pinned');
  assert.equal(saved.detectedRemote, undefined);
});
