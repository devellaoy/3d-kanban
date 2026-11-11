// Small builders for the kit's pieces (styles/kit-*.css): a task's status pill, a run's phase badge, a
// pull request's state, a chip, the banner, the details rail's rows and a button of a kind and a size.
// Views use these rather than writing the classes out, so each piece looks the same everywhere.
//
// No three.js, core/ or features/ here: the kanban page and the 2D view use it too.

import type { KanbanPrLink, RunPhase, TaskStatus } from '../../shared/kanban/types.js';
import { columnName, phaseName } from '../kanban/labels';
import { h } from './dom';
import { icon, type IconName } from './icons';

type Child = Node | string | null | undefined | false;
type Attrs = Parameters<typeof h>[1];

/** The one icon of each task status (the column's, the pill's, the Move dialog's). */
export const STATUS_ICON: Record<TaskStatus, IconName> = {
  todo: 'inbox',
  in_progress: 'loader',
  waiting: 'hand',
  review: 'eye',
  on_hold: 'circle-pause',
  done: 'circle-check',
  archived: 'archive',
};

/** A task's status as a pill: its icon and its column's name. */
export function pill(status: TaskStatus): HTMLElement {
  return h('span.st-pill', { class: status }, icon(STATUS_ICON[status], { size: 13 }), columnName(status));
}

/** What a run is doing ("plan", "review 2"), in its phase's colours. */
export function phaseBadge(phase: RunPhase | string, round?: number): HTMLElement {
  return h('span.kb-phase', { class: phase }, `${phaseName(phase)}${round ? ` ${round}` : ''}`);
}

export type PrTone = 'open' | 'draft' | 'merged' | 'closed';
const PR_ICON: Record<PrTone, IconName> = { open: 'git-pull-request', draft: 'circle-dashed', merged: 'git-merge', closed: 'git-pull-request-closed' };
const PR_NAME: Record<PrTone, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** A pull request's state as a pill, from the host's state ("OPEN") or its tone ("open"). */
export function prPill(state: KanbanPrLink['state'] | PrTone): HTMLElement {
  const tone = state.toLowerCase() as PrTone;
  return h('span.pr-pill', { class: tone }, icon(PR_ICON[tone], { size: 13 }), PR_NAME[tone]);
}

/** A chip; `cls` is its kind ("ticket", "repo", "project", "type", "tag"), and `href` makes it a link. */
export function chip(children: Child | readonly Child[], cls = '', attrs: Attrs = {}): HTMLElement {
  const kids = Array.isArray(children) ? (children as readonly Child[]) : [children as Child];
  return h(attrs.href ? 'a.kb-chip' : 'span.kb-chip', { ...attrs, class: cls }, ...kids);
}

export interface BannerOptions {
  icon: IconName;
  title: string;
  text?: Child;
  /** What to do about it, on the right: a link with `href`, a button with `onClick`. */
  link?: { label: string; href?: string; onClick?: () => void };
  /** `attention` (waits for you, the default), `neutral` (on hold, a note) or `danger` (it failed). */
  tone?: 'attention' | 'neutral' | 'danger';
}

/** What a window says first: an icon, a title and a line under it, and one way on. */
export function banner(o: BannerOptions): HTMLElement {
  const link = !o.link
    ? null
    : o.link.href
      ? h('a.banner-link', { href: o.link.href, onclick: o.link.onClick && (() => o.link!.onClick!()) }, o.link.label, icon('chevron-right', { size: 14 }))
      : h('button.banner-link', { type: 'button', onclick: () => o.link!.onClick?.() }, o.link.label, icon('chevron-right', { size: 14 }));
  return h(
    'div.banner',
    { class: o.tone && o.tone !== 'attention' ? o.tone : '', role: o.tone === 'danger' ? 'alert' : 'status' },
    icon(o.icon, { size: 18 }),
    h('div.banner-main', {}, h('strong.banner-title', {}, o.title), o.text ? h('span.banner-text', {}, o.text) : null),
    link,
  );
}

/** The details rail's rows, as a definition list; a row without a value is left out. `small` for the dates under the separator. */
export function detailsRail(rows: readonly { label: string; value: Child | readonly Child[] }[], small = false): HTMLElement {
  const dl = h('dl.rail-dl', { class: small ? 'small' : '' });
  for (const r of rows) {
    const value = (Array.isArray(r.value) ? (r.value as readonly Child[]) : [r.value as Child]).filter((v) => v !== null && v !== undefined && v !== false && v !== '');
    if (value.length) dl.append(h('dt', {}, r.label), h('dd', {}, ...value));
  }
  return dl;
}

export interface BtnOptions {
  /** `secondary` unless said: one `primary` per window, `quiet` for Cancel and tools, `danger` for the red button, `quiet-danger` for Delete among others. */
  kind?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'quiet-danger';
  icon?: IconName;
  /** `lg` in a window (--field-h, the default), `md` in a bar (--ctl-h), `sm` (--ctl-h-sm), `xs` on a card (--ctl-h-xs). */
  size?: 'lg' | 'md' | 'sm' | 'xs';
  attrs?: Attrs;
}

/** A button of the kit. Give it a stable `data-focus` in `attrs` when its view redraws. */
export function btn(label: string, o: BtnOptions = {}): HTMLButtonElement {
  const size = o.size ?? 'lg';
  return h('button.btn', { type: 'button', ...o.attrs, class: `${o.kind ?? 'secondary'} ${size} ${o.attrs?.class ?? ''}`.trim() }, o.icon ? icon(o.icon, { size: size === 'xs' ? 14 : 16 }) : null, label) as HTMLButtonElement;
}
