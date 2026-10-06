// Azure DevOps and Bitbucket credentials, per account and the office's own (server/hosting/credentials.ts).
// A token goes from the browser to the office once and never comes back.

import type { OtherHost } from '../hosting/remote.js';

export interface HostCredentialInput {
  kind: OtherHost;
  token: string;
  /** Bitbucket Cloud: the Atlassian account's e-mail (Basic auth with an API token). */
  email?: string;
  /** Azure DevOps: the organization the token is for (dev.azure.com/<org>). */
  org?: string;
}

export interface HostSignIn {
  kind: OtherHost;
  /** Set when the account has its own token: whom the host said it belongs to. */
  mine?: { who: string; email?: string; org?: string };
  /** Set when the office has one of its own. */
  office?: { who: string; org?: string };
}

export interface HostingState {
  hosts: HostSignIn[];
  /** Whether this person may set the office's own (admins, and an office without accounts). */
  admin: boolean;
  /** The Bitbucket Server / Data Center hosts the office knows of. */
  servers: string[];
}

export type HostingClientMsg =
  | { t: 'hosting.get' }
  /** `office`: the office's own (admins only); else the account's. Answered with hosting.saved. */
  | { t: 'hosting.set'; kind: OtherHost; office?: boolean; token: string; email?: string; org?: string }
  | { t: 'hosting.clear'; kind: OtherHost; office?: boolean }
  /** Admins: the Bitbucket Server / Data Center hosts to recognise in remotes. */
  | { t: 'hosting.servers'; hosts: string[] };

export type HostingServerMsg =
  | { t: 'hosting'; state: HostingState }
  | { t: 'hosting.saved'; kind: OtherHost | 'servers'; error?: string };
