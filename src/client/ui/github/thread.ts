import type { GhReviewComment, GhThread } from '../../../shared/protocol';
import type { Net } from '../../net';
import { h, timeAgo } from '../dom';
import { icon } from '../icons';
import { btn } from '../kit';
import { resolveWaiters } from './api';
import { replyBox, replyDraftKey, type CommentBox } from './comment-box';
import { ghRepoField } from './ghrepo';
import { ghMarkdown } from './md';
import { pref } from './prefs';
import { threadByRoot, type ThreadChange } from './timeline-model';

// A thread of line comments on a pull request, as the Conversation tab and the Files tab both show it:
// its comments, whether it is resolved, Resolve / Unresolve, and a box to answer it. The cards are built
// again on every draw; what has to outlive a draw (a thread you folded, an open reply box and its text, a
// resolve on its way) is kept by the window in a ThreadsUi.

/** A line comment and its replies. */
export function renderThread(root: GhReviewComment, replies: Map<number, GhReviewComment[]>, itemUrl: string): HTMLElement {
  const all = [root, ...(replies.get(root.id) ?? [])];
  return h(
    'div.pd-thread',
    {},
    ...all.map((c) =>
      h(
        'div.pd-comment',
        {},
        h('div.pd-comment-head', {}, h('b', {}, c.author), h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: new Date(c.createdAt).toLocaleString() }, timeAgo(c.createdAt))),
        ghMarkdown(c.body, itemUrl),
      ),
    ),
  );
}

/** The two places a thread is drawn: the Conversation tab, and under its line on the Files tab. */
export type ThreadWhere = 'conversation' | 'diff';

export interface ThreadState {
  /** Opened or folded by you; unset, a resolved thread is folded and any other open. */
  open?: boolean;
  /** Its reply box is out. */
  replying: boolean;
  /** A resolve or unresolve is on its way. */
  busy: boolean;
  /** Why the last resolve didn't go through. */
  error?: string;
}

/** What the threads need of the window they are in. */
export interface ThreadsHost {
  itemUrl: string;
  number: number;
  repo?: string;
  net: Net;
  /** Answering and resolving go through gh: elsewhere a thread is only read. */
  onGitHub: boolean;
  /** The tab on show, whose cards hold the reply boxes. */
  showing(): ThreadWhere;
  showInDiff(c: GhReviewComment): void;
  /** Takes in a change (when there is one) and draws the thread of root comment `rootId` again on both tabs. */
  apply(rootId: number, change?: ThreadChange): void;
}

/** The threads' state for as long as the window is open, by the id of each thread's first comment. */
export class ThreadsUi {
  readonly state = new Map<number, ThreadState>();
  /** One reply box per thread, built once: the card on show takes the node in. */
  readonly boxes = new Map<number, CommentBox>();
  /** Where each card keeps its reply button or box, from the last draw. */
  private readonly slots: Record<ThreadWhere, Map<number, HTMLElement>> = { conversation: new Map(), diff: new Map() };
  /** Timers of the resolves on their way, by thread id. */
  private readonly resolving = new Map<string, number>();
  private viewer = '';

  constructor(readonly host: ThreadsHost) {}

  of(rootId: number): ThreadState {
    let st = this.state.get(rootId);
    // A reply left unsent last time comes back with its box out.
    if (!st) this.state.set(rootId, (st = { replying: this.host.onGitHub && !!pref<string>(replyDraftKey(this.host.itemUrl, rootId), ''), busy: false }));
    return st;
  }

  /** Names the GitHub account replies go out as. */
  setViewer(login: string) {
    this.viewer = login;
    for (const b of this.boxes.values()) b.setViewer(login);
  }

  private box(rootId: number): CommentBox {
    let b = this.boxes.get(rootId);
    if (b) return b;
    const { host } = this;
    const away = () => {
      this.of(rootId).replying = false;
      this.fill('conversation', rootId);
      this.fill('diff', rootId);
    };
    // GitHub files every reply under the thread's first comment, whichever comment it answered.
    b = replyBox(host.number, host.itemUrl, host.net, { to: rootId, cancel: away }, (reply) => (away(), host.apply(rootId, { reply: { ...reply, replyTo: rootId } })), host.repo);
    b.setViewer(this.viewer);
    this.boxes.set(rootId, b);
    return b;
  }

  /** What draws a thread's card for one of the two places, from what GitHub says of the threads (pulldiff.ts takes it as its thread builder). */
  cards(where: ThreadWhere, threads: GhThread[] | undefined): (root: GhReviewComment, replies: Map<number, GhReviewComment[]>) => HTMLElement {
    const known = threadByRoot(threads);
    return (root, replies) => threadCard(root, replies, known.get(root.id), { ui: this, where });
  }

  /** A card's place for answering: the Reply button, or the thread's one reply box on the tab that is showing. */
  slot(where: ThreadWhere, rootId: number): HTMLElement {
    const el = h('div.gh-thread-actions');
    this.slots[where].set(rootId, el);
    this.fill(where, rootId);
    return el;
  }

  private fill(where: ThreadWhere, rootId: number) {
    const slot = this.slots[where].get(rootId);
    if (!slot) return;
    const st = this.of(rootId);
    const reply = () => {
      st.replying = true;
      this.fill(where, rootId);
      this.box(rootId).focus();
    };
    if (!st.replying) return slot.replaceChildren(btn('Reply', { kind: 'quiet', size: 'sm', icon: 'corner-up-left', attrs: { onclick: reply } }));
    if (this.host.showing() !== where) return slot.replaceChildren();
    const box = this.box(rootId);
    if (box.el.parentElement === slot) return;
    // Moving the box takes the focus off it: whoever was typing in it goes on typing, where they were.
    const active = document.activeElement;
    const had = active instanceof HTMLElement && box.el.contains(active) ? active : null;
    const sel = had instanceof HTMLTextAreaElement ? ([had.selectionStart, had.selectionEnd] as const) : null;
    slot.replaceChildren(box.el);
    if (!had) return;
    // Once the draw that asked for this is over and the card is on the page.
    queueMicrotask(() => {
      had.focus({ preventScroll: true });
      if (sel) (had as HTMLTextAreaElement).setSelectionRange(sel[0], sel[1]);
    });
  }

  /** The other tab came on show: its cards take the open reply boxes. */
  place() {
    const where = this.host.showing();
    for (const [rootId, slot] of this.slots[where]) if (slot.isConnected) this.fill(where, rootId);
  }

  /** Resolves the thread, or reopens a resolved one; the answer comes back as gh.resolved. */
  resolve(rootId: number, thread: GhThread) {
    const { host } = this;
    const st = this.of(rootId);
    if (st.busy) return;
    st.busy = true;
    st.error = undefined;
    const settle = () => {
      resolveWaiters.delete(thread.id);
      clearTimeout(this.resolving.get(thread.id));
      this.resolving.delete(thread.id);
      st.busy = false;
    };
    resolveWaiters.set(thread.id, (msg) => {
      settle();
      if (msg.error || msg.resolved === undefined) {
        st.error = msg.error ?? 'GitHub did not change the thread';
        return host.apply(rootId);
      }
      // Back to how such a thread stands by itself: resolved it folds away, reopened it opens.
      st.open = undefined;
      host.apply(rootId, { thread: thread.id, resolved: msg.resolved });
    });
    // The office drops messages while it's disconnected, and then no answer comes.
    this.resolving.set(
      thread.id,
      window.setTimeout(() => {
        settle();
        st.error = 'No answer from the office. Refresh to see whether the thread changed before trying again.';
        host.apply(rootId);
      }, 45_000),
    );
    host.net.send({ t: 'gh.resolve', number: host.number, thread: thread.id, resolved: !thread.resolved, ...ghRepoField(host.repo) });
    host.apply(rootId);
  }

  /** Stops waiting for answers; the window closed. */
  dispose() {
    for (const b of this.boxes.values()) b.dispose();
    for (const [id, timer] of this.resolving) {
      clearTimeout(timer);
      resolveWaiters.delete(id);
    }
    this.resolving.clear();
  }
}

/**
 * A thread as a card: where it is, how it stands and Resolve / Unresolve in its header, its comments, and
 * a place to answer. `thread` is what GitHub says of it; without it (a repository hosted elsewhere, or a
 * history GitHub didn't give) the card has no state and no Resolve. A resolved thread comes folded.
 */
export function threadCard(root: GhReviewComment, replies: Map<number, GhReviewComment[]>, thread: GhThread | undefined, ctx: { ui: ThreadsUi; where: ThreadWhere }): HTMLElement {
  const { ui, where } = ctx;
  const { host } = ui;
  const st = ui.of(root.id);
  const resolved = !!thread?.resolved;
  // An error is said under the comments, so a thread with one is never folded over it.
  const open = st.error ? true : (st.open ?? !resolved);
  const n = 1 + (replies.get(root.id)?.length ?? 0);
  // A button in the header does its own thing and leaves the fold alone.
  const act = (fn: () => void) => ((e: Event) => (e.preventDefault(), fn())) as EventListener;
  const card = h(
    'details.gh-thread',
    { class: `${resolved ? 'resolved' : ''} ${where === 'diff' ? 'in-diff' : ''}`.trim(), open },
    h(
      'summary.gh-thread-head',
      {},
      icon('chevron-right', { size: 14, cls: 'gh-thread-caret' }),
      where === 'diff' ? h('span.gh-thread-where', {}, `${n} comment${n === 1 ? '' : 's'}`) : h('code', { title: root.path }, `${root.path}${root.line ? `:${root.line}` : ''}`),
      where === 'diff' ? null : root.line == null ? h('span.gh-badge.muted', {}, 'Outdated') : h('button.link-btn', { type: 'button', onclick: act(() => host.showInDiff(root)) }, 'Show in diff'),
      !thread ? null : resolved ? h('span.gh-badge.ok', {}, icon('circle-check', { size: 13 }), thread.resolvedBy ? `Resolved by @${thread.resolvedBy}` : 'Resolved') : h('span.gh-badge', {}, 'Unresolved'),
      thread && host.onGitHub
        ? btn(st.busy ? (resolved ? 'Unresolving…' : 'Resolving…') : resolved ? 'Unresolve' : 'Resolve', { size: 'sm', attrs: { disabled: st.busy, title: resolved ? 'Reopen this thread on GitHub' : 'Mark this thread resolved on GitHub', onclick: act(() => ui.resolve(root.id, thread)) } })
        : null,
    ),
    renderThread(root, replies, host.itemUrl),
    host.onGitHub ? ui.slot(where, root.id) : null,
    st.error ? h('div.gh-merge-result.error', { role: 'alert' }, st.error) : null,
  );
  card.addEventListener('toggle', () => {
    // Only a fold that differs from where the thread stood is yours to remember.
    if (card.open !== open) st.open = card.open;
    else if (st.open !== undefined) st.open = card.open;
  });
  return card;
}
