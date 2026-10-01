// Actions on one Jira issue, with the same site, e-mail and API token the issue source reads with
// (the token is one for everybody, so a comment is signed with who wrote it): its transitions (the
// project's own workflow, whatever its statuses are called), its comments, and its assignee.
// Every function throws an Error with a text a person can act on.

import type { IssueAssignTo, IssueCommentItem, IssuePerson, IssueTransition } from '../../../../shared/kanban/issueops.js';
import { adfToText } from './jira.js';
import { attribution, type IssueActIo } from './source.js';

const TIMEOUT_MS = 30_000;
/** How many comments one read brings (the newest). */
const COMMENTS = 50;
const PEOPLE = 20;
/** A Jira issue key; anything else never goes into a URL. */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** One call to the Jira REST API of `site`; resolves to the JSON answer ({} when it has none). */
export async function jiraCall(io: IssueActIo, site: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> {
  const jira = io.jira;
  if (!jira) throw new Error('Jira isn’t set up: an admin enters the site, e-mail and API token in ⚙️ Settings → 🗂️ Kanban');
  // The token only ever goes to the site it was given for.
  if (jira.site.toLowerCase() !== site.toLowerCase()) throw new Error(`The Jira API token is for ${jira.site}, not ${site}`);
  const auth = Buffer.from(`${jira.email}:${jira.token}`).toString('base64');
  const res = await io.fetch(`https://${jira.site}${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const said = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].map(String).join('; ');
    if (res.status === 401 || res.status === 403) throw new Error(`Jira turned the e-mail and API token down (${res.status})${said ? `: ${said}` : ''}`);
    throw new Error(`Jira said ${res.status}${said ? `: ${said}` : ''}`);
  }
  return parsed;
}

const issuePath = (key: string) => {
  if (!KEY_RE.test(key)) throw new Error(`${key} isn’t a Jira issue key`);
  return `/rest/api/3/issue/${encodeURIComponent(key)}`;
};

/** Plain text as the API's rich text: a paragraph per blank-line block, a line break per single newline. */
export function textToAdf(text: string): unknown {
  const blocks = text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  return {
    type: 'doc',
    version: 1,
    content: blocks.map((block) => {
      const content: unknown[] = [];
      block.split('\n').forEach((line, i) => {
        if (i) content.push({ type: 'hardBreak' });
        if (line) content.push({ type: 'text', text: line });
      });
      return { type: 'paragraph', content };
    }),
  };
}

/** The moves open to the issue now, as the project's workflow has them. `needs` are the fields the move asks for. */
export async function jiraTransitions(io: IssueActIo, site: string, key: string): Promise<IssueTransition[]> {
  const body = await jiraCall(io, site, 'GET', `${issuePath(key)}/transitions?expand=transitions.fields`);
  const out: IssueTransition[] = [];
  for (const t of body.transitions ?? []) {
    if (!t || (typeof t.id !== 'string' && typeof t.id !== 'number')) continue;
    // Fields with a default fill themselves in; the office can't ask for the others.
    const needs = Object.values<any>(t.fields ?? {})
      .filter((f) => f?.required && !f.hasDefaultValue)
      .map((f) => String(f.name ?? f.key ?? 'a field'));
    const to = String(t.to?.name ?? t.name ?? '');
    out.push({
      id: String(t.id),
      name: String(t.name ?? to),
      to,
      ...(t.to?.statusCategory?.name ? { group: String(t.to.statusCategory.name) } : {}),
      ...(needs.length ? { needs } : {}),
    });
  }
  return out;
}

/** Moves the issue by one of its transitions; resolves to the status it is in now. */
export async function jiraTransition(io: IssueActIo, site: string, key: string, transitionId: string): Promise<string> {
  // Asked again so an id that isn't open (any more) is refused here, and the move's status is known.
  const t = (await jiraTransitions(io, site, key)).find((x) => x.id === transitionId);
  if (!t) throw new Error(`${key} can’t be moved that way (any more): reload its statuses`);
  if (t.needs?.length) throw new Error(`Moving ${key} to ${t.to} needs ${t.needs.join(', ')}: do it in Jira`);
  await jiraCall(io, site, 'POST', `${issuePath(key)}/transitions`, { transition: { id: transitionId } });
  return t.to;
}

/** The newest comments, oldest first. */
export async function jiraComments(io: IssueActIo, site: string, key: string): Promise<IssueCommentItem[]> {
  const body = await jiraCall(io, site, 'GET', `${issuePath(key)}/comment?orderBy=-created&maxResults=${COMMENTS}`);
  return (body.comments ?? [])
    .map((c: any): IssueCommentItem => ({
      id: String(c.id),
      author: String(c.author?.displayName ?? 'Someone'),
      body: adfToText(c.body),
      createdAt: String(c.created ?? ''),
      url: `https://${site}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(String(c.id))}`,
    }))
    .reverse();
}

/** Adds a comment, signed with who asked (the token is everybody's). */
export async function jiraComment(io: IssueActIo, site: string, key: string, text: string): Promise<void> {
  const doc = textToAdf(`${text.trim()}\n\n${attribution(io.who)}`);
  await jiraCall(io, site, 'POST', `${issuePath(key)}/comment`, { body: doc });
}

/** Who the issue can be assigned to, matching `query`. */
export async function jiraPeople(io: IssueActIo, site: string, key: string, query = ''): Promise<IssuePerson[]> {
  const qs = `issueKey=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&maxResults=${PEOPLE}`;
  const body = await jiraCall(io, site, 'GET', `/rest/api/3/user/assignable/search?${qs}`);
  return (Array.isArray(body) ? body : [])
    .filter((u: any) => u?.accountId && u.accountType !== 'app')
    .map((u: any): IssuePerson => ({ id: String(u.accountId), name: String(u.displayName ?? u.accountId), ...(u.avatarUrls?.['48x48'] ? { avatar: String(u.avatarUrls['48x48']) } : {}) }));
}

/** Assigns the issue to a person by account id, or to nobody. Resolves to the new assignee's name. */
export async function jiraAssign(io: IssueActIo, site: string, key: string, to: IssueAssignTo): Promise<string | undefined> {
  // The token is shared, so the office can't tell which Jira user `me` is: the browser sends the account id it remembers.
  if (to && 'me' in to) throw new Error('The office doesn’t know which Jira user you are: pick yourself in the list and pin it as “This is me”');
  await jiraCall(io, site, 'PUT', `${issuePath(key)}/assignee`, { accountId: to ? to.id : null });
  if (!to) return undefined;
  const now = await jiraCall(io, site, 'GET', `${issuePath(key)}?fields=assignee`);
  return String(now.fields?.assignee?.displayName ?? to.id);
}
