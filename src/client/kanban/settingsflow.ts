// The bookkeeping of the kanban's categories in ⚙️ Settings (settings.ts, skills.ts), kept without the
// DOM so tests/kanban-ui-settings.test.ts can run it: when the panes redraw as the office's settings
// come in, and taking listeners down with the panes that added them.

/** Functions to call once, together: the listeners of what's drawn now. */
export class Cleanups {
  private offs: (() => void)[] = [];

  add(off: () => void) {
    this.offs.push(off);
  }

  /** Calls every function added since the last time, and forgets them. */
  run() {
    for (const off of this.offs.splice(0)) off();
  }

  get size(): number {
    return this.offs.length;
  }
}

/** A set of listeners where the function that removes one removes that one. */
export class Listeners {
  private fns = new Set<() => void>();

  add(fn: () => void): () => void {
    // A wrapper of its own, so the same function added twice is two listeners.
    const entry = () => fn();
    this.fns.add(entry);
    return () => {
      this.fns.delete(entry);
    };
  }

  call() {
    for (const fn of [...this.fns]) fn();
  }

  get size(): number {
    return this.fns.size;
  }
}

/**
 * What a change of the kanban's settings redraws: `all` panes, or only the `secrets` (the rest keeps
 * what you typed). The first settings after opening redraw everything when the panes were drawn from
 * what was kept from before (`own`: a page without a board, whose copy nothing kept current while the
 * window was shut) or from nothing at all; after that, only the secrets.
 */
export function settingsRedraw(own: boolean, cached: boolean): () => 'all' | 'secrets' {
  let fresh = cached && !own;
  return () => {
    if (fresh) return 'secrets';
    fresh = true;
    return 'all';
  };
}
