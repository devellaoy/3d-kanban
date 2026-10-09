/** The part of a key press the god mode key looks at (a KeyboardEvent is one). */
export interface GodModePress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/**
 * Ctrl+N, or Alt+N where the browser keeps Ctrl+N for a new window (Chrome and Edge in a tab never
 * hand it to the page). Ctrl and Alt together is AltGr on a European keyboard, typing a character: not this.
 */
export function isGodModeKey(e: GodModePress): boolean {
  return e.code === 'KeyN' && !e.shiftKey && !e.metaKey && e.ctrlKey !== e.altKey;
}
