// The folders a task's agent is let into besides its workspace: `addDirs` (it may write there, or read what is copied in for it)
// and `readDirs` (it only reads: the project's instructions files, see instructions.ts).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FloorDef } from '../../building.js';
import type { KanbanTask } from '../../../shared/kanban/types.js';
import type { KanbanContext } from '../registry.js';
import { instructionsDir } from '../instructions.js';
import { grantDir, grantFiles } from '../uploads.js';
import { reportDir, taskRepos } from './compose.js';

/** The project's instructions folder, made if it isn't there yet (best effort). */
export function instructionReadDirs(ctx: Pick<KanbanContext, 'filesDir'>, project: string): string[] {
  const dir = instructionsDir(ctx.filesDir, project);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // the launch flag names it anyway
  }
  return [dir];
}

export function launchDirs(
  ctx: KanbanContext,
  def: FloorDef,
  task: KanbanTask,
  o: { refsFile?: string; investigate: boolean; folder: boolean },
): { addDirs: string[]; readDirs: string[] } {
  const addDirs: string[] = [];
  if (o.refsFile) addDirs.push(path.dirname(o.refsFile));
  // Always: a file sent later in an answer typed into the live session must be readable without a prompt.
  // The task's own folder of copies, never the uploads of every task.
  try {
    grantFiles(ctx.filesDir, task.id, ctx.repo.listAttachments(task.id));
    addDirs.push(grantDir(ctx.filesDir, task.id));
  } catch (err) {
    console.error(`agent-office: couldn't make task #${task.id}'s folder of attached files: ${(err as Error).message}`);
  }
  if (o.investigate) addDirs.push(reportDir(ctx, task.id));
  for (const r of taskRepos(def, task)) if (!r.primary && (r.kind === 'folder' || o.folder)) addDirs.push(r.dir);
  return { addDirs, readDirs: instructionReadDirs(ctx, task.project) };
}

/** A PR review: the task's folder of copies only when the reviewer was given text (as before), the instructions folder always. */
export function prReviewDirs(ctx: KanbanContext, task: KanbanTask, withFiles: boolean): { addDirs?: string[]; readDirs: string[] } {
  const readDirs = instructionReadDirs(ctx, task.project);
  if (!withFiles) return { readDirs };
  grantFiles(ctx.filesDir, task.id, ctx.repo.listAttachments(task.id));
  return { addDirs: [grantDir(ctx.filesDir, task.id)], readDirs };
}
