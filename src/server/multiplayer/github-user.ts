// Who an office is, as GitHub says it. The office signs in with GitHub's device flow (no scopes, so
// the token opens nothing private) and sends the token in `hello`; the relay asks GitHub whose it is
// and forgets it. Injectable so tests need no network.

/** GitHub said the token is not valid (as opposed to GitHub not being reachable). */
export class TokenRejected extends Error {}

export interface IdentityVerifier {
  /** The GitHub login the token belongs to; throws TokenRejected when GitHub refuses it, any other Error when GitHub cannot be asked. */
  login(token: string): Promise<string>;
}

/** The real thing: GET https://api.github.com/user. */
export function githubVerifier(opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): IdentityVerifier {
  const doFetch = opts.fetch ?? fetch;
  return {
    async login(token) {
      const res = await doFetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'kanban3d', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      if (res.status === 401) throw new TokenRejected('GitHub answered 401');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { login?: unknown };
      if (typeof body.login !== 'string' || !body.login) throw new TokenRejected('GitHub gave no login');
      return body.login;
    },
  };
}
