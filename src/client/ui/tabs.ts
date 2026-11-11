// The tab strip every window shares: underlined tabs (styles/kit-modal.css), with the keyboard a tablist
// should have. No three.js, core/ or features/ here: the kanban page and the 2D view use it too.

import { h } from './dom';

export interface TabDef<T extends string> {
  id: T;
  /** Its words, or a node (an icon and words, a count from tabCount()). */
  label: string | Node | readonly (string | Node | null | undefined | false)[];
  /** A tooltip. */
  title?: string;
}

export interface TabStrip<T extends string> {
  el: HTMLElement;
  /** Shows `id` as the picked tab, without calling `onPick`. */
  set(id: T): void;
  buttons: Map<T, HTMLButtonElement>;
}

/**
 * A tab strip: arrow keys, Home and End move between tabs (roving tabindex), as a tablist should.
 * `onPick` shows the picked tab's panel. Each tab's id is `<idPrefix>-<id>` (for a panel's
 * aria-labelledby) and its `data-focus` is `tab-<id>`, which doesn't depend on its label, so a view that
 * redraws can put the focus back. Two strips on the page at once need different prefixes.
 */
export function tabStrip<T extends string>(tabs: readonly TabDef<T>[], current: T, onPick: (id: T) => void, label: string, idPrefix = 'kbtab'): TabStrip<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div.tabs', { role: 'tablist', 'aria-label': label });
  const set = (id: T) => {
    for (const [k, b] of buttons) {
      b.setAttribute('aria-selected', String(k === id));
      b.tabIndex = k === id ? 0 : -1;
      b.classList.toggle('on', k === id);
    }
  };
  const ids = tabs.map((x) => x.id);
  for (const tab of tabs) {
    const b = h('button.tab', { type: 'button', role: 'tab', id: `${idPrefix}-${tab.id}`, 'data-focus': `tab-${tab.id}`, title: tab.title }) as HTMLButtonElement;
    if (Array.isArray(tab.label)) b.append(...(tab.label as readonly (string | Node | null | undefined | false)[]).filter((c): c is string | Node => c !== null && c !== undefined && c !== false));
    else b.append(tab.label as string | Node);
    b.addEventListener('click', () => {
      set(tab.id);
      onPick(tab.id);
    });
    b.addEventListener('keydown', (e) => {
      const i = ids.indexOf(tab.id);
      const to = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
      if (to === null || to === undefined) return;
      e.preventDefault();
      set(to);
      onPick(to);
      buttons.get(to)?.focus();
    });
    buttons.set(tab.id, b);
    el.append(b);
  }
  set(current);
  return { el, set, buttons };
}

/** A tab's count badge; with `attention`, in the "needs you" colours (a plan that waits for approval). Null for nothing to count. */
export function tabCount(n: number | undefined | null, attention = false): HTMLElement | null {
  return n ? h('span.tab-n', { class: attention ? 'attention' : '' }, String(n)) : null;
}
