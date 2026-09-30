// The kanban task process (plan → implement → review ⇄ fix → review column, docs/kanban-architecture.md
// §4) on ordinary office workers. machine.ts decides, orchestrator.ts carries it out, adapters/ speak
// each agent CLI, markers.ts reads the agents' answers, compose.ts writes the prompts.

import type { KanbanContext, KanbanEngineApi } from '../registry.js';
import { Orchestrator, type EngineOptions } from './orchestrator.js';

export type { EngineOptions } from './orchestrator.js';
export type { TaskAgentAdapter, TurnResult, LaunchOptions } from './adapters/types.js';

export interface KanbanEngine extends KanbanEngineApi {
  /** Starts following the office's workers (and sweeps retries); called once the context is complete. */
  begin(): void;
  dispose(): void;
  /** A task's card changed (ctx.taskChanged): its workers' WorkerInfo.kanban follows. (Optional for stand-ins in tests.) */
  cardChanged?(taskId: number): void;
}

export function createEngine(ctx: KanbanContext, options: EngineOptions = {}): KanbanEngine {
  const o = new Orchestrator(ctx, options);
  return {
    start: (id, who, opts) => o.start(id, who, opts),
    stop: (id, who) => o.stop(id, who),
    continue: (id, who, answer) => o.continue(id, who, answer),
    retry: (id, who) => o.retry(id, who),
    review: (id, who) => o.review(id, who),
    approvePlan: (id, who) => o.approvePlan(id, who),
    requestPlanChanges: (id, who, text) => o.requestPlanChanges(id, who, text),
    pr: (id, who, mode) => o.pr(id, who, mode),
    compact: (id, who) => o.compact(id, who),
    release: (id, who) => o.release(id, who),
    releaseIdle: (id, who) => o.releaseIdle(id, who),
    commented: (id, commentId, who) => o.commented(id, commentId, who),
    prForWorker: (floorId, workerId, who) => o.prForWorker(floorId, workerId, who),
    reviewPrs: (req, who) => o.reviewPrs(req, who),
    cardChanged: (id) => o.syncSummaries(ctx.repo.getTask(id)),
    begin: () => o.begin(),
    dispose: () => o.dispose(),
  };
}
