// The {{instructions}} block of the task prompts: the project's instructions as references to their files
// (see ../instructions.ts), or as text for a part whose file could not be written.

import type { KanbanPromptId } from '../../../shared/kanban/prompts.js';
import type { KanbanTask, ProjectRepo } from '../../../shared/kanban/types.js';
import type { KanbanContext } from '../registry.js';
import { projectInstructionTexts, syncInstructionFiles } from '../instructions.js';

type Render = (id: KanbanPromptId, project: string, vars: Record<string, string | number>) => string;

/**
 * The block for a run of `task`: one part for the general and the testing instructions and for each of `repos`
 * (the repositories the run works in) that has any, '' when there are none. Makes sure the files are there first.
 */
export function instructionsBlock(ctx: KanbanContext, text: Render, task: KanbanTask, repos: ProjectRepo[]): string {
  const p = task.project;
  const texts = projectInstructionTexts(ctx, p);
  const files = syncInstructionFiles(ctx.filesDir, p, texts);
  const parts: string[] = [];
  const general = texts.general?.trim();
  if (general) parts.push(files.general ? text('kanban.instructions.general.file', p, { path: files.general }) : text('kanban.instructions.general', p, { text: general }));
  const testing = texts.testing?.trim();
  if (testing) parts.push(files.testing ? text('kanban.instructions.testing.file', p, { path: files.testing }) : text('kanban.instructions.testing', p, { text: testing }));
  for (const r of repos) {
    const own = r.instructions?.trim();
    if (!own) continue;
    // Its own key only: an id like `constructor` would otherwise find Object's and lose the text.
    const file = Object.hasOwn(files.repos, r.id) ? files.repos[r.id] : undefined;
    parts.push(file ? text('kanban.instructions.repo.file', p, { repo: r.name, path: file }) : text('kanban.instructions.repo', p, { repo: r.name, text: own }));
  }
  const filled = parts.filter((x) => x.trim());
  return filled.length ? text('kanban.instructions', p, { parts: filled.join('\n\n') }) : '';
}
