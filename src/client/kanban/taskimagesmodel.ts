// What the page works out about UI testing and a task's images without the DOM: whether a task tests
// its UI (its own choice, else the project's, else the office's), where an image is read from, and
// when a fetched list is another one than the list on the page, and which repository's pull request a
// pair goes to (taskimages.ts draws them).

import type { KanbanSettings, ProjectRepo, TaskOverrides } from '../../shared/kanban/types.js';
import type { KanbanTaskImage, UiImageKind, UiImagePair } from '../../shared/kanban/uitesting.js';
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
  return `${imagesUrl(taskId)}/${img.name.split('/').map(encodeURIComponent).join('/')}${bust ? `?v=${Math.round(img.mtime)}` : ''}`;
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

/** The pairs of one folder of a task's images, under the heading the tab gives them. */
export interface ImageGroup {
  /** The folder (a repository's id); absent for the images straight in `ui/`. */
  repo?: string;
  /** The heading: the repository's name, else the folder's; '' when the tab needs none (no folders at all). */
  title: string;
  /** Which pull request these go to, beside the heading. */
  hint: string;
  pairs: UiImagePair[];
}

/**
 * The pairs in their groups, in the order pairImages gave them: the images straight in `ui/` first, then a
 * group per folder under its repository's name. A task with no folders is one group without a heading, the
 * tab as it always was; beside folders, the images in `ui/` get a heading too, so it shows where they go.
 */
export function groupImagePairs(pairs: readonly UiImagePair[], repos: readonly Pick<ProjectRepo, 'id' | 'name'>[]): ImageGroup[] {
  const folders = pairs.some((p) => p.repo);
  const groups: ImageGroup[] = [];
  for (const pair of pairs) {
    let g = groups[groups.length - 1];
    if (!g || g.repo !== pair.repo) {
      const known = repos.find((r) => r.id === pair.repo);
      g = !pair.repo
        ? { title: folders ? 'All repositories' : '', hint: folders ? 'in every pull request of the task' : '', pairs: [] }
        : known
          ? { repo: pair.repo, title: known.name, hint: 'for this repository’s pull request, or the primary’s when it has none', pairs: [] }
          : { repo: pair.repo, title: pair.repo, hint: 'not a repository of the project: in every pull request of the task', pairs: [] };
      groups.push(g);
    }
    g.pairs.push(pair);
  }
  return groups;
}

/** A pair's name for assistive technology, unique in the tab: its subject, and its group when it has a heading. */
export function pairLabel(pair: UiImagePair, group: Pick<ImageGroup, 'title'>): string {
  return group.title ? `${pair.subject} (${group.title})` : pair.subject;
}
