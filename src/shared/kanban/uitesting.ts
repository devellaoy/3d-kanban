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

export type UiImageKind = 'before' | 'after';

/** One image of a task (GET /api/kanban/tasks/<id>/images). */
export interface KanbanTaskImage {
  /** The file name, unique within the task. */
  name: string;
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

export const isUiImageName = (name: string): boolean => UI_IMAGE_RE.test(name);

/** Before or after, by the name (undefined when it isn't an image name). */
export function uiImageKind(name: string): UiImageKind | undefined {
  return UI_IMAGE_RE.exec(name)?.[1] as UiImageKind | undefined;
}

/** What the name shows: `login-before.png` is `login`. */
export function uiImageSubject(name: string): string | undefined {
  return UI_IMAGE_RE.test(name) ? name.replace(/-(before|after)\.[a-z]+$/, '') : undefined;
}

/** The MIME type an image is served as, by its extension. */
export function uiImageType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

/** A subject's images: either side may be missing. */
export interface UiImagePair {
  subject: string;
  before?: KanbanTaskImage;
  after?: KanbanTaskImage;
}

/** The images paired by subject, in alphabetical order of the subjects. */
export function pairImages(images: readonly KanbanTaskImage[]): UiImagePair[] {
  const by = new Map<string, UiImagePair>();
  for (const img of images) {
    const pair = by.get(img.subject) ?? { subject: img.subject };
    pair[img.kind] = img;
    by.set(img.subject, pair);
  }
  return [...by.values()].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}
