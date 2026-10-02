// What the TV's player has to be, to be trusted with the office's clock: pure decisions for screen.ts, no DOM or three.

/** What the office has on: a playlist (at `index`) or a single video. */
export type OnTv = { list?: string; index?: number; videoId?: string; rate: number };
/** What the player says it is on. */
export type PlayerAt = { index: number; videoId?: string };

/** Whether the player is on the video the office has: the same place in the playlist, or the same single video. */
export function onOfficeVideo(y: Pick<OnTv, 'list' | 'index' | 'videoId'>, p: PlayerAt): boolean {
  return y.list ? p.index === (y.index ?? 0) : !y.videoId || p.videoId === y.videoId;
}

/**
 * Whether the office's timeline says a single video is over (`want` is its place on it) for the player: only when
 * the player runs at the office's speed on the same video. A player held at 1× while the office is at 2× is not
 * at the end yet, however far the timeline has gone; its own ENDED state tells when it is.
 */
export function endedByClock(y: OnTv, duration: number, want: number, p: PlayerAt & { rate: number }): boolean {
  return duration > 0 && !y.list && p.rate === y.rate && onOfficeVideo(y, p) && want >= duration - 0.5;
}

/** The timing a browser has followed of a play: what a change of must be followed at once. */
export type Timing = { id: string; position: number; at: number; rate: number; paused: boolean };

/**
 * Whether the play `y` has timing the browser hasn't followed yet: a new play, or the same one paused, resumed, moved or
 * sped up. It also means an end told earlier may have been dropped by the office (while it was paused, or before the
 * move), so it is told again if it's still over.
 */
export function timingChanged(f: Timing | null, y: Timing): boolean {
  return !f || f.id !== y.id || f.position !== y.position || f.at !== y.at || f.rate !== y.rate || f.paused !== y.paused;
}

/** Whether a playlist whose length is known (`length`) has no video at `index`: ⏭️ went past its end, so it's over. */
export function pastPlaylistEnd(index: number, length: number | undefined): boolean {
  return !!length && index >= length;
}

/**
 * Whether the player's own ENDED, seen in a sync, says the office's video is over: once the guard against the last
 * play's late events (`settled`) has passed and the player is on the office's video. An ENDED that came while the
 * guard held (a start at the very end) is only found this way, whatever the speeds.
 */
export function endedByPlayer(y: Pick<OnTv, 'list' | 'index' | 'videoId'>, settled: boolean, p: PlayerAt): boolean {
  return settled && onOfficeVideo(y, p);
}
