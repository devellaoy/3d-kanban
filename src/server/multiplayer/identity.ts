// Who this office is on the relay: a GitHub login, proved with a token from the device flow. The
// relay's admin made a GitHub OAuth App and gave offices its client id (it is not a secret); we ask
// for no scopes, so the token can read nothing private, only tell the relay our login.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

export interface DeviceState {
  code: string;
  url: string;
  /** ms since epoch. */
  expiresAt: number;
}

export interface IdentityOptions {
  /** Stand-ins, for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called whenever `device` appears or goes away. */
  onChange?: () => void;
}

const CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class Identity {
  device?: DeviceState;
  private abort?: AbortController;
  private doFetch: typeof fetch;
  private sleep: NonNullable<IdentityOptions['sleep']>;

  constructor(private opts: IdentityOptions = {}) {
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? sleepFor;
  }

  get running(): boolean {
    return !!this.abort;
  }

  private async post(url: string, params: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.doFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal,
    });
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') throw new Error(`GitHub answered ${res.status} with something unreadable`);
    return body;
  }

  /**
   * Runs the device flow: shows `device` until the person types the code at GitHub, then resolves
   * with the token. Rejects when it was denied, the code ran out, GitHub could not be reached, or
   * {@link cancel} was called (message 'cancelled'). One flow at a time; a second start restarts it.
   */
  async start(clientId: string): Promise<string> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    try {
      const first = await this.post(CODE_URL, { client_id: clientId, scope: '' }, signal);
      const code = first.user_code;
      const deviceCode = first.device_code;
      if (typeof code !== 'string' || typeof deviceCode !== 'string') {
        throw new Error(typeof first.error_description === 'string' ? first.error_description : 'GitHub would not start a sign-in (is the relay\'s client id right?)');
      }
      let interval = Math.max(1, Number(first.interval) || 5);
      const expiresIn = Math.max(30, Number(first.expires_in) || 900);
      this.device = {
        code,
        url: typeof first.verification_uri === 'string' ? first.verification_uri : 'https://github.com/login/device',
        expiresAt: Date.now() + expiresIn * 1000,
      };
      this.opts.onChange?.();
      for (;;) {
        await this.sleep(interval * 1000, signal);
        if (signal.aborted) throw new Error('cancelled');
        if (Date.now() > this.device.expiresAt) throw new Error('The sign-in code ran out; start again');
        const r = await this.post(TOKEN_URL, { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
        if (typeof r.access_token === 'string' && r.access_token) return r.access_token;
        switch (r.error) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            interval = Number(r.interval) > interval ? Number(r.interval) : interval + 5;
            break;
          case 'expired_token':
            throw new Error('The sign-in code ran out; start again');
          case 'access_denied':
            throw new Error('GitHub sign-in was denied');
          default:
            throw new Error(typeof r.error_description === 'string' ? r.error_description : `GitHub sign-in failed (${String(r.error)})`);
        }
      }
    } catch (err) {
      if (signal.aborted) throw new Error('cancelled');
      throw err;
    } finally {
      if (this.abort === abort) {
        this.abort = undefined;
        this.device = undefined;
        this.opts.onChange?.();
      }
    }
  }

  cancel() {
    this.abort?.abort();
  }
}
