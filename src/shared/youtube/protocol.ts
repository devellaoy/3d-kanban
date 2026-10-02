// The Office TV's YouTube messages, riding the office's socket (see ClientMsg/ServerMsg in
// shared/protocol.ts and docs/fork.md). Every control names the play `id` it means (YoutubeTvState.id):
// one for an older play, said late, is ignored.
import type { YoutubeTvState } from './link.js';
import type { YoutubeTvList } from './queue.js';

export type YoutubeClientMsg =
  /**
   * Put a YouTube link on this floor's TV (the jukebox goes quiet). Without `queue` it plays now and what
   * was on goes to the history; `queue` adds it to the end ('end') or to the front ('next') of the queue
   * instead, and it starts at once if nothing is on.
   */
  | { t: 'tv.youtube.play'; url: string; queue?: 'end' | 'next' }
  /** Take what's on off the TV; the queue stays. */
  | { t: 'tv.youtube.stop' }
  /**
   * What's on (the play `id`) has played to its end, or YouTube won't play it
   * here (`blocked`: its error code). `next`: a playlist has another video after it.
   * With no `next` the queue's first item plays, if there is one.
   */
  | { t: 'tv.youtube.ended'; id: string; next?: boolean; blocked?: number }
  /** Hold the play still, or carry on. */
  | { t: 'tv.youtube.pause'; id: string; paused: boolean }
  /** Jump to `to` seconds, or by `by` seconds from where it is now (negative for back). The office works the place out on its own clock. */
  | { t: 'tv.youtube.seek'; id: string; to?: number; by?: number }
  /** Change the speed; one of RATES. */
  | { t: 'tv.youtube.rate'; id: string; rate: number }
  /** ⏭️ (1) or ⏮️ (-1): the next/previous video of a YouTube playlist, else the queue's next / the last one played (else back to the start). */
  | { t: 'tv.youtube.skip'; id: string; dir: 1 | -1 }
  /** Move a queued item to place `to` (0 is the front). */
  | { t: 'tv.youtube.queue.move'; qid: string; to: number }
  | { t: 'tv.youtube.queue.remove'; qid: string }
  /** Play a queued item now; what was on goes to the history. */
  | { t: 'tv.youtube.queue.jump'; qid: string }
  | { t: 'tv.youtube.queue.clear' }
  /**
   * Turn the playing YouTube playlist into queue items: `videoIds` is the WHOLE playlist in order, as the
   * player reports it (getPlaylist()), at most 200 11-character ids. The play keeps going as the playlist's
   * current video on its own (same `id`, no reload, `list` and `index` dropped), and the videos after it
   * go to the front of the queue in order.
   */
  | { t: 'tv.youtube.unpack'; id: string; videoIds: string[] }
  /** What a browser's player knows: the video's length and the playlist's. Each is taken once per play (the first to say). */
  | { t: 'tv.youtube.info'; id: string; duration?: number; listLength?: number }
  /** Everyone on the floor hears the TV equally loud (or by distance, as usual). */
  | { t: 'tv.youtube.settings'; sameVolume: boolean };

export type YoutubeServerMsg =
  /** What's on this floor's TV now (null for nothing), and the queue and settings when they changed (always on a new play). */
  { t: 'tv.youtube'; state: YoutubeTvState | null; list?: YoutubeTvList };
