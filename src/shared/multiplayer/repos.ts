// Which repositories a visitor may see code of. A worker or a task names repositories by the id
// WorkerInfo.repos / the Changes window use: a floor id (the project's own checkout) or
// `<floor>~<repo>` (another repository of a project, see kanban/repofloor.ts). Checking only the
// floor part would keep showing a repository the owner took out of a shared project to a visitor
// admitted afterwards, through the workers and tasks that still hold it; so each repository must
// also be one the visitor was verified against (VisitorScope.repos).
import { repoFloorId } from '../kanban/repofloor.js';
import type { VisitorScope } from './allow.js';

/** The floor part of a repository id. */
export const floorOfRepo = (id: string): string => id.split('~')[0];

/** Whether `id` (a floor id or `<floor>~<repo>`) is a repository in the visitor's scope: its floor is theirs and the repository was among those verified for it. */
export function repoOk(scope: VisitorScope, id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  const floor = floorOfRepo(id);
  if (!scope.floors.has(floor)) return false;
  // A scope without a list (made by hand, outside the host) is checked by floor only.
  return !scope.repos || !!scope.repos.get(floor)?.has(id);
}

/** What a task names of its project's repositories, as repository ids (the stored workspace, its repoIds and its pull requests). */
export function taskRepoIds(task: {
  project: string;
  repoIds?: string[] | null;
  prs?: { repoId: string }[];
  workspace?: { repos?: { floor: string }[] };
}): string[] {
  const own = (repoId: string) => (repoId === task.project ? repoId : repoFloorId(task.project, repoId));
  return [
    ...(task.repoIds ?? []).map(own),
    ...(task.prs ?? []).map((p) => own(p.repoId)),
    ...(task.workspace?.repos ?? []).map((r) => r.floor),
  ];
}

/** Whether every repository a task names is in the visitor's scope. */
export const taskOk = (scope: VisitorScope, task: Parameters<typeof taskRepoIds>[0]): boolean => taskRepoIds(task).every((id) => repoOk(scope, id));
