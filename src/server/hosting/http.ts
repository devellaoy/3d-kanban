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

async function send(fetch: Fetch, as: HostAs, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  } catch (err) {
    throw new Error(`${hostLabel(as.kind)} didn't answer (${(err as Error).message})`);
  }
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

/** How much of a text answer is read (a diff, a file). */
export const TEXT_MAX = 8 * 1024 * 1024;

/**
 * A GET whose answer is text (a diff, a file's contents). A redirect is followed (a few times) only
 * to the same origin, so the token never goes anywhere else; an answer over TEXT_MAX is refused.
 */
export async function hostText(fetch: Fetch, as: HostAs, url: string, accept = 'text/plain'): Promise<string> {
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
    const text = await res.text();
    if (!res.ok || res.status === 203) refuse(as, res.status, jsonOf(text));
    if (text.length > TEXT_MAX) throw new Error(`${hostLabel(as.kind)} sent more than ${TEXT_MAX / 1024 / 1024} MB`);
    return text;
  }
  throw new Error(`${hostLabel(as.kind)} redirected too many times`);
}

/** What an error answer says, from Azure DevOps' `message` or Bitbucket's `error.message`. */
function errorText(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const said = body.message ?? body.error?.message ?? body.errors?.[0]?.message ?? '';
  return String(said).slice(0, 300);
}
