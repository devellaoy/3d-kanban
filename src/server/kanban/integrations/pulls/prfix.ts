// Which of a task's open pull requests a Fix PRs or Resolve conflicts run may work on. A PR's head branch is whatever its
// author named it, so it is never trusted as ours: a fork's PR, and one from the repository's base
// or an integration branch (main, develop, ...), are skipped, never checked out.

import type { FloorDef } from '../../../building.js';
import { projectRepos } from '../../projects.js';
import type { Floor } from '../../../floor.js';
import { sameRepo } from '../../../../shared/floors.js';
import type { GhPull } from '../../../../shared/protocol.js';
import { INTEGRATION_BRANCHES, openPrs } from '../../../../shared/kanban/prs.js';
import type { KanbanPrLink, KanbanTask, ProjectRepo } from '../../../../shared/kanban/types.js';

/** The floor's polled pull requests; none when it has not polled any (or is a stand-in without a board). */
export function polledPulls(floor: Pick<Floor, 'pullsState'> | undefined): GhPull[] {
  return floor?.pullsState?.().items ?? [];
}

/** Whether the board says a linked PR's head is in another repository (a fork's); undefined when the board doesn't list it (yet). */
export function isForkPr(pulls: GhPull[], link: Pick<KanbanPrLink, 'repo' | 'number' | 'url'>, remote: string | undefined): boolean | undefined {
  const p = pulls.find((x) => x.url === link.url) ?? pulls.find((x) => x.number === link.number && sameRepo(x.repo, link.repo ?? remote));
  return p?.isCrossRepository;
}

/** A head branch that is nobody's work: an integration branch, or the repository's own base branch. */
function unsafeBranch(branch: string, repo: Pick<ProjectRepo, 'baseBranch'> | undefined): boolean {
  return INTEGRATION_BRANCHES.has(branch.toLowerCase()) || branch === repo?.baseBranch;
}

/** The task's open PRs a Fix PRs run may work on: not a fork's, and (when the branch is known) not from a base or integration branch. */
export function fixTargets(task: Pick<KanbanTask, 'prs'>, repos: Pick<ProjectRepo, 'id' | 'remote' | 'baseBranch'>[], pulls: GhPull[]): KanbanPrLink[] {
  return openPrs(task).filter((p) => {
    const repo = repos.find((r) => r.id === p.repoId);
    return isForkPr(pulls, p, repo?.remote) !== true && !(p.branch && unsafeBranch(p.branch, repo));
  });
}

/** The fork test canFixPrs takes: the board's word on each of the task's PRs, by the project's repositories. */
export function forkTest(pulls: GhPull[], repos: Pick<ProjectRepo, 'id' | 'remote'>[]) {
  return (p: KanbanPrLink) => isForkPr(pulls, p, repos.find((r) => r.id === p.repoId)?.remote);
}

/** fixTargets for a task of `def`, by the PRs its `floor` has polled. */
export function fixTargetsOf(task: Pick<KanbanTask, 'prs'>, def: FloorDef, floor: Floor | undefined): KanbanPrLink[] {
  return fixTargets(task, projectRepos(def), polledPulls(floor));
}
