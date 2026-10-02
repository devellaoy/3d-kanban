// The phone's music: a YouTube link or playlist for yourself, or for you and someone you play it to.
// Each is a session of its own on the office, with the same play, controls and queue as a floor's TV
// (server/youtube/tv.ts), only nobody else hears it: no floor, no distance, your own volume.
import type { YoutubeClientMsg } from '../youtube/protocol.js';
import type { YoutubeTvState } from '../youtube/link.js';
import type { YoutubeTvList } from '../youtube/queue.js';

/** The TV's controls a session takes too, as they are: each names the play `id` it means. */
export type PhoneMusicControl = Extract<
  YoutubeClientMsg,
  { t: 'tv.youtube.pause' | 'tv.youtube.seek' | 'tv.youtube.rate' | 'tv.youtube.skip' | 'tv.youtube.ended' | 'tv.youtube.info' | 'tv.youtube.queue.move' | 'tv.youtube.queue.remove' | 'tv.youtube.queue.jump' | 'tv.youtube.queue.clear' }
>;

/** One of the people listening to a session. */
export interface PhoneListener {
  /** Their PeerInfo id (a connection's id). */
  id: string;
  name: string;
}

/** The session you're listening to. */
export interface PhoneMusicState {
  /** Which session (not the play: that's `state.id`). */
  session: string;
  /** Who started it. */
  by: string;
  /** Everyone listening, you too, in the order they joined. */
  listeners: PhoneListener[];
  /** What plays now, as on the TV; null between the end of one and the session going (it goes once nothing's left). */
  state: YoutubeTvState | null;
  /** Its queue, as the TV's (`sameVolume` means nothing here). */
  list: YoutubeTvList;
}
