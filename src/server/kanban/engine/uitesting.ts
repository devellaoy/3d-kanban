// A task's UI images on disk (<filesDir>/grants/task-<id>/ui/) and which UI testing block of the prompts
// a run gets. The folder is inside the task's grant folder, so every run already has it as an --add-dir.
// The names and limits are in shared/kanban/uitesting.ts.

import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { KanbanPromptId } from '../../../shared/kanban/prompts.js';
import { UI_IMAGES_DIR, UI_IMAGES_MAX, UI_IMAGE_MAX_BYTES, UI_IMAGE_FOLDER_RE, UI_IMAGE_RE, pairImages, uiImageKind, uiImageSubject, type KanbanTaskImage } from '../../../shared/kanban/uitesting.js';
import { grantDir } from '../uploads.js';

/** An image of a task with the file it is in. */
export type UiImageFile = KanbanTaskImage & { file: string };

/** The folder a task's images are kept in (absolute; not made). */
export function uiImagesDir(filesDir: string, taskId: number): string {
  return path.join(grantDir(filesDir, taskId), UI_IMAGES_DIR);
}

/** Makes the images folder (mode 700), and a folder inside it for each of `folders` (a repository each), so the agent does not have to. */
export function ensureUiImagesDir(dir: string, folders: readonly string[] = []): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(dir), 0o700);
  chmodSync(dir, 0o700);
  for (const f of folders) {
    if (!UI_IMAGE_FOLDER_RE.test(f)) continue;
    mkdirSync(path.join(dir, f), { recursive: true, mode: 0o700 });
    chmodSync(path.join(dir, f), 0o700);
  }
}

/** The images in one real folder (`repo`: its name under the images folder, none for the images folder itself). */
function readFolder(dir: string, repo?: string): UiImageFile[] {
  const here = repo ? path.join(dir, repo) : dir;
  let names: string[];
  try {
    // A folder must be a real one: a link could point anywhere.
    if (!lstatSync(here).isDirectory()) return [];
    names = readdirSync(here);
  } catch {
    return [];
  }
  const out: UiImageFile[] = [];
  for (const file of names) {
    if (!UI_IMAGE_RE.test(file)) continue;
    const full = path.join(here, file);
    try {
      const st = lstatSync(full);
      if (!st.isFile() || st.size > UI_IMAGE_MAX_BYTES) continue;
      const name = repo ? `${repo}/${file}` : file;
      out.push({ name, ...(repo ? { repo } : {}), kind: uiImageKind(file)!, subject: uiImageSubject(file)!, size: st.size, mtime: Math.round(st.mtimeMs), file: full });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/**
 * A task's images: regular files only (no links), whose names fit the pattern, up to the size limit, in the
 * images folder and in the folders directly inside it that are named like a repository (UI_IMAGE_FOLDER_RE;
 * real folders only), at most UI_IMAGES_MAX of them. The cap is cut subfolder images first, so pictures
 * dropped straight in the folder cannot push out the ones assigned to a repository. In display order: the
 * images straight in the folder, then each repository's, by subject, the before before the after.
 */
export function listUiImages(dir: string): UiImageFile[] {
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const sub = entries.filter((f) => UI_IMAGE_FOLDER_RE.test(f)).sort().flatMap((f) => readFolder(dir, f));
  const root = readFolder(dir);
  const order = (images: UiImageFile[]) => pairImages(images).flatMap((p) => [p.before, p.after]).filter((i): i is KanbanTaskImage => !!i);
  const kept = new Set([...order(sub), ...order(root)].slice(0, UI_IMAGES_MAX).map((i) => i.name));
  const all = [...sub, ...root].filter((i) => kept.has(i.name));
  const byName = new Map(all.map((i) => [i.name, i]));
  return order(all).map((i) => byName.get(i.name)!);
}

/** The images as the review prompt lists them: a line per subject (and repository folder), with the absolute paths. */
export function imageListText(dir: string, images: readonly KanbanTaskImage[]): string {
  if (!images.length) return 'none yet';
  return pairImages(images)
    .map((p) => `- ${p.repo ? `${p.subject} (${p.repo})` : p.subject}: ${[p.before && `before ${path.join(dir, p.before.name)}`, p.after && `after ${path.join(dir, p.after.name)}`].filter(Boolean).join(', ')}`)
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
