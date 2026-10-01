// Browsing ALL of a project's issues (docs/kanban-architecture.md §6), not just what the issue
// sources list: the Jira site's issues of the source's project keys, and the items of a GitHub
// Projects v2 board. The messages are stateless and paged: a cursor is Jira's `nextPageToken` or
// GitHub's `endCursor`, opaque to the browser, and every request names one browsable source of the
// project (its `scope`: the IssueSourceConfig id) and never reaches wider than that one.
//
// issueops.ts joins these into the kanban's unions (protocol.ts and types.ts stay as they are), and
// calls parseBrowseMsg for any type in BROWSE_CLIENT_TYPE_LIST.

import type { NormalizedIssue } from './types.js';
import { KANBAN_LIMITS, PERSON_ID_RE, bad, isObj, optOneOf, optText, project, text, list, type Obj, type Req } from './validate.js';

/** The sources of a project that can be browsed. */
export type BrowseKind = 'jira' | 'github-project';

/** A source of the project as the browse window offers it. */
export interface BrowseScope {
  /** IssueSourceConfig.id. */
  id: string;
  kind: BrowseKind;
  label: string;
  /** The Jira site. */
  site?: string;
  /** Why it can't be browsed ("Add project keys to the Jira source to browse it"); the window lists it greyed out. */
  disabled?: string;
}

/** Jira's status categories, which GitHub items are mapped onto too (closed = done). */
export type StatusCategory = 'new' | 'indeterminate' | 'done';
/** What the "status category" filter chooses between; `open` (the default) is everything not done. */
export const BROWSE_STATUS_FILTERS = ['open', 'new', 'indeterminate', 'done', 'all'] as const;
export type BrowseStatusFilter = (typeof BROWSE_STATUS_FILTERS)[number];

/** Who the issue is assigned to, as a filter: a Jira account id or GitHub login, nobody, or anybody. The browser resolves "me" to an id first. */
export type BrowseAssignee = { id: string; name?: string } | { none: true } | { any: true };

/** The filters of the browse window. Every field is optional; none means "no filter" (statusCategory: open). */
export interface BrowseFilters {
  /** Free text (Jira `text ~`; the issue key too when it looks like one). */
  q?: string;
  statusCategory?: BrowseStatusFilter;
  /** A status name. */
  status?: string;
  assignee?: BrowseAssignee;
  issueType?: string;
  labels?: string[];
  /** A Jira fix version id, or `none`. */
  version?: string;
  /** A Jira sprint id, or `open`. */
  sprint?: string;
  /** A GitHub project iteration's title. */
  iteration?: string;
  /** A Jira epic's key, or `none`. */
  epic?: string;
  /** Jira only: extra JQL, AND-ed inside the source's project scope. */
  jql?: string;
}

/** One issue of a browse page: the usual record, with what the tree needs. */
export type BrowseIssue = NormalizedIssue & {
  /** "Story", "Bug", "Epic"; GitHub's issue type. */
  issueType?: string;
  /** Jira's hierarchy level of the type: 1 an epic, 0 a story or task, -1 a sub-task. */
  hierarchy?: number;
  subtask?: boolean;
  statusCategory?: StatusCategory;
  fixVersions?: { id: string; name: string }[];
  sprints?: { id: string; name: string; state: string }[];
  /** A GitHub project's iteration (its title). */
  iteration?: string;
  /** The issue above this one (Jira's `parent`: the epic of a story, the story of a sub-task; GitHub's parent issue). */
  parent?: { key: string; title: string; type?: string; hierarchy?: number; status?: string; statusCategory?: StatusCategory };
  /** Sub-tasks (Jira) or sub-issues (GitHub), and how many are done. */
  childCount?: number;
  childDone?: number;
  /** A GitHub issue's node id, which `kanban.browse.children` needs. */
  nodeId?: string;
};

/** A top-level node of the tree: a fix version, an iteration, a status, or one of the collapsed / empty ones. */
export interface BrowseGroup {
  /**
   * Jira: the version id, `released` (the collapsed node holding the released versions) or `none`.
   * GitHub: `i:<iteration title>`, `s:<status name>`, `completed` (the collapsed node of finished iterations), `no:iteration` or `no:status`.
   * Sent back as `group`.
   */
  id: string;
  title: string;
  kind: 'version' | 'released' | 'iteration' | 'status' | 'none';
  /** A version that has been released. */
  released?: boolean;
  /** Its release date (YYYY-MM-DD). */
  releaseDate?: string;
}

/** What the filter selects offer. Labels and sprints have no list: labels are free text, sprints come from the loaded issues. */
export interface BrowseOptions {
  statuses: { name: string; category: StatusCategory }[];
  issueTypes: string[];
  versions: BrowseGroup[];
  epics: { key: string; title: string }[];
  iterations: string[];
  /** A GitHub board's Status options. */
  statusField?: string[];
}

type ScopeReq<T> = Req<{ project: string; scope: string } & T>;
/** Where in the tree a page or a count is wanted: a group, and in it an epic (`none`: the issues without one). */
interface Where {
  group?: string;
  epic?: string;
}

export type BrowseClientMsg =
  /** The project's browsable sources; answered with kanban.browseScopes. */
  | Req<{ t: 'kanban.browse.scopes'; project: string }>
  /** The filter choices of a source; answered with kanban.browseOptions. */
  | ScopeReq<{ t: 'kanban.browse.options' }>
  /** The top-level groups (kanban.browseGroups), without counts. `released`: the versions (iterations) under the collapsed node. */
  | ScopeReq<{ t: 'kanban.browse.groups'; filters: BrowseFilters; released?: true; cursor?: string }>
  /** One approximate count of a group's (or an epic's) issues; answered with kanban.browseCount. */
  | ScopeReq<{ t: 'kanban.browse.count'; filters: BrowseFilters } & Where>
  /** One page of top-level issues (no sub-tasks) of a group, or of an epic of it; answered with kanban.browsePage. */
  | ScopeReq<{ t: 'kanban.browse.page'; filters: BrowseFilters; cursor?: string } & Where>
  /** The sub-tasks (Jira) or sub-issues (GitHub, by `nodeId`) of an issue; answered with kanban.browsePage. */
  | ScopeReq<{ t: 'kanban.browse.children'; issueKey: string; nodeId?: string; cursor?: string }>
  /** The full record of one issue (and its task, if any); the server keeps it for the actions on it. Answered with kanban.browseIssue. */
  | ScopeReq<{ t: 'kanban.browse.issue'; issueKey: string }>
  /** Who an issue of the source can be assigned to, matching `query`; answered with kanban.issuePeople (its `issueKey` is empty). */
  | ScopeReq<{ t: 'kanban.browse.people'; query?: string }>;

export type BrowseServerMsg =
  /** `me.github`: the asker's own GitHub login, when gh runs as them (for the "Me" filter of a board). */
  | { t: 'kanban.browseScopes'; rid?: string; project: string; scopes: BrowseScope[]; me?: { github?: string } }
  | { t: 'kanban.browseOptions'; rid?: string; project: string; scope: string; options: BrowseOptions }
  | { t: 'kanban.browseGroups'; rid?: string; project: string; scope: string; groups: BrowseGroup[]; next?: string }
  /** `count` is missing when the source couldn't tell (the window shows nothing). */
  | { t: 'kanban.browseCount'; rid?: string; project: string; scope: string; count?: number }
  /** `issueKey`: the parent, for a children page. `total`: GitHub's exact count. */
  | { t: 'kanban.browsePage'; rid?: string; project: string; scope: string; items: BrowseIssue[]; next?: string; total?: number; issueKey?: string }
  | { t: 'kanban.browseIssue'; rid?: string; project: string; scope: string; issue: BrowseIssue };

/** Every browse message the browser may send; issueops.ts spreads it into ISSUE_OPS_CLIENT_TYPE_LIST. */
export const BROWSE_CLIENT_TYPE_LIST: Readonly<Record<BrowseClientMsg['t'], true>> = {
  'kanban.browse.scopes': true,
  'kanban.browse.options': true,
  'kanban.browse.groups': true,
  'kanban.browse.count': true,
  'kanban.browse.page': true,
  'kanban.browse.children': true,
  'kanban.browse.issue': true,
  'kanban.browse.people': true,
};

/** Limits of what the browser may send. */
export const BROWSE_LIMITS = { q: 200, jql: 2000, cursor: 4000, value: 200, labels: 20, people: 100 } as const;
/** An opaque cursor: Jira's page token or GitHub's end cursor. */
export const CURSOR_RE = /^[\w+/=:.-]+$/;
const ID_RE = /^[\w:.-]{1,200}$/;
const NODE_ID_RE = /^[\w=-]{1,200}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

type Bare<T> = T extends unknown ? Omit<T, 'rid'> : never;

/** A value that goes into a query: short, one line, and no double quote (GitHub's board filter has no way to escape it). */
function plain(v: unknown, name: string): string {
  const s = text(v, name, BROWSE_LIMITS.value).trim();
  if (/["\u0000-\u001f]/.test(s)) bad(`${name} can't have quotes or line breaks`);
  return s;
}

const cursor = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > BROWSE_LIMITS.cursor || !CURSOR_RE.test(v)) bad('cursor must be one the server gave');
  return v as string;
};

function assignee(v: unknown): BrowseAssignee {
  if (!isObj(v)) return bad('assignee must be {id}, {none: true} or {any: true}');
  if (v.none === true) return { none: true };
  if (v.any === true) return { any: true };
  if (typeof v.id !== 'string' || !PERSON_ID_RE.test(v.id)) return bad('assignee.id must be a person id');
  const name = optText(v.name, 'assignee.name', 200)?.trim();
  return { id: v.id, ...(name ? { name } : {}) };
}

/** The filters, rebuilt field by field: anything not listed is dropped. */
export function parseBrowseFilters(v: unknown): BrowseFilters {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return bad('filters must be an object');
  const out: BrowseFilters = {};
  const q = optText(v.q, 'The search', BROWSE_LIMITS.q)?.trim();
  if (q) out.q = q;
  const cat = optOneOf(v.statusCategory, 'statusCategory', BROWSE_STATUS_FILTERS);
  if (cat) out.statusCategory = cat;
  for (const k of ['status', 'issueType', 'iteration'] as const) if (v[k] !== undefined && v[k] !== '') out[k] = plain(v[k], k);
  if (v.assignee !== undefined) out.assignee = assignee(v.assignee);
  if (v.labels !== undefined) {
    const labels = list(v.labels, 'labels', BROWSE_LIMITS.labels, (l) => plain(l, 'A label')).filter(Boolean);
    if (labels.length) out.labels = labels;
  }
  if (v.version !== undefined && v.version !== '') {
    if (typeof v.version !== 'string' || !(v.version === 'none' || /^\d{1,20}$/.test(v.version))) bad('version must be a version id or none');
    out.version = v.version as string;
  }
  if (v.sprint !== undefined && v.sprint !== '') {
    if (typeof v.sprint !== 'string' || !(v.sprint === 'open' || /^\d{1,20}$/.test(v.sprint))) bad('sprint must be a sprint id or open');
    out.sprint = v.sprint as string;
  }
  if (v.epic !== undefined && v.epic !== '') {
    if (typeof v.epic !== 'string' || !(v.epic === 'none' || (KEY_RE.test(v.epic) && v.epic.length <= KANBAN_LIMITS.issueKey))) bad('epic must be an issue key or none');
    out.epic = v.epic as string;
  }
  const jql = optText(v.jql, 'The JQL', BROWSE_LIMITS.jql)?.trim();
  if (jql) out.jql = jql;
  return out;
}

function where(r: Obj): Where {
  const group = r.group === undefined ? undefined : plain(r.group, 'group');
  if (group !== undefined && !group) bad('group can’t be empty');
  const epic = r.epic;
  if (epic !== undefined && (typeof epic !== 'string' || !(epic === 'none' || KEY_RE.test(epic)))) bad('epic must be an issue key or none');
  return { ...(group ? { group } : {}), ...(epic !== undefined ? { epic: epic as string } : {}) };
}

/** Checks the fields of a browse message (its type is already known to be in the list) and rebuilds it. */
export function parseBrowseMsg(t: BrowseClientMsg['t'], r: Obj): Bare<BrowseClientMsg> {
  const proj = project(r.project);
  if (t === 'kanban.browse.scopes') return { t, project: proj };
  if (typeof r.scope !== 'string' || !ID_RE.test(r.scope)) bad('scope must be one of the project’s issue sources');
  const scope = r.scope as string;
  const base = { project: proj, scope };
  const issueKey = () => text(r.issueKey, 'issueKey', KANBAN_LIMITS.issueKey).trim();
  switch (t) {
    case 'kanban.browse.options':
      return { t, ...base };
    case 'kanban.browse.groups': {
      const c = cursor(r.cursor);
      if (r.released !== undefined && r.released !== true) bad('released must be true');
      return { t, ...base, filters: parseBrowseFilters(r.filters), ...(r.released ? { released: true as const } : {}), ...(c ? { cursor: c } : {}) };
    }
    case 'kanban.browse.count':
      return { t, ...base, filters: parseBrowseFilters(r.filters), ...where(r) };
    case 'kanban.browse.page': {
      const c = cursor(r.cursor);
      return { t, ...base, filters: parseBrowseFilters(r.filters), ...where(r), ...(c ? { cursor: c } : {}) };
    }
    case 'kanban.browse.children': {
      const c = cursor(r.cursor);
      if (r.nodeId !== undefined && (typeof r.nodeId !== 'string' || !NODE_ID_RE.test(r.nodeId))) bad('nodeId must be a GitHub node id');
      return { t, ...base, issueKey: issueKey(), ...(r.nodeId ? { nodeId: r.nodeId as string } : {}), ...(c ? { cursor: c } : {}) };
    }
    case 'kanban.browse.issue':
      return { t, ...base, issueKey: issueKey() };
    case 'kanban.browse.people': {
      const query = optText(r.query, 'The search', BROWSE_LIMITS.people)?.trim();
      return { t, ...base, ...(query ? { query } : {}) };
    }
  }
}
