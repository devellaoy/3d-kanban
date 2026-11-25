// What the end of a pull-request turn does (pr, pr-fix, pr-conflicts, pr-answers and pr-comments): the PR: lines it reported are linked to the
// task, the floor's PR board is refreshed, and the machine is told the turn is over. Split out of the orchestrator like Departures; the
// engine's own state reaches it through the small `PrTurnDeps` interface.

import type { KanbanTask, RunPhase } from '../../../shared/kanban/types.js';
import { sameRepo } from '../../../shared/floors.js';
import { prOwners } from '../integrations/pulls/bundle.js';
import type { KanbanContext } from '../registry.js';
import type { TaskUpdate } from '../db/repository.js';
import { taskRepos } from './compose.js';
import type { MachineEvent } from './machine.js';
import { notUpdatedLines, prLines } from './markers.js';
import type { PrCommentsRuns } from './prcomments.js';

/** What the PR turn's end borrows from the orchestrator. */
export interface PrTurnDeps {
  update(id: number, patch: TaskUpdate): unknown;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): unknown;
  pushTask(task: KanbanTask | undefined): void;
}

export class PrTurn {
  constructor(
    private ctx: KanbanContext,
    private d: PrTurnDeps,
    private comments: PrCommentsRuns,
  ) {}

  /**
   * A PR turn's final `text` is in: records what it reported and answers with the machine's event. `say` puts the agent's reply in the task's
   * conversation (a fetch of review comments says nothing there: it leaves its list for the Pull requests tab).
   */
  ended(task: KanbanTask, live: { phase: RunPhase; runId: number }, text: string, pending: boolean, say: (text: string) => void): MachineEvent {
    if (live.phase === 'pr-comments') {
      this.d.note(task, this.comments.collect(task), live.runId);
      return { type: 'prCommentsDone', pending };
    }
    say(text);
    this.recordPrs(task, text);
    this.refreshPrBoards(task);
    const missed = live.phase === 'pr-conflicts' ? notUpdatedLines(text).length : 0;
    if (missed) this.d.note(task, `${missed} pull request${missed === 1 ? ' was' : 's were'} not updated: read the result for why`, live.runId);
    if (live.phase === 'pr') this.d.update(task.id, { flags: { ...(this.ctx.repo.getTask(task.id)?.flags ?? task.flags), prRequested: true } });
    return { type: 'prDone', pending };
  }

  /**
   * The pull requests a PR turn reported with a `PR:` line, kept on the task by repository: only a
   * GitHub PR of one of the task's repositories that no other task (of any project) has. A PR the
   * answer names otherwise is left to the board sync, which links it by the task's branch.
   */
  private recordPrs(task: KanbanTask, text: string) {
    const def = this.ctx.project(task.project);
    const repos = def ? taskRepos(def, task) : [];
    const branches = this.ctx.repo.repoBranches(task.id);
    const remoteOf = (project: string, repoId: string) => this.ctx.repos(project).find((r) => r.id === repoId)?.remote;
    let changed = false;
    for (const pr of prLines(text)) {
      if (pr.number === undefined || !pr.repo) continue;
      const repo = repos.find((r) => r.remote && sameRepo(r.remote, pr.repo!));
      if (!repo || prOwners(this.ctx.repo.prLinksMatching(pr.number, pr.url), remoteOf, { repo: pr.repo, number: pr.number, url: pr.url }).some((id) => id !== task.id)) continue;
      // A link already knows its PR's head branch (Fix PRs checks it out): an answer doesn't move it to the task's.
      const branch = task.prs.find((p) => p.repoId === repo.id && p.number === pr.number)?.branch ?? branches[repo.id] ?? task.branch;
      this.ctx.repo.upsertPrLink(task.id, { repoId: repo.id, repo: pr.repo, number: pr.number, url: pr.url, state: 'OPEN', ...(branch ? { branch } : {}) });
      changed = true;
    }
    if (changed) this.d.pushTask(this.ctx.repo.getTask(task.id));
  }

  /** After a PR turn the floor's PR board lists the new PR at once (its sync then links it by branch, whatever the answer said). */
  private refreshPrBoards(task: KanbanTask) {
    try {
      const def = this.ctx.project(task.project);
      const floor = this.ctx.floor(task.project);
      if (!def || !floor) return;
      for (const r of taskRepos(def, task)) if (r.kind === 'git' && r.remote) void floor.githubFor(r.remote)?.refresh().catch(() => {});
    } catch {
      /* a missing floor or board is no reason to fail the turn */
    }
  }
}
