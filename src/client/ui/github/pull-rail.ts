import type { GhLabel, GhPull, GhPullDetail } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store, workerForPull } from '../../state';
import { h, timeAgo } from '../dom';
import { btn, detailsRail } from '../kit';
import { officePrompt } from '../prompts';
// The PR review picker (kanban/prpicker.ts): both reviews first ask which of the project's PRs go with it.
import { openReviewPicker } from '../../kanban/prpicker';
import { openClose } from './close';
import { labelButton, labelChip } from './labels';
import { nodes, railButton, railStack, REVIEW_BADGE } from './pieces';
import { pullContext, pullVars, reviewPrompt, type BoardActions } from './prompts';

// The PR window's rail and footer: what is known of the pull request (its worker, review, size, labels)
// and the ways to hand it to a worker; closing and merging it stand in the footer.

export interface PullSide {
  it: GhPull;
  detail: GhPullDetail | null;
  /** How many files it changes, once the diff is read. */
  files: number | null;
  net: Net;
  actions: BoardActions;
  /** What only GitHub has (labels, merging, closing, gh's fix-up prompts) is left out elsewhere. */
  onGitHub: boolean;
  conflicts: boolean;
  /** "Fix via task #N", when a kanban task owns it (kanban/prowner.ts), and that task. */
  owner: HTMLButtonElement | null;
  ownerTask: number | null;
  /** Opens a kanban task, where the page can. */
  openTask?(id: number): void;
  /** A worker fixes it up (or resolves the conflicts) and merges. */
  handToWorker(): void;
  /** The merge dialog. */
  merge(): void;
  reload(): void;
  relabel(labels: GhLabel[]): void;
}

/** "Changes requested · 2 threads": the review decision and the line comments under it. */
function reviewLine(s: PullSide): string | null {
  const threads = s.detail?.reviewComments.filter((c) => !c.replyTo).length ?? 0;
  const said = s.it.reviewDecision ? (REVIEW_BADGE[s.it.reviewDecision]?.[0] ?? s.it.reviewDecision.toLowerCase().replace(/_/g, ' ')) : '';
  return [said, threads ? `${threads} thread${threads === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || null;
}

/** The rail: the details, then the stack of things to hand to a worker. */
export function pullRail(s: PullSide): Node[] {
  const { it, actions, net } = s;
  const isOpen = it.state === 'OPEN';
  const w = workerForPull(store.workers.values(), it);
  const task = s.ownerTask;
  const open = s.openTask;
  const labels = nodes(...it.labels.map(labelChip), s.onGitHub ? labelButton('pull', () => it, net, s.relabel) : null);
  return [
    h('h3.rail-h', {}, 'Details'),
    detailsRail([
      { label: 'Task', value: task ? (open ? h('button.link-btn', { type: 'button', onclick: () => open(task) }, `Task #${task}`) : `Task #${task}`) : null },
      { label: 'Worker', value: w ? h('span.gh-worker', {}, w.name, h('button.link-btn', { type: 'button', onclick: () => actions.goToDesk(w.deskId) }, 'Go to the desk')) : null },
      { label: 'Review', value: reviewLine(s) },
      {
        label: 'Changes',
        value: h('span.gh-pm', {}, h('span.add', {}, `+${it.additions}`), h('span.del', {}, `−${it.deletions}`), s.files === null ? null : h('span.bin', {}, `${s.files} file${s.files === 1 ? '' : 's'}`)),
      },
      { label: 'Labels', value: labels.length ? h('span.iw-labels', {}, ...labels) : null },
      { label: 'Updated', value: timeAgo(it.updatedAt) },
    ]),
    h('hr.rail-sep'),
    railStack(
      'Hand it to a worker',
      isOpen ? railButton('Review', 'eye', () => openReviewPicker(net, it, 'review', () => actions.assign(reviewPrompt(it), `Review PR #${it.number}`)), 'A worker reviews it; first you pick which of the project’s pull requests go with it') : null,
      isOpen && s.onGitHub
        ? railButton('Review panel', 'users', () => openReviewPicker(net, it, 'panel', () => actions.meeting({ pattern: 'review', pr: it.number, title: `Review of PR #${it.number}`, prompt: officePrompt('pull.panel', pullVars(it)) })), 'A few workers review it in the meeting room, each through its own lens, and the office posts one combined review')
        : null,
      !s.onGitHub
        ? null
        : s.conflicts
          ? railButton('Fix conflicts and merge', 'wrench', s.handToWorker, 'A new worker merges the base in, resolves the conflicts, gets the checks green, then merges')
          : isOpen
            ? railButton('Fix comments and merge', 'wrench', s.handToWorker, 'A worker addresses the review comments, gets the checks green, then merges')
            : null,
      isOpen ? s.owner : null,
      railButton('Ask a worker', 'message-square', () => actions.ask(pullContext(it), `Ask about PR #${it.number}`), 'Send a worker your own prompt about this PR'),
    ),
  ];
}

/** The footer's right side: closing it (quiet) and the one primary, Merge (plain while conflicts stand: fixing them comes first). */
export function pullFooter(s: PullSide): Node[] {
  if (s.it.state !== 'OPEN' || !s.onGitHub) return [];
  const { it, net } = s;
  return [
    btn('Close pull request', { kind: 'quiet-danger', icon: 'git-pull-request-closed', attrs: { title: 'Close this pull request without merging it', onclick: () => openClose('pull', it, net, s.reload) } }),
    btn('Merge', { kind: s.conflicts ? 'secondary' : 'primary', icon: 'git-merge', attrs: { disabled: !s.detail, title: s.detail ? 'Merge this pull request' : 'Loading…', onclick: s.merge } }),
  ];
}
