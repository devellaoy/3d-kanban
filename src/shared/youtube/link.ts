// YouTube on the Office TV. Telling a YouTube (or YouTube Music) link apart, and what's
// on the TV, shared by the server (which keeps one per floor) and the browser (which plays it in
// YouTube's own player, see client/youtube/).

/** What a YouTube link points at: a video, a playlist (from `index`), or a video in one, and where to start. */
export interface YoutubeLink {
  /** The 11-character video id; absent for a playlist link without one. */
  videoId?: string;
  /** A playlist's id, when the link plays one. */
  list?: string;
  /** Where in `list` it starts, 0 for the first. */
  index?: number;
  /** Seconds into the video it starts at (`t=` or `start=`). */
  start: number;
}

/** The speeds the TV plays at (YouTube's own steps); anything else is turned away. */
export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** What's on the TV: a YouTube video or playlist, who put it on, and where it is in it, how fast, and whether it's paused. */
export interface YoutubeTvState extends YoutubeLink {
  /** The link as it was put on, made canonical, for "Open on YouTube". */
  url: string;
  /** Which play this is: a token of its own, never reused (two plays can start in the same millisecond). Every control names it, so a late one for an older play is ignored. */
  id: string;
  /** Who put it on. */
  by: string;
  /** Seconds into the video (or into the playlist's current video) it was at `at`. The link's own `start` is only where it was put on from. */
  position: number;
  /** The office's clock (see the 'pong' message) when it was at `position`, so everyone sees the same frame. Every pause, seek and speed change moves it. */
  at: number;
  /** How fast it plays, one of RATES. */
  rate: number;
  /** Whether it's held still at `position` (then `at` doesn't matter). */
  paused: boolean;
  /** Who paused it, while it's paused. */
  pausedBy?: string;
  /** How long ago `at` was when this was sent, in ms, for until the clocks are compared. */
  elapsed: number;
  /** How long the video is, in seconds, once a browser has said (so a seek can't go past the end). */
  duration?: number;
  /** How many videos the playlist has, once a browser has said (so ⏭️ knows when it's on the last). */
  listLength?: number;
  /** The video's (or playlist's) title from YouTube's oEmbed, once the office has it. */
  title?: string;
}

/** Where the TV is at `nowMs` (office clock), in seconds: held still when paused, else carried on from `at` at its speed. Never below 0. */
export function tvPosition(s: Pick<YoutubeTvState, 'position' | 'at' | 'rate' | 'paused'>, nowMs: number): number {
  if (s.paused) return Math.max(0, s.position);
  return Math.max(0, s.position + (s.rate * (nowMs - s.at)) / 1000);
}

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Whether `raw` is a YouTube video id (11 characters of letters, digits, `-` and `_`). */
export const isVideoId = (raw: unknown): raw is string => typeof raw === 'string' && VIDEO_ID.test(raw);
const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
/** The longest start offset taken, in seconds (a day). */
const MAX_START = 86_400;

/** Whether `raw` is a link to YouTube at all (well formed or not), so the jukebox hands it to the TV. */
export function isYoutubeUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** `90`, `90s`, `1m30s`, `1h2m3s` or `01:30` as seconds; 0 when it's none of those. */
export function parseStart(raw: string | null | undefined): number {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 0;
  let n = 0;
  if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  else if (/^\d+(:\d{1,2}){1,2}$/.test(s)) n = s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    n = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_START, Math.floor(n))) : 0;
}

/**
 * A YouTube or YouTube Music link as what to play: youtube.com/watch?v=, youtu.be/, /shorts/, /live/,
 * /embed/, music.youtube.com, with `t=`/`start=` (or `#t=`) and `list=` (+ `index=`). A video in an
 * automatic mix (`list=RD…`, what YouTube Music links carry) plays on its own: a mix can't be played
 * from a link.
 */
export function parseYoutubeLink(raw: unknown): YoutubeLink | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { error: 'Paste a YouTube link' };
  if (s.length > 2048) return { error: 'That link is too long' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "That isn't a web link. Paste an address that starts with https://" };
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !HOSTS.has(u.hostname.toLowerCase())) return { error: "That isn't a YouTube link" };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  let videoId: string | undefined;
  if (host === 'youtu.be') videoId = parts[0];
  else if (parts[0] === 'watch') videoId = u.searchParams.get('v') ?? undefined;
  else if (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0] ?? '')) videoId = parts[1];
  else if (parts[0] !== 'playlist' && parts.length) return { error: "That YouTube link isn't a video or a playlist" };
  if (videoId !== undefined && !VIDEO_ID.test(videoId)) return { error: "That YouTube link's video id doesn't look right" };

  let list = u.searchParams.get('list') ?? undefined;
  if (list !== undefined && !LIST_ID.test(list)) list = undefined;
  // A mix is made up for whoever's listening (YouTube Music's links, "Mix - …"): only its video plays.
  if (list?.startsWith('RD') && videoId) list = undefined;
  const at = Number(u.searchParams.get('index'));
  // Without index=, a video in a list is played on its own: where it is in the list isn't known.
  const index = list && Number.isInteger(at) && at >= 1 ? Math.min(at - 1, 4999) : list && !videoId ? 0 : undefined;
  if (index === undefined) list = undefined;
  if (!videoId && !list) return { error: "That YouTube link isn't a video or a playlist" };

  const hashT = /(?:^|&)t=([^&]+)/.exec(u.hash.replace(/^#/, ''))?.[1];
  const start = parseStart(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hashT);
  return { ...(videoId ? { videoId } : {}), ...(list ? { list, index } : {}), start };
}

/** The link to open what's on the TV on YouTube itself (and to ask oEmbed for its title). */
export function youtubeUrl(l: YoutubeLink): string {
  if (l.list && !l.videoId) return `https://www.youtube.com/playlist?list=${l.list}${l.index ? `&index=${l.index + 1}` : ''}`;
  const q = new URLSearchParams({ v: l.videoId ?? '' });
  if (l.list) {
    q.set('list', l.list);
    q.set('index', String((l.index ?? 0) + 1));
  }
  if (l.start) q.set('t', `${l.start}s`);
  return `https://www.youtube.com/watch?${q}`;
}

/** What's on, for the hint bar, the TV and toasts: its title, or its video id until the title's known. */
export function youtubeTitle(s: Pick<YoutubeTvState, 'title' | 'videoId' | 'list' | 'index'>): string {
  if (s.title) return s.title;
  if (s.videoId) return `YouTube ${s.videoId}`;
  return `YouTube playlist${s.index ? `, #${s.index + 1}` : ''}`;
}
