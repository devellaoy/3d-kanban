// Which Jira source an agent's read of a ticket goes through (agent-read.ts), and whether the task prompt
// may tell the worker it can read one. Pure: nothing is asked of Jira here, and what the office knows of an issue comes in as `known`.

import { cleanJiraSite, sameJiraSite } from '../../../../shared/kanban/jira-connections.js';
import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import type { JiraConnection } from '../../secrets.js';
import { JIRA_KEY_RE, keyProject } from './browse/jql.js';
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

/** The issue the office already knows from Jira under a key (the issues plugin's `find`), if any. */
export type KnownIssue = (key: string) => NormalizedIssue | undefined;

/** The task event that binds a task to the Jira ticket the SERVER itself had from Jira (never a typed value): data is TicketBinding. */
export const TICKET_VERIFIED = 'ticket.verified';
export interface TicketBinding { ticket: string; site: string; source?: string }

/** Whether the task's events hold a server-verified binding of `ticket` (its current one) on `site`. */
export function hasBinding(events: readonly { kind: string; data?: unknown }[], ticket: string, site: string): boolean {
  return events.some((e) => {
    const d = e.kind === TICKET_VERIFIED ? (e.data as Partial<TicketBinding> | null) : undefined;
    return !!d && typeof d.ticket === 'string' && typeof d.site === 'string' && d.ticket.toUpperCase() === ticket.toUpperCase() && sameJiraSite(d.site, site);
  });
}

/** Whether a source is bound to the key (a task's own ticket, see hasBinding): decided by the caller from data it holds. */
export type Bound = (s: JiraSource, key: string) => boolean;

const OPEN_HINT = ' An admin can name the Jira project keys on the source in Settings → Projects → Issue sources to let agents read its tickets.';

/**
 * Whether a read of `key` may go through the source. A source that names project keys covers those projects' keys. An open
 * one (no keys) covers a key only when the office already knows that issue from Jira, on this source's site: what a task's
 * free `ticket` field says never widens the scope. `bound` adds a task's own server-verified ticket on this site.
 */
export function readCovers(s: JiraSource, key: string, known: KnownIssue, bound?: Bound): boolean {
  if (s.projectKeys.length) return names(s, key);
  if (bound?.(s, key)) return true;
  const i = known(key.toUpperCase());
  const site = i && i.source === 'jira' ? urlSite(i.url) : undefined;
  return !!site && sameJiraSite(s.site, site);
}

/** The project's Jira sources. */
export const jiraSourcesOf = (sources: readonly IssueSourceConfig[]): JiraSource[] => sources.filter((s): s is JiraSource => s.kind === 'jira');

/** The Jira source `key` is read through (see readCovers), or why it can't be. */
export function jiraReadSource(sources: readonly JiraSource[], connections: readonly JiraConnection[], key: string, ticketUrl: string | undefined, known: KnownIssue, bound?: Bound): JiraSource | ReadRefusal {
  if (!JIRA_KEY_RE.test(key)) return { status: 403, error: `${key} isn't a Jira issue key` };
  let candidates = sources.filter((s) => readCovers(s, key, known, bound));
  if (!candidates.length) return { status: 403, error: `${key} isn't inside one of the project's Jira sources: nothing was asked of Jira.${sources.some((s) => !s.projectKeys.length) ? OPEN_HINT : ''}` };
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
 * Whether the task prompt should tell the worker it can read its own ticket: a source that NAMES the ticket's Jira project
 * covers it, the ticket link's site (if any) agrees and a connection exists. Open sources are never advertised.
 */
export function jiraReadAdvertised(sources: readonly IssueSourceConfig[], connections: readonly JiraConnection[], ticket: string | undefined, ticketUrl: string | undefined): boolean {
  if (!ticket || !JIRA_KEY_RE.test(ticket)) return false;
  const named = jiraSourcesOf(sources).filter((s) => s.projectKeys.length);
  return !('error' in jiraReadSource(named, connections, ticket, ticketUrl, () => undefined));
}
