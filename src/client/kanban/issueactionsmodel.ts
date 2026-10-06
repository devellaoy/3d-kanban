// The DOM-free part of the issue actions (issueactions.ts): which cards get them, what kind of key an
// issue has, the Jira "me" pinned per site, and how the status choices are listed.

import type { IssuePerson, IssueTransition } from '../../shared/kanban/issueops.js';
import { toast } from '../ui/dom';

/** What the panel needs to know of the issue: from the kanban's list, or a 3D card. */
export interface ActionIssue {
  key: string;
  url?: string;
  status?: string;
  assignee?: string;
}

/** A link from a source, only when it's http(s): nothing else goes into an href. */
export function safeUrl(url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : '';
}

/** The panel's view of an issue from the kanban's list (one assignee) or a 3D card (its assignees). */
export function actionIssue(i: { key?: string; url: string; status?: string; assignee?: string; assignees?: string[] }): ActionIssue {
  const assignee = i.assignee ?? (i.assignees?.join(', ') || undefined);
  return { key: i.key ?? '', url: safeUrl(i.url) || undefined, status: i.status, assignee };
}

/**
 * The status to show: the choices' own `current` when they named one (a board's Status option, in the
 * choices' words), else the issue's (a repository copy says OPEN while its board says "In Review").
 */
export const shownStatus = (issueStatus: string | undefined, current: string | undefined) => current ?? issueStatus ?? '—';

/** Whether a move is GitHub's close or reopen, which changes the issue itself (its window fetches it again). */
export const closesOrReopens = (transitionId: string) => transitionId.startsWith('gh:');

/** Whether the key is a GitHub one (`gh:owner/repo#5`, `ghp:owner/1#item`); anything else is Jira's or Azure Boards' (`ab:org/project#5`), where "me" is pinned per site. */
export const isGithubKey = (key: string) => /^ghp?:/.test(key);

/** Where a card's actions go: its key on the floor's project, or nowhere (a card with no key is upstream's own issue, and has none). */
export function actionsTarget(card: { key?: string }, project: string | null | undefined): { project: string; key: string } | undefined {
  return card.key && project ? { project, key: card.key } : undefined;
}

/** A comment on a card, by its key (signed, and put on its task, by the office); undefined: upstream's gh.comment, for a card without a key. */
export function keyedComment(card: { key?: string }, project: string | null | undefined, text: string) {
  const to = actionsTarget(card, project);
  return to ? { t: 'kanban.issue.comment' as const, project: to.project, issueKey: to.key, text } : undefined;
}

/** The Jira site an issue is on, from its link (the pinned "me" is per site). */
export function jiraSite(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

const PIN_KEY = (site: string) => `kb-jira-me:${site}`;

/** The person pinned as "me" on a Jira site, if any. */
export function pinnedMe(site: string): IssuePerson | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY(site)) ?? 'null') as IssuePerson | null;
    return v && typeof v.id === 'string' && typeof v.name === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function setPinnedMe(site: string, who: IssuePerson | undefined) {
  try {
    if (who) localStorage.setItem(PIN_KEY(site), JSON.stringify({ id: who.id, name: who.name }));
    else localStorage.removeItem(PIN_KEY(site));
  } catch {
    toast('This browser can’t remember who you are (storage is off)', 'warn');
  }
}

/** A transition's line in the list: its name, where it leads when that isn't the same, and what it needs. */
export function transitionLabel(t: IssueTransition): string {
  const to = t.to && t.to !== t.name ? ` → ${t.to}` : '';
  return `${t.name}${to}${t.needs?.length ? ` (needs ${t.needs.join(', ')})` : ''}${t.current ? ' ✓' : ''}`;
}

/** The transitions by group, in the order the groups first come. */
export function groupTransitions(ts: readonly IssueTransition[]): [string, IssueTransition[]][] {
  const groups = new Map<string, IssueTransition[]>();
  for (const t of ts) {
    const g = t.group ?? '';
    const list = groups.get(g);
    if (list) list.push(t);
    else groups.set(g, [t]);
  }
  return [...groups];
}
