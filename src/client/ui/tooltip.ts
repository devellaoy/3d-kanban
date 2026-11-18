// The office's tooltips: a button's `title`, shown as a bubble of the kit a moment after the pointer
// rests on it, and at once when the keyboard's focus lands on it. One set of listeners for the whole
// page (installTooltips, called by each page's entry point), so a view only writes `title` as before.
//
// While a button has the pointer or the focus its `title` is kept in `data-tip` instead, so the
// browser's own tooltip doesn't come up beside this one, and put back when the pointer or the focus
// leaves. A view may write `title` again meanwhile (the task view redraws its buttons on every update):
// the new words win, and a button drawn anew under the pointer takes the bubble over without a blink.
// What the bubble says and where it goes is tooltipmodel.ts's.
//
// No three.js, core/ or features/ here: the kanban page and the 2D view use it too.

import './tooltip.css';
import { placeTip, tipDescribes, tipText, TIP_DELAY_MS, TIP_TARGETS, TIP_WARM_MS } from './tooltipmodel';

/** Where the title waits while the tooltip has the button. */
const STASH = 'data-tip';
const BUBBLE_ID = 'ui-tip';
/** Editors that bring tooltips of their own. */
const SKIP = '.excalidraw, .xterm';

let installed = false;

/** Turns the tooltips on for this page. Once per page: a second call does nothing. */
export function installTooltips(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  const words = document.createElement('span');
  const bubble = document.createElement('div');
  bubble.id = BUBBLE_ID;
  bubble.className = 'ui-tip hidden';
  bubble.setAttribute('role', 'tooltip');
  bubble.append(words);

  /** The button whose title the tooltip holds: under the pointer or focused, shown or not. */
  let anchor: HTMLElement | null = null;
  let by: 'pointer' | 'focus' = 'pointer';
  let visible = false;
  let timer = 0;
  /** When the waiting tooltip is due (a redraw meanwhile doesn't start the wait over). */
  let due = 0;
  let hiddenAt = -Infinity;
  /** The button last pressed: it shows no tooltip again until the pointer has left it. */
  let pressed: HTMLElement | null = null;
  /**
   * The focused button whose tooltip went away (it was pressed, or the bubble was taken down): the view
   * putting the focus back on it after a redraw is not the user coming to it, so it stays quiet until
   * the focus has really been somewhere else.
   */
  let hushed: HTMLElement | null = null;
  /** Whether the anchor's aria-describedby is ours to take back. */
  let describing = false;
  /** Whether the anchor's aria-label is ours: the name its title alone gave it, kept while we hold the title. */
  let named = false;
  let x = 0;
  let y = 0;

  const target = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>(TIP_TARGETS);
    return el && !el.closest(SKIP) ? el : null;
  };
  const hasTip = (el: HTMLElement) => !!tipText(el.getAttribute('title'), el.getAttribute(STASH), el.textContent);
  const focusVisible = (el: HTMLElement) => {
    try {
      return el.matches(':focus-visible');
    } catch {
      return false;
    }
  };
  /** The same button, or the one a redraw put in its place. */
  const sameButton = (was: HTMLElement, el: HTMLElement) => was === el || (!was.isConnected && (was.dataset.focus ? was.dataset.focus === el.dataset.focus : was.textContent === el.textContent));

  /** Takes the button's title over, so the browser's tooltip stays away. A title written since is the newer one. */
  function take(el: HTMLElement) {
    const title = el.getAttribute('title');
    if (title === null) return;
    if (title.trim()) el.setAttribute(STASH, title);
    else el.removeAttribute(STASH);
    el.removeAttribute('title');
    // A button with only an icon may have had its name from the title alone: it keeps it while the title is ours, in the title's latest words.
    if (!named && (el.textContent?.trim() || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby'))) return;
    if (title.trim()) el.setAttribute('aria-label', title);
    else el.removeAttribute('aria-label');
    named = !!title.trim();
  }

  /** Gives the title back, unless the view wrote a new one meanwhile. */
  function release(el: HTMLElement) {
    const stashed = el.getAttribute(STASH);
    if (stashed !== null) {
      if (!el.hasAttribute('title')) el.setAttribute('title', stashed);
      el.removeAttribute(STASH);
    }
    if (describing && el.getAttribute('aria-describedby') === BUBBLE_ID) el.removeAttribute('aria-describedby');
    describing = false;
    // The title names it again.
    if (named) el.removeAttribute('aria-label');
    named = false;
  }

  const watch = new MutationObserver(() => sync());

  /** Makes `el` the anchor, in place of the one before it; the bubble stays as it is. */
  function hold(el: HTMLElement) {
    if (anchor) release(anchor);
    else {
      watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
      document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    }
    clearTimeout(timer);
    timer = 0;
    anchor = el;
    take(el);
  }

  /** Shows the bubble at the anchor, or moves it there and changes its words when it is already up. */
  function reveal() {
    timer = 0;
    const el = anchor;
    if (!el) return;
    const text = el.isConnected ? tipText(null, el.getAttribute(STASH), el.textContent) : '';
    const box = el.getBoundingClientRect();
    if (!text || (!box.width && !box.height)) return drop();
    if (!bubble.isConnected) document.body.append(bubble);
    words.textContent = text;
    bubble.classList.remove('hidden');
    // Measured at the corner, where the window's edge can't squeeze it.
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    // Words that wrap leave the bubble as wide as it may get: it is drawn in to its longest line.
    bubble.style.width = '';
    const style = getComputedStyle(bubble);
    const snug = Math.ceil(words.getBoundingClientRect().width) + 1 + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    if (snug < bubble.offsetWidth) bubble.style.width = `${snug}px`;
    const view = document.documentElement;
    const at = placeTip(box, { width: bubble.offsetWidth, height: bubble.offsetHeight }, { width: view.clientWidth, height: view.clientHeight });
    bubble.style.left = `${at.left}px`;
    bubble.style.top = `${at.top}px`;
    bubble.style.setProperty('--tip-arrow', `${at.arrow}px`);
    bubble.classList.toggle('below', at.side === 'below');
    visible = true;
    if (!describing && !el.hasAttribute('aria-describedby') && tipDescribes(text, el.getAttribute('aria-label') ?? el.textContent)) {
      el.setAttribute('aria-describedby', BUBBLE_ID);
      describing = true;
    }
  }

  /** Takes the bubble down (and forgets a waiting one); the anchor keeps its title held until the pointer or the focus leaves it. */
  function conceal() {
    clearTimeout(timer);
    timer = 0;
    if (!visible) return;
    visible = false;
    hiddenAt = performance.now();
    bubble.classList.add('hidden');
  }

  /** The user or the page sent the tooltip away: down it goes, and a focused button stays quiet about it (see `hushed`). */
  function dismiss() {
    if (anchor && by === 'focus') hushed = anchor;
    conceal();
  }

  /** Lets the anchor go: the bubble down, the title back. */
  function drop() {
    conceal();
    if (!anchor) return;
    release(anchor);
    anchor = null;
    watch.disconnect();
    document.removeEventListener('pointermove', onMove, { capture: true });
  }

  function schedule(el: HTMLElement, how: 'pointer' | 'focus') {
    if (el === anchor) {
      // The focus came to the button the pointer is waiting on: no more waiting.
      if (how === 'focus' && !visible) {
        by = how;
        reveal();
      }
      return;
    }
    if (!hasTip(el)) return;
    const warm = visible || performance.now() - hiddenAt < TIP_WARM_MS;
    hold(el);
    by = how;
    if (how === 'focus' || warm) return reveal();
    due = performance.now() + TIP_DELAY_MS;
    timer = window.setTimeout(reveal, TIP_DELAY_MS);
  }

  /** The page changed while a button was held: its title was written again, or it was drawn anew. */
  function sync() {
    const el = anchor;
    if (!el) return;
    if (el.isConnected) {
      if (!el.hasAttribute('title')) return;
      take(el);
      if (visible) reveal();
      return;
    }
    const active = document.activeElement;
    const next = by === 'focus' ? (active instanceof HTMLElement && target(active) === active && focusVisible(active) ? active : null) : target(document.elementFromPoint(x, y));
    if (!next || !hasTip(next)) return drop();
    const waiting = !!timer;
    hold(next);
    if (visible) reveal();
    else if (waiting) timer = window.setTimeout(reveal, Math.max(0, due - performance.now()));
  }

  /** Follows the pointer while a button is held, and lets go when it is over something else (a disabled button may never say the pointer left). */
  function onMove(e: PointerEvent) {
    x = e.clientX;
    y = e.clientY;
    if (by === 'pointer' && anchor?.isConnected && !(e.target instanceof Node && anchor.contains(e.target))) drop();
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = target(e.target);
    if (!el) return;
    if (pressed) {
      if (sameButton(pressed, el)) return;
      pressed = null;
    }
    x = e.clientX;
    y = e.clientY;
    schedule(el, 'pointer');
  });
  document.addEventListener('pointerout', (e) => {
    const el = target(e.target);
    if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
    if (pressed && sameButton(pressed, el)) pressed = null;
    if (el === anchor && by === 'pointer') drop();
  });
  // A press is the answer to the tooltip: down it goes, and the next button doesn't get one at once.
  window.addEventListener(
    'pointerdown',
    (e) => {
      dismiss();
      // A press somewhere else is the user going elsewhere: the focused button isn't kept quiet for it.
      if (hushed && !(e.target instanceof Node && hushed.contains(e.target))) hushed = null;
      hiddenAt = -Infinity;
      pressed = target(e.target);
    },
    true,
  );
  window.addEventListener('click', dismiss, true);
  // On the window and before a window's own Esc (ui/dom.ts), which stops the key there. Never swallowed: the same Esc closes the window.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') dismiss();
    },
    true,
  );
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (hushed) {
      // The view put the focus back on the button it drew anew: still the one whose tooltip went away.
      if (sameButton(hushed, el)) return void (hushed = el);
      hushed = null;
    }
    if (target(el) === el && focusVisible(el)) schedule(el, 'focus');
  });
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    // The focus went to something else: the button may show its tooltip again when it comes back.
    if (e.relatedTarget && el === hushed) hushed = null;
    if (!anchor || el !== anchor || by !== 'focus') return;
    if (e.relatedTarget) return drop();
    // To nothing: the button was taken out of the page (a redraw puts the focus on the one drawn in its
    // place before this turn is over, and that one has taken the bubble by then) or the window lost the focus.
    queueMicrotask(() => {
      const held = anchor;
      if (!held || held !== el || by !== 'focus' || document.activeElement === held) return;
      if (held.isConnected) drop();
      else sync();
    });
  });
  // Only what scrolls the button away: a terminal scrolling somewhere else leaves the tooltip be.
  window.addEventListener(
    'scroll',
    (e) => {
      if (anchor && (visible || timer) && e.target instanceof Node && e.target.contains(anchor)) dismiss();
    },
    { capture: true, passive: true },
  );
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
}
