// The JQL of the browse window (pure). The scope is the source's project keys, always first and
// never optional: the token is the whole site's, so a query that left the keys out (or a user's JQL
// that broke out of them) would read other projects. Every filter value is quoted with jqlQuote, and
// the user's own JQL is checked by checkUserJql, then AND-ed in parentheses.

import type { BrowseFilters } from '../../../../../shared/kanban/browse.js';
import type { IssueSourceConfig } from '../../../../../shared/kanban/types.js';
import { jqlQuote } from '../jira.js';

type JiraConfig = Extract<IssueSourceConfig, { kind: 'jira' }>;

/** A Jira issue key; anything else never goes into a URL or a query. */
export const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** The project a Jira key belongs to (`UYT-12` → `UYT`). */
export const keyProject = (key: string): string => key.slice(0, key.lastIndexOf('-')).toUpperCase();

export const JQL_INCOMPLETE = 'The JQL must be a complete expression (balanced parentheses and quotes)';
export const JQL_BACKSLASH = 'A backslash is only allowed inside quotes in the JQL';

/**
 * Refuses user JQL that isn't one complete expression: an unclosed quote, parentheses that don't
 * balance (`x) OR (project = B` would break out of the scope), or an ORDER BY (the office sorts).
 * It walks the text, skipping "…" and '…' literals and their escapes. A backslash outside a literal is
 * refused: Jira reads `\"` there too, which would hide a quote from this walk (and so the scope's end).
 */
export function checkUserJql(jql: string): void {
  let depth = 0;
  let outside = '';
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (ch === '"' || ch === "'") {
      let closed = false;
      for (i++; i < jql.length; i++) {
        if (jql[i] === '\\') i++;
        else if (jql[i] === ch) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error(JQL_INCOMPLETE);
      outside += ' ';
      continue;
    }
    if (ch === '\\') throw new Error(JQL_BACKSLASH);
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) throw new Error(JQL_INCOMPLETE);
    outside += ch;
  }
  if (depth !== 0) throw new Error(JQL_INCOMPLETE);
  if (/\border\s+by\b/i.test(outside)) throw new Error('The JQL can’t have ORDER BY: the office sorts by the last update');
}

/** Where in the tree the issues are wanted. */
export interface JqlWhere {
  /** A fix version id, or `none`. */
  version?: string;
  /** An epic's key (its issues), or `none` (issues with no parent). */
  epic?: string;
  /** A parent's key: its sub-tasks. */
  parent?: string;
  /** Leave sub-tasks out (the tree shows them under their parent). */
  topLevel?: boolean;
}

/** `project IN (…)`: the scope, which a source without project keys doesn't have. */
export function scopeClause(scope: Pick<JiraConfig, 'projectKeys'>): string {
  if (!scope.projectKeys.length) throw new Error('Add project keys to the Jira source to browse it');
  return `project IN (${scope.projectKeys.map(jqlQuote).join(', ')})`;
}

function idOr(v: string, other: string, name: string): string {
  if (v === other) return other;
  if (!/^\d{1,20}$/.test(v)) throw new Error(`${name} must be an id`);
  return v;
}

function keyOf(v: string): string {
  if (!JIRA_KEY_RE.test(v)) throw new Error(`${v} isn’t a Jira issue key`);
  return jqlQuote(v);
}

/**
 * Whether the filters narrow the search beyond the status category, the version and the epic (a text,
 * type, status, assignee, labels, sprint or raw JQL). A narrowed search doesn't leave sub-tasks out:
 * it finds the ones that match, and the page sends their parents with them (jira.ts).
 */
export function narrows(f: BrowseFilters): boolean {
  return !!(f.q?.trim() || f.issueType || f.status || f.assignee || f.labels?.length || f.sprint || f.jql?.trim());
}

const SUBTASK = 'issuetype in subTaskIssueTypes()';

/** A fix version clause. `relaxed`: a sub-task with no version of its own passes too (its parent's versions decide, after the search). */
function versionClause(v: string, relaxed: boolean): string {
  if (idOr(v, 'none', 'The version') === 'none') return 'fixVersion is EMPTY';
  return relaxed ? `(fixVersion = ${v} OR (${SUBTASK} AND fixVersion is EMPTY))` : `fixVersion = ${v}`;
}

/** An epic clause. `relaxed`: every sub-task passes too (the epic of its parent decides, after the search). */
function epicClause(e: string, relaxed: boolean): string {
  const base = e === 'none' ? 'parent is EMPTY' : `parent = ${keyOf(e)}`;
  return relaxed ? `(${base} OR ${SUBTASK})` : base;
}

/** The filters as JQL clauses (not the scope). */
function filterClauses(f: BrowseFilters, relaxed = false): string[] {
  const out: string[] = [];
  const q = f.q?.trim();
  if (q) out.push(JIRA_KEY_RE.test(q) ? `(text ~ ${jqlQuote(q)} OR key = ${jqlQuote(q.toUpperCase())})` : `text ~ ${jqlQuote(q)}`);
  switch (f.statusCategory ?? 'open') {
    case 'open':
      out.push('statusCategory != Done');
      break;
    case 'new':
      out.push('statusCategory = "To Do"');
      break;
    case 'indeterminate':
      out.push('statusCategory = "In Progress"');
      break;
    case 'done':
      out.push('statusCategory = Done');
      break;
  }
  if (f.status) out.push(`status = ${jqlQuote(f.status)}`);
  if (f.issueType) out.push(`issuetype = ${jqlQuote(f.issueType)}`);
  for (const l of f.labels ?? []) out.push(`labels = ${jqlQuote(l)}`);
  if (f.version) out.push(versionClause(f.version, relaxed));
  if (f.sprint) out.push(idOr(f.sprint, 'open', 'The sprint') === 'open' ? 'sprint in openSprints()' : `sprint = ${f.sprint}`);
  if (f.epic) out.push(epicClause(f.epic, relaxed));
  const a = f.assignee;
  if (a) out.push('id' in a ? `assignee = ${jqlQuote(a.id)}` : 'none' in a ? 'assignee is EMPTY' : 'assignee is not EMPTY');
  return out;
}

/**
 * The query for the filters in `where`, always inside the scope's project keys (it throws when the
 * source has none). `order: false` for a count, which takes no ORDER BY.
 */
export function browseJql(scope: Pick<JiraConfig, 'projectKeys'>, filters: BrowseFilters, where: JqlWhere = {}, order = true): string {
  // A top-level page of a narrowed search keeps the sub-tasks that match (see narrows).
  const relaxed = !!where.topLevel && narrows(filters);
  const parts = [scopeClause(scope), ...filterClauses(filters, relaxed)];
  if (where.topLevel && !relaxed) parts.push('issuetype not in subTaskIssueTypes()');
  if (where.version) parts.push(versionClause(where.version, relaxed));
  if (where.epic) parts.push(epicClause(where.epic, relaxed));
  if (where.parent) parts.push(`parent = ${keyOf(where.parent)}`);
  const extra = filters.jql?.trim();
  if (extra) {
    checkUserJql(extra);
    parts.push(`(${extra})`);
  }
  return `${parts.join(' AND ')}${order ? ' ORDER BY updated DESC' : ''}`;
}
