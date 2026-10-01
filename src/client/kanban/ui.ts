// Small building blocks the kanban's windows share, on upstream's h() / openModal: a dialog frame with
// its ✕, labelled fields, selects, a tab strip, and a way to run a request from a button.

import { h, openModal, toast, type Modal } from '../ui/dom';

type Child = Node | string | null | undefined | false;

/** A dialog's frame: a header with its title and ✕, a body and an optional footer. */
export function dialog(cls: string, title: string, body: HTMLElement, footer?: HTMLElement | null, headerExtra: Child[] = []): { el: HTMLElement; close: HTMLButtonElement } {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕') as HTMLButtonElement;
  const el = h(`div.modal.${cls}`, { role: 'dialog', 'aria-label': title, 'aria-modal': 'true' }, h('header', {}, h('h2', {}, title), ...headerExtra, close), body, footer ?? null);
  return { el, close };
}

/** Opens a dialog made with dialog(); its ✕ and Esc close it. */
export function showDialog(d: { el: HTMLElement; close: HTMLButtonElement }, opts: Parameters<typeof openModal>[1] = {}): Modal {
  const modal = openModal(d.el, opts);
  d.close.addEventListener('click', () => modal.close());
  // Focus into the dialog, so the keyboard is in it from the start.
  setTimeout(() => (d.el.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]):not([disabled]), select, textarea, button:not(.close)') ?? d.close).focus(), 30);
  return modal;
}

let fieldSeq = 0;
/** A label over an input (or a group of them), with an optional hint under it. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const id = input.id || `kbf-${++fieldSeq}`;
  if (!input.id && /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName)) input.id = id;
  return h('div.kb-field', {}, h('label', { for: /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName) ? id : undefined }, label), input, hint ? h('small.kb-hint', {}, hint) : null);
}

export function textInput(value = '', attrs: Record<string, string | number | boolean | undefined> = {}): HTMLInputElement {
  const el = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs }) as HTMLInputElement;
  el.value = value;
  return el;
}

export function textArea(value = '', attrs: Record<string, string | number | boolean | undefined> = {}): HTMLTextAreaElement {
  const el = h('textarea', { rows: 4, ...attrs }) as HTMLTextAreaElement;
  el.value = value;
  return el;
}

export function numberInput(value: number, min: number, max: number, attrs: Record<string, string | number | boolean | undefined> = {}): HTMLInputElement {
  const el = h('input.kb-num', { type: 'number', min, max, step: 1, inputmode: 'numeric', ...attrs }) as HTMLInputElement;
  el.value = String(value);
  return el;
}

/** The value of a number box, kept within min..max (fallback when it's not a number). */
export function numberValue(el: HTMLInputElement, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(el.value));
  return Number.isFinite(n) && el.value.trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback;
}

export function select<T extends string>(options: readonly (readonly [T, string])[], value: T | '', attrs: Record<string, string | number | boolean | undefined> = {}): HTMLSelectElement {
  const el = h('select', attrs) as HTMLSelectElement;
  for (const [v, label] of options) el.append(h('option', { value: v }, label));
  el.value = value;
  return el;
}

export function checkbox(label: string, checked: boolean, attrs: Record<string, string | number | boolean | undefined> = {}): { el: HTMLElement; box: HTMLInputElement } {
  const box = h('input', { type: 'checkbox', ...attrs }) as HTMLInputElement;
  box.checked = checked;
  return { el: h('label.kb-check', {}, box, h('span', {}, label)), box };
}

/**
 * A tab strip: arrow keys move between tabs (roving tabindex), as a tablist should. `onPick` shows the
 * picked tab's panel; returns a function to change the tab from outside.
 */
export function tabStrip<T extends string>(tabs: readonly { id: T; label: string | Node }[], current: T, onPick: (id: T) => void, label: string): { el: HTMLElement; set(id: T): void; buttons: Map<T, HTMLButtonElement> } {
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div.kb-tabs', { role: 'tablist', 'aria-label': label });
  const set = (id: T) => {
    for (const [k, b] of buttons) {
      b.setAttribute('aria-selected', String(k === id));
      b.tabIndex = k === id ? 0 : -1;
      b.classList.toggle('on', k === id);
    }
  };
  for (const tab of tabs) {
    const b = h('button.kb-tab', { type: 'button', role: 'tab', id: `kbtab-${tab.id}`, 'data-focus': `tab-${tab.id}` }, tab.label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      set(tab.id);
      onPick(tab.id);
    });
    b.addEventListener('keydown', (e) => {
      const ids = tabs.map((x) => x.id);
      const i = ids.indexOf(tab.id);
      const to = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
      if (!to) return;
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

/**
 * Runs a request from a button: the button waits while it's under way, and a refusal from the
 * office shows as a toast. Resolves to the answer, or undefined when it failed.
 */
export async function run<T>(what: () => Promise<T>, button?: HTMLButtonElement | null, done?: string): Promise<T | undefined> {
  if (button?.disabled) return undefined;
  if (button) button.disabled = true;
  try {
    const out = await what();
    if (done) toast(done);
    return out;
  } catch (err) {
    toast((err as Error).message || 'That didn’t work', 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}
