import './windows.css';
import type { GhIssue, GhIssueDetail } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, timeAgo } from '../dom';
import { issueMeeting } from '../meeting';
import { providerPicker } from '../provider';
// Which of the project's repositories an issue is in (github/ghrepo.ts), and the queue's task for a card from the issue sources.
import { ghLabel, ghUrl, sameItem } from './ghrepo';
import { taskForCard } from '../../kanban/issuecards';
import { getJson } from './api';
import { openClose } from './close';
import { commentBox } from './comment-box';
import { labelButton, labelChip } from './labels';
import { avatar, commentCard, errorBox, nodes, spinnerRow } from './pieces';
import { issueContext, issuePrompt, type BoardActions } from './prompts';

// ---- The issue window -----------------------------------------------------------------------------

export function openIssue(first: GhIssue, net: Net, actions: BoardActions) {
  let it = first;
  const itemUrl = it.url;
  // Which of the project's repositories it's in (none: the floor's own, as upstream).
  const repo = first.repo;
  const label = ghLabel(it.number, repo);
  let detail: GhIssueDetail | null = null;
  let error = '';
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const pill = h('span.pill');
  const conv = h('div.gh-conv');
  const thread = h('div.gh-items');
  const comment = commentBox('issue', it.number, itemUrl, net, (c) => {
    if (!detail) return load();
    detail.comments.push(c);
    render();
  }, repo);
  conv.append(h('div.gh-col', {}, thread, comment.el));
  // The footer stays put and renderFrame only shows, hides and relabels, so a board refresh never
  // pulls focus out of the provider picker.
  const closeIssue = h('button.btn', { type: 'button', title: 'Close this issue on GitHub', onclick: () => openClose('issue', it, net, load) }, '✔️ Close issue…');
  const queueProvider = providerPicker(store.project, `issue-provider-${it.number}`, 'Queue on');
  const addIssueToQueue = () => {
    if (!queueProvider.valid()) return;
    modal.close();
    actions.queue(issuePrompt(it), `#${it.number} ${it.title}`, it.number, queueProvider.value(), queueProvider.model(), queueProvider.effort());
  };
  const queue = h('button.btn', { type: 'button', onclick: addIssueToQueue }) as HTMLButtonElement;
  const carry = actions.pickUp;
  const pickUp = carry ? h('button.btn', { type: 'button', title: 'Carry its card to an empty desk, a worker or the queue board, and press E there', onclick: () => carry(it) }, '✋ Pick it up') : null;
  const meta = h('div.gh-meta');
  const el = h(
    'div.modal.gh-window.issue',
    { role: 'dialog', 'aria-label': `Issue ${label}` },
    h('header', {}, pill, h('h2', { title: repo ? `${repo}#${it.number} ${it.title}` : it.title }, `${label} ${it.title}`), close),
    meta,
    h('div.gh-body', {}, conv),
    h(
      'footer',
      {},
      h('a.grow', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub ↗'),
      h('button.btn', { type: 'button', title: 'Send a worker your own prompt about this issue', onclick: () => actions.ask(issueContext(it), `Ask about issue #${it.number}`) }, '✍️ Ask a worker…'),
      h('button.btn', { type: 'button', title: 'Workers take it on together in the meeting room: a debate, lead & team, map-reduce or red / blue', onclick: () => actions.meeting(issueMeeting(it.number, it.title)) }, '🤝 Meeting…'),
      closeIssue,
      queueProvider.element,
      queue,
      pickUp,
      // planned, built and reviewed on the kanban, by a worker at a free desk.
      actions.kanbanTask ? h('button.btn', { type: 'button', title: 'A kanban task for it (plan → implement → review), started at a free desk', onclick: () => (modal.close(), actions.kanbanTask!(it)) }, '🗂️ Kanban task') : null,
      h('button.btn.primary', { type: 'button', onclick: () => actions.assign(issuePrompt(it), `Hand issue #${it.number} to a worker`) }, '🤖 Hand to a worker'),
    ),
  );
  const renderFrame = () => {
    const isOpen = it.state === 'OPEN';
    meta.replaceChildren(
      ...nodes(
        avatar(it.author),
        h('b', {}, it.author),
        h('span', {}, `opened this ${timeAgo(it.createdAt)}`),
        it.assignees.length ? h('span', {}, `· 👤 ${it.assignees.join(', ')}`) : null,
        ...it.labels.map(labelChip),
        labelButton('issue', () => it, net, (labels) => ((it = { ...it, labels }), renderFrame())),
      ),
    );
    pill.className = `pill ${isOpen ? 'done' : 'offline'}`;
    pill.textContent = isOpen ? 'open' : 'closed';
    const task = it.key ? taskForCard(it) : store.taskForIssue(it.number); // a card from the issue sources by its key
    const onQueue = !!task && task.status !== 'done';
    closeIssue.classList.toggle('hidden', !isOpen);
    pickUp?.classList.toggle('hidden', !isOpen);
    queueProvider.element.classList.toggle('hidden', !isOpen || onQueue);
    queue.classList.toggle('hidden', !isOpen);
    queue.disabled = onQueue;
    queue.title = onQueue ? '' : 'A worker picks it up by itself when a desk is free and there is room under the worker limit';
    queue.textContent = onQueue ? (task!.status === 'running' ? `🤖 ${task!.workerName ?? 'A worker'} is on it` : '📋 On the queue') : '📋 Add to queue';
  };
  const render = () => {
    thread.replaceChildren(commentCard({ id: 'body', author: it.author, body: detail?.body ?? it.body, createdAt: it.createdAt, url: it.url }, itemUrl, 'opened this'));
    if (error) thread.append(errorBox(error, load));
    else if (!detail) thread.append(spinnerRow('Loading comments…'));
    else if (!detail.comments.length) thread.append(h('p.gh-quiet', {}, 'No comments yet.'));
    else thread.append(...detail.comments.map((c) => commentCard(c, itemUrl, 'commented')));
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
  const modal = openModal(el, {
    doing: `📋 reading issue ${label}`,
    onClose: () => {
      comment.dispose();
      unsubs.forEach((u) => u());
    },
  });
  close.addEventListener('click', () => modal.close());
  renderFrame();
  load();
}
