// The kanban's secrets (<officeData>/.agent-office/kanban-secrets.json, chmod 600): the Jira
// connections and the /api/v1 key. Never sent to a browser: it only ever gets status().

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JIRA_CONNECTION_ID_RE, JIRA_CONNECTION_NAME_MAX, MAX_JIRA_CONNECTIONS, cleanJiraSite, sameJiraSite } from '../../shared/kanban/jira-connections.js';
import type { SecretStatus } from '../../shared/kanban/types.js';
import { writeAtomic } from './settings.js';

/** One Jira connection as kept: where, who, and the token. */
export interface JiraConnection {
  id: string;
  name: string;
  site: string;
  email: string;
  token: string;
}

/** What setJiraConnection takes: no id adds one (then e-mail and token are needed). */
export interface JiraConnectionInput {
  id?: string;
  name: string;
  site: string;
  email?: string;
  token?: string;
}

interface SecretsFile {
  /** Oldest first. A file from before there were several held one `jira: {site, email, token}` instead (read as id "jira", never written again). */
  jiraConnections: JiraConnection[];
  /** hashApiKey of the /api/v1 key (a file from before hashing may hold the key itself). */
  apiKey?: string;
}

/** How the /api/v1 key is kept: `sha256:<hex>`, so even the secrets file doesn't give it away. */
export function hashApiKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** The connection a stored record is, or undefined when it can't be one. */
function readConnection(v: unknown): JiraConnection | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const site = cleanJiraSite(r.site);
  if (typeof r.id !== 'string' || !JIRA_CONNECTION_ID_RE.test(r.id) || !site || typeof r.email !== 'string' || typeof r.token !== 'string' || !r.token) return undefined;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, JIRA_CONNECTION_NAME_MAX) : '';
  return { id: r.id, name: name || site, site, email: r.email, token: r.token };
}

let connectionSeq = 0;
const newConnectionId = () => `jc-${Date.now().toString(36)}${(connectionSeq++).toString(36)}`;

/** Tokens the integrations need, in kanban-secrets.json with only the office's user able to read it. */
export class KanbanSecrets {
  private secrets: SecretsFile = { jiraConnections: [] };
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'kanban-secrets.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      // No list yet: the one legacy connection, under a stable id.
      const list = Array.isArray(raw.jiraConnections) ? raw.jiraConnections : 'jiraConnections' in raw ? [] : [{ ...(raw.jira as object), id: 'jira' }];
      for (const c of list.map(readConnection)) if (c && !this.secrets.jiraConnections.some((x) => x.id === c.id) && this.secrets.jiraConnections.length < MAX_JIRA_CONNECTIONS) this.secrets.jiraConnections.push(c);
      if (typeof raw.apiKey === 'string' && raw.apiKey) this.secrets.apiKey = raw.apiKey;
    } catch {
      // none yet
    }
  }

  /** What the browser may know: the connections' id, name and site, and whether the API key is set. */
  status(): SecretStatus {
    return { jira: this.secrets.jiraConnections.map(({ id, name, site }) => ({ id, name, site })), apiKey: { configured: !!this.secrets.apiKey } };
  }

  /** The Jira connections with their tokens (copies), oldest first. */
  jiraConnections(): JiraConnection[] {
    return this.secrets.jiraConnections.map((c) => ({ ...c }));
  }

  /** Adds a connection or changes one; a string is why not, and nothing is saved then. */
  setJiraConnection(input: JiraConnectionInput): SecretStatus | string {
    const site = cleanJiraSite(input.site);
    if (!site) return 'The Jira site is a host name, like yourteam.atlassian.net';
    const name = (input.name ?? '').trim().slice(0, JIRA_CONNECTION_NAME_MAX) || site;
    const list = this.secrets.jiraConnections;
    if (input.id === undefined) {
      if (!input.email || !input.token) return 'A new Jira connection needs the e-mail and the API token';
      if (list.length >= MAX_JIRA_CONNECTIONS) return `There can be ${MAX_JIRA_CONNECTIONS} Jira connections at most`;
      list.push({ id: newConnectionId(), name, site, email: input.email, token: input.token });
    } else {
      const i = list.findIndex((c) => c.id === input.id);
      if (i < 0) return 'No such Jira connection';
      const old = list[i];
      // A login never goes to a site it wasn't given for: a new site needs the e-mail and the token again.
      if (!sameJiraSite(old.site, site) && (!input.token || !input.email)) return 'A new Jira site needs the e-mail and the API token again';
      list[i] = { id: old.id, name, site, email: input.email || old.email, token: input.token || old.token };
    }
    this.save();
    return this.status();
  }

  /** Removes a connection; a string is why not. */
  removeJiraConnection(id: string): SecretStatus | string {
    const i = this.secrets.jiraConnections.findIndex((c) => c.id === id);
    if (i < 0) return 'No such Jira connection';
    this.secrets.jiraConnections.splice(i, 1);
    this.save();
    return this.status();
  }

  /** The /api/v1 key as kept: hashApiKey of it (see checkApiKey). */
  apiKey(): string | undefined {
    return this.secrets.apiKey;
  }

  /** Whether `key` is the /api/v1 key, compared in constant time. */
  checkApiKey(key: string | undefined): boolean {
    const kept = this.secrets.apiKey;
    if (!kept || !key) return false;
    const want = Buffer.from(kept.startsWith('sha256:') ? kept : hashApiKey(kept));
    const got = Buffer.from(hashApiKey(key));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Sets or (null) clears the /api/v1 key. */
  set(patch: { apiKey?: string | null }): SecretStatus {
    if (patch.apiKey === null) delete this.secrets.apiKey;
    else if (typeof patch.apiKey === 'string') this.secrets.apiKey = hashApiKey(patch.apiKey);
    this.save();
    return this.status();
  }

  // Always the list, even empty, and never the legacy `jira`: removing the last connection must not bring it back on a restart.
  private save() {
    writeAtomic(this.file, `${JSON.stringify(this.secrets, null, 2)}\n`, 0o600);
  }
}
