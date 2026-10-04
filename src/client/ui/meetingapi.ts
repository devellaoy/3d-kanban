import { apiUrl } from '../multiplayer/visit';
import { store } from '../state';

// The floor's meeting archive over HTTP (GET /api/meetings...), for the earlier meetings view and the hand-off.

/** A request's answer, or why there isn't one (with the HTTP status, 0 when the request never got there). */
export type Got<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function get<T>(path: string, params: Record<string, string> = {}): Promise<Got<T>> {
  const q = new URLSearchParams({ ...params, floor: store.floor ?? '' }).toString();
  try {
    const r = await fetch(apiUrl(`${path}?${q}`), { credentials: 'same-origin' });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.json().catch(() => null))?.error ?? `HTTP ${r.status}` };
    return { ok: true, data: (await r.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** What to say when a note can't be shown. */
export function fileProblem(status: number, error: string): string {
  if (status === 413) return 'This file is too big to show here (over 1 MB). It’s still in the meeting’s notes folder.';
  if (status === 415) return 'This file isn’t text, so it can’t be shown here.';
  if (status === 404) return 'This file isn’t there any more.';
  return `Couldn’t open the file: ${error}`;
}
