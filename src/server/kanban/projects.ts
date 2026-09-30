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
import { normalizeRepo } from '../../shared/floors.js';
import type { KanbanProjectInfo, KanbanSettings, ProjectRepo } from '../../shared/kanban/types.js';
import { PROJECT_ID_RE, REPO_ID_RE, type ProjectRepoInput } from '../../shared/kanban/protocol.js';
import { BRANCH_RE } from './repos-file.js';

export { loadRepos } from './repos-file.js';

/** Between a floor id and a repository id in a synthetic RepoSource.floor. */
export const REPO_FLOOR_SEP = '~';

function isGit(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

/** The primary repository of a floor that has no `repos` of its own: its checkout. */
export function primaryRepo(def: Pick<FloorDef, 'id' | 'name' | 'dir' | 'repo'>): ProjectRepo {
  return { id: def.id, name: def.name, kind: isGit(def.dir) ? 'git' : 'folder', dir: def.dir, ...(def.repo ? { remote: def.repo } : {}), primary: true };
}

/** A project's repositories, the primary first. The primary always follows the floor itself. */
export function projectRepos(def: FloorDef): ProjectRepo[] {
  const base = primaryRepo(def);
  if (!def.repos?.length) return [base];
  const saved = def.repos.find((r) => r.primary);
  const primary: ProjectRepo = { ...base, ...(saved ? { name: saved.name, kind: saved.kind, ...(saved.baseBranch ? { baseBranch: saved.baseBranch } : {}), ...(saved.instructions ? { instructions: saved.instructions } : {}) } : {}), id: def.id, dir: def.dir, primary: true };
  return [primary, ...def.repos.filter((r) => !r.primary)];
}

/**
 * Checks a project's repositories as the settings dialog sends them: absolute folders that are
 * there (a git checkout for kind 'git'), unique ids, names and folders, and exactly one primary,
 * which is the floor's own checkout with the floor's id. Returns them cleaned up, or why not.
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
    if (r.baseBranch !== undefined && r.baseBranch !== '' && !BRANCH_RE.test(r.baseBranch)) return `${name}: that isn't a branch name`;
    out.push({
      id: r.primary ? def.id : r.id,
      name,
      kind,
      dir,
      ...(remote ? { remote } : r.primary && def.repo ? { remote: def.repo } : {}),
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
      primary: !!r.primary,
      ...(r.instructions?.trim() ? { instructions: r.instructions.slice(0, 20_000) } : {}),
    });
  }
  return [out.find((r) => r.primary)!, ...out.filter((r) => !r.primary)];
}

/** The RepoSource.floor a project's other repository goes by in upstream's workspace code. */
export function repoFloorId(floorId: string, repoId: string): string {
  return `${floorId}${REPO_FLOOR_SEP}${repoId}`;
}

/** The floor and repository of a synthetic RepoSource.floor (undefined for a real floor id). */
export function parseRepoFloorId(id: string): { floor: string; repo: string } | undefined {
  const at = id.indexOf(REPO_FLOOR_SEP);
  if (at <= 0) return undefined;
  const floor = id.slice(0, at);
  const repo = id.slice(at + 1);
  return PROJECT_ID_RE.test(floor) && REPO_ID_RE.test(repo) ? { floor, repo } : undefined;
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
    repos: projectRepos(def),
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
