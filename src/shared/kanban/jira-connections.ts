// The office's Jira connections (docs/kanban-architecture.md §6): each a site, an e-mail and an API
// token kept in kanban-secrets.json, so projects can use different Jira instances (or different
// accounts on one). A Jira issue source names its connection, or takes the first one for its site.
// The browser only ever learns a connection's id, name and site, never its e-mail or token.
// protocol.ts joins these messages into the kanban's unions and calls parseJiraConnectionMsg for any
// type in JIRA_CONNECTION_CLIENT_TYPE_LIST. They are all `kanban.secrets.jira.*`, so the guest filter's
// `kanban.secrets` prefix keeps them from visitors.

import { KANBAN_LIMITS, bad, optText, text, type Obj, type Req } from './validate.js';

/** Where a Jira call goes: the site, and the connection a source chose (none: the first for the site). */
export interface JiraAt {
  site: string;
  connection?: string;
}

/** What the browser may know about one connection. */
export interface JiraConnectionStatus {
  id: string;
  /** What people call it ("Customer X"); the site when none was given. */
  name: string;
  site: string;
  /** Whether its token is set (it always is for a saved one). */
  configured: boolean;
}

/** What the browser may know about the secrets: whether they're set, never what they are. */
export interface SecretStatus {
  /** The Jira connections, oldest first. */
  jira: JiraConnectionStatus[];
  /** The key for the loopback /api/v1 compatibility API (jira-loop, jira-kanban-feeder). */
  apiKey: { configured: boolean };
}

export const JIRA_CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_JIRA_CONNECTIONS = 20;
export const JIRA_CONNECTION_NAME_MAX = 60;
const JIRA_SITE_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

/** A Jira site as a host name (`https://x.atlassian.net/` → `x.atlassian.net`), or undefined when it isn't one. */
export function cleanJiraSite(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const site = v.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return site && site.length <= 200 && JIRA_SITE_RE.test(site) ? site : undefined;
}

/** Whether two sites are the same one. */
export const sameJiraSite = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export type JiraConnectionClientMsg =
  /**
   * Adds a connection (no id: name, site, e-mail and token all needed) or changes one (by id: what isn't
   * given stays, but a new site needs its token again, so a token never goes to a site it wasn't given
   * for). Admins; answered with kanban.settings.
   */
  | Req<{ t: 'kanban.secrets.jira.set'; id?: string; name: string; site: string; email?: string; token?: string }>
  /** Removes a connection (admins); answered with kanban.settings. */
  | Req<{ t: 'kanban.secrets.jira.remove'; id: string }>
  /** Asks Jira who the connection signs in as (admins); answered with kanban.secrets.jiraTested. */
  | Req<{ t: 'kanban.secrets.jira.test'; id: string }>;

export type JiraConnectionServerMsg = { t: 'kanban.secrets.jiraTested'; rid?: string; id: string; name: string; accountId?: string };

export const JIRA_CONNECTION_CLIENT_TYPE_LIST: Readonly<Record<JiraConnectionClientMsg['t'], true>> = {
  'kanban.secrets.jira.set': true,
  'kanban.secrets.jira.remove': true,
  'kanban.secrets.jira.test': true,
};

type Bare<T> = T extends unknown ? Omit<T, 'rid'> : never;

const connectionId = (v: unknown): string => (typeof v === 'string' && JIRA_CONNECTION_ID_RE.test(v) ? v : bad('id must be a Jira connection id'));

/** Checks the fields of a connection message (its type is already known to be in the list) and rebuilds it. */
export function parseJiraConnectionMsg(t: JiraConnectionClientMsg['t'], r: Obj): Bare<JiraConnectionClientMsg> {
  switch (t) {
    case 'kanban.secrets.jira.remove':
    case 'kanban.secrets.jira.test':
      return { t, id: connectionId(r.id) };
    case 'kanban.secrets.jira.set': {
      const site = cleanJiraSite(text(r.site, 'The Jira site', 200)) ?? bad('The Jira site is a host name, like yourteam.atlassian.net');
      const name = (optText(r.name, 'The name', JIRA_CONNECTION_NAME_MAX) ?? '').trim();
      const email = optText(r.email, 'The Jira e-mail', 320)?.trim();
      const token = optText(r.token, 'The Jira API token', KANBAN_LIMITS.secret)?.trim();
      const id = r.id === undefined ? undefined : connectionId(r.id);
      if (!id && (!email || !token)) bad('A new Jira connection needs the e-mail and the API token');
      return { t, ...(id ? { id } : {}), name, site, ...(email ? { email } : {}), ...(token ? { token } : {}) };
    }
  }
}
