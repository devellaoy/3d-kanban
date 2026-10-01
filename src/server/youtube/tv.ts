// 3d-kanban: what's on one floor's Office TV from YouTube, saved in .agent-office/youtube-tv.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseYoutubeLink, youtubeUrl, type YoutubeTvState } from '../../shared/youtube/link.js';

/** What's kept: the state without `elapsed`, which is worked out as it's sent. */
type Saved = Omit<YoutubeTvState, 'elapsed'>;

/**
 * The YouTube video (or playlist) on one floor's TV. Like the jukebox it only says what's on and
 * since when; every browser plays it in YouTube's own player, from the same point.
 */
export class YoutubeTv {
  private s: Saved | null = null;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, 'youtube-tv.json');
    this.load();
  }

  state(): YoutubeTvState | null {
    return this.s ? { ...this.s, elapsed: Math.max(0, this.now() - this.s.startedAt) } : null;
  }

  /** Puts `url` on (checked here, whatever the browser checked), from its `t=` if it has one. */
  play(url: unknown, by: string): { state: YoutubeTvState } | { error: string } {
    const l = parseYoutubeLink(url);
    if ('error' in l) return l;
    this.set({ ...l, url: youtubeUrl(l), by: by.slice(0, 24), startedAt: this.now() });
    return { state: this.state()! };
  }

  /** Takes it off. Says whether anything was on. */
  stop(): boolean {
    if (!this.s) return false;
    this.s = null;
    this.save();
    return true;
  }

  /**
   * The play that started at `startedAt` is over: a playlist with `next` goes on to its next video,
   * anything else comes off. Only the first browser to say so counts (the rest name an older play).
   */
  ended(startedAt: unknown, next: boolean): 'next' | 'stopped' | null {
    if (!this.s || startedAt !== this.s.startedAt) return null;
    if (next && this.s.list) {
      const { videoId: _v, title: _t, ...rest } = this.s;
      const index = (this.s.index ?? 0) + 1;
      this.set({ ...rest, index, start: 0, url: youtubeUrl({ list: rest.list, index, start: 0 }), startedAt: this.now() });
      return 'next';
    }
    this.stop();
    return 'stopped';
  }

  /** The title YouTube gave it, if it's still the play that was asked about. */
  titled(startedAt: number, title: string): boolean {
    if (!this.s || this.s.startedAt !== startedAt || !title) return false;
    this.s = { ...this.s, title: title.slice(0, 200) };
    this.save();
    return true;
  }

  private set(s: Saved) {
    this.s = s;
    this.save();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved> | null;
      if (!s || typeof s.url !== 'string') return;
      const l = parseYoutubeLink(s.url);
      if ('error' in l || typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)) return;
      this.s = {
        ...l,
        // The saved start: the link's own `t=` is where it was put on from.
        start: typeof s.start === 'number' && s.start >= 0 ? s.start : l.start,
        url: youtubeUrl(l),
        by: typeof s.by === 'string' ? s.by.slice(0, 24) : 'Someone',
        startedAt: s.startedAt,
        ...(typeof s.title === 'string' && s.title ? { title: s.title.slice(0, 200) } : {}),
      };
    } catch {
      // a broken file just means a dark TV
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.s, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
