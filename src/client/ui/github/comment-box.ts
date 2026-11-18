import type { GhComment, GhReviewComment } from '../../../shared/protocol';
import type { Net } from '../../net';
import { h } from '../dom';
import { btn } from '../kit';
import { commentWaiters, replyWaiters } from './api';
import { ghKey, ghRepoField } from './ghrepo';
import { isSendKey, sendHint } from '../../kanban/sendkey';
import { DRAFT_KEY, pref, savePref } from './prefs';
import { ghMarkdown } from './md';

// ---- Comment box --------------------------------------------------------------------------------

export interface CommentBox {
  el: HTMLElement;
  /** Names the GitHub account the comment goes out as, once the window knows it. */
  setViewer(login: string): void;
  /** Puts the cursor in the text box. */
  focus(): void;
  /** Stops waiting for an answer; the window closed. */
  dispose(): void;
}

/** What tells one box from another: where its draft is kept, what it is called and how its text goes out. */
interface Wire {
  draftKey: string;
  verb: 'Comment' | 'Reply';
  placeholder: string;
  /**
   * Sends the text and calls `done` once it is posted, or `done(why)` when it isn't. One that waits for
   * an answer over the socket returns how to stop waiting, and the box then gives up after 45 seconds.
   */
  post(body: string, done: (error?: string) => void): (() => void) | void;
  /** A way to put the box away (a reply's Cancel). */
  cancel?(): void;
}

/**
 * Where you comment on an issue or a PR's conversation. It goes out through the server's gh, so
 * as that account rather than as you. The draft is kept per item until it is posted, so Esc or a
 * closed window doesn't lose it.
 */
/** `send`: posts the comment some other way than gh.comment (a card from the issue sources goes by its key), calling `sent` after it went through. */
export function commentBox(kind: 'issue' | 'pull', number: number, itemUrl: string, net: Net, onPosted: (c: GhComment) => void, repo?: string, send?: { post(body: string): Promise<void>; sent(): void }): CommentBox {
  // `repo` for an item of another of the project's repositories.
  const waitKey = ghKey(kind, number, repo);
  return compose(itemUrl, {
    draftKey: `${DRAFT_KEY}${itemUrl}`,
    verb: 'Comment',
    placeholder: 'Write a comment',
    post(body, done) {
      if (send) {
        send
          .post(body)
          .then(() => (done(), send.sent()))
          .catch((err: Error) => done(err.message || 'The comment didn’t go through'));
        return;
      }
      commentWaiters.set(waitKey, (msg) => {
        if (!msg.comment) return done(msg.error ?? 'GitHub did not take the comment');
        done();
        onPosted(msg.comment);
      });
      net.send({ t: 'gh.comment', kind, number, body, ...ghRepoField(repo) });
      return () => commentWaiters.delete(waitKey);
    },
  });
}

/** Where a reply's draft is kept: per pull request and thread (`to`: the thread's first comment). */
export const replyDraftKey = (itemUrl: string, to: number) => `${DRAFT_KEY}${itemUrl}#r${to}`;

/**
 * Where you answer a thread of line comments: the comment box with its own draft and its own answer
 * (gh.replied, by the id of the thread's first comment, which no other thread shares).
 */
export function replyBox(number: number, itemUrl: string, net: Net, reply: { to: number; cancel?(): void }, onPosted: (c: GhReviewComment) => void, repo?: string): CommentBox {
  return compose(itemUrl, {
    draftKey: replyDraftKey(itemUrl, reply.to),
    verb: 'Reply',
    placeholder: 'Reply',
    cancel: reply.cancel,
    post(body, done) {
      replyWaiters.set(reply.to, (msg) => {
        if (!msg.reply) return done(msg.error ?? 'GitHub did not take the reply');
        done();
        onPosted(msg.reply);
      });
      net.send({ t: 'gh.reply', number, to: reply.to, body, ...ghRepoField(repo) });
      return () => replyWaiters.delete(reply.to);
    },
  });
}

function compose(itemUrl: string, wire: Wire): CommentBox {
  const { draftKey, verb } = wire;
  const noun = verb.toLowerCase();
  let busy = false;
  let timer = 0;
  let stop: (() => void) | void;
  const ta = h('textarea', { rows: 3, placeholder: wire.placeholder, title: `Markdown supported. ${sendHint()}.`, 'aria-label': wire.placeholder }) as HTMLTextAreaElement;
  ta.value = pref<string>(draftKey, '');
  const shown = h('div.gh-compose-preview.hidden');
  // One toggle: the text box, or what it will look like.
  const preview = btn('Preview', { kind: 'quiet', size: 'sm', attrs: { 'aria-pressed': 'false', title: `Show the ${noun} as it will look` } });
  const who = h('span.gh-compose-who', {}, "Posts to GitHub as the office's gh account");
  const cancel = wire.cancel ? btn('Cancel', { kind: 'quiet', size: 'sm', attrs: { title: 'Close the box without posting; what you wrote is kept as a draft', onclick: wire.cancel } }) : null;
  const post = btn(verb, { size: 'sm' });
  const result = h('div.gh-merge-result.error.hidden', { role: 'alert' });
  const el = h('div.gh-compose', {}, h('div.composite', {}, ta, shown, h('div.composite-bar', {}, who, cancel, preview, post)), result);

  const sync = () => {
    post.disabled = busy || !ta.value.trim();
    ta.readOnly = busy;
    post.textContent = busy ? 'Posting…' : verb;
    post.title = busy ? 'Waiting for GitHub’s answer…' : ta.value.trim() ? `Post the ${noun} on GitHub from the office's gh account` : `Write the ${noun} first`;
  };
  const saveDraft = () => {
    if (ta.value) savePref(draftKey, ta.value);
    else
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // storage blocked
      }
  };
  const setPreview = (on: boolean) => {
    preview.setAttribute('aria-pressed', String(on));
    ta.classList.toggle('hidden', on);
    shown.classList.toggle('hidden', !on);
    if (on) shown.replaceChildren(ta.value.trim() ? ghMarkdown(ta.value, itemUrl) : h('p.gh-quiet', {}, 'Nothing to preview.'));
    else ta.focus();
  };
  const fail = (text: string) => {
    result.textContent = text;
    result.classList.remove('hidden');
  };
  const settle = () => {
    stop?.();
    stop = undefined;
    clearTimeout(timer);
    busy = false;
  };
  const submit = () => {
    const body = ta.value;
    if (busy || !body.trim()) return;
    busy = true;
    result.classList.add('hidden');
    sync();
    stop = wire.post(body, (error) => {
      settle();
      if (error === undefined) {
        ta.value = '';
        saveDraft();
        setPreview(false);
      } else fail(error);
      sync();
    });
    if (!stop) return;
    // The office drops messages while it's disconnected, and then no answer comes.
    timer = window.setTimeout(() => {
      settle();
      fail(`No answer from the office. Reload the conversation to see whether the ${noun} went through before posting it again.`);
      sync();
    }, 45_000);
  };

  ta.addEventListener('input', () => (saveDraft(), sync()));
  ta.addEventListener('keydown', (e) => {
    if (isSendKey(e)) {
      e.preventDefault();
      submit();
    }
  });
  preview.addEventListener('click', () => setPreview(preview.getAttribute('aria-pressed') !== 'true'));
  post.addEventListener('click', submit);
  sync();
  return {
    el,
    setViewer(login) {
      if (login) who.textContent = `Posts to GitHub as @${login}`;
    },
    focus: () => ta.focus(),
    dispose: settle,
  };
}
