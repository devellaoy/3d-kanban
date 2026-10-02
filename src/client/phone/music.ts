// The phone's music (phone/player.ts): a YouTube link for yourself or for you and someone else, as a session
// the office keeps (server/youtube/, shared/phone/music.ts). It follows store.phoneMusic with a PhonePlayer,
// gives way to the office's own music while it plays (sound/ducking.ts), and hands the phone's screen what it
// needs to start, control and leave a session. The screen itself (the Music tab) is the phone's UI.
import type { PhoneMusicControl } from '../../shared/phone/music';
import { parseYoutubeLink } from '../../shared/youtube/link';
import type { Ctx } from '../core/context';
import type { Parts } from '../core/parts';
import { ducking } from '../sound/ducking';
import { store } from '../state';
import { toast } from '../ui/dom';
import type { TvControlsSource } from '../youtube/controls';
import type { TvQueueSource } from '../youtube/queue';
import { PhonePlayer } from './player';

export type PhoneMusicParts = Pick<Parts, 'settings'>;

export interface PhoneMusic {
  player: PhonePlayer;
  /** Starts a session with `url` for you, or for you and the person `to` (a PeerInfo id); with `queue`, adds it to your session's queue. Says whether it went (a bad link is toasted). */
  play(url: string, to?: string, queue?: 'end' | 'next'): boolean;
  /** One of the TV's controls, for your session. */
  control(control: PhoneMusicControl): void;
  /** ⏏ Stop listening. */
  leave(): void;
  /** For `tvControls(...)`: the session's transport bar. */
  controlsSource(): TvControlsSource;
  /** For `tvQueue(...)`: the session's queue (no unpacking, and a link adds to it). */
  queueSource(): TvQueueSource;
}

export function installPhoneMusic(ctx: Ctx, parts: PhoneMusicParts): PhoneMusic {
  const { net } = ctx;
  const player = new PhonePlayer({ net, settings: () => parts.settings });

  const play: PhoneMusic['play'] = (url, to, queue) => {
    const l = parseYoutubeLink(url);
    if ('error' in l) {
      toast(l.error, 'warn');
      return false;
    }
    net.send({ t: 'phone.music.play', url: url.trim(), ...(to ? { to } : {}), ...(queue ? { queue } : {}) });
    return true;
  };
  const control = (c: PhoneMusicControl) => net.send({ t: 'phone.music.control', control: c });
  const leave = () => net.send({ t: 'phone.music.leave' });

  // Headphones: the TV and the jukebox are silent for you while yours plays.
  const duck = () => ducking.set(player.playing());
  store.on('phoneMusic', () => {
    player.changed();
    duck();
  });
  ctx.ticks.add('render', ({ now }) => player.frame(now));
  (window as unknown as { __phoneMusic: PhonePlayer }).__phoneMusic = player;

  return {
    player,
    play,
    control,
    leave,
    controlsSource: () => player.controls(control),
    queueSource: () => ({
      state: () => player.state(),
      list: () => store.phoneMusic?.list ?? { queue: [], back: false, sameVolume: false },
      send: control,
      add: (raw, queue) => play(raw, undefined, queue),
      unpack: null,
      canUnpack: () => false,
      addLabel: 'Add a YouTube link to your music',
      addNote: 'A video or a playlist from YouTube or YouTube Music. Enter adds it to the queue, or plays it if nothing’s on.',
      guest: false,
    }),
  };
}
