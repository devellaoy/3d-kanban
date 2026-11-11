import './windows.css';
import type { GhIssue, GhIssueDetail } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, timeAgo } from '../dom';
import { iconButton } from '../icons';
import { btn, detailsRail, outLink } from '../kit';
import { issueMeeting } from '../meeting';
import { providerPicker } from '../provider';
import { modalShell, openShell } from '../shell';
// Which of the project's repositories an issue is in (github/ghrepo.ts), and the queue's task for a card from the issue sources.
import { ghLabel, ghUrl, sameItem } from './ghrepo';
import { taskForCard } from '../../kanban/issuecards';
import { getJson } from './api';
import { openClose } from './close';
import { commentBox } from './comment-box';
import { labelButton, labelChip } from './labels';
import { avatar, commentCard, errorBox, issuePill, railButton, railStack, sectionHead, spinnerRow } from './pieces';
import { issueContext, issuePrompt, type BoardActions } from './prompts';

// ---- The issue window -----------------------------------------------------------------------------

/**
 * For a card from the issue sources (kanban/issuecards.ts): its status and assignee actions at the top of
 * the rail (`reload` fetches the issue again after one), its comments posted by its key, and the way to
 * its kanban task.
 */
export interface IssueWindowExtras {
  extra?: (it: GhIssue, reload: () => void) => Node;
  postComment?: (body: string) => Promise<void>;
  /** Opens the kanban task made from it (the footer's "Task #N"). */
  openTask?: (id: number) => void;
  /** The window closed. */
  closed?: () => void;
}

/**
 * The window of a GitHub issue: the shared shell with its number, state and author in the header, the
 * description and the comments in the body, its people, labels and the ways to hand it to a worker in
 * the rail, and closing it and its kanban task in the footer.
 */
export function openIssue(first: GhIssue, net: Net, actions: BoardActions, extras: IssueWindowExtras = {}) {
  let it = first;
  const itemUrl = it.url;
  // Which of the project's repositories it's in (none: the floor's own, as upstream).
  const repo = first.repo;
  const label = ghLabel(it.number, repo);
  let detail: GhIssueDetail | null = null;
  let error = '';
  const state = h('span.iw-slot');
  const meta = h('span.iw-meta');
  const desc = h('section.iw-sec');
  const thread = h('section.iw-sec');
  const comment = commentBox('issue', it.number, itemUrl, net, (c) => {
    if (!detail) return load();
    detail.comments.push(c);
    render();
  }, repo, extras.postComment && { post: extras.postComment, sent: () => load() });
  // The rail and the footer stay put and renderFrame only shows, hides and relabels, so a board refresh
  // never pulls focus out of the provider picker.
  const details = h('div.iw-details');
  const closeIssue = btn('Close issue', { kind: 'quiet', icon: 'circle-check', attrs: { title: 'Close this issue on GitHub', onclick: () => openClose('issue', it, net, load) } });
  const queueProvider = providerPicker(store.project, `issue-provider-${it.number}`, 'Queue on');
  const addIssueToQueue = () => {
    if (!queueProvider.valid()) return;
    modal.close();
    actions.queue(issuePrompt(it), `#${it.number} ${it.title}`, it.number, queueProvider.value(), queueProvider.model(), queueProvider.effort());
  };
  const queueText = h('span');
  const queue = railButton('', 'list', addIssueToQueue);
  queue.append(queueText);
  const carry = actions.pickUp;
  const pickUp = carry ? railButton('Pick it up', 'hand', () => carry(it), 'Carry its card to an empty desk, a worker or the queue board, and press E there') : null;
  const assign = () => actions.assign(issuePrompt(it), `Hand issue #${it.number} to a worker`);
  // Planned, built and reviewed on the kanban by a worker at a free desk: the window's main button where the office has it.
  const kanban = actions.kanbanTask;
  const start = kanban
    ? btn('Create and start', { kind: 'primary', icon: 'play', attrs: { title: 'A kanban task for it (plan → implement → review), started at a free desk', onclick: () => (modal.close(), kanban(it)) } })
    : btn('Hand to a worker', { kind: 'primary', icon: 'bot', attrs: { onclick: assign } });
  const toTask = h('button.link-btn.iw-task-link.hidden', { type: 'button', title: 'Open the kanban task made from it', onclick: () => it.taskId && (modal.close(), extras.openTask?.(it.taskId)) }) as HTMLButtonElement;
  const refresh = iconButton('refresh-cw', 'Refresh', { title: 'Refresh: read it from GitHub again' });
  const shell = modalShell({
    cls: 'iw w840',
    kind: 'rich',
    title: it.title,
    label: `Issue ${label}`,
    id: outLink(repo ? `${repo.split('/').pop()} #${it.number}` : label, it.url, { title: 'Open it on GitHub' }),
    pill: state,
    meta: [meta],
    tools: [refresh],
    body: h('div.iw-main', {}, desc, thread, comment.el),
    rail: [
      extras.extra?.(first, () => load()) ?? null,
      details,
      h('hr.rail-sep'),
      railStack(
        'Hand it to a worker',
        kanban ? railButton('Hand to a worker', 'bot', assign, 'A worker starts on it at a free desk, outside the kanban') : null,
        railButton('Ask a worker', 'message-square', () => actions.ask(issueContext(it), `Ask about issue #${it.number}`), 'Send a worker your own prompt about this issue'),
        railButton('Meeting', 'users', () => actions.meeting(issueMeeting(it.number, it.title)), 'Workers take it on together in the meeting room: a debate, lead & team, map-reduce or red / blue'),
        pickUp,
        queueProvider.element,
        queue,
      ),
    ],
    footerLeft: [outLink('Open on GitHub', it.url)],
    footerRight: [closeIssue, toTask, start],
  });
  const renderFrame = () => {
    const isOpen = it.state === 'OPEN';
    shell.setTitle(it.title);
    state.replaceChildren(issuePill(isOpen));
    meta.replaceChildren(h('b', {}, it.author), ` opened this ${timeAgo(it.createdAt)}`);
    details.replaceChildren(
      detailsRail([
        { label: 'Author', value: h('span.iw-with-icon', {}, avatar(it.author), it.author) },
        { label: 'Assignees', value: it.assignees.length ? it.assignees.join(', ') : extras.extra ? null : h('span.iw-none', {}, 'Nobody') },
        { label: 'Labels', value: h('span.iw-labels', {}, ...it.labels.map(labelChip), labelButton('issue', () => it, net, (labels) => ((it = { ...it, labels }), renderFrame()))) },
        { label: 'Updated', value: timeAgo(it.updatedAt) },
      ]),
    );
    const task = it.key ? taskForCard(it) : store.taskForIssue(it.number); // a card from the issue sources by its key
    const onQueue = !!task && task.status !== 'done';
    closeIssue.classList.toggle('hidden', !isOpen);
    pickUp?.classList.toggle('hidden', !isOpen);
    queueProvider.element.classList.toggle('hidden', !isOpen || onQueue);
    queue.classList.toggle('hidden', !isOpen);
    queue.disabled = onQueue;
    queue.title = onQueue ? '' : 'A worker picks it up by itself when a desk is free and there is room under the worker limit';
    queueText.textContent = onQueue ? (task!.status === 'running' ? `${task!.workerName ?? 'A worker'} is on it` : 'On the queue') : 'Add to queue';
    // A card that already has its kanban task leads to it, where the office can open one from here.
    const hasTask = !!it.taskId && !!extras.openTask;
    toTask.textContent = hasTask ? `Task #${it.taskId}` : '';
    toTask.classList.toggle('hidden', !hasTask);
    start.classList.toggle('hidden', hasTask && !!kanban);
  };
  const render = () => {
    desc.replaceChildren(sectionHead('Description'), commentCard({ id: 'body', author: it.author, body: detail?.body ?? it.body, createdAt: it.createdAt, url: it.url }, itemUrl, 'opened this', { role: 'Author' }));
    thread.replaceChildren(sectionHead('Comments', detail?.comments.length));
    if (error) thread.append(errorBox(error, load));
    else if (!detail) thread.append(spinnerRow('Loading comments…'));
    else if (!detail.comments.length) thread.append(h('p.gh-quiet', {}, 'No comments yet.'));
    else thread.append(...detail.comments.map((c) => commentCard(c, itemUrl, '', c.author === it.author ? { role: 'Author' } : {})));
  };
  let generation = 0;
  function load() {
    const g = ++generation;
    error = '';
    render();
    getJson<GhIssueDetail>(ghUrl(`/api/gh/issue?number=${it.number}`, repo))
      .then((d) => {
        if (g !== generation) return;
        detail = d;
        it = { ...it, state: d.state };
        comment.setViewer(d.viewer);
      })
      .catch((err) => g === generation && (error = (err as Error).message))
      .finally(() => g === generation && (renderFrame(), render()));
  }
  const unsubs = [
    store.on('issues', () => {
      const fresh = store.issues.items.find((i) => sameItem(i, it)); // in its repository
      if (!fresh) return;
      // The board can lag behind a close made from here.
      it = detail ? { ...fresh, state: fresh.state === 'OPEN' ? detail.state : fresh.state } : fresh;
      renderFrame();
    }),
    store.on('queue', renderFrame),
  ];
  const modal = openShell(shell, {
    doing: `📋 reading issue ${label}`,
    onClose: () => {
      comment.dispose();
      unsubs.forEach((u) => u());
      extras.closed?.();
    },
  });
  refresh.addEventListener('click', () => load());
  renderFrame();
  load();
}
