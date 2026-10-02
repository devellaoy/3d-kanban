// The phone's 🎵 Music tab (phone/ui.ts shows it): a YouTube link for yourself (🎧 Me), on this floor's TV
// (📺 Floor TV, as the TV window puts one on) or for you and someone else (👤 Someone), then what your phone
// plays: the video (PhonePlayer laid over the slot while the tab is shown), who's listening, the TV's
// transport bar and queue (youtube/controls.ts, youtube/queue.ts) and your own volume, no distance.
import '../youtube/youtube.css';
import './music.css';
import { ROOF } from '../../shared/rooftop';
import { youtubeTitle } from '../../shared/youtube/link';
import { visiting } from '../multiplayer/visit';
import type { Net } from '../net';
import { store, type Settings } from '../state';
import { h } from '../ui/dom';
import { tvControls, type TvControlsSource } from '../youtube/controls';
import { sendToTv, tvQueue } from '../youtube/queue';
import type { PhoneMusic } from './music';

export interface MusicTabDeps {
  net: Net;
  music: PhoneMusic;
  /** Your settings (the music volume, which is the jukebox's too). */
  settings(): Settings;
  /** Sets your music volume (0–1) and saves it. */
  setVolume(level: number): void;
  /** The floor's TV as the transport bar controls it. */
  tvControls(): TvControlsSource;
  /** Puts the phone away and opens the TV window. */
  openTv(): void;
}

export interface MusicTab {
  el: HTMLElement;
  /** Takes the video off the screen and stops following the store. */
  close(): void;
}

type Target = 'me' | 'tv' | 'someone';

const TARGETS: { id: Target; label: string; title: string }[] = [
  { id: 'me', label: '🎧 Me', title: 'Only you hear it, at your own volume wherever you are' },
  { id: 'tv', label: '📺 Floor TV', title: 'On the TV of the floor you’re on: everyone there hears it' },
  { id: 'someone', label: '👤 Someone', title: 'You and someone else, on any floor, hear it in step' },
];

/** The floor you're on, if it has a TV (the roof and the lobby don't). */
const tvFloor = () => (store.floor && store.floor !== ROOF ? store.floors.find((f) => f.id === store.floor) : undefined);

/** The people you can play to: everyone else in the 3D office (on /lite there's no player to hear it on). */
const others = () => [...store.peers.values()].filter((p) => p.id !== store.you && !p.lite).sort((a, b) => a.name.localeCompare(b.name));

const floorName = (id: string | undefined) => (id === ROOF ? 'the roof' : (store.floors.find((f) => f.id === id)?.name ?? 'the lobby'));

/** "🎧 You and Ann", "🎧 You, Ann and Bo". */
export function listenersLine(ids: { id: string; name: string }[]): string {
  const names = [...ids].sort((a, b) => Number(b.id === store.you) - Number(a.id === store.you)).map((l) => (l.id === store.you ? 'You' : l.name));
  if (names.length <= 1) return `🎧 ${names[0] ?? 'Nobody'}`;
  return `🎧 ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function openMusicTab(deps: MusicTabDeps): MusicTab {
  const { music } = deps;
  const { player } = music;
  const guest = !!visiting();
  let target: Target = 'me';

  // ---- Where it goes, and the link -----------------------------------------------------------------
  const segBtns = TARGETS.map((t) =>
    h('button.btn.phm-target', { type: 'button', title: t.title, 'aria-pressed': 'false', 'data-target': t.id, onclick: () => setTarget(t.id) }, t.label),
  );
  const seg = h('div.seg.phm-seg', { role: 'group', 'aria-label': 'Who hears it' }, ...segBtns);
  const targetNote = h('p.setting-note.phm-note');
  const who = h('select.phm-who', { 'aria-label': 'Play it to', onchange: () => paintForm() }) as HTMLSelectElement;
  const url = h('input', { type: 'text', placeholder: 'YouTube link or playlist', 'aria-label': 'YouTube link to play', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const playBtn = h('button.btn.primary', { type: 'button', onclick: () => send() }, '▶ Play');
  const queueBtn = h('button.btn', { type: 'button', onclick: () => send('end') }, '＋ Queue');
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  const form = h('section.phm-form', { 'aria-label': 'Play a link' }, seg, targetNote, who, h('div.webhook.phm-addrow', {}, url), h('div.phm-btns', {}, playBtn, queueBtn));

  function setTarget(t: Target) {
    target = t;
    paintForm();
    render(true);
  }

  function send(queue?: 'end') {
    if (target === 'someone' && !who.value) return who.focus(); // Enter in the link box, with no one picked
    let ok: boolean;
    if (target === 'tv') ok = sendToTv(deps.net, url.value, queue);
    else ok = music.play(url.value, target === 'someone' ? who.value || undefined : undefined, queue);
    if (ok) url.value = '';
    else url.focus();
  }

  let whoKey = '';
  function paintForm() {
    const floor = tvFloor();
    if (target === 'tv' && !floor) target = 'me';
    segBtns[1].disabled = !floor;
    for (const b of segBtns) {
      const on = b.dataset.target === target;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const people = others();
    who.hidden = target !== 'someone';
    const k = people.map((p) => `${p.id}|${p.name}|${p.floor}`).join('\n');
    if (k !== whoKey) {
      whoKey = k;
      const was = who.value;
      // Never silently the first person: the choice stays only while they are still here, else back to the placeholder.
      who.replaceChildren(
        h('option', { value: '' }, people.length ? 'Pick someone…' : 'Nobody else is in the office'),
        ...people.map((p) => h('option', { value: p.id }, `${p.name} · ${p.floor === store.floor ? 'here' : floorName(p.floor)}`)),
      );
      who.value = people.some((p) => p.id === was) ? was : '';
    }
    playBtn.disabled = queueBtn.disabled = target === 'someone' && !who.value;
    playBtn.title = target === 'tv' ? 'Put it on the TV now' : target === 'someone' ? 'Play it to the two of you now (what you listen to stops)' : 'Play it for you now';
    queueBtn.title = target === 'tv' ? 'Add it to the end of the TV’s queue' : target === 'someone' ? 'Add it to the queue of the music you share with them (starts it if you have none)' : 'Add it to the end of your own music’s queue (starts it if nothing’s on)';
    targetNote.textContent =
      target === 'tv'
        ? `📺 The TV on ${floor?.name ?? 'this floor'}: everyone here hears it`
        : target === 'someone'
          ? `👤 ${people.length ? 'You and them, wherever they are, in step. They hear it at their own volume.' : 'Nobody else is in the office now.'}`
          : '🎧 Only you hear it, the same anywhere you go.';
  }

  // ---- What your phone plays ----------------------------------------------------------------------
  const slot = h('div.phm-slot', { 'aria-hidden': 'true' });
  const nowTitle = h('div.svc-title');
  const nowMeta = h('div.svc-meta');
  const ctl = tvControls(music.controlsSource());
  const queue = tvQueue(music.queueSource());
  const vol = h('input.ytv-seek.phm-vol', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Your music volume' }) as HTMLInputElement;
  const volPct = h('span.ytv-time');
  vol.addEventListener('input', () => {
    deps.setVolume(Number(vol.value) / 100);
    paintVolume();
  });
  const stop = h('button.btn.phm-stop', { type: 'button', title: 'Stop listening (the others keep theirs)', onclick: () => music.leave() }, '⏏ Stop listening');
  const mine = h(
    'section.phm-now',
    { 'aria-label': 'On your phone' },
    h('h3.phm-head', {}, '🎵 On your phone'),
    slot,
    h('div.phm-line', {}, h('div.svc-main', {}, nowTitle, nowMeta)),
    ctl.el,
    h('div.ytv-seekrow.phm-volrow', { title: 'Your music volume: the jukebox’s and the TV’s too, here with no distance' }, h('span', { 'aria-hidden': 'true' }, '🔈'), vol, volPct),
    stop,
    queue.el,
  );
  const idle = h('p.phone-empty.phm-idle', {}, 'Nothing on your phone. Paste a YouTube link above. 🎶');

  // ---- The floor's TV, when it's the target ------------------------------------------------------
  const tvCtl = tvControls(deps.tvControls());
  const tvTitle = h('div.svc-title');
  const tvMeta = h('div.svc-meta');
  const tv = h(
    'section.phm-tv',
    { 'aria-label': 'The floor’s TV' },
    h('h3.phm-head', {}, '📺 On the TV'),
    h('div.phm-line', {}, h('div.svc-main', {}, tvTitle, tvMeta)),
    tvCtl.el,
    h('button.btn', { type: 'button', title: 'Put the phone away and watch the TV big', onclick: () => deps.openTv() }, '📺 Open the TV window'),
  );

  const el = h(
    'div.phm',
    {},
    guest ? h('p.setting-note', {}, '👀 You’re visiting: music is for the people of this office.') : form,
    tv,
    mine,
    idle,
  );

  function paintVolume() {
    const s = deps.settings();
    const v = Math.round(s.music * 100);
    if (document.activeElement !== vol) vol.value = String(v);
    vol.style.setProperty('--fill', `${v}%`);
    volPct.textContent = s.musicMuted ? 'Muted' : `${v}%`;
    vol.title = s.musicMuted ? 'Your music is muted (⚙️ Settings): this sets the level for when it is not' : '';
  }

  let drawn = '';
  let drawnList: unknown;
  function render(force = false) {
    const m = store.phoneMusic;
    const y = m?.on ?? null;
    const t = store.youtube;
    const showTv = target === 'tv' && !!t;
    const k = JSON.stringify([
      y && [y.id, y.title, y.index, y.paused, y.rate, y.pausedBy, y.duration, y.list],
      m?.listeners,
      player.errorText(),
      player.needsClick(),
      !!player.duration(),
      player.rateNote(),
      showTv && [t.id, t.title, t.paused, t.rate, t.by, t.pausedBy, t.duration],
    ]);
    const list = m?.list;
    if (!force && k === drawn && list === drawnList) return;
    drawn = k;
    drawnList = list;
    mine.hidden = !m;
    idle.hidden = !!m || showTv;
    if (m) {
      nowTitle.textContent = y ? youtubeTitle(y) : 'Up next…';
      nowTitle.title = nowTitle.textContent;
      nowMeta.textContent = [listenersLine(m.listeners), y && `by ${y.by}`, player.errorText(), player.needsClick() ? '🔇 click to hear it' : ''].filter(Boolean).join(' · ');
      ctl.render();
      queue.render();
      paintVolume();
    }
    tv.hidden = !showTv;
    if (showTv) {
      tvTitle.textContent = youtubeTitle(t);
      tvMeta.textContent = `${t.paused ? '⏸ paused' : '▶ on'} · put on by ${t.by}`;
      tvCtl.render();
    }
  }

  const offs = [
    store.on('phoneMusic', () => render()),
    store.on('youtube', () => render()),
    store.on('youtubeList', () => render()),
    store.on('peers', paintForm),
    store.on('floor', () => (paintForm(), render(true))),
    store.on('floors', paintForm),
    player.listen(() => render()),
  ];
  // The seek bars and times move on their own; the length comes in without a message (YouTube's error and the
  // click it wants come through player.listen).
  let hadDuration = !!player.duration();
  const ticker = window.setInterval(() => {
    if (!mine.hidden) ctl.tick();
    if (!tv.hidden) tvCtl.tick();
    if (!!player.duration() !== hadDuration) {
      hadDuration = !!player.duration();
      render();
    }
  }, 250);

  paintForm();
  render(true);
  // Once the phone has put the tab on its screen (the slot has to be in the page to be lined up with).
  let closed = false;
  queueMicrotask(() => closed || player.mount(slot));

  return {
    el,
    close() {
      closed = true;
      player.mount(null);
      offs.forEach((off) => off());
      clearInterval(ticker);
    },
  };
}
