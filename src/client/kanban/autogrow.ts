// A text box that grows with its text: as tall as what's written in it, from its CSS min-height up
// to the room the pane it sits in has, and only then a scrollbar of its own. The room is that of the
// nearest scrolling ancestor, so the same box fits the kanban page's task window, a worker window's
// Task tab and a phone (taskconv.ts).

/** Room left around the box in its pane (the pane's own padding), in px. */
const SLACK = 24;

/**
 * How tall a box with `content` px of text is: never under `min`, never over `cap` (a cap under
 * `min` gives way to it), and scrolling inside only when the text is taller than that.
 */
export function grownHeight(content: number, min: number, cap: number): { height: number; scroll: boolean } {
  const max = Math.max(min, cap);
  return { height: Math.min(Math.max(content, min), max), scroll: content > max };
}

/** The nearest ancestor that scrolls up and down, if any. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return p;
  }
  return null;
}

/**
 * Makes `ta` grow with its text. `box` is what has to fit in the pane with it (the text box and its
 * toolbar); the returned `fit` measures again, for a value set from code (which fires no `input`).
 */
export function autoGrow(ta: HTMLTextAreaElement, box: HTMLElement = ta): () => void {
  const fit = () => {
    // Out of the page or hidden, there is nothing to measure: the observer below fits it once it has a size.
    if (!ta.isConnected || !ta.clientWidth) return;
    const scroller = scrollerOf(box);
    const vv = window.visualViewport;
    // No taller than what's in sight either: a phone's keyboard shrinks the visual viewport, not the
    // pane, and what's in sight of the pane starts where the pane does.
    const above = scroller ? Math.max(0, scroller.getBoundingClientRect().top - (vv?.offsetTop ?? 0)) : 0;
    const seen = (vv?.height ?? window.innerHeight) - above;
    const room = Math.min(scroller?.clientHeight ?? seen, seen);
    const cap = room - (box.offsetHeight - ta.offsetHeight) - SLACK;
    const style = getComputedStyle(ta);
    const min = parseFloat(style.minHeight) || 0;
    // scrollHeight is the text with the padding: the borders come on top, or the padding comes off.
    const px = (v: string) => parseFloat(v) || 0;
    const edge = style.boxSizing === 'border-box' ? px(style.borderTopWidth) + px(style.borderBottomWidth) : -(px(style.paddingTop) + px(style.paddingBottom));
    // Measuring collapses the box for a moment, which would make the pane jump on every key.
    const top = scroller?.scrollTop ?? 0;
    ta.style.height = 'auto';
    const content = ta.scrollHeight + edge;
    // scrollHeight is a whole number: text within a pixel of the minimum is the minimum.
    const { height, scroll } = grownHeight(content - min < 1 ? min : content, min, cap);
    ta.style.height = `${height}px`;
    ta.style.overflowY = scroll ? 'auto' : 'hidden';
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  };
  ta.addEventListener('input', fit);
  // No DOM (the tests): typing still fits it.
  if (typeof ResizeObserver === 'undefined' || typeof window === 'undefined') return fit;
  // A new width wraps the text anew, and the first size comes when the box is put on the page. Only
  // the width counts, so setting the height above never loops. The window's size moves the cap: it
  // is followed while the box is on the page, so a closed task leaves no listener behind.
  let width = 0;
  new ResizeObserver((entries) => {
    const now = entries[entries.length - 1]?.contentRect.width ?? 0;
    if (now === width) return;
    width = now;
    // The visual viewport has its own event: a phone's keyboard resizes it and not the window.
    for (const t of [window, window.visualViewport]) t?.[now ? 'addEventListener' : 'removeEventListener']('resize', fit);
    if (!now) return;
    fit();
  }).observe(ta);
  return fit;
}
