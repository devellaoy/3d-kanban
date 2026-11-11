// Idempotent creation: a browser that times out waiting for a task's creation sends it again with the
// same `once` key, and gets the first one's answer instead of a second task. The server stores the task
// before it waits for the start, so the first creation usually did happen.

import type { KanbanCaller, KanbanContext } from './registry.js';

/** How long a made answer is kept after it settled. */
export const ONCE_KEEP_MS = 15 * 60_000;
/** The most answers kept at once, the oldest dropped first. */
export const ONCE_MAX = 500;

export interface Once {
  /**
   * Runs `make` unless this caller already did with this key: then the first run's answer, also while
   * that one is still running. `repeated` is true for every answer but the first's. A string (a
   * refusal: nothing was made) or a throw is forgotten at once so the form can be fixed and sent again.
   * Without a key, `make` just runs.
   */
  run<R>(who: KanbanCaller, key: string | undefined, make: () => Promise<R | string>): Promise<{ value: R | string; repeated: boolean }>;
}

export function createOnce(keepMs = ONCE_KEEP_MS, max = ONCE_MAX): Once {
  // A Map keeps insertion order, so its first key is the oldest.
  const seen = new Map<string, Promise<unknown>>();
  return {
    run<R>(who: KanbanCaller, key: string | undefined, make: () => Promise<R | string>) {
      if (!key) return make().then((value) => ({ value, repeated: false }));
      // The account, not the connection: a reconnect changes the clientId but it's the same person.
      const id = `${who.accountId ?? who.name}\n${key}`;
      const known = seen.get(id) as Promise<R | string> | undefined;
      if (known) return known.then((value) => ({ value, repeated: true }));
      // Stored before any await, so a repeat that arrives while the first is still running shares it.
      const first = make();
      seen.set(id, first);
      if (seen.size > max) seen.delete(seen.keys().next().value as string);
      const forget = () => {
        if (seen.get(id) === first) seen.delete(id);
      };
      first.then(
        (value) => {
          if (typeof value === 'string') return forget();
          const timer = setTimeout(forget, keepMs);
          timer.unref?.();
        },
        forget,
      );
      return first.then((value) => ({ value, repeated: false }));
    },
  };
}

const perContext = new WeakMap<KanbanContext, Once>();

/** The context's own memory of creations. */
export function onceFor(ctx: KanbanContext): Once {
  let once = perContext.get(ctx);
  if (!once) perContext.set(ctx, (once = createOnce()));
  return once;
}
