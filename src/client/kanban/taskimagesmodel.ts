// What the page works out about UI testing and a task's images without the DOM: whether a task tests
// its UI (its own choice, else the project's, else the office's), where an image is read from, and
// when a fetched list is another one than the list on the page (taskimages.ts draws them).

import type { KanbanSettings, TaskOverrides } from '../../shared/kanban/types.js';
import type { KanbanTaskImage, UiImageKind } from '../../shared/kanban/uitesting.js';
import { apiUrl } from '../multiplayer/visit';
import { KANBAN_DEFAULTS } from './defaults';

/** What new tasks of a project take: the project's choice, else the office's (the page's default before the settings came). */
export function projectUiTesting(settings: Pick<KanbanSettings, 'defaults' | 'projects'> | null | undefined, project: string): boolean {
  return settings?.projects[project]?.uiTesting ?? settings?.defaults.uiTesting ?? KANBAN_DEFAULTS.defaults.uiTesting;
}

/** Whether a task tests its UI: its own choice first (mirrors KanbanSettingsStore.uiTesting on the server). */
export function taskUiTesting(settings: Pick<KanbanSettings, 'defaults' | 'projects'> | null | undefined, project: string, overrides?: Pick<TaskOverrides, 'uiTesting'>): boolean {
  return overrides?.uiTesting ?? projectUiTesting(settings, project);
}

/**
 * What an edit sends for the tick box: nothing when it still says what the task does today (so a task
 * that follows its project keeps following it), else the box's value as the task's own choice.
 */
export function uiTestingPatch(checked: boolean, effective: boolean): boolean | undefined {
  return checked === effective ? undefined : checked;
}

/** The list of a task's images. */
export function imagesUrl(taskId: number): string {
  return apiUrl(`/api/kanban/tasks/${taskId}/images`);
}

/** One image's file; `v` (its modified time) makes a retaken picture of the same name another address. */
export function imageUrl(taskId: number, img: Pick<KanbanTaskImage, 'name' | 'mtime'>, bust = true): string {
  return `${imagesUrl(taskId)}/${encodeURIComponent(img.name)}${bust ? `?v=${Math.round(img.mtime)}` : ''}`;
}

/** The list as one string: two lists that read the same need no redraw (a redraw would fetch every picture again). */
export function imagesKey(images: readonly KanbanTaskImage[]): string {
  return images.map((i) => `${i.name}:${i.size}:${Math.round(i.mtime)}`).join('|');
}

export const KIND_NAMES: Record<UiImageKind, string> = { before: 'Before', after: 'After' };

/** What stands in place of a side that has no picture. */
export function missingText(kind: UiImageKind): string {
  return kind === 'before' ? 'No before image: the view may be new' : 'No after image yet';
}
