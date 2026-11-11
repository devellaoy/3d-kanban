// Small building blocks the kanban's windows share, on upstream's h() / openModal: a dialog frame with
// its ✕ (the shared shell's header), labelled fields, selects, the shared tab strip, and a way to run a
// request from a button.

import { h, openModal, toast, type Modal } from '../ui/dom';
import { shellHead } from '../ui/shell';

// The tab strip is the office's shared one (ui/tabs.ts); the kanban's views import it from here.
export { tabStrip, tabCount } from '../ui/tabs';

type Child = Node | string | null | undefined | false;

/**
 * A dialog's frame: the shell's simple header (ui/shell.ts: the title, `headerExtra` as its tools, the ✕),
 * then the caller's body and optional footer as they are.
 */
export function dialog(cls: string, title: string, body: HTMLElement, footer?: HTMLElement | null, headerExtra: Child[] = []): { el: HTMLElement; close: HTMLButtonElement } {
  const { head, close } = shellHead({ title, tools: headerExtra });
  const el = h(`div.modal.shell.${cls}`, { role: 'dialog', 'aria-label': title, 'aria-modal': 'true' }, head, body, footer ?? null);
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
