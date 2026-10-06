// Everyone's own Azure DevOps and Bitbucket credentials, like their own GitHub sign-in (signins.ts):
// what the office does on those hosts when somebody clicks, and what their workers' office-pr does,
// runs as them. Each account's are in .agent-office/homes/<id>/hosting.json, and the office's own
// (an admin's choice, and what an office without accounts uses) in .agent-office/hosting-secrets.json,
// both readable by the office alone. A token never goes back to a browser: it only learns whether
// one is set and whom the host says it belongs to.
//
// The git credential helper (bin/office-git-credential.js) reads the same files, so a push over
// HTTPS goes out with the same token (see gitconfig.ts).

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostLabel, OTHER_HOSTS, type OtherHost } from '../../shared/hosting/remote.js';
import type { HostCredentialInput, HostingState, HostSignIn } from '../../shared/protocol/hosting.js';
import type { Fetch, HostAs, HostingProvider } from './provider.js';
import { withHelperEnv } from '../gitconfig.js';

export interface SavedHost {
  token: string;
  /** Bitbucket Cloud: the Atlassian account's e-mail, for Basic auth with an API token. */
  email?: string;
  /** Azure DevOps: the organization the token was checked with (a PAT is scoped to its organizations). */
  org?: string;
  /** Who the host said the token belongs to when it was set. */
  who?: string;
}

export interface SavedHosting {
  azure?: SavedHost;
  bitbucket?: SavedHost;
  'bitbucket-server'?: SavedHost;
  /** Office only: the Bitbucket Server / Data Center hosts (host[:port]) the office knows of. */
  servers?: string[];
}

const SIGN_INS = '☰ → 🔐 Your sign-ins';
const ACCOUNT_ID = /^[A-Za-z0-9]{6,64}$/;
/** Azure DevOps PATs are 52 or 84 characters; Atlassian API tokens are longer. Generous either way. */
const TOKEN = /^[A-Za-z0-9_\-=+/.:]{16,512}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const SERVER = /^[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?$/;
const AZ_ORG = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/;
export const MAX_SERVERS = 10;

/** The Authorization header for a saved credential. */
export function authOf(kind: OtherHost, s: SavedHost): string {
  if (kind === 'azure') return `Basic ${Buffer.from(`:${s.token}`).toString('base64')}`;
  if (kind === 'bitbucket' && s.email) return `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`;
  return `Bearer ${s.token}`;
}

export class HostCredentials {
  constructor(
    private dataDir: string,
    private providers: Partial<Record<OtherHost, HostingProvider>>,
    private fetch: Fetch = (url, init) => globalThis.fetch(url, init),
  ) {}

  /** The file a scope's credentials are in: an account's, or the office's own (null). */
  file(scope: string | null): string {
    if (scope !== null && !ACCOUNT_ID.test(scope)) throw new Error('Not an account id');
    return scope === null ? path.join(this.dataDir, 'hosting-secrets.json') : path.join(this.dataDir, 'homes', scope, 'hosting.json');
  }

  load(scope: string | null): SavedHosting {
    try {
      const raw = JSON.parse(readFileSync(this.file(scope), 'utf8'));
      return raw && typeof raw === 'object' ? (raw as SavedHosting) : {};
    } catch {
      return {};
    }
  }

  private save(scope: string | null, saved: SavedHosting) {
    const file = this.file(scope);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync keeps an existing file's mode.
    chmodSync(file, 0o600);
  }

  /** The Bitbucket Server / Data Center hosts the office knows of. */
  serverHosts(): string[] {
    const list = this.load(null).servers;
    return Array.isArray(list) ? list.filter((h) => typeof h === 'string' && SERVER.test(h)) : [];
  }

  setServerHosts(list: unknown): string | undefined {
    if (!Array.isArray(list) || list.length > MAX_SERVERS) return `Up to ${MAX_SERVERS} hosts`;
    const hosts = [...new Set(list.map((h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean))];
    const bad = hosts.find((h) => !SERVER.test(h));
    if (bad) return `${bad} isn't a host name (host or host:port)`;
    this.save(null, { ...this.load(null), servers: hosts });
    return undefined;
  }

  private asOf(kind: OtherHost, scope: string | null): HostAs | undefined {
    const s = this.load(scope)[kind];
    if (!s?.token) return undefined;
    return { kind, auth: authOf(kind, s), key: scope ?? 'office', ...(s.who ? { who: s.who } : {}) };
  }

  /**
   * How the office acts on `kind` for `accountId`: with their own token, else the office's, else a
   * reason they can act on. Without an account (an office on the shared password), the office's.
   */
  as(accountId: string | undefined, kind: OtherHost): HostAs | string {
    const label = hostLabel(kind);
    if (accountId) {
      const mine = ACCOUNT_ID.test(accountId) ? this.asOf(kind, accountId) : undefined;
      if (mine) return mine;
    }
    const office = this.asOf(kind, null);
    if (office) return office;
    return accountId ? `Set your ${label} token first (${SIGN_INS}): the office acts on ${label} as you` : `The office has no ${label} token yet: set it in ${SIGN_INS}`;
  }

  /**
   * Credentials to read with when nobody in particular asks (the PR board's polling, an issue
   * source): the office's, else those of the account that set its own most recently.
   */
  anyAs(kind: OtherHost): HostAs | undefined {
    const office = this.asOf(kind, null);
    if (office) return office;
    for (const id of this.accountsNewestFirst()) {
      const a = ACCOUNT_ID.test(id) ? this.asOf(kind, id) : undefined;
      if (a) return a;
    }
    return undefined;
  }

  /** The accounts that keep credentials of their own, the most recently changed first. */
  private accountsNewestFirst(): string[] {
    const homes = path.join(this.dataDir, 'homes');
    let ids: string[];
    try {
      ids = readdirSync(homes).filter((d) => ACCOUNT_ID.test(d));
    } catch {
      return [];
    }
    const at = (id: string) => {
      try {
        return statSync(path.join(homes, id, 'hosting.json')).mtimeMs;
      } catch {
        return -1;
      }
    };
    return ids.map((id) => ({ id, t: at(id) })).filter((x) => x.t >= 0).sort((a, b) => b.t - a.t).map((x) => x.id);
  }

  /** Checks a token with the host and keeps it, with whom it belongs to. Resolves to why not. */
  async set(scope: string | null, input: HostCredentialInput): Promise<string | undefined> {
    const kind = input.kind;
    if (!OTHER_HOSTS.includes(kind)) return 'Unknown host';
    const token = String(input.token ?? '').trim();
    if (!TOKEN.test(token)) return `That doesn't look like a ${hostLabel(kind)} token`;
    const email = input.email ? String(input.email).trim() : undefined;
    if (email && !EMAIL.test(email)) return "That doesn't look like an e-mail address";
    if (kind === 'bitbucket' && !email) return 'Bitbucket needs the e-mail of your Atlassian account with an API token';
    const org = input.org ? String(input.org).trim().replace(/^https?:\/\/dev\.azure\.com\//i, '').replace(/\/.*$/, '') : undefined;
    if (kind === 'azure' && (!org || !AZ_ORG.test(org))) return 'Azure DevOps needs the organization the token is for (dev.azure.com/<organization>)';
    const saved: SavedHost = { token, ...(email ? { email } : {}), ...(kind === 'azure' ? { org } : {}) };
    const provider = this.providers[kind];
    if (!provider) return `${hostLabel(kind)} isn't supported yet`;
    try {
      const who = await provider.whoAmI({ kind, auth: authOf(kind, saved), key: scope ?? 'office' }, this.fetch, { org });
      if (who) saved.who = who;
    } catch (err) {
      return (err as Error).message.replace(/Your .* sign-in stopped working.*$/, `${hostLabel(kind)} turned that token down`);
    }
    this.save(scope, { ...this.load(scope), [kind]: saved });
    return undefined;
  }

  clear(scope: string | null, kind: OtherHost) {
    const saved = this.load(scope);
    if (!saved[kind]) return;
    delete saved[kind];
    this.save(scope, saved);
  }

  /** What a browser may know: for each host, whether `accountId` and the office have a token, and whose. */
  state(accountId: string | undefined, admin: boolean): HostingState {
    const mine = accountId && ACCOUNT_ID.test(accountId) ? this.load(accountId) : {};
    const office = this.load(null);
    const hosts: HostSignIn[] = (['azure', 'bitbucket'] as const).map((kind) => ({
      kind,
      ...(mine[kind]?.token ? { mine: { who: mine[kind]!.who ?? '', ...(mine[kind]!.email ? { email: mine[kind]!.email } : {}), ...(mine[kind]!.org ? { org: mine[kind]!.org } : {}) } } : {}),
      ...(office[kind]?.token ? { office: { who: office[kind]!.who ?? '', ...(office[kind]!.org ? { org: office[kind]!.org } : {}) } } : {}),
    }));
    return { hosts, admin, servers: this.serverHosts() };
  }

  /**
   * `env` for git run as `accountId` (or the office) on a repository on Azure DevOps or Bitbucket:
   * the office's credential helper (bin/office-git-credential.js) with their tokens, then the
   * office's. Unchanged when the helper isn't installed (writeOfficeCommands hasn't run: tests).
   */
  gitEnv(env: Record<string, string>, accountId: string | undefined): Record<string, string> {
    const helper = path.join(this.dataDir, 'bin', 'office-git-credential');
    if (!existsSync(helper)) return env;
    const files = [...(accountId && ACCOUNT_ID.test(accountId) ? [this.file(accountId)] : []), this.file(null)];
    return withHelperEnv(env, helper, files);
  }

  /**
   * `env` for git that only reads and that nobody in particular asked for (the office fetching a
   * worktree's base branch): the helper with the office's tokens, then those of the accounts that set
   * their own, the most recent first, as the boards read (anyAs).
   */
  readGitEnv(env: Record<string, string>): Record<string, string> {
    const helper = path.join(this.dataDir, 'bin', 'office-git-credential');
    if (!existsSync(helper)) return env;
    return withHelperEnv(env, helper, [this.file(null), ...this.accountsNewestFirst().map((id) => this.file(id))]);
  }

  /** Whether `accountId` (or the office) has any credentials for `kind`. */
  has(accountId: string | undefined, kind: OtherHost): boolean {
    return typeof this.as(accountId, kind) !== 'string';
  }

  /** Whether the file is there at all (tests, and the credential helper's config). */
  exists(scope: string | null): boolean {
    return existsSync(this.file(scope));
  }
}
