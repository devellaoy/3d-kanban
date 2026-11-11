// What Find PRs tells you (the wording as pure functions, prbuttons.ts shows it): kanban.prFound
// -> toasts. Kept free of the DOM so a test can read it.

import type { PrRef } from '../../shared/kanban/types.js';
import { PR_LINK_MAX } from '../../shared/kanban/prmsgs.js';

export { PR_LINK_MAX };

/** Whether one more PR may be ticked when `picked` are: one go links at most PR_LINK_MAX. */
export const canPickMore = (picked: number): boolean => picked < PR_LINK_MAX;

/** What the window says of its ticks ("1 of 2 selected"), and the most one go takes when there are more candidates than that. */
export const pickedText = (picked: number, candidates: number): string => `${picked} of ${candidates} selected${candidates > PR_LINK_MAX ? ` · ${PR_LINK_MAX} at most in one go` : ''}`;

export interface FoundToast {
  text: string;
  kind?: 'warn';
}

export const prName = (p: PrRef): string => `${p.repo}#${p.number}`;

/** "Linked a/b#1, a/b#2": a long list is cut short. */
export function linkedText(prs: readonly PrRef[], max = 4): string {
  const shown = prs.slice(0, max).map(prName).join(', ');
  return `Linked ${shown}${prs.length > max ? ` and ${prs.length - max} more` : ''}`;
}

/** "#12 Fix the login": the task a window or toast speaks of. */
export const taskLabel = (t: { id: number; title: string }): string => `#${t.id} ${t.title}`;

/** The one toast for candidates when the task view is gone: no window can ask, so it says where to look. */
export const goneToast = (taskId: number, candidates: number): string => `Task #${taskId}: ${candidates} pull request${candidates === 1 ? '' : 's'} may be its. Open its Pull requests tab and use Find PRs again.`;

/**
 * The toasts for an answer; when there are candidates, the window that asks about them says the rest.
 * `taskId`: set when the task isn't the one shown any more, so each text names it.
 */
export function foundToasts(found: { linked: readonly PrRef[]; candidates: readonly unknown[]; skipped: readonly { repo: string; number: number; reason: string }[]; notes: readonly string[] }, taskId?: number): FoundToast[] {
  const out: FoundToast[] = [];
  if (found.linked.length) out.push({ text: linkedText(found.linked) });
  else if (!found.candidates.length) out.push({ text: taskId === undefined ? 'No pull requests found for this task' : 'No pull requests found' });
  if (found.skipped.length) out.push({ text: `Skipped ${found.skipped.slice(0, 3).map((s) => `${prName(s)} (${s.reason})`).join(', ')}${found.skipped.length > 3 ? ` and ${found.skipped.length - 3} more` : ''}`, kind: 'warn' });
  // One toast per note: a note names its repository and what is missing, and is long.
  for (const n of found.notes.slice(0, 3)) out.push({ text: n, kind: 'warn' });
  if (found.notes.length > 3) out.push({ text: `and ${found.notes.length - 3} more`, kind: 'warn' });
  return taskId === undefined ? out : out.map((t) => ({ ...t, text: `Task #${taskId}: ${t.text}` }));
}
