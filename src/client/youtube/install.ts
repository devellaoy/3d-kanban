// 3d-kanban: YouTube on the Office TV in the 3D office. One install line in main.ts (Parts.youtube);
// the TV (features/tv) and the couch (features/seating) ask it first through their deps, and the
// jukebox's window through two seams (see docs/fork.md).
//
// What the TV shows, first to last: someone's shared screen (a share always has the TV; YouTube pauses
// for it and picks up in step after), then YouTube, then the idle card.
import { youtubeTitle } from '../../shared/youtube/link';
import type { Ctx, Hint } from '../core/context';
import { aside, hintTitle, key } from '../core/hint';
import type { Parts } from '../core/parts';
import { store } from '../state';
import { clip, toast } from '../ui/dom';
import { TvScreen } from './screen';
import { openTvWindow } from './window';

export type YoutubeParts = Pick<Parts, 'talk' | 'settings' | 'hud'>;

export function installYoutubeTv(ctx: Ctx, parts: YoutubeParts) {
  const shares = () => parts.talk.currentShares();
  const screen = new TvScreen(ctx, { shareOn: () => shares().length > 0, settings: () => parts.settings });

  // Someone coming in with something on, while the browser still wants a click before it can be heard.
  let greeted = '';
  store.on('youtube', () => {
    screen.changed();
    const y = store.youtube;
    if (y && greeted !== y.id && !navigator.userActivation?.hasBeenActive) toast(`📺 “${youtubeTitle(y)}” is on the TV: click the office to hear it`);
    greeted = y?.id ?? '';
    ctx.hint.invalidate();
  });
  ctx.ticks.add('render', ({ now }) => screen.frame(now));
  (window as unknown as { __youtubeTv: TvScreen }).__youtubeTv = screen;

  function watchIt() {
    openTvWindow({
      net: ctx.net,
      screen,
      sharing: () => shares()[0]?.[0],
      shareScreen: () => void parts.talk.toggleShare(),
      openVolume: () => parts.hud.showSettings('sound'),
    });
  }

  return {
    /** YouTube is what the TV shows (on, and nobody's sharing a screen). */
    showing: () => !!store.youtube && shares().length === 0,
    /** The TV window, unless a shared screen has the TV. Says whether it opened. */
    watch(): boolean {
      if (shares().length > 0 || !store.youtube) return false;
      watchIt();
      return true;
    },
    /** E at the TV: watch YouTube big, or put something on; a shared screen is features/voice's. Says whether it took the key. */
    tvUse(): boolean {
      if (shares().length > 0) return false;
      watchIt();
      return true;
    },
    /** The TV's hint while YouTube has it, or nothing's on; a shared screen's is upstream's. */
    tvHint(): Hint | null {
      if (shares().length > 0) return null;
      const y = store.youtube;
      if (!y) return { k: 'yt|off', parts: [hintTitle('📺 Office TV'), key('E', 'Put on YouTube or share your screen')] };
      const error = screen.errorText();
      const quiet = screen.needsClick();
      return {
        k: `yt|${y.id}|${y.title}|${y.index}|${error}|${quiet}`,
        parts: [hintTitle('📺 Office TV'), aside(`▶ ${clip(youtubeTitle(y), 40)} · ${y.by}`), error ? aside(error) : '', quiet ? aside('🔇 click to hear') : '', key('E', 'Watch it big')],
      };
    },
  };
}
