// One call to a host's REST API, with the errors a person can act on: a sign-in the host turned
// down, a repository it can't find, a host that didn't answer.

import { hostLabel } from '../../shared/hosting/remote.js';
import type { Fetch, HostAs } from './provider.js';

const TIMEOUT_MS = 30_000;
const SIGN_INS = '☰ → 🔐 Your sign-ins';

/** Throws the error a person can act on for an answer that isn't a success. */
function refuse(as: HostAs, status: number, parsed: unknown): never {
  const label = hostLabel(as.kind);
  // Azure DevOps answers a token it doesn't take with a redirect to its sign-in page (203 or 302), not a 401.
  if (status === 401 || status === 203 || (status >= 300 && status < 400)) {
    throw new Error(as.key === 'office' ? `${label} turned the office's credentials down: an admin sets them again in ${SIGN_INS}` : `Your ${label} sign-in stopped working: set a new token in ${SIGN_INS}`);
  }
  const said = errorText(parsed);
  if (status === 403) throw new Error(`${label} says the token may not do this (403)${said ? `: ${said}` : ''}: check its scopes`);
  if (status === 404) throw new Error(`${label} can't find it (404)${said ? `: ${said}` : ''}: check the remote and that the token can see the repository`);
  throw new Error(`${label} said ${status}${said ? `: ${said}` : ''}`);
}

/** Until when (ms) a host asked these credentials to wait (429), by kind and whose. */
const waiting = new Map<string, number>();
/** How long to wait after a 429 that doesn't say (Retry-After), and the most a Retry-After is believed. */
const WAIT_MS = 60_000;
const WAIT_MAX_MS = 60 * 60_000;

/** Tests: forget the waits, and the clock. */
export const hostRate = { now: () => Date.now(), clear: () => waiting.clear() };

/** How long a 429 asks to wait: Retry-After in seconds or as a date, else a minute. */
function retryAfter(res: Response): number {
  const v = res.headers.get('retry-after');
  const secs = Number(v);
  const ms = v && Number.isFinite(secs) ? secs * 1000 : v ? Date.parse(v) - hostRate.now() : NaN;
  return Math.min(WAIT_MAX_MS, Number.isFinite(ms) && ms > 0 ? ms : WAIT_MS);
}

/**
 * One request, unless the host asked these credentials to wait (a 429, until its Retry-After):
 * then none goes out until then, and the caller hears when it may try again.
 */
async function send(fetch: Fetch, as: HostAs, url: string, init: RequestInit): Promise<Response> {
  const key = `${as.kind}:${as.key}`;
  const until = waiting.get(key) ?? 0;
  const label = hostLabel(as.kind);
  if (until > hostRate.now()) throw new Error(`${label} asked the office to slow down: it tries again in ${Math.ceil((until - hostRate.now()) / 1000)} s`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  } catch (err) {
    throw new Error(`${label} didn't answer (${(err as Error).message})`);
  }
  if (res.status === 429) {
    const wait = retryAfter(res);
    waiting.set(key, hostRate.now() + wait);
    throw new Error(`${label} asked the office to slow down (429): it tries again in ${Math.ceil(wait / 1000)} s`);
  }
  return res;
}

const jsonOf = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
};

export async function hostCall(fetch: Fetch, as: HostAs, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, contentType = 'application/json'): Promise<any> {
  const res = await send(fetch, as, url, {
    method,
    headers: { authorization: as.auth, accept: 'application/json', ...(body !== undefined ? { 'content-type': contentType } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const parsed = jsonOf(await res.text());
  if (!res.ok || res.status === 203) refuse(as, res.status, parsed);
  if (parsed === undefined) throw new Error(`${hostLabel(as.kind)} answered with something that isn't JSON`);
  return parsed;
}

/** How much of a text answer is read (a diff, a file), unless the caller asks for less. */
export const TEXT_MAX = 8 * 1024 * 1024;

/** An answer longer than the caller would read: refused before the rest of it comes in. */
export class TooBig extends Error {}

/** An answer's text, read only up to `max` bytes (Content-Length, when it says, refuses it at once). */
async function textUpTo(res: Response, max: number, label: string): Promise<string> {
  const big = () => new TooBig(`${label} sent more than ${Math.round((max / 1024 / 1024) * 10) / 10} MB`);
  if (Number(res.headers.get('content-length')) > max) {
    void res.body?.cancel().catch(() => undefined);
    throw big();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      throw big();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * A GET whose answer is text (a diff, a file's contents). A redirect is followed (a few times) only
 * to the same origin, so the token never goes anywhere else; an answer over `max` (TEXT_MAX) is
 * refused with TooBig, without reading the rest of it.
 */
export async function hostText(fetch: Fetch, as: HostAs, url: string, accept = 'text/plain', max = TEXT_MAX): Promise<string> {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await send(fetch, as, at, { method: 'GET', headers: { authorization: as.auth, accept } });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, at);
      if (next.origin !== new URL(url).origin) refuse(as, res.status, undefined);
      at = next.href;
      continue;
    }
    if (!res.ok || res.status === 203) refuse(as, res.status, jsonOf(await res.text()));
    return await textUpTo(res, max, hostLabel(as.kind));
  }
  throw new Error(`${hostLabel(as.kind)} redirected too many times`);
}

/** What an error answer says, from Azure DevOps' `message` or Bitbucket's `error.message`. */
function errorText(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const said = body.message ?? body.error?.message ?? body.errors?.[0]?.message ?? '';
  return String(said).slice(0, 300);
}
