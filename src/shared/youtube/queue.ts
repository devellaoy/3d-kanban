// The Office TV's queue ("Up next"), as the floor sees it. The server keeps it (server/youtube/).
import type { YoutubeLink } from './link.js';

/** The longest the queue gets; adding to a full one is turned away. */
export const QUEUE_MAX = 100;

/** The most videos a playlist is unpacked from (a longer one is sent as a window around where it is). */
export const UNPACK_MAX = 200;

/** A video or playlist waiting its turn on the TV. */
export interface YoutubeQueueItem extends YoutubeLink {
  /** Which queue entry this is: a token of its own, what the queue's controls name. */
  qid: string;
  /** The link as it was added, made canonical. */
  url: string;
  /** Who added it. */
  by: string;
  /** Its title from YouTube's oEmbed, once the office has it. */
  title?: string;
}

/** The TV's queue and settings, sent with `tv.youtube` only when they change. */
export interface YoutubeTvList {
  /** What plays after the current one, in order. */
  queue: YoutubeQueueItem[];
  /** Whether something played before the current one, for ⏮️ (it's otherwise "back to the start"). */
  back: boolean;
  /** Whether everyone on the floor hears the TV equally loud, however far from it they stand. */
  sameVolume: boolean;
}
