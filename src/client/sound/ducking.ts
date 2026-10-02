// Headphones: while your phone plays music (phone/music.ts) the jukebox (features/jukebox/sound.ts) and the
// Office TV (youtube/screen.ts) are silent for you, and come back after. Only this browser: nobody else's
// sound changes. A flag with a say-so for what has to re-apply its volume at once.
type Listener = () => void;

const listeners = new Set<Listener>();

export const ducking = {
  /** Whether the office's own music is held back. */
  on: false,
  /** Puts it on or off, telling the listeners when that changes it. */
  set(on: boolean) {
    if (this.on === on) return;
    this.on = on;
    for (const l of listeners) l();
  },
  /** Calls `fn` when it changes; returns what takes it away. */
  listen(fn: Listener): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
