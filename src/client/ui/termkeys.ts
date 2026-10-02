/** The parts of a keydown the terminal's editing keys depend on. */
export type TermKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/** A keydown's parts that say which key it is: the character it types and the key's place. */
export type TermKeyAt = Pick<KeyboardEvent, 'key' | 'code'>;

/**
 * Whether this is the key that types `key` (in either case), or the key in `key`'s place (`code`)
 * when that one types no ASCII: [ and ] that take AltGr or are other letters (ü, å), C and V that are
 * с and м in Russian. Not where the key in that place types something else ASCII: Ctrl + + zooms in
 * on a German keyboard, and Ctrl+V is Ctrl+V wherever V is.
 */
export function keyAt(e: TermKeyAt, key: string, code: string): boolean {
  return e.key.toLowerCase() === key || (e.code === code && !/^[ -~]$/.test(e.key));
}

/** Whether this browser is on a Mac (or an iPad), where ⌘ is the editing modifier. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * The editing keys people expect from their own terminal ("Natural Text Editing" in iTerm2, and
 * what VS Code's terminal sends), which xterm.js leaves out: it sends a plain backspace for ⌘⌫ and
 * Ctrl+⌫, a plain Enter for Shift+Enter, and nothing at all for ⌘← / ⌘→. Returns the bytes to send
 * instead, or undefined to let xterm handle the key. Every one is a readline control key that
 * Claude Code, Codex, OpenCode and bash all understand:
 *
 * - Shift+Enter → Ctrl+J, a new line in the agents' prompts (Enter, like before, in a shell)
 * - Ctrl+⌫ → Ctrl+W, delete the word before the cursor (⌥⌫ already does, as Esc ⌫)
 * - ⌘⌫ → Ctrl+U, delete to the start of the line; ⌘⌦ → Ctrl+K, to the end
 * - ⌘← / ⌘→ → Ctrl+A / Ctrl+E, jump to the start / end of the line
 */
export function naturalKey(e: TermKey, mac = IS_MAC): string | undefined {
  const mods = `${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.shiftKey ? 'S' : ''}${e.metaKey ? 'M' : ''}`;
  const cmd = mac ? 'M' : null;
  switch (e.key) {
    case 'Enter':
      return mods === 'S' ? '\n' : undefined;
    case 'Backspace':
      if (mods === 'C') return '\x17';
      return mods === cmd ? '\x15' : undefined;
    case 'Delete':
      return mods === cmd ? '\x0b' : undefined;
    case 'ArrowLeft':
      return mods === cmd ? '\x01' : undefined;
    case 'ArrowRight':
      return mods === cmd ? '\x05' : undefined;
  }
  return undefined;
}

/**
 * Copy and paste the way Windows Terminal and VS Code's terminal do them off a Mac, where xterm.js
 * would send Ctrl+C as an interrupt and Ctrl+V as a literal ^V: Ctrl+C (and Ctrl+Shift+C) copies
 * while text is selected and interrupts, as before, while none is; Ctrl+V and Ctrl+Shift+V paste.
 * On a Mac ⌘C / ⌘V already do and Ctrl+C stays an interrupt, so nothing changes there.
 */
export function clipboardKey(e: TermKey & TermKeyAt, hasSelection: boolean, mac = IS_MAC): 'copy' | 'paste' | undefined {
  if (mac || !e.ctrlKey || e.altKey || e.metaKey) return undefined;
  if (keyAt(e, 'c', 'KeyC')) return hasSelection ? 'copy' : undefined;
  if (keyAt(e, 'v', 'KeyV')) return 'paste';
  return undefined;
}
