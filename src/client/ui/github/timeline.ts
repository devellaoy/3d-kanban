import type { GhPullDetail } from '../../../shared/protocol';
import { h } from '../dom';
import { icon, type IconName } from '../icons';
import { outLink } from '../kit';
import { when } from './pieces';
import { eventText, type GhCommit, type GhHappening } from './timeline-model';

// What happened to a pull request between its comments, drawn as GitHub's own page does: one quiet line
// each (a small icon in the avatars' column, who, what and when), and a push's commits as a short list.

const STATE_ICON: Record<Extract<GhHappening, { kind: 'state' }>['what'], IconName> = {
  merged: 'git-merge',
  closed: 'git-pull-request-closed',
  reopened: 'git-pull-request',
  ready: 'git-pull-request',
  draft: 'circle-dashed',
};

const EVENT_ICON: Record<Exclude<GhHappening['kind'], 'state' | 'commit'>, IconName> = {
  'force-push': 'upload',
  'review-request': 'eye',
  label: 'tag',
  assign: 'user',
  rename: 'pencil',
  base: 'git-branch',
  branch: 'trash-2',
};

function row(mark: IconName, cls: string, at: string, ...words: (Node | string)[]): HTMLElement {
  return h('div.gh-event', { class: cls }, h('span.gh-event-icon', {}, icon(mark, { size: 14 })), h('span.gh-event-text', {}, ...words), when(at));
}

/** One step of the history as a line: who did what, and when. */
export function eventRow(e: GhHappening): HTMLElement {
  if (e.kind === 'commit') return commitsBlock([e]);
  const mark = e.kind === 'state' ? STATE_ICON[e.what] : e.kind === 'branch' && e.what === 'restored' ? 'undo-2' : EVENT_ICON[e.kind];
  return row(mark, e.kind === 'state' ? e.what : '', e.at, h('strong', {}, e.actor), ` ${eventText(e)}`);
}

/** Commits that came one after another: who added them, then each one's first line and its short sha. */
export function commitsBlock(commits: GhCommit[]): HTMLElement {
  const authors = [...new Set(commits.map((c) => c.author))];
  const who = authors.length > 2 ? `${authors.length} people` : authors.join(' and ');
  return h(
    'div.gh-commits',
    {},
    row('git-commit-horizontal', '', commits[commits.length - 1].at, h('strong', {}, who), commits.length === 1 ? ' added a commit' : ` added ${commits.length} commits`),
    h(
      'ul.gh-commit-list',
      {},
      ...commits.map((c) =>
        h('li', {}, h('span.gh-commit-msg', { title: c.headline }, c.headline), h('a.gh-sha', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: `${c.author}, ${new Date(c.at).toLocaleString()}` }, c.oid.slice(0, 7))),
      ),
    ),
  );
}

/** A quiet line for a history GitHub didn't give (the window then lists by time, without the events). */
export function historyError(d: GhPullDetail): HTMLElement | null {
  return d.historyError ? h('p.gh-quiet.gh-history-note', {}, `Couldn't load the PR's history from GitHub: ${d.historyError}`) : null;
}

/** At the start of the history: where the older part is when the PR has more history than the office read. */
export function historyCut(d: GhPullDetail, url: string): HTMLElement | null {
  return d.historyCut ? h('p.gh-quiet.gh-history-note', {}, outLink('Older history is on GitHub', url)) : null;
}
