// Jira Cloud issues (IssueSourceConfig 'jira'), with the REST API's POST /rest/api/3/search/jql and
// the site, e-mail and API token in kanban-secrets.json. The JQL is built here from the source's
// fields, every value quoted and escaped, so a filter can't change what the query means; the
// user's own extra JQL is AND-ed in parentheses.

import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import { jiraAuthHeader, pickJiraConnection, type JiraConnection } from './jira-auth.js';
import { ISSUE_BODY_MAX, SOURCE_MAX, type IssueSource, type IssueSourceIo } from './source.js';

type JiraConfig = Extract<IssueSourceConfig, { kind: 'jira' }>;

const PAGE = 100;
const FIELDS = ['summary', 'description', 'assignee', 'labels', 'status', 'parent', 'project', 'updated', 'issuetype'];

/** A JQL string literal: in double quotes, with backslashes and quotes escaped. */
export function jqlQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n\t]+/g, ' ')}"`;
}

/** The assignee clause: currentUser() for me, else the account id or e-mail, quoted. */
function assigneeClause(a: string): string {
  const v = a.trim();
  if (/^(@?me|currentuser\(\))$/i.test(v)) return 'assignee = currentUser()';
  return `assignee = ${jqlQuote(v)}`;
}

/**
 * The source's JQL. `epicField` 'parent' (team-managed projects, and Jira Cloud since 2024) or
 * 'Epic Link' (older company-managed projects) is how the epic filter is asked.
 */
export function buildJql(c: Pick<JiraConfig, 'projectKeys' | 'filters'>, epicField: 'parent' | 'Epic Link' = 'parent'): string {
  const f = c.filters;
  const parts: string[] = [];
  if (c.projectKeys.length) parts.push(`project IN (${c.projectKeys.map(jqlQuote).join(', ')})`);
  if (f.assignee) parts.push(assigneeClause(f.assignee));
  if (f.epic) parts.push(`${epicField === 'parent' ? 'parent' : '"Epic Link"'} = ${jqlQuote(f.epic)}`);
  for (const l of f.labels ?? []) parts.push(`labels = ${jqlQuote(l)}`);
  const notIn = f.statusCategoryNot?.length ? f.statusCategoryNot : ['Done'];
  parts.push(notIn.length === 1 ? `statusCategory != ${jqlQuote(notIn[0])}` : `statusCategory NOT IN (${notIn.map(jqlQuote).join(', ')})`);
  const extra = f.jql?.trim();
  if (extra) {
    if (/\border\s+by\b/i.test(extra)) throw new Error('The extra JQL can’t have ORDER BY: the office sorts by the last update');
    parts.push(`(${extra})`);
  }
  return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

/**
 * Atlassian Document Format (the v3 API's rich text) as plain text: paragraphs and headings as
 * lines, lists as "- " / "1. ", code blocks fenced, mentions and links by their text.
 */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  const out = block(node, 0).replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function inline(nodes: unknown[] | undefined): string {
  return (nodes ?? []).map((n) => block(n, 0)).join('');
}

function block(raw: unknown, depth: number): string {
  if (!raw || typeof raw !== 'object') return '';
  const n = raw as { type?: string; text?: string; attrs?: Record<string, any>; content?: unknown[] };
  const kids = n.content ?? [];
  switch (n.type) {
    case 'doc':
      return kids.map((k) => block(k, depth)).join('');
    case 'text':
      return n.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return `${inline(kids)}\n\n`;
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} ${inline(kids)}\n\n`;
    case 'blockquote':
      return `${kids.map((k) => block(k, depth)).join('').trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
    case 'codeBlock':
      return `\`\`\`${n.attrs?.language ?? ''}\n${inline(kids)}\n\`\`\`\n\n`;
    case 'rule':
      return '---\n\n';
    case 'bulletList':
    case 'orderedList': {
      const lines = kids.map((item, i) => {
        const body = ((item as { content?: unknown[] }).content ?? []).map((k) => block(k, depth + 1)).join('').trim();
        const mark = n.type === 'orderedList' ? `${i + 1}.` : '-';
        return `${'  '.repeat(depth)}${mark} ${body.replace(/\n/g, `\n${'  '.repeat(depth + 1)}`)}`;
      });
      return `${lines.join('\n')}\n\n`;
    }
    case 'mention':
      return String(n.attrs?.text ?? '@someone');
    case 'emoji':
      return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return String(n.attrs?.url ?? '');
    case 'date':
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'status':
      return `[${n.attrs?.text ?? ''}]`;
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[attachment]\n\n';
    case 'table':
      return `${kids.map((row) => ((row as { content?: unknown[] }).content ?? []).map((cell) => block(cell, depth).replace(/\s+/g, ' ').trim()).join(' | ')).join('\n')}\n\n`;
    default:
      return kids.length ? kids.map((k) => block(k, depth)).join('') : (n.text ?? '');
  }
}

/** One issue of the search's answer. */
export function jiraIssue(raw: any, site: string, sourceId?: string): NormalizedIssue | undefined {
  if (!raw || typeof raw.key !== 'string') return undefined;
  const f = raw.fields ?? {};
  const parent = f.parent;
  return {
    source: 'jira',
    ...(sourceId ? { sourceId } : {}),
    key: raw.key,
    title: String(f.summary ?? raw.key),
    url: `https://${site}/browse/${encodeURIComponent(raw.key)}`,
    body: adfToText(f.description).slice(0, ISSUE_BODY_MAX),
    ...(f.assignee?.displayName ? { assignee: String(f.assignee.displayName) } : {}),
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
    ...(f.status?.name ? { status: String(f.status.name) } : {}),
    ...(parent?.key ? { epic: String(parent.key) } : {}),
    ...(f.project?.key ? { project: String(f.project.key) } : {}),
    updatedAt: String(f.updated ?? ''),
  };
}

async function search(io: IssueSourceIo, jira: JiraConnection, site: string, jql: string, sourceId?: string): Promise<NormalizedIssue[]> {
  const out: NormalizedIssue[] = [];
  let next: string | undefined;
  for (let page = 0; page < Math.ceil(SOURCE_MAX / PAGE); page++) {
    const res = await io.fetch(`https://${jira.site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { authorization: jiraAuthHeader(jira), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ jql, fields: FIELDS, maxResults: PAGE, ...(next ? { nextPageToken: next } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!res.ok) {
      const said = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].map(String).join('; ');
      if (res.status === 401 || res.status === 403) throw new Error(`Jira turned the e-mail and API token down (${res.status})${said ? `: ${said}` : ''}`);
      throw new JiraQueryError(`Jira said ${res.status}${said ? `: ${said}` : ''}`, res.status);
    }
    for (const raw of body.issues ?? []) {
      const issue = jiraIssue(raw, site, sourceId);
      if (issue) out.push(issue);
    }
    next = typeof body.nextPageToken === 'string' && body.nextPageToken && body.isLast !== true ? body.nextPageToken : undefined;
    if (!next || out.length >= SOURCE_MAX) break;
  }
  return out.slice(0, SOURCE_MAX);
}

class JiraQueryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const jiraSource: IssueSource = {
  async list(config, io: IssueSourceIo) {
    const c = config as JiraConfig;
    // The connection the source names, else the first for its site: the token only ever goes to its own site.
    const jira = pickJiraConnection(io.jira, c);
    if (!c.filters.epic) return search(io, jira, c.site, buildJql(c), c.id);
    // An epic's issues: `parent =` first; older company-managed projects only know "Epic Link".
    try {
      const found = await search(io, jira, c.site, buildJql(c, 'parent'), c.id);
      if (found.length) return found;
    } catch (err) {
      if (!(err instanceof JiraQueryError && err.status === 400)) throw err;
    }
    try {
      return await search(io, jira, c.site, buildJql(c, 'Epic Link'), c.id);
    } catch (err) {
      // No "Epic Link" field on this site: nothing under that epic, then.
      if (err instanceof JiraQueryError && err.status === 400) return [];
      throw err;
    }
  },
};
