// What 🔎 Find PRs tells you (the wording as pure functions, prbuttons.ts shows it): kanban.prFound
// -> toasts. Kept free of the DOM so a test can read it.

import type { PrRef } from '../../shared/kanban/types.js';

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

/** The toasts for an answer; when there are candidates, the window that asks about them says the rest. */
export function foundToasts(found: { linked: readonly PrRef[]; candidates: readonly unknown[]; skipped: readonly { repo: string; number: number; reason: string }[]; notes: readonly string[] }): FoundToast[] {
  const out: FoundToast[] = [];
  if (found.linked.length) out.push({ text: linkedText(found.linked) });
  else if (!found.candidates.length) out.push({ text: 'No pull requests found for this task' });
  if (found.skipped.length) out.push({ text: `Skipped ${found.skipped.slice(0, 3).map((s) => `${prName(s)} (${s.reason})`).join(', ')}${found.skipped.length > 3 ? ` and ${found.skipped.length - 3} more` : ''}`, kind: 'warn' });
  if (found.notes.length) out.push({ text: found.notes.slice(0, 3).join(' '), kind: 'warn' });
  return out;
}
