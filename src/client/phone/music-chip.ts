// While your phone plays music and the phone is put away: a chip in the HUD's lower right corner with what
// plays, ⏯ and ⏏, so someone who was played something (and never opened the phone) can pause or leave it.
// Clicking its title opens the phone on 🎵 Music.
import { youtubeTitle } from '../../shared/youtube/link';
import { store } from '../state';
import { h } from '../ui/dom';
import type { PhoneMusic } from './music';

export interface MusicChipDeps {
  music: PhoneMusic;
  /** Whether the phone is open (the chip steps aside: the Music tab has it all). */
  phoneOpen(): boolean;
  /** Opens the phone on 🎵 Music. */
  openMusic(): void;
}

export function installMusicChip(deps: MusicChipDeps) {
  const { music } = deps;
  const title = h('span.phm-chip-title');
  const open = h('button.phm-chip-open', { type: 'button', onclick: () => deps.openMusic() }, h('span', { 'aria-hidden': 'true' }, '🎵'), title);
  const toggle = h('button.btn.phm-chip-btn', { type: 'button' });
  const leave = h('button.btn.phm-chip-btn', { type: 'button', title: 'Stop listening', 'aria-label': 'Stop listening', onclick: () => music.leave() }, '⏏');
  toggle.addEventListener('click', () => {
    const y = music.player.state();
    if (y) music.control({ t: 'tv.youtube.pause', id: y.id, paused: !y.paused });
  });
  const el = h('div.phm-chip.panel', { role: 'group', 'aria-label': 'Music on your phone', hidden: true }, open, toggle, leave);
  document.getElementById('hud')?.append(el);

  let drawn = '';
  function render() {
    const y = music.player.state();
    const show = !!store.phoneMusic && !deps.phoneOpen();
    const quiet = music.player.needsClick();
    const k = JSON.stringify([show, y && [y.id, y.title, y.index, y.paused], quiet]);
    if (k === drawn) return;
    drawn = k;
    el.hidden = !show;
    if (!show) return;
    const name = y ? youtubeTitle(y) : 'Up next…';
    title.textContent = quiet ? `${name} · 🔇 click to hear` : name;
    open.title = `${name}: open the phone’s music (Y)`;
    toggle.textContent = y?.paused ? '▶' : '⏸';
    toggle.title = y?.paused ? 'Play' : 'Pause';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.disabled = !y;
  }
  store.on('phoneMusic', render);
  music.player.listen(render);
  return { render };
}
