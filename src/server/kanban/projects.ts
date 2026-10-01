// Project = floor (docs/kanban-architecture.md §2). A floor's repositories are FloorDef.repos in
// floors.json; the floor's own checkout is always the primary one, with the floor's id as its id.
// A floor without `repos` is a one-repository project, exactly as upstream has it.
//
// Other repositories reach upstream's WorkerManager.makeWorkspace as RepoSource entries. Upstream
// uses RepoSource.floor only as a label that it looks floors up by (the Changes window's PR lookup,
// leave-on-merge, "lent" floors), never to find the checkout, which is RepoSource.dir. So a project's
// other repository gets the synthetic floor id `<floorId>~<repoId>`: those lookups find no floor and
// quietly skip it, and nothing else in upstream needs changing (see tests/kanban-core-projects.test.ts).

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FloorDef } from '../building.js';
import type { RepoSource } from '../workers.js';
import { MAX_REPOS } from '../workers.js';
import { normalizeRepo, sameRepo } from '../../shared/floors.js';
import type { KanbanProjectInfo, KanbanSettings, ProjectRepo } from '../../shared/kanban/types.js';
import { REPO_ID_RE, type ProjectRepoInput } from '../../shared/kanban/protocol.js';
import { repoFloorId } from '../../shared/kanban/repofloor.js';
import { checkoutRepo } from '../ghrepo.js';
import { BRANCH_RE } from './repos-file.js';

export { loadRepos } from './repos-file.js';

export { REPO_FLOOR_SEP, parseRepoFloorId, repoFloorId } from '../../shared/kanban/repofloor.js';

function isGit(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

/** The primary repository of a floor that has no `repos` of its own: its checkout. */
export function primaryRepo(def: Pick<FloorDef, 'id' | 'name' | 'dir' | 'repo'>): ProjectRepo {
  return { id: def.id, name: def.name, kind: isGit(def.dir) ? 'git' : 'folder', dir: def.dir, ...(def.repo ? { remote: def.repo } : {}), primary: true };
}

/**
 * A project's repositories, the primary first. The primary always follows the floor itself: its
 * checkout, and its GitHub repository when the floor knows one (FloorDef.repo); a floor that doesn't
 * (a local checkout) takes the remote saved for the primary. Every kanban consumer of the primary's
 * owner/name goes through here, never FloorDef.repo. Another git repository with no saved GitHub
 * repository takes the one its checkout's origin names (github.com only) unless another repository
 * of the project already has it (a second clone or worktree); a saved one always wins.
 */
export function projectRepos(def: FloorDef): ProjectRepo[] {
  return projectReposResolved(def).map(({ detectedRemote, ...r }) => (detectedRemote ? { ...r, remote: detectedRemote } : r));
}

/**
 * The project's repositories as saved (`remote`), each with the remote read from its checkout's
 * origin as `detectedRemote` instead while none is saved. A detected remote is dropped when it is the
 * primary's, a saved one's or an earlier detected one's, so one GitHub repository never has two boards.
 */
function projectReposResolved(def: FloorDef): ProjectRepo[] {
  const saved = projectReposSaved(def);
  const taken = saved.map((r) => r.remote).filter((r): r is string => !!r);
  return saved.map((r) => {
    if (r.primary || r.kind !== 'git' || r.remote) return r;
    const found = checkoutRepo(r.dir);
    if (!found || taken.some((t) => sameRepo(t, found))) return r;
    taken.push(found);
    return { ...r, detectedRemote: found };
  });
}

/** The repositories in `list` once each (ignoring case), in the first spelling met. */
export function uniqueRepos(list: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const r of list) if (r && !out.some((o) => sameRepo(o, r))) out.push(r);
  return out;
}

/** projectRepos as saved: no remote read from the checkouts. */
function projectReposSaved(def: FloorDef): ProjectRepo[] {
  const base = primaryRepo(def);
  if (!def.repos?.length) return [base];
  const saved = def.repos.find((r) => r.primary);
  const remote = def.repo ?? saved?.remote;
  const primary: ProjectRepo = { ...base, ...(saved ? { name: saved.name, kind: saved.kind, ...(remote ? { remote } : {}), ...(saved.baseBranch ? { baseBranch: saved.baseBranch } : {}), ...(saved.instructions ? { instructions: saved.instructions } : {}) } : {}), id: def.id, dir: def.dir, primary: true };
  return [primary, ...def.repos.filter((r) => !r.primary)];
}

/**
 * Checks a project's repositories as the settings dialog sends them: absolute folders that are
 * there (a git checkout for kind 'git'), unique ids, names and folders, and exactly one primary,
 * which is the floor's own checkout with the floor's id, and whose GitHub repository is the floor's
 * when the floor knows one (FloorDef.repo). Returns them cleaned up, or why not.
 */
export function validateProjectRepos(def: FloorDef, input: ProjectRepoInput[]): ProjectRepo[] | string {
  if (!Array.isArray(input) || !input.length) return 'A project has at least its own repository';
  if (input.length > MAX_REPOS + 1) return `A project can have at most ${MAX_REPOS} repositories besides its own`;
  const primaries = input.filter((r) => r.primary);
  if (primaries.length !== 1) return 'Exactly one repository is the primary one: the floor’s own checkout';
  const ids = new Set<string>();
  const names = new Set<string>();
  const dirs = new Set<string>();
  const out: ProjectRepo[] = [];
  for (const r of input) {
    const name = (r.name ?? '').trim();
    if (!name || name.length > 100) return 'Every repository needs a name (at most 100 characters)';
    if (names.has(name.toLowerCase())) return `Two repositories are called ${name}`;
    names.add(name.toLowerCase());
    if (typeof r.dir !== 'string' || !path.isAbsolute(r.dir)) return `${name}: use the folder's full path`;
    const dir = path.resolve(r.dir);
    if (r.primary) {
      if (dir !== path.resolve(def.dir)) return `The primary repository is the floor's own checkout (${def.dir})`;
      if (r.id !== def.id) return `The primary repository's id is the floor's (${def.id})`;
    } else if (!REPO_ID_RE.test(r.id) || r.id === def.id) return `${name}: its id must be short (lower-case letters, digits and -, at most 20) and not the floor's`;
    if (ids.has(r.id)) return `Two repositories have the id ${r.id}`;
    ids.add(r.id);
    if (dirs.has(dir)) return `${name}: that folder is already in the project`;
    dirs.add(dir);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // not there
    }
    if (!isDir) return `${name}: ${dir} isn't a folder on this machine`;
    const git = isGit(dir);
    const kind = r.kind ?? (git ? 'git' : 'folder');
    if (kind === 'git' && !git) return `${name}: ${dir} isn't a git checkout (pick “folder” for a plain folder)`;
    const remote = r.remote === undefined || r.remote === '' ? undefined : normalizeRepo(r.remote);
    if (r.remote && !remote) return `${name}: the GitHub repository is owner/name`;
    if (r.primary && def.repo && remote && !sameRepo(remote, def.repo)) return `The floor's own repository is ${def.repo}; add another repository instead, or re-add the floor`;
    if (r.baseBranch !== undefined && r.baseBranch !== '' && !BRANCH_RE.test(r.baseBranch)) return `${name}: that isn't a branch name`;
    out.push({
      id: r.primary ? def.id : r.id,
      name,
      kind,
      dir,
      ...(r.primary && def.repo ? { remote: def.repo } : remote ? { remote } : {}),
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
      primary: !!r.primary,
      ...(r.instructions?.trim() ? { instructions: r.instructions.slice(0, 20_000) } : {}),
    });
  }
  return [out.find((r) => r.primary)!, ...out.filter((r) => !r.primary)];
}

/**
 * The project's other git repositories a task works in, as upstream's RepoSource list for
 * WorkerManager.spawn / makeWorkspace. `repoIds` null = all of them; folders can't have worktrees.
 */
export function repoSources(def: FloorDef, repoIds: string[] | null): RepoSource[] {
  return projectRepos(def)
    .filter((r) => !r.primary && r.kind === 'git' && (!repoIds || repoIds.includes(r.id)))
    .map((r) => ({ floor: repoFloorId(def.id, r.id), name: r.name, ...(r.remote ? { repo: r.remote } : {}), dir: r.dir }));
}

/** A project as the kanban lists it. */
export function projectInfo(def: FloorDef, settings: KanbanSettings, open: boolean): KanbanProjectInfo {
  const p = settings.projects[def.id];
  return {
    id: def.id,
    name: def.name,
    ...(def.repo ? { repo: def.repo } : {}),
    dir: def.dir,
    // A remote read from a checkout is not sent as `remote`: the settings form would save it.
    repos: projectReposResolved(def),
    open,
    settings: {
      maxConcurrent: p?.maxConcurrent ?? 2,
      planApproval: p?.planApproval ?? settings.defaults.planApproval,
      issueSources: p?.issueSources.length ?? 0,
      promptOverrides: Object.keys(p?.prompts ?? {}).length,
      reviewRounds: p?.review?.rounds ?? settings.review.rounds,
    },
  };
}
