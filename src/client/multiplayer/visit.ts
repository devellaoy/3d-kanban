// Visiting another player's office: the browser's socket is piped to their office (`?visit=<login>`),
// so everything here is about where requests go and what a visitor's browser doesn't even try to send.
// No imports from the 3D parts: persist.ts and net.ts (also loaded by the 2D view) use it.
import { classOf } from '../../shared/multiplayer/allow';

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

/** The GitHub login of the office being visited, if this page was opened with `?visit=`. */
export function visiting(): string | undefined {
  // Tests run the store and the URL helpers with no page.
  if (typeof location === 'undefined') return undefined;
  const v = new URLSearchParams(location.search).get('visit');
  return v && LOGIN_RE.test(v) ? v : undefined;
}

/** Where an `/api/...` request goes: through the owner's office while visiting, unchanged otherwise. */
export function apiUrl(path: string): string {
  const login = visiting();
  return login ? `/api/mp/visit/${login}${path}` : path;
}

export function goVisit(login: string) {
  location.href = `/?visit=${encodeURIComponent(login)}`;
}

export function goHome() {
  location.href = '/';
}

let denied: (() => void) | undefined;
/** What to do (a hint to the visitor) when a message is dropped for being a change to someone else's office. */
export function onVisitDenied(fn: () => void) {
  denied = fn;
}

/** Whether a visitor's browser holds this message back: the owner's office would refuse it anyway (this is only the hint). */
export function heldBack(type: string): boolean {
  if (!visiting() || classOf(type) !== 'deny') return false;
  denied?.();
  return true;
}

let over = false;
let ended: ((reason: string) => void) | undefined;
/** What shows the reason a visit ended (a toast); set by the multiplayer install. */
export function onVisitEnded(fn: (reason: string) => void) {
  ended = fn;
}

/** The visit is over (the owner left, refused, or the link dropped): say why, then back to your own office. */
export function endVisit(reason = 'The visit ended.') {
  if (over || !visiting()) return;
  over = true;
  ended?.(reason);
  setTimeout(goHome, 3000);
}

/** No reconnecting once a visit ended: the page is on its way home. */
export function visitOver(): boolean {
  return over;
}
