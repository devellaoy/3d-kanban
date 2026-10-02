// The jukebox's side of YouTube on the Office TV (two seams in features/jukebox/ui.ts): a
// YouTube link pasted into its stream box goes on the TV, and its window says what's on there.
import { isYoutubeUrl, youtubeTitle } from '../../shared/youtube/link';
import type { Net } from '../net';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { sendToTv } from './queue';

/** A YouTube link in the jukebox's stream box: off to the TV instead (the jukebox can't play YouTube). Says whether it was one. */
export function youtubeToTv(net: Net, input: HTMLInputElement): boolean {
  if (!isYoutubeUrl(input.value)) return false;
  if (sendToTv(net, input.value)) {
    input.value = '';
    toast('📺 That’s YouTube: it goes on the Office TV, and the jukebox goes quiet meanwhile');
  } else input.focus();
  return true;
}

/** A line in the jukebox's window: what's on the TV, or that a YouTube link goes there. */
export function jukeboxTvNote(): HTMLElement {
  const el = h('p.setting-note.ytv-jb-note');
  const paint = () => {
    const y = store.youtube;
    el.textContent = y
      ? `📺 On the Office TV now: “${youtubeTitle(y)}”, put on by ${y.by}. The jukebox stays quiet while it plays; putting a tune on takes it off the TV.`
      : '📺 A YouTube or YouTube Music link goes on the Office TV (by the couch) instead, and the jukebox goes quiet while it plays.';
  };
  const off = store.on('youtube', () => (el.isConnected ? paint() : off()));
  paint();
  return el;
}
