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

/** Whether a Jira source covers a key: its project keys hold the key's project, or it names none (it then reads every project). */
export const jiraCovers = (s: Pick<JiraConfig, 'projectKeys'>, key: string): boolean => !s.projectKeys.length || s.projectKeys.some((k) => k.toUpperCase() === keyProject(key));

export const JQL_INCOMPLETE = 'The JQL must be a complete expression (balanced parentheses and quotes)';
export const JQL_BACKSLASH = 'A backslash is only allowed inside quotes in the JQL';

/**
 * The only functions the user's JQL may call. Others read beyond the scope (`issueFunction`, `membersOf`,
 * `linkedIssues`, the versions of every project) and would show other projects' data under the shared token.
 */
export const JQL_FUNCTIONS = ['currentUser', 'openSprints', 'closedSprints', 'futureSprints', 'subTaskIssueTypes', 'standardIssueTypes', 'now', 'startOfDay', 'endOfDay', 'startOfWeek', 'endOfWeek', 'startOfMonth', 'endOfMonth', 'startOfYear', 'endOfYear'];
export const JQL_FUNCTIONS_ERROR = `The JQL can only use these functions: ${JQL_FUNCTIONS.map((f) => `${f}()`).join(', ')}`;
/** Words that sit before a parenthesis without being a function call. */
const BEFORE_PAREN = new Set(['and', 'or', 'not', 'in', 'was']);

/**
 * Refuses user JQL that isn't one complete expression: an unclosed quote, parentheses that don't
 * balance (`x) OR (project = B` would break out of the scope), or an ORDER BY (the office sorts).
 * It walks the text, skipping "…" and '…' literals and their escapes. A backslash outside a literal is
 * refused: Jira reads `\"` there too, which would hide a quote from this walk (and so the scope's end).
 * A function call (a name before a parenthesis, quoted or not) is refused unless it is in JQL_FUNCTIONS.
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
      if (/^\s*\(/.test(jql.slice(i + 1))) throw new Error(JQL_FUNCTIONS_ERROR);
      outside += ' ';
      continue;
    }
    if (ch === '\\') throw new Error(JQL_BACKSLASH);
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) throw new Error(JQL_INCOMPLETE);
    outside += ch;
  }
  if (depth !== 0) throw new Error(JQL_INCOMPLETE);
  for (const [, name] of outside.matchAll(/([^\s()"',=!<>~]+)\s*\(/g)) {
    const n = name.toLowerCase();
    if (!BEFORE_PAREN.has(n) && !JQL_FUNCTIONS.some((f) => f.toLowerCase() === n)) throw new Error(JQL_FUNCTIONS_ERROR);
  }
  if (/\border\s+by\b/i.test(outside)) throw new Error('The JQL can’t have ORDER BY: the office sorts by the last update');
}

/** Where in the tree the issues are wanted. */
export interface JqlWhere {
  /** A fix version id, or `none`. */
  version?: string;
  /** An epic's key (its issues), or `none` (issues with no parent that aren't epics). */
  epic?: string;
  /** A parent's key: its sub-tasks. */
  parent?: string;
  /** Leave sub-tasks out (the tree shows them under their parent). */
  topLevel?: boolean;
  /** Sub-tasks (of these parents, or of any when empty) that match the filters. A sub-task has no version or epic of its own: its parent's decide, so those clauses are left out. */
  subtasksOf?: string[];
  /** With topLevel: the issues that match the filters, or are one of these keys (a story that has a matching sub-task). */
  orKeys?: string[];
  /** Only these keys (which of a page's stories match the filters). */
  keys?: string[];
  /** Leave out the clauses Jira may refuse (the key search of a text, the Epic exclusion): the retry after a 400. */
  lenient?: boolean;
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
 * Whether the filters narrow the search beyond the version and the epic (a status category other than
 * "all", a text, type, status, assignee, labels, sprint or raw JQL). A narrowed page also brings the
 * matching sub-tasks of its stories (jira.ts).
 */
export function narrows(f: BrowseFilters): boolean {
  return !!((f.statusCategory ?? 'open') !== 'all' || f.q?.trim() || f.issueType || f.status || f.assignee || f.labels?.length || f.sprint || f.jql?.trim());
}

/** Whether anything but the status category narrows the search (see narrows). */
export const narrowsBeyondCategory = (f: BrowseFilters): boolean => narrows({ ...f, statusCategory: 'all' });

/** Whether a text looks like a key of one of the scope's projects (so `key = "X-1"` is a clause Jira accepts: it 400s for a project that doesn't exist, as in "UTF-8"). */
export const keyLike = (q: string, scope: Pick<JiraConfig, 'projectKeys'>): boolean => JIRA_KEY_RE.test(q) && scope.projectKeys.some((k) => k.toUpperCase() === keyProject(q));

const SUBTASK = 'issuetype in subTaskIssueTypes()';

/** A fix version clause. */
const versionClause = (v: string): string => (idOr(v, 'none', 'The version') === 'none' ? 'fixVersion is EMPTY' : `fixVersion = ${v}`);

/** An epic clause: an epic's issues, or the ones with no parent (an epic has none either: see browseJql). */
const epicClause = (e: string): string => (e === 'none' ? 'parent is EMPTY' : `parent = ${keyOf(e)}`);

/** The filters as JQL clauses (not the scope, the version, the epic or the raw JQL). */
function filterClauses(scope: Pick<JiraConfig, 'projectKeys'>, f: BrowseFilters, lenient: boolean): string[] {
  const out: string[] = [];
  const q = f.q?.trim();
  if (q) out.push(!lenient && keyLike(q, scope) ? `(text ~ ${jqlQuote(q)} OR key = ${jqlQuote(q.toUpperCase())})` : `text ~ ${jqlQuote(q)}`);
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
  if (f.sprint) out.push(idOr(f.sprint, 'open', 'The sprint') === 'open' ? 'sprint in openSprints()' : `sprint = ${f.sprint}`);
  const a = f.assignee;
  if (a) out.push('id' in a ? `assignee = ${jqlQuote(a.id)}` : 'none' in a ? 'assignee is EMPTY' : 'assignee is not EMPTY');
  return out;
}

/**
 * The query for the filters in `where`, always inside the scope's project keys (it throws when the
 * source has none). `order: false` for a count, which takes no ORDER BY.
 */
export function browseJql(scope: Pick<JiraConfig, 'projectKeys'>, filters: BrowseFilters, where: JqlWhere = {}, order = true): string {
  const extra = filters.jql?.trim();
  if (extra) checkUserJql(extra);
  const sub = !!where.subtasksOf;
  const mine = [...filterClauses(scope, filters, !!where.lenient), ...(extra ? [`(${extra})`] : [])];
  const parts = [scopeClause(scope)];
  // A story with a matching sub-task is listed too, though its own clauses may not match: the filters, or one of the keys.
  if (where.orKeys?.length && mine.length) parts.push(`((${mine.join(' AND ')}) OR key in (${where.orKeys.map(keyOf).join(', ')}))`);
  else parts.push(...mine);
  if (where.keys) parts.push(`key in (${where.keys.map(keyOf).join(', ')})`);
  if (where.topLevel) parts.push('issuetype not in subTaskIssueTypes()');
  // `parent is EMPTY` is true of an epic too: "No epic" doesn't list the epics themselves. Jira refuses a type that doesn't exist (a site with no "Epic"), hence lenient; the page also drops epics by their level.
  if (where.topLevel && !where.lenient && !sub && (where.epic === 'none' || filters.epic === 'none')) parts.push('issuetype != Epic');
  if (sub) {
    parts.push(SUBTASK);
    if (where.subtasksOf!.length) parts.push(`parent in (${where.subtasksOf!.map(keyOf).join(', ')})`);
  } else {
    // A sub-task has no version or epic of its own: its parent's decide, so a query for sub-tasks leaves them out.
    for (const v of [filters.version, where.version]) if (v) parts.push(versionClause(v));
    for (const e of [filters.epic, where.epic]) if (e) parts.push(epicClause(e));
  }
  if (where.parent) parts.push(`parent = ${keyOf(where.parent)}`);
  return `${parts.join(' AND ')}${order ? ' ORDER BY updated DESC' : ''}`;
}
