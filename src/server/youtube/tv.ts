// What's on one floor's Office TV from YouTube, its queue and what played before, saved in
// .agent-office/youtube-tv.json.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RATES, isVideoId, parseYoutubeLink, tvPosition, youtubeUrl, type YoutubeLink, type YoutubeTvState } from '../../shared/youtube/link.js';
import { QUEUE_MAX, UNPACK_MAX, type YoutubeQueueItem, type YoutubeTvList } from '../../shared/youtube/queue.js';
import * as q from './queue.js';
import { parseSaved, type Play, type Saved } from './saved.js';

const clip = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The YouTube video (or playlist) on one floor's TV. Like the jukebox it only says where it is
 * (`position` at `at`, how fast, whether it's paused); every browser plays it in YouTube's own
 * player, from the same point. Every change of timing first freezes where it is now, then changes
 * the one thing, and every control names the play `id` it means (a stale one does nothing and says so).
 */
export class YoutubeTv {
  private s: Play | null = null;
  private queue: YoutubeQueueItem[] = [];
  private history: YoutubeQueueItem[] = [];
  private sameVolume = false;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    /** A new play's (or queue entry's) id (see YoutubeTvState.id). */
    private readonly newId: () => string = randomUUID,
  ) {
    this.file = path.join(dataDir, 'youtube-tv.json');
    this.load();
  }

  state(): YoutubeTvState | null {
    return this.s ? { ...this.s, elapsed: Math.max(0, this.now() - this.s.at) } : null;
  }

  list(): YoutubeTvList {
    return { queue: [...this.queue], back: this.history.length > 0, sameVolume: this.sameVolume };
  }

  /**
   * Puts `url` on (checked here, whatever the browser checked), from its `t=` if it has one: now, with what was on going
   * to the history, or with `queue` into the queue (it starts at once if nothing is on, then `queued` is absent).
   */
  play(url: unknown, by: string, queue?: 'end' | 'next'): { state: YoutubeTvState; queued?: YoutubeQueueItem } | { error: string } {
    const l = parseYoutubeLink(url);
    if ('error' in l) return l;
    const item = this.item(l, by);
    if (queue && this.s) {
      const next = q.add(this.queue, item, queue);
      if (!next) return { error: 'The TV queue is full' };
      this.queue = next;
      this.save();
      return { state: this.state()!, queued: item };
    }
    this.begin(item, true);
    return { state: this.state()! };
  }

  /** Takes what's on off, the queue stays. Says whether anything was on. */
  stop(): boolean {
    if (!this.s) return false;
    this.s = null;
    this.save();
    return true;
  }

  /** Holds it still or lets it go on; says whether that changed anything. */
  pause(id: unknown, paused: unknown, by: string): boolean {
    if (!this.s || id !== this.s.id || typeof paused !== 'boolean' || paused === this.s.paused) return false;
    const { pausedBy: _p, ...rest } = this.frozen();
    this.set({ ...rest, paused, ...(paused ? { pausedBy: by.slice(0, 24) } : {}) });
    return true;
  }

  /** Jumps to `to` seconds, or by `by` from where it is; kept within the video (its length, once known). */
  seek(id: unknown, to: unknown, by: unknown): boolean {
    if (!this.s || id !== this.s.id) return false;
    const target = clip(to) ? to : clip(by) ? tvPosition(this.s, this.now()) + by : undefined;
    if (target === undefined) return false;
    const max = this.s.duration ?? Infinity;
    this.set({ ...this.s, position: Math.max(0, Math.min(max, target)), at: this.now() });
    return true;
  }

  rate(id: unknown, rate: unknown): boolean {
    if (!this.s || id !== this.s.id || !RATES.some((r) => r === rate) || rate === this.s.rate) return false;
    this.set({ ...this.frozen(), rate: rate as number });
    return true;
  }

  /**
   * ⏭️ (1) or ⏮️ (-1). Forward: the YouTube playlist's next video (unless it's on its last), else the queue's next, else off.
   * Back: the playlist's previous video, else the last one played (what's on goes to the queue's front, or is left out
   * when the queue is full: a queued video is never pushed off), else the start.
   * Null when `id` isn't what's on.
   */
  skip(id: unknown, dir: unknown): 'list' | 'queue' | 'history' | 'restart' | 'stopped' | null {
    const s = this.s;
    if (!s || id !== s.id || (dir !== 1 && dir !== -1)) return null;
    const index = s.index ?? 0;
    if (dir === 1) {
      if (s.list && (s.listLength === undefined || index + 1 < s.listLength)) return this.inList(index + 1);
      return this.nextOrOff() ? 'queue' : 'stopped';
    }
    if (s.list && index > 0) return this.inList(index - 1);
    const last = this.history.at(-1);
    if (!last) {
      this.set({ ...s, position: 0, at: this.now() });
      return 'restart';
    }
    this.history = this.history.slice(0, -1);
    // What was on goes to the queue's front, unless the queue is full: it is then the one left out, never a queued item.
    this.queue = q.add(this.queue, this.item(s, s.by, s), 'next') ?? this.queue;
    this.begin(last, false);
    return 'history';
  }

  /**
   * The play `id` is over: a playlist with `next` goes on to its next video, else the queue's first item plays,
   * else it comes off. Only the first browser to say so counts (the rest name an older play).
   */
  ended(id: unknown, next: boolean): 'next' | 'queue' | 'stopped' | null {
    if (!this.s || id !== this.s.id) return null;
    const index = this.s.index ?? 0;
    // Past the playlist's known end there's no next video: it's over like any other.
    if (next && this.s.list && (this.s.listLength === undefined || index + 1 < this.s.listLength)) {
      this.inList(index + 1);
      return 'next';
    }
    if (this.nextOrOff()) return 'queue';
    return 'stopped';
  }

  /** What a browser knows of it: the length of the video, the playlist's. Each is taken once. Says whether anything was new. */
  info(id: unknown, duration: unknown, listLength: unknown): boolean {
    const s = this.s;
    if (!s || id !== s.id) return false;
    const d = s.duration === undefined && clip(duration) && duration > 0 && duration < 1e6 ? duration : undefined;
    const n = s.listLength === undefined && s.list && typeof listLength === 'number' && Number.isInteger(listLength) && listLength > 0 && listLength <= 5000 ? listLength : undefined;
    if (d === undefined && n === undefined) return false;
    this.set({ ...s, ...(d !== undefined ? { duration: d } : {}), ...(n !== undefined ? { listLength: n } : {}) });
    return true;
  }

  /** Whether the floor hears it equally loud; says whether that changed. */
  setSameVolume(on: unknown): boolean {
    if (typeof on !== 'boolean' || on === this.sameVolume) return false;
    this.sameVolume = on;
    this.save();
    return true;
  }

  /** The title YouTube gave it, if it's still the play that was asked about. */
  titled(id: string, title: string): boolean {
    if (!this.s || this.s.id !== id || !title) return false;
    this.s = { ...this.s, title: title.slice(0, 200) };
    this.save();
    return true;
  }

  /** The title for a queued item (by its `qid`), if it's still queued. */
  titledQueued(qid: string, title: string): boolean {
    if (!title || !this.queue.some((i) => i.qid === qid)) return false;
    this.queue = this.queue.map((i) => (i.qid === qid ? { ...i, title: title.slice(0, 200) } : i));
    this.save();
    return true;
  }

  /** Moves a queued item to place `to`. */
  move(qid: unknown, to: unknown): boolean {
    const next = typeof qid === 'string' && typeof to === 'number' ? q.move(this.queue, qid, to) : null;
    return this.setQueue(next);
  }

  remove(qid: unknown): YoutubeQueueItem | undefined {
    const item = this.queue.find((i) => i.qid === qid);
    if (item) this.setQueue(q.remove(this.queue, item.qid));
    return item;
  }

  clear(): boolean {
    return this.setQueue(this.queue.length ? [] : null);
  }

  /** Plays a queued item now; what was on goes to the history. */
  jump(qid: unknown): boolean {
    const t = typeof qid === 'string' ? q.take(this.queue, qid) : null;
    if (!t) return false;
    this.queue = t.rest;
    this.begin(t.item, true);
    return true;
  }

  /**
   * The playing playlist's videos become queue items. `videoIds` are the playlist's videos in order (at most UNPACK_MAX),
   * `at` is where the player is in them, `current` the video it plays there and `index` its place in the whole
   * playlist; they must agree with each other and with the video the office has (`index`), so the office never guesses the position. What's on stays on as `current` alone (same play, so the position carries on and the
   * browsers drop the playlist without moving it), and the ones after `at` go to the queue's front.
   * Gives the items added, or why not.
   */
  unpack(id: unknown, videoIds: unknown, at: unknown, current: unknown, index: unknown): YoutubeQueueItem[] | { error: string } {
    const s = this.s;
    if (!s || id !== s.id) return { error: 'That is not what is on the TV any more' };
    if (!s.list) return { error: 'Only a YouTube playlist can be unpacked into the queue' };
    if (!Array.isArray(videoIds) || videoIds.length === 0 || videoIds.length > UNPACK_MAX || !videoIds.every(isVideoId)) return { error: 'The playlist could not be read, so it was not unpacked' };
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= videoIds.length || videoIds[at] !== current) return { error: 'The TV moved to another video while unpacking, so the playlist was not unpacked' };
    // The play's timing is the office's video's: a player that has gone on to another one is not unpacked from.
    if (index !== (s.index ?? 0)) return { error: 'The TV moved to another video while unpacking, so the playlist was not unpacked' };
    if (at < videoIds.length - 1 && this.queue.length >= QUEUE_MAX) return { error: 'The TV queue is full, so the playlist was not unpacked' };
    const added = videoIds.slice(at + 1).map((videoId) => this.item({ videoId, start: 0 }, s.by));
    const { list: _l, index: _i, listLength: _n, title: _t, ...rest } = s;
    this.s = { ...rest, videoId: videoIds[at], url: youtubeUrl({ videoId: videoIds[at], start: s.start }) };
    this.queue = q.addFront(this.queue, added);
    this.save();
    return added.filter((a) => this.queue.includes(a));
  }

  /** The state with where it is now made its `position` (`at` is now): what a change of timing starts from. */
  private frozen(): Play {
    const s = this.s!;
    return { ...s, position: tvPosition(s, this.now()), at: this.now() };
  }

  /** A queue entry for `l`; a playing `Play` brings its title along. */
  private item(l: YoutubeLink, by: string, from?: Play): YoutubeQueueItem {
    return { ...(l.videoId ? { videoId: l.videoId } : {}), ...(l.list ? { list: l.list, index: l.index } : {}), start: l.start, qid: this.newId(), url: from?.url ?? youtubeUrl(l), by: by.slice(0, 24), ...(from?.title ? { title: from.title } : {}) };
  }

  /** `item` goes on as a play of its own; what was on moves to the history (unless it's coming back from there). */
  private begin(item: YoutubeQueueItem, remember: boolean) {
    if (remember && this.s) this.history = q.remember(this.history, this.item(this.s, this.s.by, this.s));
    const { qid: _q, ...link } = item;
    this.set({ ...link, id: this.newId(), position: item.start, at: this.now(), rate: 1, paused: false });
  }

  /** The queue's first item plays; false (and the TV goes dark) when there is none. */
  private nextOrOff(): boolean {
    const [first, ...rest] = this.queue;
    if (!first) {
      this.stop();
      return false;
    }
    this.queue = rest;
    this.begin(first, true);
    return true;
  }

  /** The playlist's video `index`, as a play of its own. */
  private inList(index: number): 'list' {
    const { videoId: _v, title: _t, pausedBy: _p, duration: _d, ...rest } = this.s!;
    this.set({ ...rest, index, start: 0, url: youtubeUrl({ list: rest.list, index, start: 0 }), id: this.newId(), position: 0, at: this.now(), rate: 1, paused: false });
    return 'list';
  }

  private setQueue(next: YoutubeQueueItem[] | null): boolean {
    if (!next) return false;
    this.queue = next;
    this.save();
    return true;
  }

  private set(s: Play) {
    this.s = s;
    this.save();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = parseSaved(JSON.parse(readFileSync(this.file, 'utf8')), this.newId);
      if (!saved) return;
      this.s = saved.now;
      this.queue = saved.queue;
      this.history = saved.history;
      this.sameVolume = saved.sameVolume;
    } catch {
      // a broken file just means a dark TV
    }
  }

  private save() {
    const saved: Saved = { version: 2, now: this.s, queue: this.queue, history: this.history, sameVolume: this.sameVolume };
    try {
      writeFileSync(this.file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
