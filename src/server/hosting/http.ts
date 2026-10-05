// One call to a host's REST API, with the errors a person can act on: a sign-in the host turned
// down, a repository it can't find, a host that didn't answer.

import { hostLabel } from '../../shared/hosting/remote.js';
import type { Fetch, HostAs } from './provider.js';

const TIMEOUT_MS = 30_000;
const SIGN_INS = '☰ → 🔐 Your sign-ins';

export async function hostCall(fetch: Fetch, as: HostAs, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, contentType = 'application/json'): Promise<any> {
  const label = hostLabel(as.kind);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: as.auth, accept: 'application/json', ...(body !== undefined ? { 'content-type': contentType } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err) {
    throw new Error(`${label} didn't answer (${(err as Error).message})`);
  }
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  // Azure DevOps answers a token it doesn't take with a redirect to its sign-in page (203 or 302), not a 401.
  if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)) {
    throw new Error(as.key === 'office' ? `${label} turned the office's credentials down: an admin sets them again in ${SIGN_INS}` : `Your ${label} sign-in stopped working: set a new token in ${SIGN_INS}`);
  }
  if (!res.ok) {
    const said = errorText(parsed);
    if (res.status === 403) throw new Error(`${label} says the token may not do this (403)${said ? `: ${said}` : ''}: check its scopes`);
    if (res.status === 404) throw new Error(`${label} can't find it (404)${said ? `: ${said}` : ''}: check the remote and that the token can see the repository`);
    throw new Error(`${label} said ${res.status}${said ? `: ${said}` : ''}`);
  }
  if (parsed === undefined) throw new Error(`${label} answered with something that isn't JSON`);
  return parsed;
}

/** What an error answer says, from Azure DevOps' `message` or Bitbucket's `error.message`. */
function errorText(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const said = body.message ?? body.error?.message ?? body.errors?.[0]?.message ?? '';
  return String(said).slice(0, 300);
}
