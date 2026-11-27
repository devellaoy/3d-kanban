// A task's UI images on disk (<filesDir>/grants/task-<id>/ui/) and which UI testing block of the prompts
// a run gets. The folder is inside the task's grant folder, so every run already has it as an --add-dir.
// The names and limits are in shared/kanban/uitesting.ts.

import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { KanbanPromptId } from '../../../shared/kanban/prompts.js';
import { UI_IMAGES_DIR, UI_IMAGES_MAX, UI_IMAGE_MAX_BYTES, UI_IMAGE_FOLDER_RE, UI_IMAGE_RE, pairImages, uiImageKind, uiImageSubject, type KanbanTaskImage } from '../../../shared/kanban/uitesting.js';
import { grantDir } from '../uploads.js';
import { createHash } from 'node:crypto';
import type { KanbanRepository } from '../db/repository.js';
import { dropUiTestReport, readUiTestReport, storeUiTestReport, uiTestReportPath } from '../taskfiles.js';

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
 * images folder and in every folder directly inside it whose name fits UI_IMAGE_FOLDER_RE (real folders only;
 * the images folder itself must be a real folder too, or nothing in it is read), at most UI_IMAGES_MAX of them.
 * `folders` names the project's repositories: the cap keeps their images first, then the ones straight in the
 * folder, then those of any other folder (a repository since removed or renamed, a scratch folder), so neither
 * can push out the pictures assigned to a repository. In display order: the images straight in the folder,
 * then each folder's, by subject, the before before the after.
 */
export function listUiImages(dir: string, folders: readonly string[] = []): UiImageFile[] {
  let entries: string[];
  try {
    // Checked before any folder inside it is read: through a linked images folder they would be someone else's.
    if (!lstatSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names = entries.filter((f) => UI_IMAGE_FOLDER_RE.test(f)).sort();
  const known = names.filter((f) => folders.includes(f)).flatMap((f) => readFolder(dir, f));
  const other = names.filter((f) => !folders.includes(f)).flatMap((f) => readFolder(dir, f));
  const root = readFolder(dir);
  const order = (images: UiImageFile[]) => pairImages(images).flatMap((p) => [p.before, p.after]).filter((i): i is KanbanTaskImage => !!i);
  const kept = new Set([...order(known), ...order(root), ...order(other)].slice(0, UI_IMAGES_MAX).map((i) => i.name));
  const all = [...known, ...other, ...root].filter((i) => kept.has(i.name));
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

/** The task event that says what the office kept of a UI test's report (see keepUiTestReport); one without a text marks a new UI test. */
export const UI_REPORT_EVENT = 'pr.uitest.report';
/** The most of a report an event keeps, for a prompt to carry when no file of it can be named. */
export const UI_REPORT_TEXT_MAX = 30_000;

const reportHash = (text: string) => createHash('sha256').update(text.trim()).digest('hex');
type ReportRepo = Pick<KanbanRepository, 'appendEvent' | 'listEvents'>;
type ReportEvent = { sha?: unknown; name?: unknown; text?: unknown; length?: unknown; stale?: unknown };
const lastReportEvent = (repo: ReportRepo, taskId: number) => [...repo.listEvents(taskId)].reverse().find((e) => e.kind === UI_REPORT_EVENT)?.data as ReportEvent | undefined;

/**
 * A new UI test starts: what an earlier one left is not its report. Its files are removed (dropUiTestReport); when the file at the
 * report's path could not be, its hash is kept, so that file is not taken for the new test's report (ownUiTestReport).
 */
export function resetUiTestReport(repo: ReportRepo, filesDir: string, taskId: number): void {
  const left = dropUiTestReport(filesDir, taskId) ? undefined : readUiTestReport(filesDir, taskId);
  repo.appendEvent(taskId, UI_REPORT_EVENT, left === undefined ? {} : { stale: reportHash(left) });
}

/** What the tester of the UI test that just ended wrote in the report file: never the file an earlier test left there (resetUiTestReport). */
export function ownUiTestReport(repo: ReportRepo, filesDir: string, taskId: number): string | undefined {
  const own = readUiTestReport(filesDir, taskId);
  return own !== undefined && lastReportEvent(repo, taskId)?.stale === reportHash(own) ? undefined : own;
}

/**
 * Keeps a UI test's report: whole in a file (storeUiTestReport: the report's own, or one beside it when that path cannot be written),
 * and in a task event that holds that file's name and the hash of what it was given, or neither when no file could be written, with
 * the text's first UI_REPORT_TEXT_MAX characters and its whole length as the last fallback.
 */
export function keepUiTestReport(repo: ReportRepo, filesDir: string, taskId: number, report: string): void {
  const text = report.trim();
  const file = storeUiTestReport(filesDir, taskId, text || undefined);
  repo.appendEvent(taskId, UI_REPORT_EVENT, text ? { ...(file ? { sha: reportHash(text), name: path.basename(file) } : {}), text: text.slice(0, UI_REPORT_TEXT_MAX), length: text.length } : {});
}

/**
 * What a prompt may say of the task's UI test report: its file, only when it is the very text the office stored there (a regular
 * file within the limit whose hash is the one kept: a file the store could not replace or remove, or one changed since, is never
 * named); else the kept text, with `cut` (the report's whole length) when that is only its beginning; nothing when the last UI
 * test left no report.
 */
export function uiTestReportFor(repo: ReportRepo, filesDir: string, taskId: number): { file?: string; text?: string; cut?: number } {
  const last = lastReportEvent(repo, taskId);
  if (!last || typeof last.text !== 'string' || !last.text) return {};
  const name = typeof last.name === 'string' ? last.name : undefined;
  const read = typeof last.sha === 'string' ? readUiTestReport(filesDir, taskId, {}, name === path.basename(uiTestReportPath(filesDir, taskId)) ? undefined : name) : undefined;
  if (read !== undefined && reportHash(read) === last.sha) return { file: name ? path.join(path.dirname(uiTestReportPath(filesDir, taskId)), name) : uiTestReportPath(filesDir, taskId) };
  return { text: last.text, ...(typeof last.length === 'number' && last.length > last.text.length ? { cut: last.length } : {}) };
}

/** The line of a review's prompt about the tester's report (see uiTestReportFor); undefined when there is none. */
export function uiTestReportLine(repo: ReportRepo, filesDir: string, taskId: number): string | undefined {
  const kept = uiTestReportFor(repo, filesDir, taskId);
  if (kept.file) return `The tester's report is in ${kept.file}.`;
  if (!kept.text) return undefined;
  const cut = kept.cut ? `\n[The report is cut here: this is its first ${kept.text.length} of ${kept.cut} characters. The rest, which may hold findings, could not be given to you: say in your review that the UI test's report was read only in part.]` : '';
  return `The tester's report could not be kept as a file. It is:\n${kept.text}${cut}`;
}
