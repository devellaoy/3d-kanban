// A text box's own action: a view gives one of its textareas a second small button, shown by the large
// editor (ui/textexpand.ts) right beside its Expand button, on its left, whenever that one shows (so never
// on a disabled or read-only box). The view says what the button is and what a press does; this keeps
// which box has which action, and draws the one button the page shares.
//
// No three.js, core/ or features/ here: the kanban page and the 2D view use it too.

import { icon, iconButton, type IconName } from './icons';

export interface FieldAction {
  icon: IconName;
  /** The button's name for screen readers. */
  label: string;
  /** Its tooltip: what a press does, in a sentence or two. */
  title: string;
  /** A press on the button; the box keeps the focus. */
  run(field: HTMLTextAreaElement): void;
}

/** A box with an action keeps room for two buttons on its right (textexpand.css). */
const ROOM = 'ta-has-action';
const actions = new WeakMap<HTMLTextAreaElement, FieldAction>();

/** Gives `field` an action. Returns what takes it away again (unless another has replaced it since). */
export function setFieldAction(field: HTMLTextAreaElement, action: FieldAction): () => void {
  actions.set(field, action);
  field.classList.add(ROOM);
  return () => {
    if (actions.get(field) !== action) return;
    actions.delete(field);
    field.classList.remove(ROOM);
  };
}

/** The action of a text box, if it has one. */
export function fieldAction(el: HTMLTextAreaElement | null | undefined): FieldAction | undefined {
  return el ? actions.get(el) : undefined;
}

/** The page's one action button (hidden until shown), and how it takes the look of the action it stands for now. */
export function actionButton(): { el: HTMLButtonElement; wear(action: FieldAction): void } {
  const el = iconButton('sparkles', 'Action', { class: 'xs text-expand-btn text-action-btn hidden', tabindex: -1 }, 14);
  let worn: FieldAction | null = null;
  return {
    el,
    wear(action) {
      if (action === worn) return;
      worn = action;
      el.replaceChildren(icon(action.icon, { size: 14 }));
      el.setAttribute('aria-label', action.label);
      el.setAttribute('title', action.title);
    },
  };
}
