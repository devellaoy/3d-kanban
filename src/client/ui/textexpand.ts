// The large editor of a text box: every textarea on the page gets a small Expand button in its top right
// corner while the pointer is on it or it has the focus, and the button (or Alt+Enter in the box) opens
// its text in a window nearly as large as the screen. One button and one set of listeners for the whole
// page (installTextExpand, called by each page's entry point beside installTooltips), so a view writes a
// plain <textarea> as before and gets this with it. A box that must not have it says `data-no-expand`.
//
// The window has no Save or Cancel: what is typed there is typed into the field (with the `input` event
// the field's own view listens to), and what the field's view writes into it (a pasted file's link from
// kanban/attachbox.ts, a drafted prompt) shows in the window. Files pasted or dropped on the window are
// handed to the field, whose view does with them what it does. Esc, the close button, Done and Ctrl/Cmd+Enter
// close it and put the keyboard back in the field, the caret where it was in the window.
//
// A field its view draws anew is followed only by its data-focus inside the same task view (replacement()
// in the model); otherwise the editor is orphaned. A field that turns read-only or disabled meanwhile is
// not written to either. In both cases the editor says so in its footer and offers Copy text, and what the
// field never took is shown on closing in a small Text kept window. Nothing goes to the clipboard unless
// the user presses Copy text.
// Which box gets the button, the window's title and where the button goes is textexpandmodel.ts's.
// A box its view gave an action (ui/fieldaction.ts) gets that action's button beside this one, on its left.
//
// No three.js, core/ or features/ here: the kanban page and the 2D view use it too.

import './textexpand.css';
import { h, onModalChange, toast, type Modal } from './dom';
import { actionButton, fieldAction } from './fieldaction';
import { iconButton } from './icons';
import { btn } from './kit';
import { modalShell, openShell } from './shell';
import { actionPlace, adopt, BTN_SIZE, buttonPlace, expandable, fieldName, isExpandKey, replacement, editorState, keptOnClose, mayWrite, MIN_FIELD_H, MIN_FIELD_W, type FieldInfo, type SyncFacts, type EditorState } from './textexpandmodel';

/** Marks the window's own text box, which never gets the button. */
const EDITOR = 'data-text-expand-editor';
/** A text box that gets the button keeps room for it on its right (textexpand.css). */
const ROOM = 'ta-expandable';
/** Editors that bring their own text handling. */
const FOREIGN = '.xterm, .excalidraw';
/** How often the open window looks for text written into the field without an event. */
const POLL_MS = 400;

let installed = false;

/** The Copy text button of a window that holds text the field could not take: the user's own press puts the whole text of `box` on the clipboard, and when that can't be done the text is selected to copy by hand. */
function copyButton(box: HTMLTextAreaElement, kind: 'quiet' | 'secondary'): HTMLButtonElement {
  const title = 'Copy the whole text to the clipboard';
  const b = btn('Copy text', kind === 'quiet' ? { kind, size: 'sm', icon: 'copy', attrs: { title } } : { kind, icon: 'copy', attrs: { title } });
  b.addEventListener('click', () => {
    const byHand = () => {
      box.focus();
      box.select();
      toast("Couldn't copy: the text is selected, copy it with Ctrl/Cmd+C", 'warn');
    };
    if (!navigator.clipboard?.writeText) return byHand();
    navigator.clipboard.writeText(box.value).then(() => toast('Copied'), byHand);
  });
  return b;
}

/** The small window that keeps a text the editor could not put anywhere, so closing the editor does not lose it. */
function keepText(text: string, why: 'orphaned' | 'locked' | 'conflict') {
  const box = h('textarea.text-kept-box', { [EDITOR]: '', 'aria-label': 'The kept text' }) as HTMLTextAreaElement;
  box.rows = 12;
  box.readOnly = true;
  box.value = text;
  const says = {
    orphaned: 'The field this text was written for is gone, so it could not be put there. Copy it and paste it where it belongs.',
    locked: "The field this text was written for can't be edited any more, so it could not be put there. Copy it if you still need it.",
    conflict: 'The field this text was written for got another text while it was locked, so yours was not put there. Copy it if you still need it.',
  }[why];
  const close = btn('Close', { kind: 'primary' });
  const shell = modalShell({ cls: 'text-kept w640', icon: 'maximize-2', title: 'Text kept', body: [h('p.text-kept-why', {}, says), box], footerRight: [copyButton(box, 'secondary'), close] });
  const modal = openShell(shell);
  close.addEventListener('click', () => modal.close());
}

/** Turns the large editor on for this page. Once per page: a second call does nothing. */
export function installTextExpand(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  const button = iconButton('maximize-2', 'Expand', { class: 'xs text-expand-btn hidden', tabindex: -1, title: 'Open this text in a large editor (Alt+Enter).' }, 14);
  /** The button of the box's own action, when it has one: shown and hidden with the Expand button, and as much the module's own. */
  const act = actionButton();
  const own = [button, act.el];
  document.body.append(button, act.el);

  /** The text box under the pointer, and the one with the focus. */
  let hovered: HTMLTextAreaElement | null = null;
  let focused: HTMLTextAreaElement | null = null;
  /** The box the button belongs to now, shown or not. */
  let anchor: HTMLTextAreaElement | null = null;
  let shown = false;
  let frame = 0;
  /** Set while the button itself says the pointer left it (see hide). */
  let telling = false;
  /** Closes the open window, when there is one (only one at a time). */
  let closeEditor: (() => void) | null = null;
  /** The window (its backdrop) the open editor's field was in. */
  let owner: Element | null = null;

  const info = (el: HTMLTextAreaElement): FieldInfo => {
    const box = el.getBoundingClientRect();
    return { inEditor: el.hasAttribute(EDITOR), foreign: !!el.closest(FOREIGN), disabled: el.matches(':disabled'), readOnly: el.readOnly, optedOut: !!el.closest('[data-no-expand]'), width: box.width, height: box.height };
  };
  const usable = (el: HTMLTextAreaElement | null): el is HTMLTextAreaElement => !!el && el.isConnected && expandable(info(el));
  /**
   * Keeps room for the button in a box that gets it, from the first time it is seen. One that isn't laid
   * out yet (a pane drawn hidden) is taken to be big enough: its words would move when it first got the button.
   */
  const mark = (el: HTMLTextAreaElement) => {
    if (el.classList.contains(ROOM) || !el.isConnected) return;
    const f = info(el);
    if (expandable(f.width || f.height ? f : { ...f, width: MIN_FIELD_W, height: MIN_FIELD_H })) el.classList.add(ROOM);
  };

  /** Takes one of the two buttons away. */
  function conceal(b: HTMLButtonElement) {
    if (b.classList.contains('hidden')) return;
    // The tooltip (ui/tooltip.ts) holds the button while the pointer is on it and hears nothing when it
    // just goes: it is told the pointer left, so its bubble goes with the button.
    telling = true;
    b.dispatchEvent(new Event('pointerout', { bubbles: true }));
    telling = false;
    b.classList.add('hidden');
  }
  function hide() {
    if (!shown) return;
    shown = false;
    own.forEach(conceal);
  }

  /** Puts the button in its box's corner, or takes it away when the box or that corner of it can't be seen. */
  function place() {
    frame = 0;
    const el = anchor;
    if (!usable(el)) return hide();
    // Left of the box's own scrollbar (what is left of its width without its content and its borders).
    const at = buttonPlace(el.getBoundingClientRect(), el.offsetWidth - el.clientWidth - 2 * el.clientLeft);
    // The corner has to be the box's own there: not under a window's header or footer it has scrolled beneath, nor under another window.
    const under = document.elementsFromPoint(at.left + BTN_SIZE / 2, at.top + BTN_SIZE / 2).find((n) => !own.some((b) => b.contains(n)));
    if (under !== el) return hide();
    button.style.setProperty('--tx-left', `${at.left}px`);
    button.style.setProperty('--tx-top', `${at.top}px`);
    button.classList.remove('hidden');
    shown = true;
    const action = fieldAction(el);
    if (!action) return conceal(act.el);
    const beside = actionPlace(at);
    act.wear(action);
    act.el.style.setProperty('--tx-left', `${beside.left}px`);
    act.el.style.setProperty('--tx-top', `${beside.top}px`);
    act.el.classList.remove('hidden');
  }
  const later = () => {
    if (anchor && !frame) frame = requestAnimationFrame(place);
  };
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);

  /** Picks the box the button belongs to: the one under the pointer before the one with the focus. */
  function update() {
    const el = usable(hovered) ? hovered : usable(focused) ? focused : null;
    if (el !== anchor) {
      sizes?.disconnect();
      anchor = el;
      if (el) {
        mark(el);
        sizes?.observe(el);
      }
    }
    place();
  }

  // A text box drawn into the page keeps the button's room from the start, so its words don't move when the pointer first comes to it.
  // What is drawn or taken away may also have moved the box the button is on, with no scroll or resize to say so.
  new MutationObserver((records) => {
    later();
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLTextAreaElement) mark(n);
        else if (n instanceof Element && n.firstElementChild) n.querySelectorAll('textarea').forEach(mark);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('textarea').forEach(mark);

  document.addEventListener('pointerover', (e) => {
    // A finger has no hover: on a touch screen the button comes with the focus.
    if (e.pointerType === 'touch') return;
    const t = e.target;
    // On either button the pointer is still on its box.
    if (t instanceof Node && own.some((b) => b.contains(t))) return;
    const el = t instanceof HTMLTextAreaElement ? t : null;
    if (el === hovered) return;
    hovered = el;
    update();
  });
  document.addEventListener('pointerout', (e) => {
    // Out of the page altogether.
    if (telling || e.relatedTarget || !hovered) return;
    hovered = null;
    update();
  });
  document.addEventListener('focusin', (e) => {
    focused = e.target instanceof HTMLTextAreaElement ? e.target : null;
    update();
  });
  document.addEventListener('focusout', (e) => {
    if (e.target !== focused) return;
    focused = null;
    update();
  });
  // A press on the button must not take the focus (and the caret) out of the box.
  const keepFocus = (e: Event) => e.preventDefault();
  for (const b of own) {
    b.addEventListener('pointerdown', keepFocus);
    b.addEventListener('mousedown', keepFocus);
  }
  button.addEventListener('click', () => anchor && open(anchor));
  act.el.addEventListener('click', () => usable(anchor) && fieldAction(anchor)?.run(anchor));
  // Before the box's own key handlers: Alt+Enter is this and nothing else.
  document.addEventListener(
    'keydown',
    (e) => {
      const el = e.target;
      if (!isExpandKey(e) || !(el instanceof HTMLTextAreaElement) || !usable(el)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) open(el);
    },
    true,
  );
  // Whatever moves the box moves the button: a scroll anywhere round it, the window's size, its own size, text that makes it grow.
  window.addEventListener('scroll', later, { capture: true, passive: true });
  window.addEventListener('resize', later);
  document.addEventListener('input', later);
  onModalChange(() => {
    // The window the field was in closed underneath the editor (it sent itself, or the office closed it).
    if (closeEditor && owner && !owner.isConnected) closeEditor();
    update();
  });

  /** The field's name for the window's title: its label's own words (not the "Optional" beside them). */
  function nameOf(field: HTMLTextAreaElement): string {
    const label = field.labels?.[0];
    const own = label ? [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ') : '';
    return fieldName({ ariaLabel: field.getAttribute('aria-label'), label: own.trim() ? own : label?.textContent, placeholder: field.placeholder });
  }

  /** Opens `from`'s text in the window. */
  function open(from: HTMLTextAreaElement) {
    if (closeEditor) return;
    let field = from;
    const name = nameOf(field);
    const big = h('textarea.text-expand-box', { [EDITOR]: '', 'aria-label': name, placeholder: field.placeholder }) as HTMLTextAreaElement;
    if (field.maxLength >= 0) big.maxLength = field.maxLength;
    big.spellcheck = field.spellcheck;
    const start = adopt(field.value, [field.selectionStart, field.selectionEnd]);
    big.value = start.value;
    /** The text the window opened with: only a text written since is worth saving from a field that has gone. */
    const opened = start.value;
    // A field in the mono font (a prompt, a query) is written in it here too.
    if (/mono|courier|consolas|menlo/i.test(getComputedStyle(field).fontFamily)) big.classList.add('mono');

    owner = field.closest('.backdrop');
    // A field is followed across its view's redraws only by its data-focus inside the view it was drawn in (a task view's root is made once per task).
    const key = field.dataset.focus ?? null;
    const home = field.closest('.kb-tv');
    /** The field's text as the two last agreed on: a difference is text written into the field without an event. */
    let last = field.value;
    /** Set while one side is being written from the other, so the writing isn't taken for an edit to copy back. */
    let busy = false;
    /** The user has typed in the window since it opened (not the field's text written into it). */
    let dirty = false;
    /** The user has typed or moved the caret in the window: the opening caret is no longer theirs to set. */
    let touched = false;
    /** The window has text the field did not take (it was locked): the field's text must not replace it. */
    let held = false;
    let state: EditorState = 'normal';
    const locked = () => field.matches(':disabled') || field.readOnly;
    /** What the editor knows of its field now (the decisions on it are the model's). A field that says what the editor says has not changed away from it. */
    const facts = (): SyncFacts => ({ connected: field.isConnected, ownerThere: !owner || owner.isConnected, locked: locked(), held, fieldChanged: field.value !== last && field.value !== big.value });
    /** The field can take the text it refused: it is there, unlocked, and still says what it said then (a text its view wrote meanwhile is not written over). */
    const takesHeld = () => held && mayWrite(facts());

    /** The window's selection, on the field: its view reads the caret there (a pasted file's link goes in at it, also when the upload ends later). */
    const mirror = () => {
      try {
        field.setSelectionRange(big.selectionStart, big.selectionEnd, big.selectionDirection ?? undefined);
      } catch {
        // A box that has no selection to set.
      }
      // Some browsers put the focus where a selection is set: it stays in the window.
      if (modal.backdrop.isConnected && document.activeElement === field) big.focus({ preventScroll: true });
    };
    /** Field to window: the field's text and its caret, when the text is not the window's. Not while the window holds text the field refused. */
    const pull = () => {
      if (held) return;
      last = field.value;
      if (field.value === big.value) return;
      const a = adopt(field.value, [field.selectionStart, field.selectionEnd]);
      big.value = a.value;
      big.setSelectionRange(a.start, a.end);
    };
    /** Window to field, as if typed there: its view keeps its draft and its buttons by the `input` it hears. One write, one event. */
    const write = () => {
      busy = true;
      try {
        field.value = big.value;
        mirror();
        field.dispatchEvent(new Event('input', { bubbles: true }));
      } finally {
        busy = false;
      }
      held = false;
      // What the field's view made of it (a trimmed or corrected text) is the text.
      pull();
    };
    /** What the footer says and whether the window can be typed in, from the state of the field. */
    const refresh = () => {
      const next = editorState(facts());
      big.readOnly = next !== 'normal';
      if (next === state) return;
      state = next;
      const note = {
        normal: '',
        orphaned: 'The field this text was for is gone. Copy the text before you close the editor.',
        locked: "This field can't be edited right now. Your text is kept here until you close the editor.",
        conflict: 'This field got another text while it was locked. Your text is kept here: copy it before you close the editor.',
      }[state];
      shell.setFooter(state === 'normal' ? [hint()] : [h('span.foot-hint.text-expand-note', {}, note), copyButton(big, 'quiet')], [done]);
    };
    const hint = () => h('span.foot-hint', {}, h('kbd.kbd', {}, 'Esc'), 'or Done returns to the field');
    const push = () => {
      if (busy) return;
      rebind();
      refresh();
      if (!mayWrite(facts())) {
        // The big box keeps what was typed, for the field when it can take it again or for the Text kept window.
        held = true;
        return;
      }
      write();
    };
    /** The window's text and the field's, after the field was switched: the window's is written only when it was edited here, else the field's is taken. Never into a locked field. */
    const settle = () => {
      if (!field.isConnected || busy) return;
      if (field.value === big.value) {
        last = field.value;
        return;
      }
      refresh();
      if (dirty && mayWrite(facts())) write();
      else if (dirty) held = true;
      else pull();
    };
    // On the field itself: the attach box's `input` doesn't bubble.
    const onFieldInput = () => {
      if (!busy) pull();
    };
    /**
     * The view drew the field anew: the one in its place is the field from now on. That is the only box with
     * the same data-focus in the same task view the field was in (replacement() in the model); a field
     * without a key or a view, or with two candidates, is not followed. Only switches, and says whether it did.
     */
    function rebind(): boolean {
      if (field.isConnected || !home?.isConnected) return false;
      const boxes = [...home.querySelectorAll<HTMLTextAreaElement>('textarea')].filter((el) => el !== field && !el.hasAttribute(EDITOR));
      const i = replacement({ key, home }, boxes.map((el) => ({ key: el.dataset.focus ?? null, home: el.closest('.kb-tv') })));
      if (i < 0) return false;
      field.removeEventListener('input', onFieldInput);
      field = boxes[i];
      field.addEventListener('input', onFieldInput);
      return true;
    }
    field.addEventListener('input', onFieldInput);
    const poll = window.setInterval(() => {
      if (rebind()) settle();
      refresh();
      if (takesHeld()) write();
      else if (!busy && field.value !== last) pull();
    }, POLL_MS);

    big.addEventListener('input', () => {
      dirty = true;
      touched = true;
    });
    big.addEventListener('input', push);
    big.addEventListener('keydown', () => (touched = true));
    big.addEventListener('pointerdown', () => (touched = true));
    for (const type of ['select', 'keyup', 'pointerup'] as const) big.addEventListener(type, mirror);
    // The caret moved by a held arrow key, or a selection dragged out: no other event says so until it ends.
    const onSelection = () => {
      if (document.activeElement === big && !busy) mirror();
    };
    document.addEventListener('selectionchange', onSelection);

    /** Hands a paste or a drag of files on to the field, and says whether its view took it. Not to a field that is gone or locked. */
    const pass = (type: string, prop: 'clipboardData' | 'dataTransfer', data: DataTransfer | null): boolean => {
      if (rebind()) settle();
      // Not into a field that is gone or locked, nor one in conflict: the file's link would go into a text the editor doesn't show.
      if (!mayWrite(facts())) return false;
      mirror();
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, prop, { value: data });
      field.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const carriesFiles = (data: DataTransfer | null) => !!data && [...data.types].includes('Files');
    big.addEventListener('paste', (e) => {
      if (e.clipboardData?.files.length && pass('paste', 'clipboardData', e.clipboardData)) e.preventDefault();
    });
    big.addEventListener('dragover', (e) => {
      if (carriesFiles(e.dataTransfer) && pass('dragover', 'dataTransfer', e.dataTransfer)) e.preventDefault();
    });
    big.addEventListener('dragleave', (e) => {
      if (carriesFiles(e.dataTransfer)) pass('dragleave', 'dataTransfer', e.dataTransfer);
    });
    big.addEventListener('drop', (e) => {
      if (carriesFiles(e.dataTransfer) && pass('drop', 'dataTransfer', e.dataTransfer)) e.preventDefault();
    });
    // Ctrl/Cmd+Enter is "done" here, never the send key of the window underneath.
    big.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      modal.close();
    });

    const done = btn('Done', { kind: 'primary', attrs: { title: 'Close the editor and go back to the field. The text is already there.' } });
    const shell = modalShell({ cls: 'text-expand', icon: 'maximize-2', title: name, body: big, footerLeft: [hint()], footerRight: [done] });
    const modal: Modal = openShell(shell, {
      backdropCloses: false,
      onClose: () => {
        clearInterval(poll);
        clearTimeout(caret);
        document.removeEventListener('selectionchange', onSelection);
        closeEditor = null;
        // One last look at the field: drawn anew, or unlocked, since the last poll.
        if (rebind()) settle();
        refresh();
        if (takesHeld()) write();
        const why = keptOnClose(facts(), big.value, opened);
        const stillThere = !owner || owner.isConnected;
        owner = null;
        field.removeEventListener('input', onFieldInput);
        if (why) {
          // The text must not just go, and the clipboard is not ours to take: it stays in a window of its own once this one has settled. The field is left as it is.
          const text = big.value;
          setTimeout(() => keepText(text, why), 0);
        } else if (field.isConnected && stillThere && !locked()) {
          field.focus({ preventScroll: true });
          const a = adopt(field.value, [big.selectionStart, big.selectionEnd]);
          try {
            field.setSelectionRange(a.start, a.end);
          } catch {
            // A box that has no selection to set.
          }
        }
        update();
      },
    });
    closeEditor = () => modal.close();
    done.addEventListener('click', () => modal.close());
    // The caret where it was in the field: now, so the focus the shell gives the box brings it into view, and again once it has (unless the user has taken the caret by then).
    big.setSelectionRange(start.start, start.end);
    const caret = window.setTimeout(() => {
      if (document.activeElement !== big) big.focus();
      // A selection made meanwhile without a key or a press (Select all from a menu, a script) is theirs too.
      if (touched || big.selectionStart !== start.start || big.selectionEnd !== start.end) return;
      big.setSelectionRange(start.start, start.end);
      mirror();
    }, 60);
    update();
  }
}
