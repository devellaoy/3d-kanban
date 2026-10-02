// Addresses that came from a server end up as links and window.open targets. With multiplayer the
// server can be another office's, so a `javascript:` or `data:` address in a frame must never become
// something a click runs: only http(s) is a link.

/** An absolute http(s) address as given, or undefined for anything else (including unparseable text). */
export function safeUrl(u: string | undefined | null): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** For an href that may also be this app's own path (`/lite`, `#top`): relative stays, other schemes go. */
export function safeHref(u: string): string | undefined {
  try {
    const p = new URL(u, 'http://app.invalid/').protocol;
    return p === 'http:' || p === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** window.open for a server-given address: nothing happens when it is not http(s). */
export function openSafe(u: string | undefined | null): void {
  const url = safeUrl(u);
  if (url) window.open(url, '_blank', 'noopener');
}
