// The 3D office's issue cards from the project's issue sources (Settings → Issue sources). A floor
// whose project has any shows their issues on its issues board (server: kanban/integrations/issues/
// wall.ts), each with its ticket key: `gh:owner/repo#12`, `ghp:…` or a Jira key such as `UYT-1415`.
// A card is told apart by that key (shared/kanban/issuecard.ts cardId); one of the floor's own GitHub
// issues keeps upstream's number, prompts and window, and any other gets the prompts and the window here.

import type { AgentEffort, AgentProvider, CarriedIssue, GhIssue, QueueTask } from '../../shared/protocol';
import { cardId, cardLabel, isPrimaryIssue, parseGhKey } from '../../shared/kanban/issuecard.js';
import type { Net } from '../net';
import { store } from '../state';
import { issuePrompt, type BoardActions } from '../ui/boards';
import { h, openModal, toast } from '../ui/dom';
import { markdown } from '../ui/markdown';
import { issueMeeting, type MeetingPreset } from '../ui/meeting';
import { providerPicker } from '../ui/provider';
import { labelChip, openIssue } from '../ui/pull';
import { kanbanApi, type KanbanOk } from './api';
import { issueTask } from './hireform';
import { SOURCE_KIND_NAMES } from './labels';

const primaryRepo = () => store.currentFloor()?.repo;

/** A card as its label and prompts need it: from the board, or carried (then the board fills in the rest). */
type AnyCard = GhIssue | CarriedIssue;

const numberOf = (it: AnyCard) => ('number' in it ? it.number : it.issue);

/** Whether the card is one of the floor's own GitHub issues: upstream's number, prompts and window. */
export function isOwnIssue(it: AnyCard): boolean {
  const n = numberOf(it);
  return !it.key ? n > 0 : isPrimaryIssue({ number: n, key: it.key, repo: 'repo' in it ? it.repo : undefined }, primaryRepo());
}

/** What the card is called: `#12`, `api#12`, `UYT-1415`. */
export function issueCardLabel(it: AnyCard): string {
  return cardLabel({ number: numberOf(it), key: it.key, repo: 'repo' in it ? it.repo : undefined }, primaryRepo());
}

/**
 * What the source said about the card last taken off the board, so the card in your hands still
 * knows its link and text when a refresh of the sources drops it from the board meanwhile.
 */
const carried = new Map<string, GhIssue>();

/** The card in your hands for a board card: the floor's own issue's number (0 for any other), and its key. */
export function cardOfIssue(it: GhIssue): CarriedIssue {
  if (it.key) {
    carried.clear();
    carried.set(cardId(it), it);
  }
  return { issue: isOwnIssue(it) ? it.number : 0, title: it.title, ...(it.key ? { key: it.key } : {}) };
}

/** The board's card for a carried one (undefined once it's gone from the board). */
export function issueOfCard(card: AnyCard): GhIssue | undefined {
  const id = cardId(card);
  return store.issues.items.find((i) => cardId(i) === id);
}

/**
 * Everything known about a card: the board's, else what it said when it was taken, else what its key
 * says (a GitHub issue's link comes from it; a Jira key is all there is to go on).
 */
function sourceOf(card: AnyCard): GhIssue {
  if ('number' in card) return card;
  const known = issueOfCard(card) ?? carried.get(cardId(card));
  if (known) return known;
  const gh = parseGhKey(card.key);
  return {
    number: card.issue,
    title: card.title,
    state: 'OPEN',
    url: gh ? `https://github.com/${gh.repo}/issues/${gh.number}` : '',
    author: '',
    labels: [],
    assignees: [],
    createdAt: '',
    updatedAt: '',
    body: '',
    comments: 0,
    ...(gh ? { repo: gh.repo } : {}),
    ...(card.key ? { key: card.key } : {}),
  };
}

/** What a message about the card says which issue it is: the floor's own issue's number, the source's key. */
export function cardFields(card: CarriedIssue): { issue?: number; issueKey?: string } {
  return { ...(card.issue > 0 ? { issue: card.issue } : {}), ...(card.key ? { issueKey: card.key } : {}) };
}

/** Whether the card's task is on the 📋 queue and not done. */
export function cardOnQueue(card: CarriedIssue): boolean {
  const t = taskForCard({ number: card.issue, key: card.key });
  return !!t && t.status !== 'done';
}

/**
 * The 📋 queue's task for a card: the one not done, else the last one (as state.ts taskForIssue). A
 * card with a key is its task's by that key; one of the floor's own issues also by its number when the
 * task was queued without one (an agent's, or from before). Another repository's #12 is never the floor's.
 */
export function taskForCard(it: { number: number; key?: string }): QueueTask | undefined {
  const own = it.number > 0 && (!it.key || isPrimaryIssue({ number: it.number, key: it.key }, primaryRepo()));
  const tasks = store.queue.tasks.filter((t) => (it.key && t.issueKey === it.key) || (own && !t.issueKey && t.issue === it.number));
  return tasks.find((t) => t.status !== 'done') ?? tasks[tasks.length - 1];
}

/** A board card's chips for where it came from: its source (not for GitHub repositories), its status, its kanban task. */
export function sourceChips(it: GhIssue): (HTMLElement | string)[] {
  return [
    it.source && it.source !== 'github-repo' ? h('span.qchip', {}, SOURCE_KIND_NAMES[it.source]) : '',
    it.status && it.source !== 'github-repo' ? h('span.qchip', {}, it.status) : '',
    it.taskId ? h('span.qchip.done', { title: 'The kanban task made from it' }, `🗂️ #${it.taskId}`) : '',
  ];
}

/** Where a card came from, in a sentence: "Jira UYT-1415", "GitHub issue acme/api#12". */
function sourceName(it: GhIssue): string {
  const gh = parseGhKey(it.key);
  if (gh) return `GitHub issue ${gh.repo}#${gh.number}`;
  if (it.source === 'github-project') return `GitHub project item ${issueCardLabel(it)}`;
  if (it.source === 'jira') return `Jira issue ${it.key}`;
  return `issue ${issueCardLabel(it)}`;
}

/** The task a worker gets for a card that isn't one of the floor's own GitHub issues. */
function sourcePrompt(it: GhIssue): string {
  const gh = parseGhKey(it.key);
  const read = gh ? `Read it first with \`gh issue view ${gh.number} -R ${gh.repo} --comments\`.` : [it.url ? `Source: ${it.url}` : '', it.body.trim()].filter(Boolean).join('\n\n');
  const pr = gh ? `open a pull request that closes ${gh.repo}#${gh.number}` : `open a pull request that mentions ${it.key}`;
  return `Work on ${sourceName(it)}: "${it.title}".\n\n${read}\n\nCreate a new branch, implement the change, verify it, then ${pr}.`;
}

/** The prompt a worker gets for a board card (🤖 Hand to a worker, 📋 Add to queue, a card taken to a desk). */
export function cardIssuePrompt(it: GhIssue): string {
  return isOwnIssue(it) ? issuePrompt(it) : sourcePrompt(it);
}

/** The prompt for a carried card: one of the floor's own issues by its number, any other from what its source said. */
export function cardPrompt(card: CarriedIssue): string {
  if (isOwnIssue(card)) return issuePrompt({ number: card.issue, title: card.title });
  return sourcePrompt(sourceOf(card));
}

/** What 🤝 Meeting about a card starts with. */
export function cardMeeting(card: AnyCard): MeetingPreset {
  const n = numberOf(card);
  if (isOwnIssue(card)) return issueMeeting(n, card.title);
  const it = sourceOf(card);
  const label = issueCardLabel(card);
  const gh = parseGhKey(card.key);
  const read = gh ? `Read it first with gh issue view ${gh.number} -R ${gh.repo} --comments.` : [it.url, it.body.trim()].filter(Boolean).join('\n\n');
  return { title: `${label} ${card.title}`, prompt: `${sourceName(it)}: “${card.title}”. ${read}`.trim() };
}

/**
 * P with a card at an empty desk, or 🗂️ Kanban task: the card's issue as a kanban task, once per ticket.
 * A card from the issue sources goes by the server's kanban.issues.createTask, which makes it from the
 * source's whole text, finds a task already made from it (archived too, or made a moment ago by someone
 * else) and starts one in To do at the desk. Upstream's card (no key) goes as before.
 */
export function cardTask(net: Net, card: AnyCard, deskId: string | undefined, deskLabel: string) {
  const it = sourceOf(card);
  const project = store.floor;
  if (!card.key || !project) return issueTask(net, { number: numberOf(card), title: card.title, url: it.url, body: it.body, ...(it.repo ? { repo: it.repo } : {}) }, deskId, deskLabel);
  const name = issueCardLabel(card);
  kanbanApi(net)
    .request<KanbanOk>({ t: 'kanban.issues.createTask', project, issueKey: card.key, start: true, ...(deskId ? { deskId } : {}) })
    .then((ok) => {
      if (!ok.taskId) return;
      const text = !ok.existed ? `🗂️ ${name} is task #${ok.taskId} now, starting at ${deskLabel}` : ok.started ? `🗂️ ${name} was already task #${ok.taskId}: it starts at ${deskLabel}` : ok.startError ? `🗂️ ${name} is task #${ok.taskId}` : `🗂️ ${name} is already task #${ok.taskId}`;
      const el = toast(ok.startError ? `${text}: ${ok.startError}` : text, ok.startError || (ok.existed && !ok.started) ? 'warn' : 'info');
      // The toasts don't take the mouse; this button does.
      const open = h('button.btn.small', { type: 'button', style: 'pointer-events:auto;margin-left:8px' }, 'open');
      open.addEventListener('click', () => {
        el.remove();
        void import('./taskview').then((m) => m.openTaskWindow(net, ok.taskId!));
      });
      el.append(open);
    })
    .catch((err: Error) => toast(`🗂️ ${err.message}`, 'error'));
}

/** 📋 Add to queue for a card from the issue sources: queued by its key (and the floor's own issue's number). */
function queueCard(net: Net, it: GhIssue, provider?: AgentProvider, model?: string, effort?: AgentEffort) {
  net.send({ t: 'queue.add', prompt: cardIssuePrompt(it), title: `${issueCardLabel(it)} ${it.title}`, ...cardFields(cardOfIssue(it)), provider, model, effort });
}

/**
 * A board card's window. One of the floor's own issues opens upstream's; another of the project's
 * GitHub repositories' too, with its actions going by its key; anything else (Jira, a project's draft,
 * a repository outside the project) this one.
 */
export function openCard(it: GhIssue, net: Net, actions: BoardActions) {
  if (!it.key) return openIssue(it, net, actions);
  // The floor's own issue from the sources: upstream's window and prompts, queued with its key too.
  if (isOwnIssue(it)) return openIssue(it, net, { ...actions, queue: (_prompt, _title, _issue, provider, model, effort) => queueCard(net, it, provider, model, effort) });
  if (it.number > 0) {
    return openIssue(it, net, {
      ...actions,
      queue: (_prompt, _title, _issue, provider, model, effort) => queueCard(net, it, provider, model, effort),
      assign: (_prompt, title) => actions.assign(sourcePrompt(it), title.replace(`#${it.number}`, issueCardLabel(it))),
      ask: (_context, title) => actions.ask(`${sourceName(it)}: “${it.title}”. Read it with gh issue view ${it.number} -R ${parseGhKey(it.key)?.repo ?? it.repo} --comments.`, title.replace(`#${it.number}`, issueCardLabel(it))),
      meeting: () => actions.meeting(cardMeeting(it)),
    });
  }
  openSourceIssue(it, net, actions);
}

/** The window of a card that isn't a GitHub issue of the project: what the source says, and the same actions as upstream's. */
function openSourceIssue(first: GhIssue, net: Net, actions: BoardActions) {
  let it = first;
  const label = issueCardLabel(it);
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const pill = h('span.pill.done', {}, it.source ? SOURCE_KIND_NAMES[it.source] : 'issue');
  const meta = h('div.gh-meta');
  const body = h('div.gh-items');
  const queueProvider = providerPicker(store.project, `issue-provider-${cardId(it)}`, 'Queue on');
  const queue = h('button.btn', { type: 'button' }) as HTMLButtonElement;
  queue.addEventListener('click', () => {
    if (!queueProvider.valid()) return;
    modal.close();
    queueCard(net, it, queueProvider.value(), queueProvider.model(), queueProvider.effort());
  });
  const carry = actions.pickUp;
  const task = h('button.btn', { type: 'button' }) as HTMLButtonElement;
  task.addEventListener('click', () => {
    modal.close();
    if (it.taskId) void import('./taskview').then((m) => m.openTaskWindow(net, it.taskId!));
    else if (actions.kanbanTask) actions.kanbanTask(it);
  });
  const el = h(
    'div.modal.gh-window.issue',
    { role: 'dialog', 'aria-label': `Issue ${label}` },
    h('header', {}, pill, h('h2', { title: `${label} ${it.title}` }, `${label} ${it.title}`), close),
    meta,
    h('div.gh-body', {}, h('div.gh-conv', {}, h('div.gh-col', {}, body))),
    h(
      'footer',
      {},
      it.url ? h('a.grow', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, `Open in ${it.source === 'jira' ? 'Jira' : 'GitHub'} ↗`) : h('span.grow'),
      h('button.btn', { type: 'button', title: 'Send a worker your own prompt about this issue', onclick: () => actions.ask(`${sourceName(it)}: “${it.title}”.${it.url ? ` ${it.url}` : ''}\n\n${it.body.trim()}`.trim(), `Ask about ${label}`) }, '✍️ Ask a worker…'),
      h('button.btn', { type: 'button', title: 'Workers take it on together in the meeting room: a debate, lead & team, map-reduce or red / blue', onclick: () => actions.meeting(cardMeeting(it)) }, '🤝 Meeting…'),
      queueProvider.element,
      queue,
      carry ? h('button.btn', { type: 'button', title: 'Carry its card to an empty desk, a worker or the queue board, and press E there', onclick: () => carry(it) }, '✋ Pick it up') : null,
      actions.kanbanTask || it.taskId ? task : null,
      h('button.btn.primary', { type: 'button', onclick: () => actions.assign(sourcePrompt(it), `Hand ${label} to a worker`) }, '🤖 Hand to a worker'),
    ),
  );
  const render = () => {
    meta.replaceChildren(
      ...[
        it.status ? h('span.pill', {}, it.status) : null,
        it.assignees.length ? h('span', {}, `👤 ${it.assignees.join(', ')}`) : null,
        ...it.labels.map(labelChip),
        it.taskId ? h('span', {}, `🗂️ task #${it.taskId}`) : null,
      ].filter((x): x is HTMLElement => !!x),
    );
    body.replaceChildren(it.body.trim() ? markdown(it.body, it.url) : h('p.gh-quiet', {}, 'No description.'));
    const onQueue = cardOnQueue(cardOfIssue(it));
    queueProvider.element.classList.toggle('hidden', onQueue);
    queue.disabled = onQueue;
    queue.textContent = onQueue ? '📋 On the queue' : '📋 Add to queue';
    queue.title = onQueue ? '' : 'A worker picks it up by itself when a desk is free and there is room under the worker limit';
    task.textContent = it.taskId ? `↗ Task #${it.taskId}` : '🗂️ Kanban task';
    task.title = it.taskId ? 'The kanban task made from it' : 'A kanban task for it (plan → implement → review), started at a free desk';
  };
  const unsubs = [
    store.on('issues', () => {
      const fresh = issueOfCard(it);
      if (!fresh) return;
      it = fresh;
      render();
    }),
    store.on('queue', render),
  ];
  const modal = openModal(el, { doing: `📋 reading issue ${label}`, onClose: () => unsubs.forEach((u) => u()) });
  close.addEventListener('click', () => modal.close());
  render();
}
