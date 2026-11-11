import type { GhComment } from '../../../shared/protocol';
import { AVATAR_COLORS } from '../../state';
import { h, timeAgo } from '../dom';
import { icon, type IconName } from '../icons';
import { btn, type PrTone } from '../kit';
import { markdown } from '../markdown';

// ---- Small pieces ---------------------------------------------------------------------------------

export function avatar(name: string) {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) | 0;
  return h('span.gh-avatar', { style: `background:${AVATAR_COLORS[Math.abs(x) % AVATAR_COLORS.length]}`, 'aria-hidden': 'true' }, (name[0] ?? '?').toUpperCase());
}

export function when(iso: string, url?: string) {
  const title = iso ? new Date(iso).toLocaleString() : '';
  return url ? h('a.when', { href: url, target: '_blank', rel: 'noopener noreferrer', title }, timeAgo(iso)) : h('span.when', { title }, timeAgo(iso));
}

/** A review's state in words, and the tone of its badge (`ok`, `bad`, `muted` or none). */
export const REVIEW_BADGE: Record<string, [string, string]> = {
  APPROVED: ['Approved', 'ok'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
  COMMENTED: ['Reviewed', ''],
  DISMISSED: ['Review dismissed', 'muted'],
  REVIEW_REQUIRED: ['Review required', ''],
};

const BADGE_ICON: Record<string, IconName> = { ok: 'circle-check', bad: 'circle-x' };

/** A review state as an outlined pill (the header of a PR window, a review in its conversation). */
export function reviewBadge(state: string): HTMLElement {
  const [word, tone] = REVIEW_BADGE[state] ?? [state.toLowerCase().replace(/_/g, ' ') || 'reviewed', ''];
  return h('span.gh-badge', { class: tone }, BADGE_ICON[tone] ? icon(BADGE_ICON[tone], { size: 13 }) : null, word);
}

/**
 * One entry of a conversation: the avatar, who wrote it (with `role`: "Author", "Reviewer"), when, an
 * optional review state, and the text under them.
 */
export function commentCard(c: GhComment, itemUrl: string, verb: string, o: { review?: string; role?: 'Author' | 'Reviewer' } = {}) {
  return h(
    'article.gh-comment',
    {},
    avatar(c.author),
    h(
      'div.gh-comment-main',
      {},
      h(
        'div.gh-comment-head',
        {},
        h('strong', {}, c.author),
        o.role ? h('span.role-tag', { class: o.role === 'Reviewer' ? 'reviewer' : '' }, o.role) : null,
        verb ? h('span', {}, verb) : null,
        when(c.createdAt, c.url),
        o.review !== undefined ? reviewBadge(o.review) : null,
      ),
      c.body.trim() || o.review === undefined ? markdown(c.body, itemUrl) : null,
    ),
  );
}

/** Drops the nulls of optional pieces, for replaceChildren. */
export function nodes(...xs: (Node | string | null | undefined | false)[]): (Node | string)[] {
  return xs.filter((x): x is Node | string => x != null && x !== false);
}

export function spinnerRow(text: string) {
  return h('div.gh-loading', {}, h('span.spinner'), text);
}

export function errorBox(text: string, retry?: () => void) {
  return h('div.gh-error', { role: 'alert' }, `Couldn't load from GitHub: ${text}`, retry ? btn('Retry', { icon: 'rotate-cw', size: 'sm', attrs: { onclick: retry } }) : null);
}

/** A pull request's state as the kit's tone (ui/kit.ts prPill). */
export function stateOf(it: { state: string; isDraft?: boolean }): PrTone {
  if (it.state === 'MERGED') return 'merged';
  if (it.state === 'CLOSED') return 'closed';
  return it.isDraft ? 'draft' : 'open';
}

/** An issue's state as a pill: open or closed. */
export function issuePill(open: boolean): HTMLElement {
  return h('span.pr-pill', { class: open ? 'open' : 'merged' }, icon(open ? 'circle-dot' : 'circle-check', { size: 13 }), open ? 'Open' : 'Closed');
}

/** A section's small heading, with an optional count after it. */
export function sectionHead(text: string, count?: number): HTMLElement {
  return h('h3.gh-sec-h', {}, text, count ? h('span.count', {}, String(count)) : null);
}

/** A full-width button of a rail's stack ("Hand it to a worker"): its icon and its words. */
export function railButton(label: string, mark: IconName, onclick: () => void, title?: string): HTMLButtonElement {
  return btn(label, { icon: mark, size: 'md', attrs: { title, onclick } });
}

/** A heading and the stack of buttons under it, for a window's rail. */
export function railStack(heading: string, ...items: (Node | null | undefined | false)[]): HTMLElement {
  return h('section.rail-stack', {}, h('h3.rail-h', {}, heading), ...nodes(...items));
}
