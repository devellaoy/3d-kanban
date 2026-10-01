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
/** GitHub has no "To do" / "In progress" state: its issues are open or closed, so a GitHub board offers only these. */
const GITHUB_CATS: BrowseStatusFilter[] = ['open', 'done', 'all'];
/** The status categories a scope offers. */
export const catsFor = (scope: BrowseScope): [BrowseStatusFilter, string][] => (scope.kind === 'github-project' ? CATS.filter(([v]) => GITHUB_CATS.includes(v)) : CATS);
/** A remembered status category the scope doesn't offer (a "To do" kept on a GitHub board) falls back to Not done. */
export const catOf = (cat: BrowseStatusFilter, scope: BrowseScope): BrowseStatusFilter => (catsFor(scope).some(([v]) => v === cat) ? cat : 'open');
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

/** Why "Me" can't be resolved on a scope. */
export const meWhy = (scope: BrowseScope): string => (scope.kind === 'jira' ? PIN_FIRST : 'Your own GitHub sign-in isn’t known to the office');

/**
 * "Me" is set but can't be resolved (the pin was cleared, the GitHub login is unknown): the filters
 * go back to Anyone, so the tree and the select agree. Returns the notice to show, or undefined.
 */
export function dropUnresolvedMe(s: Saved, scope: BrowseScope, me: { id: string; name: string } | undefined): string | undefined {
  if (s.who !== 'me' || me) return undefined;
  s.who = '';
  return `“Me” isn’t available: ${meWhy(scope)}`;
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
