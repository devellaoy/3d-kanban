// The kanban's integrations: issue sources, task references and the compatibility API, skills,
// pull requests across a project's repositories. installKanban (../index.ts) registers these.

import type { KanbanContext, KanbanPluginFactory, KanbanPullsApi, KanbanRefsApi } from '../registry.js';
import { createIssues } from './issues/index.js';
import { createPullsParts } from './pulls/index.js';
import { createRefs as createRefsApi, createRefsPlugin } from './refs/index.js';
import { createSkills } from './skills/index.js';

/** Every integration plugin, in the order they are consulted. */
export const integrationPlugins: KanbanPluginFactory[] = [
  (ctx) => createIssues(ctx).plugin,
  (ctx) => createPullsParts(ctx).plugin,
  (ctx) => createRefsPlugin(ctx),
  (ctx) => createSkills(ctx).plugin,
];

export function createPulls(ctx: KanbanContext): KanbanPullsApi {
  return createPullsParts(ctx).api;
}

export function createRefs(ctx: KanbanContext): KanbanRefsApi {
  return createRefsApi(ctx);
}

/** For the engine: the {{skills}} line of a task's phase prompt (see skills/index.ts). */
export { skillHint } from './skills/index.js';
