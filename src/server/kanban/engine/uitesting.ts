// A task's UI images on disk (<filesDir>/grants/task-<id>/ui/) and which UI testing block of the prompts
// a run gets. The folder is inside the task's grant folder, so every run already has it as an --add-dir.
// The names and limits are in shared/kanban/uitesting.ts.

import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { KanbanPromptId } from '../../../shared/kanban/prompts.js';
import { UI_IMAGES_DIR, UI_IMAGES_MAX, UI_IMAGE_MAX_BYTES, UI_IMAGE_RE, pairImages, uiImageKind, uiImageSubject, type KanbanTaskImage } from '../../../shared/kanban/uitesting.js';
import { grantDir } from '../uploads.js';

/** An image of a task with the file it is in. */
export type UiImageFile = KanbanTaskImage & { file: string };

/** The folder a task's images are kept in (absolute; not made). */
export function uiImagesDir(filesDir: string, taskId: number): string {
  return path.join(grantDir(filesDir, taskId), UI_IMAGES_DIR);
}

/** Makes the images folder (mode 700) so the agent does not have to. */
export function ensureUiImagesDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(dir), 0o700);
  chmodSync(dir, 0o700);
}

/**
 * A task's images: regular files only (no links), whose names fit the pattern, up to the size limit and
 * at most UI_IMAGES_MAX of them. In order of subject, the before before the after.
 */
export function listUiImages(dir: string): UiImageFile[] {
  let names: string[];
  try {
    // The folder itself must be a real folder: a link could point anywhere.
    if (!lstatSync(dir).isDirectory()) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: UiImageFile[] = [];
  for (const name of names) {
    if (!UI_IMAGE_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > UI_IMAGE_MAX_BYTES) continue;
      out.push({ name, kind: uiImageKind(name)!, subject: uiImageSubject(name)!, size: st.size, mtime: Math.round(st.mtimeMs), file });
    } catch {
      // gone meanwhile
    }
  }
  const byFile = new Map(out.map((i) => [i.name, i]));
  const ordered = pairImages(out).flatMap((p) => [p.before, p.after]).filter((i): i is KanbanTaskImage => !!i);
  return ordered.slice(0, UI_IMAGES_MAX).map((i) => byFile.get(i.name)!);
}

/** The images as the review prompt lists them: a line per subject, with the absolute paths. */
export function imageListText(dir: string, images: readonly KanbanTaskImage[]): string {
  if (!images.length) return 'none yet';
  return pairImages(images)
    .map((p) => `- ${p.subject}: ${[p.before && `before ${path.join(dir, p.before.name)}`, p.after && `after ${path.join(dir, p.after.name)}`].filter(Boolean).join(', ')}`)
    .join('\n');
}

/** Which prompt a run's UI testing block is: the kinds of run that carry one. */
export type UiBlockKind = 'implement' | 'review' | 'fix' | 'comment';

/**
 * The block prompt for a run, or undefined when it has none. `on`: the task's UI testing choice; `images`:
 * whether it has any images. The implementer gets the full instruction with the choice on and the
 * on-request one off; a reviewer and a fix round get theirs when there is a reason (the choice or images);
 * a comment or pull request fix, without one, the on-request one, so "do UI testing" in a comment is heard.
 */
export function uiBlockId(kind: UiBlockKind, on: boolean, images: boolean): KanbanPromptId | undefined {
  const active = on || images;
  switch (kind) {
    case 'implement':
      return on ? 'kanban.uiTesting' : 'kanban.uiTesting.onRequest';
    case 'review':
      return active ? 'kanban.uiTesting.review' : undefined;
    case 'fix':
      return active ? 'kanban.uiTesting.fix' : undefined;
    case 'comment':
      return active ? 'kanban.uiTesting.fix' : 'kanban.uiTesting.onRequest';
  }
}
