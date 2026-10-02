// The TV window's "Up next": what plays after what's on, in order, with ▶ ⬆ ⬇ ✕ on each, and the
// box to put a link on now or at the end of the queue. The office keeps the queue (server/youtube/);
// a visitor sees it but can't change it.
import { parseYoutubeLink, youtubeTitle } from '../../shared/youtube/link';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol';
import type { YoutubeQueueItem, YoutubeTvList } from '../../shared/youtube/queue';
import { visiting } from '../multiplayer/visit';
import type { Net } from '../net';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import type { TvScreen } from './screen';
import type { YoutubeOnTv } from './slice';

/** Sends a YouTube link to the floor's TV (now, or to the end of its queue), or says what's wrong with it. Says whether it went. */
export function sendToTv(net: Net, raw: string, queue?: 'end' | 'next'): boolean {
  const l = parseYoutubeLink(raw);
  if ('error' in l) {
    toast(l.error, 'warn');
    return false;
  }
  net.send({ t: 'tv.youtube.play', url: raw.trim(), ...(queue ? { queue } : {}) });
  return true;
}

export interface TvQueue {
  el: HTMLElement;
  /** The queue, or what's on, changed. */
  render(): void;
}

/** The queue's own controls. */
export type QueueControl = Extract<YoutubeClientMsg, { t: 'tv.youtube.queue.move' | 'tv.youtube.queue.remove' | 'tv.youtube.queue.jump' | 'tv.youtube.queue.clear' }>;

/** What the queue shows and changes: the Office TV's (`tvQueueSource`) or another session's with the same model. */
export interface TvQueueSource {
  state(): YoutubeOnTv | null;
  list(): YoutubeTvList;
  send(c: QueueControl): void;
  /** Puts a link on now or at the end/next in the queue; says whether it went. */
  add(raw: string, queue?: 'end' | 'next'): boolean;
  /** 📥 Unpack into the queue, for a source that can (the TV): null hides it. */
  unpack: (() => void) | null;
  /** Whether the loaded playlist can be unpacked now. */
  canUnpack(): boolean;
  /** Who it's for, in the add box's note (default: the floor's TV). */
  addNote?: string;
  /** The add box's label (default: Put a YouTube link on the TV). */
  addLabel?: string;
  /** A visitor sees the queue but can't change it. */
  guest: boolean;
}

export function tvQueueSource(deps: { net: Net; screen: TvScreen }): TvQueueSource {
  return {
    state: () => store.youtube,
    list: () => store.youtubeList,
    send: (c) => deps.net.send(c),
    add: (raw, queue) => sendToTv(deps.net, raw, queue),
    unpack() {
      const y = store.youtube;
      const here = deps.screen.playlistAt();
      if (y?.list && here) deps.net.send({ t: 'tv.youtube.unpack', id: y.id, ...here });
    },
    canUnpack: () => !!deps.screen.playlistAt(),
    guest: !!visiting(),
  };
}

export function tvQueue(deps: TvQueueSource): TvQueue {
  const { guest } = deps;
  const list = h('ul.svc-list.ytv-queue', { 'aria-label': 'Up next' });
  const count = h('span.ytv-count');
  const clear = h('button.btn.small', { type: 'button', title: 'Take everything off the queue (what’s on keeps playing)', onclick: () => deps.send({ t: 'tv.youtube.queue.clear' }) }, '🧹 Clear');
  const unpack = h('button.btn.small', { type: 'button', title: 'Put this playlist’s videos into the queue one by one, so they can be reordered or skipped' }, '📥 Unpack into the queue');

  const url = h('input', { type: 'text', placeholder: 'https://www.youtube.com/watch?v=… or music.youtube.com/…', 'aria-label': 'YouTube link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const playNow = h('button.btn', { type: 'button', title: 'Play it now; what’s on goes back in the history' }, '▶️ Play now');
  const addIt = h('button.btn', { type: 'button', title: 'Add it to the end of the queue' }, '➕ Add to queue');
  const go = (queue?: 'end') => {
    if (!deps.add(url.value, queue)) return url.focus();
    url.value = '';
  };
  playNow.addEventListener('click', () => go());
  addIt.addEventListener('click', () => go('end'));
  // Enter adds to the queue while something's on, and plays it when nothing is.
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(deps.state() ? 'end' : undefined);
  });
  unpack.addEventListener('click', () => deps.unpack?.());

  const add = h(
    'div.ytv-add',
    {},
    h('label', {}, deps.addLabel ?? 'Put a YouTube link on the TV'),
    h('div.webhook.ytv-addrow', {}, url, h('div.ytv-addbtns', {}, playNow, addIt)),
    h('p.setting-note', {}, deps.addNote ?? 'A video or a playlist from YouTube or YouTube Music (a t= in the link starts it there). Everyone on this floor sees and hears it at the same point, and the jukebox goes quiet meanwhile. Enter adds it to the queue, or plays it if nothing’s on.'),
  );

  const el = h(
    'section.ytv-next',
    { 'aria-label': 'Up next' },
    h('div.ytv-nexthead', {}, h('h3', {}, 'Up next'), count, h('span.grow'), guest || !deps.unpack ? '' : unpack, guest ? '' : clear),
    list,
    guest ? h('p.setting-note', {}, '👀 You’re visiting: the queue is theirs to change.') : add,
  );

  const row = (q: YoutubeQueueItem, i: number, n: number) => {
    const title = q.title ?? youtubeTitle(q);
    const act = (label: string, what: string, onclick: () => void, disabled = false) =>
      h('button.btn.small', { type: 'button', title: what, 'aria-label': `${what}: ${title}`, onclick, disabled }, label);
    return h(
      'li',
      {},
      h('span.ytv-pos', {}, String(i + 1)),
      h('div.svc-main', {}, h('div.svc-title', { title }, title), h('div.svc-meta', {}, `added by ${q.by}`)),
      guest
        ? ''
        : h(
            'div.ytv-acts',
            {},
            act('▶', 'Play now', () => deps.send({ t: 'tv.youtube.queue.jump', qid: q.qid })),
            act('⬆', 'Move up', () => deps.send({ t: 'tv.youtube.queue.move', qid: q.qid, to: i - 1 }), i === 0),
            act('⬇', 'Move down', () => deps.send({ t: 'tv.youtube.queue.move', qid: q.qid, to: i + 1 }), i === n - 1),
            act('✕', 'Remove', () => deps.send({ t: 'tv.youtube.queue.remove', qid: q.qid })),
          ),
    );
  };

  return {
    el,
    render() {
      const y = deps.state();
      const { queue } = deps.list();
      count.textContent = queue.length ? String(queue.length) : '';
      clear.hidden = !queue.length;
      unpack.hidden = !(y?.list && deps.canUnpack());
      list.replaceChildren(
        ...(queue.length
          ? queue.map((q, i) => row(q, i, queue.length))
          : [h('li.ytv-empty', {}, h('div.svc-meta', {}, guest ? 'Nothing queued.' : 'Nothing queued. Add a link below and it plays after this one.'))]),
      );
      // The likelier one stands out: queue it while something's on, play it when nothing is.
      playNow.classList.toggle('primary', !y);
      addIt.classList.toggle('primary', !!y);
    },
  };
}
