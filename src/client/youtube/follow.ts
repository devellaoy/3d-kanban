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
