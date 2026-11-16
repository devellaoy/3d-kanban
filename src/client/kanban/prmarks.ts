// A pull request's review marks (shared/kanban/prs.ts: only an open or draft one has any): icons at the
// end of its chip on a task's card, and pills in the Review column of the task view's Pull requests tab.
// Each icon has its own shape and its words as a title, so nothing rests on colour.

import { h } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { reviewBadge } from '../ui/github/pieces';
import '../ui/github/windows.css';
import { prMarks, prMarkWords, type PrReview } from '../../shared/kanban/prs.js';

type Marked = Parameters<typeof prMarks>[0];

/** The card's icon of a review; "review required" has none, so a chip that only waits stays quiet. */
const REVIEW_ICON: Partial<Record<PrReview, IconName>> = { APPROVED: 'circle-check', CHANGES_REQUESTED: 'circle-x' };

/** The marks for a card's PR chip, in the chip's own ink; null when it shows none. */
export function prMarkIcons(p: Marked): HTMLElement | null {
  const m = prMarks(p);
  // The words come review first, unresolved comments last (prMarkWords).
  const words = prMarkWords(p);
  const name = m.review && REVIEW_ICON[m.review];
  const parts = [
    name ? h('span.kb-pr-mark', { title: words[0] }, icon(name, { size: 12 })) : null,
    m.unresolved ? h('span.kb-pr-mark', { title: words.at(-1) }, icon('message-square', { size: 12 }), String(m.unresolved)) : null,
  ].filter((x): x is HTMLElement => !!x);
  // The chip's own label says the marks in words; the icons are for the eye.
  return parts.length ? h('span.kb-pr-marks', { 'aria-hidden': 'true' }, ...parts) : null;
}

/** The marks as pills for the Pull requests tab: the review state, then the unresolved comments. */
export function prMarkPills(p: Marked): HTMLElement[] {
  const m = prMarks(p);
  const out: HTMLElement[] = [];
  if (m.review) out.push(reviewBadge(m.review));
  if (m.unresolved) out.push(h('span.gh-badge', { title: prMarkWords(p).at(-1) }, icon('message-square', { size: 13 }), `${m.unresolved} unresolved`));
  return out;
}
