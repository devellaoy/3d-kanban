// Tabs on a worker's terminal: the terminal itself, plus its shell tabs (shared/shelltabs/protocol.ts),
// each a plain login shell in the worker's folder that runs on the office's machine. They're the
// worker's, not this browser's: everyone who opens the worker's window sees the same ones, they keep
// running when the window closes, and they end with their ×, `exit`, the worker going home or the
// office restarting. A shell tab's terminal is made the first time the tab shows here.
import './termtabs.css';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { Net } from '../net';
import type { ServerMsg, ShellTab } from '../../shared/protocol';
import { h, timeAgo } from './dom';
import { clipboardKey, keyAt, naturalKey } from './termkeys';
import { makeXterm } from './xterm';

export interface TermTabsOptions {
  net: Net;
  /** The terminal's own area and keypad, hidden while a shell tab shows (the keypad is the terminal's). */
  host: HTMLElement;
  keypad: HTMLElement | null;
  /** Back on the terminal's tab. */
  focusTerm(): void;
  /** Closes the worker's window (Ctrl+] in a shell tab, as in the terminal). */
  closeWindow(): void;
  /** Follows the server's messages for this window; hands back the way to stop. */
  listen(fn: (msg: ServerMsg) => void): () => void;
  /** A different tab came to show (the terminal's own or a shell tab). */
  onActiveChange?(): void;
}

export interface TermTabs {
  /** The tab bar (above the terminal) and where the shell tabs show (beside it). */
  bar: HTMLElement;
  pages: HTMLElement;
  /** Focuses the terminal of the tab showing. */
  focusActive(): void;
  /** Types into the shell tab showing; false when the terminal's own tab is showing. */
  inputActive(data: string): boolean;
  /** A shell tab is showing (not the terminal's own). */
  onShell(): boolean;
  /** The window closed: stops watching the tabs (they keep running) and lets their terminals go. */
  destroy(): void;
}

/** A shell tab's terminal in this window, made the first time the tab shows. */
interface ShellView {
  el: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  ro: ResizeObserver;
  /** The size last sent, so a resize goes once per change. */
  sent: string;
  /** The snapshot has come: the terminal shows the shell, and sizes it. */
  ready: boolean;
  /** The size the shell has, and how many are watching it (0: not told yet). */
  shared: { cols: number; rows: number };
  viewers: number;
}

export function termTabs(workerId: string, opts: TermTabsOptions): TermTabs {
  const { net } = opts;
  const tabsBar = h('div.term-tabs', { role: 'tablist', 'aria-label': 'Tabs' });
  const addBtn = h('button.term-tab-add', { type: 'button', title: "Open a shell in this worker's folder in a new tab (it keeps running when you close this window, and ends when the office restarts)" }, '+ New tab');
  const bar = h('div.term-tabbar', {}, tabsBar, addBtn);
  const pages = h('div.term-shellpages.hidden');

  let tabs: ShellTab[] = [];
  const views = new Map<string, ShellView>();
  /** The shell tab showing; null for the terminal's own. */
  let active: string | null = null;

  const render = () => {
    const tab = (on: boolean, label: HTMLElement, close?: HTMLElement) => h('div.term-tab', { class: on ? 'on' : '' }, label, close ?? null);
    tabsBar.replaceChildren(
      tab(active === null, h('button.term-tab-label', { type: 'button', role: 'tab', 'aria-selected': String(active === null), onclick: () => show(null) }, '💻 Terminal')),
      ...tabs.map((t) =>
        tab(
          active === t.id,
          h('button.term-tab-label', { type: 'button', role: 'tab', 'aria-selected': String(active === t.id), title: `Opened by ${t.by}, ${timeAgo(t.at)}`, onclick: () => show(t.id) }, t.title),
          h(
            'button.term-tab-close',
            {
              type: 'button',
              title: 'Close this shell (ends whatever runs in it)',
              'aria-label': `Close ${t.title}`,
              onclick: (e: Event) => {
                e.stopPropagation();
                net.send({ t: 'shelltab.close', tabId: t.id });
              },
            },
            '×',
          ),
        ),
      ),
    );
  };

  /**
   * Sizes a shell tab to this window, as the terminal does (ui/terminal.ts): typing claims the shell's
   * size (latest typist wins); opening or resizing the window only does when nobody else is watching,
   * otherwise this view follows the shell's size so cursor movements render right for everyone.
   */
  const sizeView = (id: string, v: ShellView, typing = false) => {
    if (!v.ready) return;
    if (!typing && v.viewers !== 1) {
      if (v.shared.cols > 0 && (v.shared.cols !== v.term.cols || v.shared.rows !== v.term.rows)) v.term.resize(v.shared.cols, v.shared.rows);
      return;
    }
    if (v.el.clientWidth === 0 || v.el.clientHeight === 0) return;
    try {
      v.fit.fit();
    } catch {
      return;
    }
    const key = `${v.term.cols}x${v.term.rows}`;
    if (v.term.cols > 0 && v.term.rows > 0 && key !== v.sent && (v.term.cols !== v.shared.cols || v.term.rows !== v.shared.rows)) {
      v.sent = key;
      net.send({ t: 'shelltab.resize', tabId: id, cols: v.term.cols, rows: v.term.rows });
    }
  };

  const viewFor = (id: string): ShellView => {
    const existing = views.get(id);
    if (existing) return existing;
    const el = h('div.term-shellhost');
    pages.append(el);
    const { term, fit } = makeXterm({ keypad: !!opts.keypad });
    const v: ShellView = { el, term, fit, ro: new ResizeObserver(() => sizeView(id, v)), sent: '', ready: false, shared: { cols: 0, rows: 0 }, viewers: 0 };
    views.set(id, v);
    term.open(el);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey) {
        // As in the terminal (ui/terminal.ts): Ctrl+] leaves the window, Ctrl+[ is an Esc for the shell.
        if (keyAt(e, ']', 'BracketRight')) {
          opts.closeWindow();
          return false;
        }
        if (keyAt(e, '[', 'BracketLeft')) {
          e.preventDefault();
          term.input('\x1b');
          return false;
        }
      }
      // Copy and paste off a Mac, and the prompt's editing keys, as in the terminal (termkeys.ts).
      const clip = e.type === 'keydown' && !e.isComposing ? clipboardKey(e, term.hasSelection()) : undefined;
      if (clip === 'paste') return false;
      if (clip === 'copy') {
        e.preventDefault();
        document.execCommand('copy');
        term.clearSelection();
        return false;
      }
      const natural = e.type === 'keydown' && !e.isComposing ? naturalKey(e) : undefined;
      if (natural !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        term.input(natural);
        return false;
      }
      return true;
    });
    term.onData((data) => {
      sizeView(id, v, true);
      net.send({ t: 'shelltab.input', tabId: id, data });
    });
    v.ro.observe(el);
    net.send({ t: 'shelltab.attach', tabId: id });
    return v;
  };

  const dropView = (id: string) => {
    const v = views.get(id);
    if (!v) return;
    v.ro.disconnect();
    v.term.dispose();
    v.el.remove();
    views.delete(id);
  };

  const focusActive = () => {
    if (active === null) opts.focusTerm();
    else views.get(active)?.term.focus();
  };

  const show = (id: string | null) => {
    active = id;
    const onMain = id === null;
    opts.host.classList.toggle('hidden', !onMain);
    opts.keypad?.classList.toggle('hidden', !onMain);
    pages.classList.toggle('hidden', onMain);
    if (id !== null) viewFor(id);
    for (const [vid, v] of views) v.el.classList.toggle('hidden', vid !== id);
    render();
    if (id !== null) sizeView(id, views.get(id)!);
    focusActive();
    opts.onActiveChange?.();
  };

  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'shelltab.tabs' && msg.workerId === workerId) {
      tabs = msg.tabs;
      const ids = new Set(tabs.map((t) => t.id));
      for (const id of [...views.keys()]) if (!ids.has(id)) dropView(id);
      if (msg.opened && ids.has(msg.opened)) show(msg.opened);
      else if (active !== null && !ids.has(active)) show(null);
      else render();
    } else if (msg.t === 'welcome') {
      // After a reconnect the server has forgotten this window's subscriptions and views: ask again.
      // Each snapshot that comes back resets its terminal.
      net.send({ t: 'shelltab.list', workerId });
      for (const [id, v] of views) {
        v.ready = false;
        v.viewers = 0;
        v.sent = '';
        net.send({ t: 'shelltab.attach', tabId: id });
      }
    } else if (msg.t === 'shelltab.snapshot') {
      const v = views.get(msg.tabId);
      if (!v) return;
      v.ready = false;
      v.term.reset();
      v.term.resize(msg.cols, msg.rows);
      v.shared = { cols: msg.cols, rows: msg.rows };
      v.sent = `${msg.cols}x${msg.rows}`;
      v.term.write(msg.data, () => {
        v.ready = true;
        sizeView(msg.tabId, v);
        v.term.scrollToBottom();
      });
    } else if (msg.t === 'shelltab.size') {
      const v = views.get(msg.tabId);
      if (!v) return;
      v.shared = { cols: msg.cols, rows: msg.rows };
      v.viewers = msg.viewers;
      // Someone else sized the shell: follow it (a lone viewer owns the size, so an echo of their own changes nothing).
      if (v.ready && msg.viewers > 1 && (msg.cols !== v.term.cols || msg.rows !== v.term.rows) && `${msg.cols}x${msg.rows}` !== v.sent) {
        v.term.resize(msg.cols, msg.rows);
        v.sent = '';
      } else if (v.ready) sizeView(msg.tabId, v);
    } else if (msg.t === 'shelltab.data') {
      views.get(msg.tabId)?.term.write(msg.data);
    }
  };
  const unlisten = opts.listen(onMsg);

  addBtn.addEventListener('click', () => net.send({ t: 'shelltab.open', workerId }));
  render();
  net.send({ t: 'shelltab.list', workerId });

  return {
    bar,
    pages,
    focusActive,
    onShell: () => active !== null,
    inputActive: (data) => {
      const v = active === null ? undefined : views.get(active);
      if (!v) return false;
      v.term.input(data);
      v.term.focus();
      return true;
    },
    destroy: () => {
      unlisten();
      for (const id of [...views.keys()]) {
        if (tabs.some((t) => t.id === id)) net.send({ t: 'shelltab.detach', tabId: id });
        dropView(id);
      }
      net.send({ t: 'shelltab.unlist', workerId });
    },
  };
}
