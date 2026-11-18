// What a tooltip says and where its bubble goes (ui/tooltip.ts draws it): the pure half, without the DOM.

/** What gets a tooltip: buttons and links drawn as buttons, never every element with a title. */
export const TIP_TARGETS = 'button, a.btn, [role="button"]';

/** How long the pointer rests on a button before its tooltip shows. */
export const TIP_DELAY_MS = 350;
/** Moving to another button this soon after a tooltip went shows the next one at once. */
export const TIP_WARM_MS = 400;
/** The space between a button and its tooltip. */
export const TIP_GAP = 8;
/** The closest the tooltip gets to the window's edge. */
export const TIP_MARGIN = 8;
/** The closest the tooltip's arrow gets to its corner. */
const ARROW_INSET = 14;

const clean = (s: string | null | undefined) => (s ?? '').trim();

/**
 * The words of a button's tooltip, or '' when it has none. A `title` written since the tooltip took
 * the last one over (`data-tip`) is the newer of the two, so it wins. Words that only repeat what the
 * button already says get no bubble.
 */
export function tipText(title: string | null | undefined, stashed: string | null | undefined, label: string | null | undefined): string {
  const text = clean(title) || clean(stashed);
  return text && text.toLowerCase() !== clean(label).replace(/\s+/g, ' ').toLowerCase() ? text : '';
}

/**
 * Whether the tooltip describes the button for a screen reader (aria-describedby): not when the
 * button's name is the same words (an icon button's label), which would be read twice.
 */
export function tipDescribes(text: string, name: string | null | undefined): boolean {
  return !!text && text.toLowerCase() !== clean(name).toLowerCase();
}

export interface TipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipPlace {
  left: number;
  top: number;
  /** Which side of the button it is on: above unless there is no room. */
  side: 'above' | 'below';
  /** Where its arrow points, from the bubble's left edge: at the button's middle, kept off the corners. */
  arrow: number;
}

/**
 * Where the bubble goes: centred above the button, below it when it doesn't fit above (and does, or
 * fits better, below), and always inside the window.
 */
export function placeTip(anchor: TipBox, tip: { width: number; height: number }, view: { width: number; height: number }, gap = TIP_GAP, margin = TIP_MARGIN): TipPlace {
  const above = anchor.top - gap - tip.height;
  const below = anchor.top + anchor.height + gap;
  const roomAbove = above - margin;
  const roomBelow = view.height - margin - (below + tip.height);
  const side: TipPlace['side'] = roomAbove >= 0 || roomAbove >= roomBelow ? 'above' : 'below';
  const mid = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(margin, view.width - margin - tip.width);
  const left = Math.round(Math.min(maxLeft, Math.max(margin, mid - tip.width / 2)));
  const maxTop = Math.max(margin, view.height - margin - tip.height);
  const top = Math.round(Math.min(maxTop, Math.max(margin, side === 'above' ? above : below)));
  const inset = Math.min(ARROW_INSET, tip.width / 2);
  const arrow = Math.round(Math.min(tip.width - inset, Math.max(inset, mid - left)));
  return { left, top, side, arrow };
}
