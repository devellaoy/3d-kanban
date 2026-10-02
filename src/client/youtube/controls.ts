// The TV window's transport bar, under the player: ⏮️ ⏪ ⏯️ ⏩ ⏭️, the seek bar and the time, the
// speed, and who paused it. Every button says what it does to the whole floor's TV: the office keeps
// one play per floor (server/youtube/), and these only ask it.
import { RATES } from '../../shared/youtube/link';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h } from '../ui/dom';
import type { TvScreen } from './screen';
import { youtubeAt, type YoutubeOnTv } from './slice';

/** `75` as `1:15`, `3725` as `1:02:05`. */
export function clockTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** `1.25` as `1.25×`. */
const rateLabel = (r: number) => `${r}×`;

export interface TvControls {
  el: HTMLElement;
  /** What's on changed (paused, speed, what plays, its length): the buttons and the speed. */
  render(): void;
  /** The seek bar and the time, a few times a second. */
  tick(): void;
}

export function tvControls(deps: { net: Net; screen: TvScreen }): TvControls {
  const send = (m: YoutubeClientMsg) => deps.net.send(m);
  /** Sends a control for what's on now, naming its play. */
  const control = (make: (id: string) => YoutubeClientMsg) => () => {
    const y = store.youtube;
    if (y) send(make(y.id));
  };
  const btn = (label: string, title: string, onclick: () => void, cls = '') =>
    h('button.btn', { type: 'button', class: cls, title, 'aria-label': title, onclick }, label);

  const back = btn('⏮️', 'Previous: back a video, or to the start', control((id) => ({ t: 'tv.youtube.skip', id, dir: -1 })));
  const back30 = btn('⏪30', 'Back 30 seconds', control((id) => ({ t: 'tv.youtube.seek', id, by: -30 })));
  const back10 = btn('⏪10', 'Back 10 seconds', control((id) => ({ t: 'tv.youtube.seek', id, by: -10 })));
  const toggle = btn('⏸️', 'Pause', control((id) => ({ t: 'tv.youtube.pause', id, paused: !store.youtube?.paused })), 'primary ytv-play');
  const fwd10 = btn('⏩10', 'Forward 10 seconds', control((id) => ({ t: 'tv.youtube.seek', id, by: 10 })));
  const fwd30 = btn('⏩30', 'Forward 30 seconds', control((id) => ({ t: 'tv.youtube.seek', id, by: 30 })));
  const next = btn('⏭️', 'Next: the playlist’s next video, or the next in the queue', control((id) => ({ t: 'tv.youtube.skip', id, dir: 1 })));

  const seek = h('input.ytv-seek', { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Where it is' }) as HTMLInputElement;
  const time = h('span.ytv-time', { 'aria-live': 'off' }, '0:00');
  const speed = h(
    'select.ytv-rate',
    { 'aria-label': 'Speed', title: 'Speed, for everyone on this floor' },
    ...RATES.map((r) => h('option', { value: String(r) }, rateLabel(r))),
  ) as HTMLSelectElement;
  const note = h('div.ytv-ctl-note.setting-note');

  /** Dragging the seek bar: shows where you'd land, and goes there on letting go. */
  let dragging = false;
  seek.addEventListener('input', () => {
    dragging = true;
    paintTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    dragging = false;
    const y = store.youtube;
    if (y) send({ t: 'tv.youtube.seek', id: y.id, to: Number(seek.value) });
  });
  // Let go where it started: no 'change' comes, so stop previewing (after a 'change' that does come).
  const letGo = () => setTimeout(() => (dragging = false));
  seek.addEventListener('pointerup', letGo);
  seek.addEventListener('blur', letGo);
  speed.addEventListener('change', () => {
    const y = store.youtube;
    if (y) send({ t: 'tv.youtube.rate', id: y.id, rate: Number(speed.value) });
  });

  const el = h(
    'div.ytv-controls',
    {},
    h('div.ytv-transport', { role: 'group', 'aria-label': 'Playback' }, back, back30, back10, toggle, fwd10, fwd30, next),
    h('div.ytv-seekrow', {}, seek, time, speed),
    note,
  );

  /** How long what's on is: the player's own word first (it knows the playlist's current video), else the office's. Undefined for live or not yet known. */
  const length = (y: YoutubeOnTv): number | undefined => {
    const d = deps.screen.duration() || y.duration;
    return d && d > 0 ? d : undefined;
  };

  function paintTime(at: number) {
    const y = store.youtube;
    const d = y ? length(y) : undefined;
    time.textContent = d ? `${clockTime(at)} / ${clockTime(d)}` : clockTime(at);
    if (d) seek.style.setProperty('--fill', `${Math.min(100, (at / d) * 100)}%`);
  }

  return {
    el,
    render() {
      const y = store.youtube;
      el.hidden = !y;
      if (!y) return;
      toggle.textContent = y.paused ? '▶️' : '⏸️';
      toggle.title = y.paused ? 'Play' : 'Pause';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-pressed', String(y.paused));
      // A rate the select doesn't have (an older office) still shows.
      if (speed.value !== String(y.rate)) speed.append(h('option', { value: String(y.rate) }, rateLabel(y.rate)));
      speed.value = String(y.rate);
      const why = [y.paused ? `⏸ paused${y.pausedBy ? ` by ${y.pausedBy}` : ''}` : '', deps.screen.rateNote()].filter(Boolean).join(' · ');
      note.textContent = why;
      note.hidden = !why;
      this.tick();
    },
    tick() {
      const y = store.youtube;
      if (!y) return;
      const d = length(y);
      seek.hidden = !d;
      el.classList.toggle('live', !d);
      if (!d) return paintTime(youtubeAt(y));
      seek.max = String(Math.floor(d));
      if (dragging) return;
      const at = Math.min(d, youtubeAt(y));
      seek.value = String(Math.floor(at));
      paintTime(at);
    },
  };
}
