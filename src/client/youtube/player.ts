// The YouTube player that follows the office's play, for whoever shows one: the Office TV (screen.ts) and
// the phone's music (phone/player.ts). It makes YouTube's iframe player in a host element, loads the play
// it is given, keeps it in step with the office's clock (and jumps when it drifts), says when a play is over
// or how long it is, and handles YouTube's errors and the browser's autoplay rule. What it doesn't do is
// decide where it shows, how loud it is or what the office is told with: those come in as `deps`.
import { UNPACK_MAX } from '../../shared/youtube/queue';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol';
import { toast } from '../ui/dom';
import { BLOCKED, YT_STATE, loadYoutubeApi, youtubeError, type YtPlayer } from './api';
import { endedByClock, endedByPlayer, onOfficeVideo, pastPlaylistEnd, timingChanged } from './follow';
import { youtubeAt, type YoutubeOnTv } from './slice';

/** Out of step by more than this many seconds, it jumps to where everyone else is. */
const DRIFT = 1;

/** What the player tells the office: a play's end, or how long it (and its playlist) is. */
export type PlayerSays = Extract<YoutubeClientMsg, { t: 'tv.youtube.ended' | 'tv.youtube.info' }>;

export interface SyncedPlayerDeps {
  /** The element YouTube's player replaces with its iframe. */
  host: HTMLElement;
  /** The iframe's size (CSS pixels, or '100%'): at least 200×200, YouTube's own minimum. */
  size: { width: number | string; height: number | string };
  /** The play the office has for this player, or null. */
  state(): YoutubeOnTv | null;
  /** What the player tells the office. */
  send(m: PlayerSays): void;
  /** Whether it should be playing now (the TV: it's shown on the screen). Not playing, it's held paused. */
  shouldPlay(): boolean;
  /** How loud it is, 0–100, once the browser lets it be heard (the player mutes itself until then). */
  volume(): number;
  /** Something the screen shows changed (an error, a click wanted, the sound allowed): repaint and redo the hint. */
  changed(): void;
  /** Before the iframe is made: whatever the host needs to be in the page. */
  prepare?(): void;
  /** True where nothing is told to the office (visiting someone else's: a visitor only watches). */
  quiet?(): boolean;
  /** The icon in the toast when YouTube's player can't load. */
  icon: string;
}

export class SyncedPlayer {
  private player: YtPlayer | null = null;
  ready = false;
  private making = false;
  /** The play the player has loaded (its `id`), its playlist, and when it was loaded (performance.now()). */
  private loaded: { id: string; list?: string; at: number } | null = null;
  /** The timing this browser last followed (position, at, rate, paused) of the play that's on: only a change in it is followed at once. */
  private followed: { id: string; position: number; at: number; rate: number; paused: boolean } | null = null;
  /** The plays already said to be over, so it's said once. */
  private told = new Set<string>();
  /** What the office has been told of the play that's on (its length, its playlist's length), once each. */
  private info = { id: '', duration: false, list: false };
  /** YouTube's error for the play that's on, if it gave one. */
  private error: { id: string; text: string } | null = null;
  /** The page has had a click or a key, so the browser lets it be heard. */
  unlocked = navigator.userActivation?.hasBeenActive ?? false;
  blockedAutoplay = false;
  volume = -1;
  private lastSync = 0;
  /** Since when it should have been playing and hasn't, on performance.now()'s clock (see sync). */
  private stuckSince = 0;

  constructor(private readonly deps: SyncedPlayerDeps) {
    // A click or a key on the page lets the browser play it out loud: the first one, or the next
    // one after the browser held it back anyway (it played muted meanwhile, see sync).
    const unlock = () => {
      if (this.unlocked && !this.blockedAutoplay) return;
      this.unlocked = true;
      this.blockedAutoplay = false;
      this.applyVolume(true);
      // A paused play stays paused: the click is only for the sound.
      if (this.deps.shouldPlay() && this.ready && !this.deps.state()?.paused && this.player?.getPlayerState() !== YT_STATE.playing) this.player?.playVideo();
      this.deps.changed();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  /** For checks from the console and headless runs. */
  debug() {
    const p = this.ready ? this.player : null;
    const y = this.deps.state();
    return { ready: this.ready, unlocked: this.unlocked, blockedAutoplay: this.blockedAutoplay, volume: this.volume, error: this.errorText(), state: p?.getPlayerState(), at: p?.getCurrentTime(), want: y ? youtubeAt(y) : undefined };
  }

  /** Whether you can't hear it yet: the browser wants a click or a key first. */
  needsClick(): boolean {
    return !!this.deps.state() && this.deps.shouldPlay() && (!this.unlocked || this.blockedAutoplay);
  }

  /** YouTube's error for what's on, if it gave one. */
  errorText(): string | undefined {
    return this.error && this.error.id === this.deps.state()?.id ? this.error.text : undefined;
  }

  /** What's on changed (or you came onto another floor): loads it, or stops. */
  changed() {
    const y = this.deps.state();
    if (!y) {
      this.loaded = null;
      if (this.ready) this.player?.stopVideo();
      return;
    }
    if (!this.player) return void this.make();
    if (this.ready) this.load(y);
  }

  /** Back on after being held (the share ended, you came back to the office): where everyone else is now. */
  resume() {
    const y = this.deps.state();
    if (!this.ready || !this.player || !y) return;
    if (this.loaded?.id !== y.id) return this.load(y);
    this.follow(y, youtubeAt(y));
  }

  /** Held paused (not shown any more). */
  pause() {
    if (this.ready) this.player?.pauseVideo();
  }

  /** Where the video is now, in seconds: the player's own once it has this play, else where the office has it. */
  currentTime(): number | undefined {
    const y = this.deps.state();
    if (!y) return undefined;
    return this.ready && this.player && this.loaded?.id === y.id ? this.player.getCurrentTime() : youtubeAt(y);
  }

  /** How long the video is, if the player or the office knows. */
  duration(): number | undefined {
    const y = this.deps.state();
    const d = this.ready && this.player && this.loaded?.id === y?.id ? this.player.getDuration() : 0;
    return d > 0 ? d : y?.duration;
  }

  /**
   * What unpacking the loaded playlist needs: its video ids in order from the video the player is on (at most
   * UNPACK_MAX), where the player is in them (`at`, always 0) and the video it plays there (`current`) and its
   * place in the whole playlist (`index`). Null when there's no playlist, the player hasn't it yet, or it isn't on a video of it yet.
   */
  playlistAt(): { videoIds: string[]; at: number; current: string; index: number } | null {
    const y = this.deps.state();
    if (!y || !this.ready || !this.player || this.loaded?.id !== y.id) return null;
    const ids = this.player.getPlaylist();
    const index = this.player.getPlaylistIndex();
    const current = this.player.getVideoData?.().video_id;
    if (!ids || !current || !Number.isInteger(index) || ids[index] !== current) return null;
    return { videoIds: ids.slice(index, index + UNPACK_MAX), at: 0, current, index };
  }

  /** Why the speed the office asked for isn't what you see, when it isn't. */
  rateNote(): string | undefined {
    const y = this.deps.state();
    if (!y || y.rate === 1 || !this.ready || !this.player || this.loaded?.id !== y.id || this.rateOk(y)) return undefined;
    return 'This video only plays at 1×';
  }

  /** Whether this video can play at the speed the office has (an empty list: not known yet, so try). */
  private rateOk(y: YoutubeOnTv): boolean {
    const rates = this.player?.getAvailablePlaybackRates?.() ?? [];
    return rates.length === 0 || rates.includes(y.rate);
  }

  private tell(m: PlayerSays) {
    if (!this.deps.quiet?.()) this.deps.send(m);
  }

  /** Each frame: how loud it is and that it's in step, a few times a second. */
  tick(now: number) {
    if (now - this.lastSync <= 250) return;
    this.lastSync = now;
    this.applyVolume();
    const y = this.deps.state();
    if (y && this.deps.shouldPlay()) this.sync(y, now);
  }

  async make() {
    if (this.making || this.player) return;
    this.making = true;
    try {
      const YT = await loadYoutubeApi();
      this.deps.prepare?.();
      this.player = new YT.Player(this.deps.host, {
        width: this.deps.size.width as number,
        height: this.deps.size.height as number,
        playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1, enablejsapi: 1, origin: location.origin, widget_referrer: location.href },
        events: {
          onReady: () => {
            this.ready = true;
            const f = this.player!.getIframe();
            // Never the keyboard's or the mouse's: those are the game's.
            f.tabIndex = -1;
            f.setAttribute('aria-hidden', 'true');
            this.applyVolume(true);
            const y = this.deps.state();
            if (y) this.load(y);
          },
          onStateChange: (e) => this.stateChanged(e.data),
          onError: (e) => this.failed(e.data),
          onAutoplayBlocked: () => {
            this.blockedAutoplay = true;
            this.deps.changed();
          },
        },
      });
    } catch {
      toast(`${this.deps.icon} YouTube's player didn't load: is youtube.com blocked here?`, 'warn');
    } finally {
      this.making = false;
    }
  }

  /** Loads what's on, from where everyone else is. */
  private load(y: YoutubeOnTv) {
    const p = this.player!;
    const at = youtubeAt(y);
    if (this.loaded?.id === y.id) {
      // Its playlist unpacked into the queue (it has lost its `list` and got a `videoId`): the playlist would go on
      // to its next video by itself, so the video already playing is loaded on its own, from where it is. Whatever
      // the old load still says (ended, an error) is held back by `loaded.at` (see `current`).
      if (this.loaded.list && !y.list && y.videoId) {
        this.loaded = { id: y.id, at: performance.now() };
        p.loadVideoById({ videoId: y.videoId, startSeconds: at });
        this.stuckSince = 0;
        this.keep(y);
        if (!this.deps.shouldPlay() || y.paused) p.pauseVideo();
        this.applyVolume(true);
        return;
      }
      // The same play, only changed (paused, moved, sped up) or told more (its title, its length): only a change of
      // timing is followed at once, anything else is left to sync (a seek on every broadcast would jump the video).
      this.loaded.list = y.list;
      if (timingChanged(this.followed, y)) {
        // An end said while it was paused was dropped by the office, and nobody says it twice: say it again if it's over.
        this.told.delete(y.id);
        this.follow(y, at, 0.5);
      }
      this.keep(y);
      this.applyVolume(true);
      return;
    }
    const inList = !!y.list && this.loaded?.list === y.list && !!p.getPlaylist();
    this.loaded = { id: y.id, list: y.list, at: performance.now() };
    if (y.list) {
      if (inList && p.getPlaylistIndex() === y.index) this.follow(y, at);
      // A skip within the playlist: a play of its own, with the same list.
      else if (inList) p.playVideoAt(y.index ?? 0);
      else p.loadPlaylist({ list: y.list, listType: 'playlist', index: y.index ?? 0, startSeconds: at });
    } else if (y.videoId) p.loadVideoById({ videoId: y.videoId, startSeconds: at });
    this.stuckSince = 0;
    this.keep(y);
    // Loading plays; it's held when it's paused or not shown.
    if (!this.deps.shouldPlay() || y.paused) p.pauseVideo();
    this.applyVolume(true);
  }

  /** Notes the timing of `y` as the one this browser has followed. */
  private keep(y: YoutubeOnTv) {
    this.followed = { id: y.id, position: y.position, at: y.at, rate: y.rate, paused: y.paused };
  }

  /** Puts the speed right, then pauses or plays, and moves to `at` if it's off by more than `tol` seconds (at 1×). */
  private follow(y: YoutubeOnTv, at: number, tol = DRIFT) {
    const p = this.player;
    if (!p) return;
    this.setRate(y);
    if (Math.abs(p.getCurrentTime() - at) > tol * Math.max(1, y.rate)) p.seekTo(at, true);
    const state = p.getPlayerState();
    if (!this.deps.shouldPlay() || y.paused) p.pauseVideo();
    else if (state !== YT_STATE.playing && state !== YT_STATE.buffering) p.playVideo();
  }

  private setRate(y: YoutubeOnTv) {
    const p = this.player;
    if (p && p.getPlaybackRate() !== y.rate && this.rateOk(y)) p.setPlaybackRate(y.rate);
  }

  /** In step with everyone else: out by more than DRIFT, it jumps; stopped when it shouldn't be, it plays. */
  private sync(y: YoutubeOnTv, now: number) {
    const p = this.player;
    if (!p || !this.ready || this.loaded?.id !== y.id) return;
    const state = p.getPlayerState();
    const want = youtubeAt(y, now);
    const data = p.getVideoData?.();
    // Live streams have no fixed point to be at; nor has the last video, while the next one loads.
    if (data?.isLive || (y.videoId && data?.video_id && data.video_id !== y.videoId)) return;
    this.setRate(y);
    this.report(y, data?.isLive);
    // A playlist whose length turned out shorter than the office's place in it (⏭️ went past its end): nothing is left to play.
    if (y.list && !this.told.has(y.id) && pastPlaylistEnd(y.index ?? 0, p.getPlaylist()?.length) && this.current(y, 1000)) return this.over(y);
    const tol = DRIFT * Math.max(1, y.rate);
    if (y.paused) {
      // Held still where it was paused: never played, whatever the browser thinks of its sound.
      this.stuckSince = 0;
      if (state !== YT_STATE.unstarted && Math.abs(p.getCurrentTime() - want) > tol) p.seekTo(want, true);
      if (state !== YT_STATE.paused && state !== YT_STATE.cued) p.pauseVideo();
      return;
    }
    const duration = p.getDuration();
    // The office's timeline only says it's over for a player that keeps to it; otherwise the player's own ENDED does.
    const at = { index: p.getPlaylistIndex(), videoId: data?.video_id };
    if (endedByClock(y, duration, want, { ...at, rate: p.getPlaybackRate() }) && !this.told.has(y.id)) return this.over(y);
    if (state === YT_STATE.ended) {
      // An ENDED that stateChanged held back as too soon after loading is still the end, at any speed.
      if (endedByPlayer(y, this.current(y, 1000), at) && !this.told.has(y.id)) this.over(y);
      return;
    }
    if (state !== YT_STATE.playing && state !== YT_STATE.buffering) {
      p.playVideo();
      // Held back for its sound (the browser's autoplay rule): it plays muted until the next click or key.
      this.stuckSince ||= now;
      if (now - this.stuckSince > 2500 && !this.blockedAutoplay && this.volume > 0) {
        this.blockedAutoplay = true;
        this.applyVolume(true);
        this.deps.changed();
      }
      return;
    }
    this.stuckSince = 0;
    if (state !== YT_STATE.playing || duration <= 0) return;
    // Only at the speed the office has: a video that can't play at it would be jumped back again and again.
    if (p.getPlaybackRate() === y.rate && Math.abs(p.getCurrentTime() - want) > tol) p.seekTo(want, true);
  }

  /** Tells the office how long the video (and its playlist) is, once each per play: the first browser to know says. */
  private report(y: YoutubeOnTv, live?: boolean) {
    const p = this.player;
    if (!p || live || this.deps.quiet?.()) return;
    if (this.info.id !== y.id) this.info = { id: y.id, duration: false, list: false };
    // Nothing left to say: the player isn't asked anything.
    if ((this.info.duration || y.duration !== undefined) && (!y.list || this.info.list || y.listLength !== undefined)) return;
    if (!this.current(y, 1500)) return;
    // What the player knows is about the office's video only when it is on it (it may still be on the last one).
    const here = onOfficeVideo(y, { index: p.getPlaylistIndex(), videoId: p.getVideoData?.().video_id });
    const duration = here ? p.getDuration() : 0;
    const length = y.list && here ? (p.getPlaylist()?.length ?? 0) : 0;
    const say = !this.info.duration && y.duration === undefined && duration > 0;
    const sayList = !this.info.list && y.listLength === undefined && length > 0;
    if (!say && !sayList) return;
    if (say) this.info.duration = true;
    if (sayList) this.info.list = true;
    this.tell({ t: 'tv.youtube.info', id: y.id, ...(say ? { duration } : {}), ...(sayList ? { listLength: length } : {}) });
  }

  /**
   * Whether a player event can be about the play that's on, not the last one, whose `ended` or error
   * can still be on its way from the iframe just after the next one loads (`within` ms). Its own end
   * that soon (a start past its length) is found by sync instead.
   */
  private current(y: YoutubeOnTv, within: number): boolean {
    if (this.loaded?.id !== y.id || performance.now() - this.loaded.at < within) return false;
    const data = this.player?.getVideoData?.();
    return !(y.videoId && !y.list && data?.video_id && data.video_id !== y.videoId);
  }

  private stateChanged(state: number) {
    const y = this.deps.state();
    if (!y) return;
    if (state === YT_STATE.playing && this.blockedAutoplay) {
      this.blockedAutoplay = false;
      this.deps.changed();
    }
    if (state === YT_STATE.ended && this.current(y, 1000)) this.over(y);
    // A playlist went on to its next video by itself: the office hears it from whoever's first.
    if (y.list && state === YT_STATE.playing && this.player && this.player.getPlaylistIndex() > (y.index ?? 0) && !this.told.has(y.id) && this.current(y, 1000)) this.over(y, true);
  }

  /** What's on has played to its end: the office takes it off, or goes on to a playlist's next video. */
  private over(y: YoutubeOnTv, next?: boolean) {
    // Paused, it isn't over yet: nothing's said (nor marked said), so it's said once it plays on to its end.
    if (this.told.has(y.id) || y.paused) return;
    this.told.add(y.id);
    const list = this.player?.getPlaylist();
    const more = next ?? (!!y.list && !!list && (y.index ?? 0) + 1 < list.length);
    this.tell({ t: 'tv.youtube.ended', id: y.id, ...(more ? { next: true } : {}) });
  }

  private failed(code: number) {
    const y = this.deps.state();
    if (!y || !this.current(y, 250)) return;
    this.error = { id: y.id, text: youtubeError(code) };
    this.deps.changed();
    if (BLOCKED.has(code) && !this.told.has(y.id)) {
      this.told.add(y.id);
      const list = this.player?.getPlaylist();
      const more = !!y.list && !!list && (y.index ?? 0) + 1 < list.length;
      this.tell({ t: 'tv.youtube.ended', id: y.id, blocked: code, ...(more ? { next: true } : {}) });
    }
  }

  /** Sets the volume `deps.volume()` says, but silent until the browser lets it be heard and while it isn't to play. */
  applyVolume(force = false) {
    const p = this.player;
    if (!p || !this.ready) return;
    const volume = this.unlocked && !this.blockedAutoplay && this.deps.shouldPlay() ? this.deps.volume() : 0;
    if (volume === this.volume && !force) return;
    this.volume = volume;
    if (volume > 0) {
      if (p.isMuted()) p.unMute();
      p.setVolume(volume);
    } else p.mute();
  }
}
