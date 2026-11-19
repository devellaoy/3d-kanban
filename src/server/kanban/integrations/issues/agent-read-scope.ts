// Which Jira source an agent's read of a ticket goes through (agent-read.ts), and whether the task prompt
// may tell the worker it can read one. Pure: nothing is asked of Jira here.

import { cleanJiraSite, sameJiraSite } from '../../../../shared/kanban/jira-connections.js';
import type { IssueSourceConfig } from '../../../../shared/kanban/types.js';
import type { JiraConnection } from '../../secrets.js';
import { JIRA_KEY_RE, jiraCovers, keyProject } from './browse/jql.js';
import { pickJiraConnection } from './jira-auth.js';

export type JiraSource = Extract<IssueSourceConfig, { kind: 'jira' }>;

/** The host of a ticket's link, as a Jira site (undefined when it isn't a link). */
export function urlSite(ticketUrl: string | undefined): string | undefined {
  if (!ticketUrl) return undefined;
  try {
    return cleanJiraSite(new URL(ticketUrl).host);
  } catch {
    return undefined;
  }
}

const names = (s: JiraSource, key: string) => s.projectKeys.some((k) => k.toUpperCase() === keyProject(key));

/** A refusal: 403 when the scope says no, 409 when only the connection is missing. */
export interface ReadRefusal { status: 403 | 409; error: string }

/**
 * The project's Jira sources as a read may use them: named ones as they are, an open one (no project keys) only for the Jira
 * projects the project's tasks already have tickets in (`tickets`), and dropped when there are none.
 */
export function jiraReadScope(sources: readonly IssueSourceConfig[], tickets: Iterable<string | undefined>): JiraSource[] {
  const known = new Set<string>();
  for (const t of tickets) if (t && JIRA_KEY_RE.test(t)) known.add(keyProject(t));
  const out: JiraSource[] = [];
  for (const s of sources) {
    if (s.kind !== 'jira') continue;
    if (s.projectKeys.length) out.push(s);
    else if (known.size) out.push({ ...s, projectKeys: [...known] });
  }
  return out;
}

/** The scoped Jira source `key` is read through (see jiraReadScope), or why it can't be. */
export function jiraReadSource(scoped: readonly JiraSource[], connections: readonly JiraConnection[], key: string, ticketUrl?: string): JiraSource | ReadRefusal {
  if (!JIRA_KEY_RE.test(key)) return { status: 403, error: `${key} isn't a Jira issue key` };
  let candidates = scoped.filter((s) => jiraCovers(s, key));
  if (!candidates.length) return { status: 403, error: `${key} isn't inside one of the project's Jira sources: nothing was asked of Jira` };
  // The ticket's own link pins the site, so the same key on two sites can't be read from the wrong one.
  const site = urlSite(ticketUrl);
  if (site) {
    candidates = candidates.filter((s) => sameJiraSite(s.site, site));
    if (!candidates.length) return { status: 403, error: `${key}'s link is on ${site}, where the project has no Jira source that covers it: nothing was asked of Jira` };
  }
  const source = candidates.find((s) => names(s, key)) ?? candidates[0];
  try {
    pickJiraConnection(connections, { site: source.site, ...(source.connection ? { connection: source.connection } : {}) });
  } catch (err) {
    return { status: 409, error: (err as Error).message };
  }
  return source;
}

/**
 * Whether the task prompt should tell the worker it can read its own ticket: the read would be served, through a source that
 * names the key's project or, for an open one, sits on the ticket link's site. `tickets` are the project's tasks' tickets.
 */
export function jiraReadAdvertised(sources: readonly IssueSourceConfig[], connections: readonly JiraConnection[], ticket: string | undefined, ticketUrl: string | undefined, tickets: Iterable<string | undefined>): boolean {
  if (!ticket || !JIRA_KEY_RE.test(ticket)) return false;
  // The ticket is the project's own, so its Jira project is known whatever the tasks say.
  const source = jiraReadSource(jiraReadScope(sources, [...tickets, ticket]), connections, ticket, ticketUrl);
  if ('error' in source) return false;
  const was = sources.find((s) => s.id === source.id);
  const site = urlSite(ticketUrl);
  return (!!was && was.kind === 'jira' && names(was, ticket)) || (!!site && sameJiraSite(site, source.site));
}
