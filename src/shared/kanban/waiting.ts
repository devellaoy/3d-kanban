// Whether a task worker waits on someone, for the office (N, the arrows, the counts), the dog, the
// webhook and the notifications: the worker's status read through its task.

import type { WorkerInfo } from '../protocol.js';
import type { KanbanRole, RunPhase, WaitingReason } from './types.js';

/** The waits that need a person (a usage limit retries by itself). The kanban page's needsAttention uses it too. */
export const ATTENTION_REASONS: readonly WaitingReason[] = ['plan_questions', 'plan_approval', 'agent_asking', 'stopped', 'failed', 'interrupted'];

/**
 * Whether a task worker waits on someone; undefined for any other worker, and whenever the task says
 * nothing (upstream's rule then). A task waiting on you (the plan's questions or approval, a failed
 * phase) keeps waiting until it's handled, not just until you looked. In progress, the engine hands the
 * task between steps by itself (plan to implement, implement to review, ...), so a worker that ends a
 * turn while its run is under way (running, queued, stopping), or sits at its plan's exit prompt, isn't
 * waiting on anyone; any other prompt is (a permission the engine may not have turned into a wait yet).
 * In review, an implementer's finished turn waits until seen and a reviewer's never does. It only ever
 * narrows upstream's statuses, so a waiting worker is still needs_input or done.
 */
export function taskWaiting(w: Pick<WorkerInfo, 'kanban' | 'status' | 'acked'>): boolean | undefined {
  const k = w.kanban;
  if (!k?.status || (w.status !== 'done' && w.status !== 'needs_input')) return undefined;
  if (k.status === 'in_progress') {
    // The run's own worker is handed on by the engine: its finished turn, and in a plan its exit prompt
    // (ExitPlanMode, which the engine answers). Any other prompt, or another worker asking (say the
    // implementer, typed into during a review), waits on someone.
    const own = !!k.runState && k.runState !== 'idle' && k.role === runRole(k.phase);
    return w.status === 'needs_input' && !(own && k.phase === 'plan');
  }
  if (k.status === 'waiting') return !!k.waitingReason && ATTENTION_REASONS.includes(k.waitingReason);
  if (k.status === 'review') return w.status === 'needs_input' || (k.role !== 'reviewer' && !w.acked);
  return undefined;
}

/** Who works in a run of `phase`: the reviewer in a review, the implementer in everything else. */
function runRole(phase: RunPhase | undefined): KanbanRole {
  return phase === 'review' || phase === 'pr-review' ? 'reviewer' : 'implementer';
}

/** A needs-input worker the engine carries on with by itself (e.g. a plan's approval prompt): shown as working. */
export function engineCarriesOn(w: Pick<WorkerInfo, 'kanban' | 'status' | 'acked'>): boolean {
  return w.status === 'needs_input' && taskWaiting(w) === false;
}
