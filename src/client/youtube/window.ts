// The TV window: what's on, big (the TV's own player, lined up with the window's slot), and
// a box to put a YouTube link on, change it or take it off.
import './youtube.css';
import { youtubeTitle, youtubeUrl } from '../../shared/youtube/link';
import { visiting } from '../multiplayer/visit';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from '../ui/dom';
import { tvControls } from './controls';
import { sendToTv, tvQueue } from './queue';
import type { TvScreen } from './screen';
import { youtubeAt, type YoutubeOnTv } from './slice';

export { sendToTv };

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

/** What's on, on YouTube itself, from where the TV has got to. */
const hereOnYoutube = (y: YoutubeOnTv) => youtubeUrl({ ...y, start: Math.floor(youtubeAt(y)) });

export function openTvWindow(deps: TvWindowDeps) {
  const guest = !!visiting();
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const slot = h('div.ytv-slot');
  const now = h('div.ytv-now');
  const controls = tvControls(deps);
  const queue = tvQueue(deps);
  const same = h('input', { type: 'checkbox', id: 'ytv-same' }) as HTMLInputElement;
  same.addEventListener('change', () => deps.net.send({ t: 'tv.youtube.settings', sameVolume: same.checked }));
  const setting = h(
    'div.ytv-setting',
    {},
    h('label.ytv-same', { for: 'ytv-same' }, same, '🔊 Same volume across the floor'),
    h('p.setting-note', {}, 'Everyone on this floor hears the TV equally loud, at their desks too. Your own volume still applies.'),
  );
  const footNote = h('span.grow');
  const volume = h('button.btn', { type: 'button' }, '🔈 Your volume');
  const share = h('button.btn', { type: 'button' }, '🖥️ Share your screen instead');
  const el = h(
    'div.modal.ytv-window',
    { role: 'dialog', 'aria-label': 'Office TV' },
    h('header', {}, h('h2', {}, '📺 Office TV'), close),
    h('div.body', {}, slot, controls.el, now, queue.el, guest ? '' : setting),
    h('footer', {}, footNote, share, volume),
  );

  let link: HTMLAnchorElement | null = null;
  let drawn = '';
  const render = () => {
    const y = store.youtube;
    const list = store.youtubeList;
    const who = deps.sharing();
    const error = deps.screen.errorText();
    const k = JSON.stringify([
      y && [y.id, y.title, y.index, y.paused, y.rate, y.pausedBy, y.duration, y.listLength, y.list],
      list,
      who,
      error,
      deps.screen.needsClick(),
      !!deps.screen.duration(),
      !!deps.screen.playlistAt(),
      deps.screen.rateNote(),
    ]);
    if (k === drawn) return;
    drawn = k;
    const showSlot = !!y && !who;
    slot.hidden = !showSlot;
    deps.screen.watchIn(showSlot ? slot : null);
    share.hidden = !!y || !!who;
    if (guest) controls.el.hidden = true;
    else controls.render();
    if (who) controls.el.hidden = true;
    queue.render();
    same.checked = list.sameVolume;
    footNote.textContent = list.sameVolume
      ? 'It plays in YouTube’s own player. Its volume is your jukebox volume, the same anywhere on this floor.'
      : 'It plays in YouTube’s own player. Its volume is your jukebox volume, louder the closer you are to the TV.';
    link = y ? h('a.btn', { href: hereOnYoutube(y), target: '_blank', rel: 'noopener noreferrer', title: 'Open it on YouTube from where the TV is, in a new tab' }, '↗ YouTube') : null;
    now.replaceChildren(
      h('span.jb-disc', { class: y && !who && !y.paused ? 'spin' : '' }, y ? '📺' : '⬛'),
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
              : guest
                ? 'Nothing’s playing in this office'
                : 'Paste a YouTube link below, or share your screen',
        ),
      ),
      link ?? '',
      y && !guest ? h('button.btn', { type: 'button', title: 'Take it off the TV (the queue stays)', onclick: () => deps.net.send({ t: 'tv.youtube.stop' }) }, '⏹️ Stop') : '',
    );
  };
  // The seek bar, the time and the YouTube link's t= move on their own, between changes.
  const tick = () => {
    const y = store.youtube;
    if (!guest && !deps.sharing()) controls.tick();
    if (y && link) link.href = hereOnYoutube(y);
  };

  const offs = [store.on('youtube', render), store.on('youtubeList', render)];
  // A screen share starting or stopping, YouTube's error, or the player learning the length, while it's open.
  const timer = window.setInterval(render, 1000);
  const ticker = window.setInterval(tick, 250);
  const modal = openModal(el, {
    doing: '📺 watching the TV',
    onClose: () => {
      offs.forEach((off) => off());
      clearInterval(timer);
      clearInterval(ticker);
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
