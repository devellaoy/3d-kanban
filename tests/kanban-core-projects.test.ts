import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, type FloorDef } from '../src/server/building.js';
import { MAX_REPOS } from '../src/server/workers.js';
import { MAX_PROJECT_REPOS, loadRepos } from '../src/server/kanban/repos-file.js';
import { parseRepoFloorId, primaryRepo, projectInfo, projectRepos, repoFloorId, repoSources, validateProjectRepos } from '../src/server/kanban/projects.js';
import { defaultKanbanSettings } from '../src/server/kanban/settings.js';
import type { ProjectRepoInput } from '../src/shared/kanban/protocol.js';

function office(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-core-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const checkout = (name: string, git = true) => {
    const dir = path.join(root, 'acme', name);
    mkdirSync(git ? path.join(dir, '.git') : dir, { recursive: true });
    return dir;
  };
  return { root, dataDir, checkout };
}

const def = (id: string, dir: string, extra: Partial<FloorDef> = {}): FloorDef => ({ id, name: id, repo: `acme/${id}`, dir, palette: 0, addedBy: 'Sam', addedAt: 1, ...extra });

test('an old floors.json without repos loads, and saves, exactly as upstream has it', (t) => {
  const { root, dataDir, checkout } = office(t);
  const old = [def('web', checkout('web')), def('api', checkout('api'), { palette: 2 })];
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(old));
  const building = new Building(dataDir, root);
  assert.deepEqual(building.list(), old);
  for (const d of building.list()) assert.ok(!('repos' in d));
  // Saving (a floor taken off) writes no repos key either.
  building.remove('api');
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[];
  assert.deepEqual(saved, [old[0]]);
  // Its one repository is the floor's checkout.
  const [only] = projectRepos(building.list()[0]);
  assert.deepEqual(only, { id: 'web', name: 'web', kind: 'git', dir: old[0].dir, remote: 'acme/web', primary: true });
  assert.deepEqual(repoSources(building.list()[0], null), []);
});

test("a project's repositories are saved in floors.json and read back, checked for shape only", (t) => {
  const { root, dataDir, checkout } = office(t);
  const web = checkout('web');
  const api = checkout('api');
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify([def('web', web)]));
  const building = new Building(dataDir, root);
  const repos = validateProjectRepos(building.list()[0], [
    { id: 'web', name: 'Web', dir: web, primary: true, baseBranch: 'main' },
    { id: 'api', name: 'API', dir: api, remote: 'https://github.com/acme/api.git', primary: false, instructions: 'Run npm test' },
  ]);
  assert.ok(Array.isArray(repos), String(repos));
  assert.equal(typeof building.setRepos('web', repos), 'object');
  const again = new Building(dataDir, root);
  assert.deepEqual(again.list()[0].repos, repos);
  const all = projectRepos(again.list()[0]);
  assert.deepEqual(all.map((r) => [r.id, r.primary, r.name]), [['web', true, 'Web'], ['api', false, 'API']]);
  assert.equal(all[0].baseBranch, 'main');
  assert.equal(all[1].remote, 'acme/api');
  // The other repository reaches upstream's workspace code under a floor id no floor has.
  assert.deepEqual(repoSources(again.list()[0], null), [{ floor: 'web~api', name: 'API', repo: 'acme/api', dir: api }]);
  assert.deepEqual(repoSources(again.list()[0], ['web']), []);
  assert.deepEqual(parseRepoFloorId(repoFloorId('web', 'api')), { floor: 'web', repo: 'api' });
  assert.equal(parseRepoFloorId('web'), undefined);
  // A folder that's gone (a disk not mounted) doesn't wipe the list: floors.json is read for shape only.
  rmSync(api, { recursive: true });
  assert.equal(new Building(dataDir, root).list()[0].repos?.length, 2);
  // Clearing them.
  again.setRepos('web', undefined);
  assert.ok(!('repos' in new Building(dataDir, root).list()[0]));
  assert.equal(again.setRepos('nope', []), 'No such floor');
});

test('loadRepos drops what floors.json can’t mean', () => {
  const dir = '/work/web';
  const got = loadRepos(
    [
      { id: 'x', primary: true, dir: '/elsewhere', name: 'Wrong primary' },
      { id: 'anything', primary: true, dir, name: 'Web' },
      { id: 'web2', primary: true, dir, name: 'Second primary' },
      { id: 'Bad Id', dir: '/work/a' },
      { id: 'api', dir: 'relative/path' },
      { id: 'api', dir: '/work/api', kind: 'folder', remote: 'nonsense value', baseBranch: 'has space' },
      { id: 'api', dir: '/work/api2' },
      'junk',
    ],
    'web',
    dir,
  );
  assert.deepEqual(got, [
    { id: 'web', name: 'Web', kind: 'git', dir, primary: true },
    { id: 'api', name: 'api', kind: 'folder', dir: '/work/api', primary: false },
  ]);
  assert.equal(loadRepos('nope', 'web', dir), undefined);
  assert.equal(loadRepos([], 'web', dir), undefined);
  assert.equal(MAX_PROJECT_REPOS, MAX_REPOS, "repos-file keeps upstream's limit");
});

test('validateProjectRepos refuses what the settings dialog must not save', (t) => {
  const { checkout } = office(t);
  const web = checkout('web');
  const api = checkout('api');
  const notes = checkout('notes', false);
  const d = def('web', web);
  const primary: ProjectRepoInput = { id: 'web', name: 'web', dir: web, primary: true };
  const check = (input: ProjectRepoInput[]) => validateProjectRepos(d, input);
  assert.match(String(check([])), /at least its own/);
  assert.match(String(check([{ ...primary, primary: false, id: 'x' }])), /Exactly one/);
  assert.match(String(check([primary, { ...primary, id: 'x', name: 'x', dir: api }])), /Exactly one/);
  assert.match(String(check([{ ...primary, dir: api }])), /floor's own checkout/);
  assert.match(String(check([{ ...primary, id: 'other' }])), /floor's \(web\)/);
  assert.match(String(check([primary, { id: 'api', name: 'API', dir: 'relative', primary: false }])), /full path/);
  assert.match(String(check([primary, { id: 'api', name: 'API', dir: path.join(api, 'missing'), primary: false }])), /isn't a folder/);
  assert.match(String(check([primary, { id: 'notes', name: 'Notes', dir: notes, kind: 'git', primary: false }])), /isn't a git checkout/);
  assert.match(String(check([primary, { id: 'Bad', name: 'API', dir: api, primary: false }])), /id must be short/);
  assert.match(String(check([primary, { id: 'web', name: 'API', dir: api, primary: false }])), /not the floor's/);
  assert.match(String(check([primary, { id: 'a'.repeat(21), name: 'API', dir: api, primary: false }])), /at most 20/);
  assert.match(String(check([primary, { id: 'api', name: 'web', dir: api, primary: false }])), /Two repositories are called/);
  assert.match(String(check([primary, { id: 'api', name: 'API', dir: web, primary: false }])), /already in the project/);
  assert.match(String(check([primary, { id: 'api', name: 'API', dir: api, remote: 'not a repo', primary: false }])), /owner\/name/);
  assert.match(String(check([primary, { id: 'api', name: 'API', dir: api, baseBranch: 'bad branch', primary: false }])), /branch name/);
  const many = Array.from({ length: MAX_REPOS + 1 }, (_, i) => ({ id: `r${i}`, name: `r${i}`, dir: api, primary: false }));
  assert.match(String(check([primary, ...many])), /at most/);

  // Good: the primary first whatever the order, a plain folder found as one, the floor's remote kept.
  const ok = check([{ id: 'notes', name: 'Notes', dir: notes, primary: false }, primary]);
  assert.ok(Array.isArray(ok));
  assert.deepEqual(ok, [
    { id: 'web', name: 'web', kind: 'git', dir: web, remote: 'acme/web', primary: true },
    { id: 'notes', name: 'Notes', kind: 'folder', dir: notes, primary: false },
  ]);
  assert.deepEqual(primaryRepo(d), ok[0]);
  // Folders can't have worktrees: they're not workspace sources.
  assert.deepEqual(repoSources({ ...d, repos: ok }, null), []);
});

test('projectInfo sums up a project for the board', (t) => {
  const { checkout } = office(t);
  const s = defaultKanbanSettings();
  s.projects.web = { branchInstructions: '', generalInstructions: '', testingInstructions: '', maxConcurrent: 4, issueSources: [], prompts: { 'kanban.plan': 'x' }, skills: {}, review: { rounds: 5 } };
  const info = projectInfo(def('web', checkout('web')), s, true);
  assert.equal(info.open, true);
  assert.deepEqual(info.settings, { maxConcurrent: 4, planApproval: 'auto', issueSources: 0, promptOverrides: 1, reviewRounds: 5 });
  assert.equal(projectInfo(def('api', checkout('api')), s, false).settings.reviewRounds, s.review.rounds);
});
