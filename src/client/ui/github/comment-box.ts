import type { GhComment } from '../../../shared/protocol';
import type { Net } from '../../net';
import { h } from '../dom';
import { btn } from '../kit';
import { markdown } from '../markdown';
import { commentWaiters } from './api';
import { ghKey, ghRepoField } from './ghrepo';
import { isSendKey, sendHint } from '../../kanban/sendkey';
import { DRAFT_KEY, pref, savePref } from './prefs';

// ---- Comment box --------------------------------------------------------------------------------

export interface CommentBox {
  el: HTMLElement;
  /** Names the GitHub account the comment goes out as, once the window knows it. */
  setViewer(login: string): void;
  /** Stops waiting for an answer; the window closed. */
  dispose(): void;
}

/**
 * Where you comment on an issue or a PR's conversation. It goes out through the server's gh, so
 * as that account rather than as you. The draft is kept per item until it is posted, so Esc or a
 * closed window doesn't lose it.
 */
/** `send`: posts the comment some other way than gh.comment (a card from the issue sources goes by its key), calling `sent` after it went through. */
export function commentBox(kind: 'issue' | 'pull', number: number, itemUrl: string, net: Net, onPosted: (c: GhComment) => void, repo?: string, send?: { post(body: string): Promise<void>; sent(): void }): CommentBox {
  const draftKey = `${DRAFT_KEY}${itemUrl}`;
  // `repo` for an item of another of the project's repositories.
  const waitKey = ghKey(kind, number, repo);
  let busy = false;
  let timer = 0;
  const ta = h('textarea', { rows: 3, placeholder: 'Write a comment', title: `Markdown supported. ${sendHint()}.`, 'aria-label': 'Write a comment' }) as HTMLTextAreaElement;
  ta.value = pref<string>(draftKey, '');
  const shown = h('div.gh-compose-preview.hidden');
  // One toggle: the text box, or what it will look like.
  const preview = btn('Preview', { kind: 'quiet', size: 'sm', attrs: { 'aria-pressed': 'false', title: 'Show the comment as it will look' } });
  const who = h('span.gh-compose-who', {}, "Posts to GitHub as the office's gh account");
  const post = btn('Comment', { size: 'sm' });
  const result = h('div.gh-merge-result.error.hidden', { role: 'alert' });
  const el = h('div.gh-compose', {}, h('div.composite', {}, ta, shown, h('div.composite-bar', {}, who, preview, post)), result);

  const sync = () => {
    post.disabled = busy || !ta.value.trim();
    ta.readOnly = busy;
    post.textContent = busy ? 'Posting…' : 'Comment';
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
    if (on) shown.replaceChildren(ta.value.trim() ? markdown(ta.value, itemUrl) : h('p.gh-quiet', {}, 'Nothing to preview.'));
    else ta.focus();
  };
  const fail = (text: string) => {
    result.textContent = text;
    result.classList.remove('hidden');
  };
  const settle = () => {
    commentWaiters.delete(waitKey);
    clearTimeout(timer);
    busy = false;
  };
  const submit = () => {
    const body = ta.value;
    if (busy || !body.trim()) return;
    busy = true;
    result.classList.add('hidden');
    sync();
    if (send) {
      send
        .post(body)
        .then(() => {
          ta.value = '';
          saveDraft();
          setPreview(false);
          send.sent();
        })
        .catch((err: Error) => fail(err.message || 'The comment didn’t go through'))
        .finally(() => ((busy = false), sync()));
      return;
    }
    commentWaiters.set(waitKey, (msg) => {
      settle();
      if (msg.comment) {
        ta.value = '';
        saveDraft();
        setPreview(false);
        onPosted(msg.comment);
      } else fail(msg.error ?? 'GitHub did not take the comment');
      sync();
    });
    // The office drops messages while it's disconnected, and then no answer comes.
    timer = window.setTimeout(() => {
      settle();
      fail('No answer from the office. Reload the conversation to see whether the comment went through before posting it again.');
      sync();
    }, 45_000);
    net.send({ t: 'gh.comment', kind, number, body, ...ghRepoField(repo) });
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
    dispose: settle,
  };
}
