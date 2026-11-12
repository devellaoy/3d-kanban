// Before/after images of a UI change, kept for a task (docs/kanban-architecture.md). An implementer saves
// them in the task's `ui` folder under names this file defines; the Images tab, the reviewer's prompt
// and the pull request's description read them back. Pure, shared by the server and the browser.

/** The folder of a task's grant folder that holds its images. */
export const UI_IMAGES_DIR = 'ui';
/** The biggest image the office lists, serves or attaches. */
export const UI_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** The most images of one task the office lists. */
export const UI_IMAGES_MAX = 40;

/** `<subject>-before.png` or `<subject>-after.jpg` (png, jpg, jpeg or webp): lower-case, no folders. */
export const UI_IMAGE_RE = /^[a-z0-9][a-z0-9._-]{0,80}-(before|after)\.(png|jpe?g|webp)$/;

/**
 * The name of a repository's folder under `ui/` (`ui/<repoId>/…`): wide enough for a repository id (20) and the
 * primary repository's floor id (40, may start with a dash); a dot-folder is never one (the office's staging folder).
 */
export const UI_IMAGE_FOLDER_RE = /^[a-z0-9-]{1,40}$/;

export type UiImageKind = 'before' | 'after';

/** One image of a task (GET /api/kanban/tasks/<id>/images). */
export interface KanbanTaskImage {
  /** The path under `ui/`, unique within the task: `login-after.png`, or `web/login-after.png` in a repository's folder. */
  name: string;
  /** The folder the image is in (a repository's id, see UI_IMAGE_FOLDER_RE); absent for an image straight in `ui/`. */
  repo?: string;
  kind: UiImageKind;
  /** What the pair shows: the name without its `-before`/`-after` and extension. */
  subject: string;
  size: number;
  /** Modified time, ms since the epoch. */
  mtime: number;
}

/** GET /api/kanban/tasks/<id>/images. */
export interface KanbanTaskImageList {
  taskId: number;
  images: KanbanTaskImage[];
}

/** A name under `ui/` split into its folder (undefined for a plain name) and file name: `web/a-after.png` → web, a-after.png. */
export function splitUiImageName(name: string): { folder?: string; file: string } {
  const i = name.indexOf('/');
  return i < 0 ? { file: name } : { folder: name.slice(0, i), file: name.slice(i + 1) };
}

/** A plain file name (no folder) that fits the pattern. */
export const isUiImageName = (name: string): boolean => UI_IMAGE_RE.test(name);

/** A name under `ui/` that fits: a file name, with at most one repository folder before it. */
export function isUiImagePath(name: string): boolean {
  const { folder, file } = splitUiImageName(name);
  return UI_IMAGE_RE.test(file) && (folder === undefined || UI_IMAGE_FOLDER_RE.test(folder));
}

/** Before or after, by the name or path (undefined when it isn't an image name). */
export function uiImageKind(name: string): UiImageKind | undefined {
  return UI_IMAGE_RE.exec(splitUiImageName(name).file)?.[1] as UiImageKind | undefined;
}

/** What the name shows: `login-before.png` and `web/login-before.png` are `login`. */
export function uiImageSubject(name: string): string | undefined {
  const { file } = splitUiImageName(name);
  return UI_IMAGE_RE.test(file) ? file.replace(/-(before|after)\.[a-z]+$/, '') : undefined;
}

/** The MIME type an image is served as, by its extension. */
export function uiImageType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

/** A subject's images in one folder (`repo`; none for `ui/` itself): either side may be missing. */
export interface UiImagePair {
  subject: string;
  repo?: string;
  before?: KanbanTaskImage;
  after?: KanbanTaskImage;
}

/**
 * The images paired by folder and subject: the images straight in `ui/` first, then each repository's folder
 * alphabetically, the subjects alphabetical within each. The same subject in two folders is two pairs.
 */
export function pairImages(images: readonly KanbanTaskImage[]): UiImagePair[] {
  const by = new Map<string, UiImagePair>();
  for (const img of images) {
    const repo = img.repo ?? splitUiImageName(img.name).folder;
    const key = `${repo ?? ''}/${img.subject}`;
    const pair = by.get(key) ?? { subject: img.subject, ...(repo ? { repo } : {}) };
    pair[img.kind] = img;
    by.set(key, pair);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...by.values()].sort((a, b) => cmp(a.repo ?? '', b.repo ?? '') || cmp(a.subject, b.subject));
}
