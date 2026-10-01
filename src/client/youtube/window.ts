// 3d-kanban: the TV window: what's on, big (the TV's own player, lined up with the window's slot), and
// a box to put a YouTube link on, change it or take it off.
import './youtube.css';
import { parseYoutubeLink, youtubeTitle } from '../../shared/youtube/link';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast } from '../ui/dom';
import type { TvScreen } from './screen';

export interface TvWindowDeps {
  net: Net;
  screen: TvScreen;
  /** Who's sharing a screen on the floor (it has the TV), if anyone. */
  sharing(): string | undefined;
  /** Shares your screen on the TV (see features/voice). */
  shareScreen(): void;
  /** Settings, open at the Sound pane (the TV's volume is the jukebox's). */
  openVolume(): void;
}

/** Sends a YouTube link to the floor's TV, or says what's wrong with it. Says whether it went. */
export function sendToTv(net: Net, raw: string): boolean {
  const l = parseYoutubeLink(raw);
  if ('error' in l) {
    toast(l.error, 'warn');
    return false;
  }
  net.send({ t: 'tv.youtube.play', url: raw.trim() });
  return true;
}

export function openTvWindow(deps: TvWindowDeps) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const slot = h('div.ytv-slot');
  const now = h('div.ytv-now');
  const url = h('input', { type: 'text', placeholder: 'https://www.youtube.com/watch?v=… or music.youtube.com/…', 'aria-label': 'YouTube link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const play = h('button.btn.primary', { type: 'button' }, '▶️ Play');
  const volume = h('button.btn', { type: 'button' }, '🔈 Your volume');
  const share = h('button.btn', { type: 'button' }, '🖥️ Share your screen instead');
  const el = h(
    'div.modal.ytv-window',
    { role: 'dialog', 'aria-label': 'Office TV' },
    h('header', {}, h('h2', {}, '📺 Office TV'), close),
    h(
      'div.body',
      {},
      slot,
      now,
      h('label', { style: 'margin-top:14px' }, 'Put a YouTube link on the TV'),
      h('div.webhook', {}, url, play),
      h('p.setting-note', {}, 'A video or a playlist from YouTube or YouTube Music (a t= in the link starts it there). Everyone on this floor sees and hears it at the same point, and the jukebox goes quiet meanwhile.'),
    ),
    h('footer', {}, h('span.grow', {}, 'It plays in YouTube’s own player. Its volume is your jukebox volume, louder the closer you are to the TV.'), share, volume),
  );

  let drawn = '';
  const render = () => {
    const y = store.youtube;
    const who = deps.sharing();
    const error = deps.screen.errorText();
    const k = JSON.stringify([y?.startedAt, y?.title, y?.index, who, error, deps.screen.needsClick()]);
    if (k === drawn) return;
    drawn = k;
    const showSlot = !!y && !who;
    slot.hidden = !showSlot;
    deps.screen.watchIn(showSlot ? slot : null);
    share.hidden = !!y || !!who;
    play.textContent = y ? '🔁 Change' : '▶️ Play';
    now.replaceChildren(
      h('span.jb-disc', { class: y && !who ? 'spin' : '' }, y ? '📺' : '⬛'),
      h(
        'div.svc-main',
        {},
        h('div.svc-title', {}, y ? youtubeTitle(y) : who ? `🖥️ ${who} is sharing a screen` : 'Nothing on the TV'),
        h(
          'div.svc-meta',
          {},
          who
            ? `A shared screen has the TV until it stops${y ? `; “${youtubeTitle(y)}” carries on after, in step` : ''}`
            : y
              ? [`put on by ${y.by}`, error, deps.screen.needsClick() ? '🔇 click anywhere to hear it' : ''].filter(Boolean).join(' · ')
              : 'Paste a YouTube link below, or share your screen',
        ),
      ),
      y ? h('a.btn', { href: y.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it on YouTube, in a new tab' }, '↗ YouTube') : '',
      y ? h('button.btn', { type: 'button', title: 'Take it off the TV', onclick: () => deps.net.send({ t: 'tv.youtube.stop' }) }, '⏹️ Stop') : '',
    );
  };

  const go = () => {
    if (!sendToTv(deps.net, url.value)) return url.focus();
    url.value = '';
  };
  play.addEventListener('click', go);
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  const offs = [store.on('youtube', render)];
  // A screen share starting or stopping, or YouTube's error, while it's open.
  const timer = window.setInterval(render, 1000);
  const modal = openModal(el, {
    doing: '📺 watching the TV',
    onClose: () => {
      offs.forEach((off) => off());
      clearInterval(timer);
      deps.screen.watchIn(null);
    },
  });
  close.addEventListener('click', () => modal.close());
  share.addEventListener('click', () => {
    modal.close();
    deps.shareScreen();
  });
  volume.addEventListener('click', () => {
    modal.close();
    deps.openVolume();
  });
  render();
}
