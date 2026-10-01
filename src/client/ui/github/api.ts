import type { ServerMsg } from '../../../shared/protocol';
import { store } from '../../state';
// 3d-kanban: which of the project's repositories a PR or issue is in (github/ghrepo.ts).
import { ghWaiter, namedRepo } from './ghrepo';

// Talking to the office about GitHub: the reads (over HTTP, for the floor you're on), and the
// answers to what the dialogs asked for over the socket (merged, commented, closed, labeled).

/** The board windows ask about the floor you're on. */
function onFloor(url: string): string {
  return store.floor ? `${url}${url.includes('?') ? '&' : '?'}floor=${encodeURIComponent(store.floor)}` : url;
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(onFloor(url), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function getText(url: string): Promise<string> {
  const r = await fetch(onFloor(url), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.text();
}

// 3d-kanban: keyed by ghKey (kind, number and repository), not the number alone.
export const mergeWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.merged' }>) => void>();
export const commentWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.commented' }>) => void>();
/** Open close dialogs, by "issue:N" or "pull:N". */
export const closeWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.closed' }>) => void>();
/** Open label pickers, by "issue:N" or "pull:N". */
export const labelWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.labeled' }>) => void>();

/** Main feeds server messages through here so an open merge, close or label dialog or comment box hears back. */
export function routePullMessage(msg: ServerMsg) {
  // 3d-kanban: by repository too, when the reply names one (see ghWaiter).
  if (msg.t === 'gh.merged') ghWaiter(mergeWaiters, 'pull', msg.number, namedRepo(msg))?.(msg);
  if (msg.t === 'gh.commented') ghWaiter(commentWaiters, msg.kind, msg.number, namedRepo(msg))?.(msg);
  if (msg.t === 'gh.closed') ghWaiter(closeWaiters, msg.kind, msg.number, namedRepo(msg))?.(msg);
  if (msg.t === 'gh.labeled') ghWaiter(labelWaiters, msg.kind, msg.number, namedRepo(msg))?.(msg);
}
