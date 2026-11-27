// The review picker's (prpicker.ts) own reckoning, free of the DOM: the request a choice sends, the
// words on its button and in its toast, the meeting form's preset from the office's brief, and the
// two ticks a browser remembers.

import type { KanbanPrBundleItem, PrRef } from '../../shared/kanban/types.js';
import type { MeetingPreset } from '../ui/meeting';
import { refKey, reviewTaskOf } from './model';

export type PickerMode = 'review' | 'panel';

/** What the picker's two ticks ask of a review. */
export interface ReviewFlags {
  /** Post the finished review on the pull requests. */
  post: boolean;
  /** A worker also tests the UI and saves before and after pictures to the task's Images tab. */
  uiTest: boolean;
}

/** The picked PRs (their refKeys) as refs, in the order picked; keys nothing in `all` answers to are left out. */
export function pickedRefs(keys: Iterable<string>, all: readonly PrRef[]): PrRef[] {
  const prs: PrRef[] = [];
  for (const k of keys) {
    const p = all.find((x) => refKey(x) === k);
    if (p) prs.push({ repo: p.repo, number: p.number });
  }
  return prs;
}

/**
 * The kanban's review of the picked PRs: always a kanban task. One task's PRs go into that task,
 * unless the UI is tested too: such a review is a task of its own.
 */
export function reviewRequest(project: string, keys: Iterable<string>, all: readonly PrRef[], bundle: KanbanPrBundleItem[], flags: ReviewFlags) {
  const picked = [...keys];
  const taskId = flags.uiTest ? undefined : reviewTaskOf(picked, bundle);
  return { t: 'kanban.pr.review' as const, project, prs: pickedRefs(picked, all), ...(taskId ? { taskId } : {}), post: flags.post, uiTest: flags.uiTest };
}

/** Asks the office for the meeting form's preset for a panel on the picked PRs. */
export function briefRequest(project: string, keys: Iterable<string>, all: readonly PrRef[], bundle: KanbanPrBundleItem[]) {
  const picked = [...keys];
  const taskId = reviewTaskOf(picked, bundle);
  return { t: 'kanban.pr.brief' as const, project, prs: pickedRefs(picked, all), ...(taskId ? { taskId } : {}) };
}

/** What the meeting form starts out with for a panel on several PRs, from the office's brief. */
export const briefPreset = (brief: { prompt: string; title: string; pr: number }): MeetingPreset => ({ pattern: 'review', pr: brief.pr, title: brief.title, prompt: brief.prompt });

/** The primary button's words. `onlySelf`: just the PR the picker was opened for is ticked. */
export function goLabel(mode: PickerMode, n: number, onlySelf: boolean): string {
  if (mode === 'panel') return onlySelf || n < 2 ? 'Call the panel for this PR' : `Call the panel for ${n} PRs`;
  return n < 2 ? 'Review this PR' : `Review ${n} PRs together`;
}

/** The primary button's tooltip. */
export function goTitle(mode: PickerMode, n: number): string {
  if (!n) return 'Tick at least one pull request first';
  if (mode === 'panel') return 'A few workers review the ticked pull requests in the meeting room; the meeting form opens next';
  return 'The review is a kanban task, done by the reviewers set in the kanban’s review settings';
}

/** The tick that posts the review, in the number of the PRs ticked. */
export const postLabel = (n: number) => `Post the review on the pull request${n > 1 ? 's' : ''} when it is done`;

export const UI_TEST_LABEL = 'Also test the UI: a worker runs the app and tests the views and functions the pull requests change. What it tested and found goes into the review, its before and after pictures to the task’s Images tab (not to any pull request)';

/** What the toast says once the office took the review. No worker yet: the task waits for room in the office. */
export function reviewToast(n: number, ok: { taskId?: number; workerId?: string }): string {
  const what = n === 1 ? 'the PR' : `the ${n} PRs`;
  if (!ok.taskId) return `The review of ${what} is a kanban task`;
  return ok.workerId ? `The review of ${what} is kanban task #${ok.taskId}` : `The review of ${what} is queued: task #${ok.taskId} starts when the office has room`;
}

/** How long the picker waits for the answer to a review request: the office's own bound on starting it is well under this. */
export const REVIEW_WAIT_MS = 45_000;

/** What the picker says when a review request failed: a request that got no answer may still be starting, so it is not to be sent blindly again. */
export function reviewFailure(message: string): string {
  return /didn.t answer/i.test(message) ? 'The office is slow to answer: the review may still be starting. Look at the board before you try again.' : message;
}

// --- The ticks a browser remembers -----------------------------------------------------------------

export const POST_KEY = 'kanban.prReview.post';
export const UI_TEST_KEY = 'kanban.prReview.uiTest';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // Storage is blocked: the ticks start off.
  }
};

/** A remembered tick; off when nothing was saved or the storage can't be read. */
export function readFlag(key: string, store: Store | undefined = browserStore()): boolean {
  try {
    return store?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Remembers a tick; a storage that can't be written is left alone. */
export function writeFlag(key: string, on: boolean, store: Store | undefined = browserStore()): void {
  try {
    store?.setItem(key, on ? '1' : '0');
  } catch {
    // Not remembered, that's all.
  }
}
