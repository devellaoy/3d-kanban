// The handoff baseline (#331): what a reviewed task's workspace held when it last came to the Review
// column (KanbanTask.handoffFingerprint). A comment's or answer's work that leaves the workspace as it
// was then is not reviewed again; a task that never reached Review has no baseline and is judged
// against its base branch as before.

import type { KanbanTask } from '../../../shared/kanban/types.js';
import type { TaskUpdate } from '../db/repository.js';
import type { KanbanContext } from '../registry.js';
import type { Effect, MachineEvent } from './machine.js';
import { workspaceFingerprint } from './workspace.js';

export class Handoffs {
  /** The tasks whose workspace fingerprint failed (logged once, until it works again). */
  private unprinted = new Set<number>();

  constructor(
    private ctx: KanbanContext,
    private folder: (project: string) => boolean,
    private update: (id: number, patch: TaskUpdate) => unknown,
  ) {}

  /**
   * Whether the step that fed `e` brought the task to what the user gets in the Review column, so its baseline is
   * stored. Not when a resume changed nothing (the baseline still holds), nor for a task that is never reviewed again.
   */
  due(task: KanbanTask, e: MachineEvent, effects: readonly Effect[]): boolean {
    const unchanged = e.type === 'resumed' && e.since === 'handoff' && !e.changes;
    return effects.some((x) => x.type === 'finished') && !unchanged && task.type !== 'investigate' && task.useReview;
  }

  /** A resume turn's event: against the baseline when the task has one, otherwise `changes()` (against the base branch). */
  async resumed(task: KanbanTask, pending: boolean, changes: () => Promise<boolean>): Promise<MachineEvent> {
    if (task.type === 'investigate') return { type: 'resumed', changes: false, pending };
    if (!task.handoffFingerprint) return { type: 'resumed', changes: await changes(), pending };
    // Reviewed again only when something differs from how the task last came to Review.
    const now = await this.fingerprint(task);
    return { type: 'resumed', changes: now === undefined || now !== task.handoffFingerprint, since: 'handoff', pending };
  }

  /** Stores the workspace as the task now stands in the Review column; never throws. */
  async store(taskId: number): Promise<void> {
    try {
      const fresh = this.ctx.repo.getTask(taskId);
      if (fresh?.status !== 'review') return;
      const print = await this.fingerprint(fresh);
      if (this.ctx.repo.getTask(taskId)?.status === 'review') this.update(taskId, { handoffFingerprint: print ?? null });
    } catch (err) {
      console.error(`agent-office: couldn't store kanban task #${taskId}'s handoff fingerprint: ${(err as Error).message}`);
    }
  }

  /** The task's workspace as it is now (workspaceFingerprint); undefined when there is no git to ask. */
  private async fingerprint(task: KanbanTask): Promise<string | undefined> {
    const floor = this.ctx.floor(task.project);
    if (this.folder(task.project) || !floor || !task.workspace) return undefined;
    const print = await workspaceFingerprint(floor.dir, task.workspace);
    if (print !== undefined) this.unprinted.delete(task.id);
    else if (!this.unprinted.has(task.id)) {
      this.unprinted.add(task.id);
      console.error(`agent-office: couldn't fingerprint kanban task #${task.id}'s workspace, so a comment's work on it is always reviewed`);
    }
    return print;
  }
}
