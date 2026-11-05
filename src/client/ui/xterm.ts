// One terminal in a worker's window, set up the same way wherever it shows: the worker's own
// (ui/terminal.ts) and each of its shell tabs (ui/termtabs.ts).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { TERM_THEME } from './termtheme';

/** A terminal with its fit addon (links open in a new browser tab). */
export function makeXterm(opts: { keypad?: boolean } = {}): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    // A few more columns on a phone's narrow screen.
    fontSize: opts.keypad ? 12 : 14,
    lineHeight: 1.1,
    theme: TERM_THEME,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit };
}
