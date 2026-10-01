// A project's other repository goes by a synthetic floor id `<floorId>~<repoId>` in upstream's
// workspace code (RepoSource.floor, WorkerInfo.repos[].floor, the Changes window's `repo`); the
// primary repository is the floor itself. Shared so the server and the browser build the same id.

import { PROJECT_ID_RE, REPO_ID_RE } from './protocol.js';

/** Between a floor id and a repository id in a synthetic RepoSource.floor. */
export const REPO_FLOOR_SEP = '~';

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
