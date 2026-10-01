// The Office TV's YouTube messages, riding the office's socket (see ClientMsg/ServerMsg in
// shared/protocol.ts and docs/fork.md).
import type { YoutubeTvState } from './link.js';

export type YoutubeClientMsg =
  /** Put a YouTube link on this floor's TV (the jukebox goes quiet). */
  | { t: 'tv.youtube.play'; url: string }
  /** Take it off the TV. */
  | { t: 'tv.youtube.stop' }
  /**
   * What's on (the play `id`) has played to its end, or YouTube won't play it
   * here (`blocked`: its error code). `next`: a playlist has another video after it.
   */
  | { t: 'tv.youtube.ended'; id: string; next?: boolean; blocked?: number };

export type YoutubeServerMsg =
  /** What's on this floor's TV now; null for nothing. */
  { t: 'tv.youtube'; state: YoutubeTvState | null };
