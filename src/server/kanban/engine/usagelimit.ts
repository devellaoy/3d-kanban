// A usage limit or a lost connection stopped a run: when it carries on by itself, within autoResume's limits (split out of the orchestrator).

import type { KanbanContext } from '../registry.js';
import type { KanbanTask } from '../../../shared/kanban/types.js';
import type { TurnResult } from './adapters/types.js';
import { backoffMs } from './markers.js';
import { limitReset, type LimitedRun } from './limitreset.js';
import type { MachineEvent } from './machine.js';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

export interface LimitDeps {
  ctx: KanbanContext;
  now(): number;
  finishRun(id: number, project: string, patch: Parameters<KanbanContext['repo']['finishRun']>[1]): unknown;
  note(task: KanbanTask, text: string): unknown;
  apply(taskId: number, e: MachineEvent): Promise<unknown>;
  drain(project: string): void;
}

export class UsageLimits<L extends LimitedRun & { runId: number; phase: string }> {
  /** When a task's run of usage limits began, to cap the total wait (autoResume.maxWaitHours). */
  private since = new Map<number, number>();

  constructor(private d: LimitDeps) {}

  clear(taskId: number) {
    this.since.delete(taskId);
  }

  /** A usage limit or lost connection: retry later, within autoResume's limits. */
  async limited(task: KanbanTask, live: L, result: TurnResult, sessionId?: string) {
    const auto = this.d.ctx.settings.get().autoResume;
    const now = this.d.now();
    const attempts = task.retryAttempts + 1;
    const since = this.since.get(task.id) ?? now;
    this.since.set(task.id, since);
    const said = result.apiError ?? result.text;
    const resetP = limitReset(this.d.ctx, live, said, now); // started first: its worker's Codex home is read before the run is finished
    this.d.finishRun(live.runId, task.project, { status: 'failed', error: clip(`Interrupted: ${said}`, 2000), ...(sessionId ? { sessionId } : {}) });
    const reset = await resetP;
    const at = reset !== undefined ? reset + 60_000 : this.d.now() + backoffMs(attempts);
    if (!auto.enabled || attempts > auto.maxAttempts || at - since > auto.maxWaitHours * 3_600_000) {
      this.since.delete(task.id);
      await this.d.apply(task.id, { type: 'gaveUp', text: clip(`A usage limit or a lost connection stopped it${auto.enabled ? ` (${attempts - 1} tries)` : ''}: Retry once it has reset${reset !== undefined ? ` (${new Date(reset).toLocaleString('en-GB')})` : ''}. ${said}`, 500) });
    } else {
      this.d.note(task, `A usage limit or a lost connection interrupted it. It carries on by itself at ${new Date(at).toLocaleString('en-GB')}.`);
      await this.d.apply(task.id, { type: 'limited', retryAt: at, attempts, text: clip(said, 300) });
    }
    void this.d.drain(task.project);
  }
}
