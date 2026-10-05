// Repositories on Azure DevOps and Bitbucket in the kanban: office-pr's routes for the workers
// (officepr.ts) and the tasks' Azure Boards work items kept with their pull requests (workitems.ts).
// The providers themselves are src/server/hosting/.

import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import { floorPullsListeners, type PulledFloor } from '../pulls/board.js';
import { hostCredentials, hostFetch } from '../../../hosting/index.js';
import { officePrHook, type OfficePrDeps } from './officepr.js';
import { checkWorkItems, workItemMarks, type WorkItemDeps } from './workitems.js';

export interface HostingOptions {
  officePr?: OfficePrDeps;
  workItems?: Partial<WorkItemDeps>;
}

export function createHostingPlugin(ctx: KanbanContext, opts: HostingOptions = {}): KanbanPlugin {
  const marks = workItemMarks();
  const deps: WorkItemDeps = { creds: hostCredentials, fetch: hostFetch, ...opts.workItems };
  const onBoard = (floor: PulledFloor) =>
    void checkWorkItems(ctx, floor.id, floor.pullsState().items, marks, deps).catch((err) => console.error('agent-office: keeping work items with their pull requests failed:', err));
  return {
    name: 'hosting',
    hook: { '/office/pr': officePrHook(ctx, opts.officePr) },
    start() {
      floorPullsListeners.add(onBoard);
    },
    stop() {
      floorPullsListeners.delete(onBoard);
      marks.done.clear();
      marks.failed.clear();
    },
  };
}
