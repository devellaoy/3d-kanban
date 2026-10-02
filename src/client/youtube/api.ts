// YouTube's IFrame Player API (https://developers.google.com/youtube/iframe_api_reference),
// loaded from YouTube the first time something's on the TV. Only the parts the Office TV uses are typed.

/** The player's states (YT.PlayerState). */
export const YT_STATE = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const;

export interface YtPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  loadPlaylist(o: { list: string; listType: 'playlist'; index?: number; startSeconds?: number }): void;
  playVideoAt(index: number): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  /** The speeds this video can play at (live streams and some videos only have 1). */
  getAvailablePlaybackRates(): number[];
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getPlaylist(): string[] | null;
  getPlaylistIndex(): number;
  getIframe(): HTMLIFrameElement;
  /** Not in the reference, but there: the loaded video's id, and whether it's live. */
  getVideoData?(): { video_id?: string; isLive?: boolean };
  destroy(): void;
}

export interface YtEvents {
  onReady?: (e: { target: YtPlayer }) => void;
  onStateChange?: (e: { target: YtPlayer; data: number }) => void;
  onError?: (e: { target: YtPlayer; data: number }) => void;
  onAutoplayBlocked?: (e: { target: YtPlayer }) => void;
}

interface YtNamespace {
  Player: new (el: HTMLElement | string, opts: { width?: string | number; height?: string | number; videoId?: string; host?: string; playerVars?: Record<string, string | number>; events?: YtEvents }) => YtPlayer;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YtNamespace> | null = null;

/** YouTube's API, loading it first if it isn't here yet. A failed load is tried again next time. */
export function loadYoutubeApi(): Promise<YtNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise<YtNamespace>((resolve, reject) => {
    const before = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      before?.();
      resolve(window.YT!);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error("YouTube's player didn't load"));
    };
    document.head.append(s);
  });
  return loading;
}

/** What YouTube's error codes mean, for the TV and a toast. */
export function youtubeError(code: number): string {
  if (code === 101 || code === 150 || code === 152) return "🚫 This video's owner doesn't let it play outside YouTube";
  if (code === 100) return '🚫 That video is private, or it was taken down';
  if (code === 2) return "🚫 YouTube didn't take that link";
  if (code === 5) return "🚫 Your browser can't play this video";
  if (code === 153) return "🚫 YouTube wouldn't play here (it was given no page address)";
  return `🚫 YouTube couldn't play it (error ${code})`;
}

/** The codes after which it won't ever play here: the office takes it off (or goes on to the next one). */
export const BLOCKED = new Set([100, 101, 150, 152]);
