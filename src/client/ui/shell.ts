// The window shell every modal shares (styles/kit-modal.css): a header (simple: an icon and the title on
// one row; rich: a row of id, status and tools, then the title on a line of its own), a body with an
// optional details rail, and a footer with a left and a right group (the one primary button last on the
// right). openShell() opens it through openModal, so the modal stack, Esc, the way back to mouse-look and
// what teammates see you doing work as for every other window.
//
// No three.js, core/ or features/ here: the kanban page and the 2D view use it too.

import { h, openModal, type Modal } from './dom';
import { icon, type IconName } from './icons';

type Child = Node | string | null | undefined | false;

export interface ShellHeadOptions {
  /** `simple` (the default): one row. `rich`: the id row, then the title on its own line. */
  kind?: 'simple' | 'rich';
  /** Simple header: the icon before the title. */
  icon?: IconName;
  title: string;
  /** An id or a context in mono: "#144", "3d-kanban #143". After the title when simple, first on the row when rich. */
  id?: Child;
  /** Rich header: the status pill after the id. */
  pill?: Child;
  /** Rich header: what else stands on the id row (a phase badge, a review state). */
  meta?: readonly Child[];
  /** The quiet tools on the right, before the ✕. */
  tools?: readonly Child[];
  /** Rich header: lines under the title (who wants to merge what). */
  lines?: readonly Child[];
  /** The tab strip (ui/tabs.ts), last in the header. */
  tabs?: HTMLElement | null;
}

export interface ShellOptions extends ShellHeadOptions {
  /** The window's own classes, dot or space separated ("kb-hold w480"). */
  cls?: string;
  role?: 'dialog' | 'alertdialog';
  /** Its accessible name (the title unless given). */
  label?: string;
  body?: Child | readonly Child[];
  /** The details rail right of the body; leave out for a window without one. */
  rail?: Child | readonly Child[];
  footerLeft?: readonly Child[];
  footerRight?: readonly Child[];
}

export interface Shell {
  el: HTMLElement;
  /** The ✕. openShell() wires it; a caller that opens the window itself listens to it. */
  close: HTMLButtonElement;
  head: HTMLElement;
  main: HTMLElement;
  rail: HTMLElement | null;
  foot: HTMLElement | null;
  /** Replaces the footer's two groups; with nothing in either, the footer goes. */
  setFooter(left: readonly Child[], right: readonly Child[]): void;
  setTitle(text: string): void;
}

const kids = (c: Child | readonly Child[] | undefined): Child[] => (Array.isArray(c) ? [...(c as readonly Child[])] : [c as Child]);
const some = (c: readonly Child[] | undefined) => !!c?.some((x) => x !== null && x !== undefined && x !== false);

/**
 * A shell's header. The ✕ is a direct child of the header (simple) or of its first row (rich), which is
 * where openModal looks for a window's own ✕ before adding one (ui/dom.ts addCloseButton).
 */
export function shellHead(o: ShellHeadOptions): { head: HTMLElement; close: HTMLButtonElement; title: HTMLElement } {
  const close = h('button.btn.close.icon-btn', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, icon('x', { size: 18 })) as HTMLButtonElement;
  const title = h('h2', {}, o.title);
  const id = o.id ? h('span.shell-id', {}, o.id) : null;
  const tools = h('div.shell-tools', {}, ...(o.tools ?? []));
  if (o.kind === 'rich') {
    if (some(o.tools)) tools.append(h('span.shell-sep', { 'aria-hidden': 'true' }));
    const row = h('div.shell-row', {}, id, o.pill ?? null, ...(o.meta ?? []), tools, close);
    const lines = (o.lines ?? []).map((l) => (l ? h('div.shell-line', {}, l) : null));
    return { head: h('header.shell-head.rich', { class: o.tabs ? 'has-tabs' : '' }, row, title, ...lines, o.tabs ?? null), close, title };
  }
  return { head: h('header.shell-head.simple', {}, o.icon ? icon(o.icon, { size: 18 }) : null, title, id, tools, close), close, title };
}

/** Builds a window in the shell. Open it with openShell(). */
export function modalShell(o: ShellOptions): Shell {
  const { head, close, title } = shellHead(o);
  const main = h('div.shell-main', {}, ...kids(o.body));
  const rail = o.rail === undefined ? null : h('aside.shell-rail', {}, ...kids(o.rail));
  const cls = (o.cls ?? '').split(/[.\s]+/).filter(Boolean);
  const el = h('div.modal.shell', { class: cls.join(' '), role: o.role ?? 'dialog', 'aria-modal': 'true', 'aria-label': o.label ?? o.title }, head, h('div.shell-body', {}, main, rail));
  const shell: Shell = {
    el,
    close,
    head,
    main,
    rail,
    foot: null,
    setFooter(left, right) {
      if (!some(left) && !some(right)) {
        shell.foot?.remove();
        shell.foot = null;
        return;
      }
      const groups = [h('div.shell-foot-left', {}, ...left), h('div.shell-foot-right', {}, ...right)];
      if (shell.foot) return shell.foot.replaceChildren(...groups);
      shell.foot = h('footer.shell-foot', {}, ...groups);
      el.append(shell.foot);
    },
    setTitle(text) {
      title.textContent = text;
      if (!o.label) el.setAttribute('aria-label', text);
    },
  };
  shell.setFooter(o.footerLeft ?? [], o.footerRight ?? []);
  return shell;
}

/**
 * Opens a shell as a window: openModal's stack, Esc and backdrop, the ✕ wired to close it, and the
 * keyboard put inside it (what asks for it with `autofocus`, else the first field of the body, the
 * picked tab, the first button of the body, the primary button, and last the ✕).
 */
export function openShell(shell: Shell, opts: Parameters<typeof openModal>[1] = {}): Modal {
  const modal = openModal(shell.el, opts);
  shell.close.addEventListener('click', () => modal.close());
  setTimeout(() => {
    const first =
      shell.el.querySelector<HTMLElement>('[autofocus]') ??
      shell.main.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])') ??
      shell.head.querySelector<HTMLElement>('[role=tab][aria-selected=true]') ??
      shell.main.querySelector<HTMLElement>('button:not([disabled]), a[href]') ??
      shell.foot?.querySelector<HTMLElement>('.primary:not([disabled])') ??
      shell.close;
    first.focus();
  }, 30);
  return modal;
}
