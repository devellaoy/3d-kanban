// When a textarea gets the large editor's button, what the editor is called and where the button goes: the pure half of ui/textexpand.ts, without the DOM.

/** What the module knows of a textarea when it decides whether it gets the button. */
export interface FieldInfo {
  /** It is the large editor's own text box. */
  inEditor: boolean;
  /** Inside an editor that brings its own text handling (.xterm, .excalidraw). */
  foreign: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** Marked data-no-expand. */
  optedOut: boolean;
  width: number;
  height: number;
}

/** A field narrower or lower than this is too small for the button. */
export const MIN_FIELD_W = 120;
export const MIN_FIELD_H = 40;
/** The button's side on screen, px, and how far it sits from the field's top and right edges. */
export const BTN_SIZE = 22;
export const BTN_INSET = 4;
/** The longest title the editor shows. */
const NAME_MAX = 60;

/** Whether the field gets the button: an ordinary, editable, big enough text box. */
export function expandable(f: FieldInfo): boolean {
  return !f.inEditor && !f.foreign && !f.disabled && !f.readOnly && !f.optedOut && f.width >= MIN_FIELD_W && f.height >= MIN_FIELD_H;
}

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The editor's title: aria-label, else the field's label text, else the start of its placeholder, else 'Text'. Whitespace collapsed; cut to 60 chars with an ellipsis ('…') when longer. */
export function fieldName(o: { ariaLabel?: string | null; label?: string | null; placeholder?: string | null }): string {
  const first = (o.placeholder ?? '').split(/[.:?\n]/)[0];
  const name = squash(o.ariaLabel) || squash(o.label) || squash(first) || 'Text';
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX - 1).trimEnd() + '…' : name;
}

/** Where the button goes (viewport px, its top-left corner): the field's top right corner, inside it, left of its vertical scrollbar. */
export function buttonPlace(rect: { top: number; right: number }, scrollbar: number): { left: number; top: number } {
  return {
    left: Math.round(rect.right - Math.max(0, scrollbar) - BTN_INSET - BTN_SIZE),
    top: Math.round(rect.top + BTN_INSET),
  };
}

/** What the big box takes when the field changed from elsewhere: the field's text and its selection, kept inside the text (null selection = the end; start never after end). */
export function adopt(value: string, sel: readonly [number | null, number | null]): { value: string; start: number; end: number } {
  const len = value.length;
  const at = (n: number | null) => (n === null ? len : Math.min(Math.max(0, n), len));
  const end = at(sel[1]);
  const start = Math.min(at(sel[0]), end);
  return { value, start, end };
}

/** Alt+Enter and nothing else held (no Ctrl, Meta or Shift), never mid-IME-composition. */
export function isExpandKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing;
}
