// The DOM-free part of 🔎 Browse issues (browse.ts): what its filters are set to, how that is kept
// per project and source in this browser, and the BrowseFilters the office is sent from it.

import type { IssuePerson } from '../../shared/kanban/issueops.js';
import type { BrowseFilters, BrowseScope, BrowseStatusFilter } from '../../shared/kanban/browse.js';
import { pinnedMe } from './issueactionsmodel';

/** What the filters are set to, as remembered. `who` picks the assignee filter; `person` is the someone picked. */
export interface Saved {
  q: string;
  cat: BrowseStatusFilter;
  status: string;
  who: '' | 'me' | 'none' | 'any' | 'person';
  person?: { id: string; name: string };
  type: string;
  labels: string;
  version: string;
  sprint: string;
  iteration: string;
  epic: string;
  jql: string;
  jqlOn: boolean;
}

export const DEFAULTS: Saved = {
  q: '',
  cat: 'open',
  status: '',
  who: '',
  type: '',
  labels: '',
  version: '',
  sprint: '',
  iteration: '',
  epic: '',
  jql: '',
  jqlOn: false,
};
export const CATS: [BrowseStatusFilter, string][] = [
  ['open', 'Not done'],
  ['new', 'To do'],
  ['indeterminate', 'In progress'],
  ['done', 'Done'],
  ['all', 'Any status'],
];
export const PIN_FIRST = 'Pin yourself first: 📌 This is me in an issue’s Assignee';
export const SEARCH_MS = 300;

export const savedKey = (project: string, scope: string) => `kb-browse:${project}:${scope}`;
export const scopeKey = (project: string) => `kb-browse-scope:${project}`;
export function recall<T>(key: string): T | undefined {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
export function keep(key: string, v: unknown) {
  try {
    localStorage.setItem(key, typeof v === 'string' ? v : JSON.stringify(v));
  } catch {
    // Storage off: the filters are just not remembered.
  }
}
export const recallScope = (project: string) => {
  try {
    return localStorage.getItem(scopeKey(project)) ?? '';
  } catch {
    return '';
  }
};

/** Whom "Me" stands for on a scope: the pinned person of the Jira site, or the asker's own GitHub login. */
export function meOf(scope: BrowseScope, github: string | undefined): { id: string; name: string } | undefined {
  if (scope.kind === 'github-project') return github ? { id: github, name: github } : undefined;
  const me: IssuePerson | undefined = scope.site ? pinnedMe(scope.site) : undefined;
  return me ? { id: me.id, name: me.name } : undefined;
}

/** The filters the office is sent, from what is set. */
export function toFilters(s: Saved, scope: BrowseScope, me: { id: string; name: string } | undefined): BrowseFilters {
  const jira = scope.kind === 'jira';
  const labels = s.labels
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  const assignee = s.who === 'none' ? { none: true as const } : s.who === 'any' ? { any: true as const } : s.who === 'me' ? me : s.who === 'person' ? s.person : undefined;
  return {
    ...(s.q.trim() ? { q: s.q.trim() } : {}),
    statusCategory: s.cat,
    ...(s.status ? { status: s.status } : {}),
    ...(assignee ? { assignee } : {}),
    ...(s.type ? { issueType: s.type } : {}),
    ...(labels.length ? { labels } : {}),
    ...(jira && s.version ? { version: s.version } : {}),
    ...(jira && s.sprint ? { sprint: s.sprint } : {}),
    ...(!jira && s.iteration ? { iteration: s.iteration } : {}),
    ...(s.epic ? { epic: s.epic } : {}),
    ...(jira && s.jqlOn && s.jql.trim() ? { jql: s.jql.trim() } : {}),
  };
}
