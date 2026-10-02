// The phone's music player: the same YouTube player as the Office TV's (youtube/player.ts), following the
// session the office keeps for you (store.phoneMusic), at your own music volume with no distance. The iframe
// can't be moved in the page (it would reload), so its box stays where it is, parked off-screen, and is laid
// over the phone's video slot while the phone shows it (mount), like the TV window's.
import './music.css';
import type { PhoneMusicControl } from '../../shared/phone/music';
import { visiting } from '../multiplayer/visit';
import type { Net } from '../net';
import { store, type Settings } from '../state';
import { h, inTopModal, onModalChange } from '../ui/dom';
import type { TvControlsSource } from '../youtube/controls';
import { SyncedPlayer } from '../youtube/player';
import type { YoutubeOnTv } from '../youtube/slice';

export interface PhonePlayerDeps {
  net: Net;
  /** Your settings now (your music volume). */
  settings(): Settings;
}

export class PhonePlayer {
  /** The 16:9 box the player is in. Parked off-screen, or laid over the slot given to `mount`. */
  readonly el = h('div.phone-music-box', { 'aria-hidden': 'true' });
  private readonly host = h('div');
  private readonly sp: SyncedPlayer;
  private slot: HTMLElement | null = null;
  private placed = '';
  private frames = 0;
  private watch: ResizeObserver | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: PhonePlayerDeps) {
    this.el.append(this.host);
    document.body.append(this.el);
    // The box only needs lining up again when something may have moved: these say so, and frame() checks now and then anyway.
    const again = () => this.place();
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, { capture: true, passive: true }); // the phone's body scrolls
    onModalChange(again);
    if (typeof ResizeObserver !== 'undefined') this.watch = new ResizeObserver(again);
    this.sp = new SyncedPlayer({
      host: this.host,
      size: { width: '100%', height: '100%' },
      state: () => this.state(),
      send: (control) => deps.net.send({ t: 'phone.music.control', control }),
      quiet: () => !!visiting(),
      // Always while the session plays: nothing hides it but the end.
      shouldPlay: () => !!this.state(),
      volume: () => {
        const s = deps.settings();
        return Math.round(100 * Math.min(1, s.musicMuted ? 0 : s.music * s.music));
      },
      changed: () => this.listeners.forEach((fn) => fn()),
      icon: '🎵',
    });
  }

  /** What your session plays now (timed on this page's clock), or null. */
  state(): YoutubeOnTv | null {
    return store.phoneMusic?.on ?? null;
  }

  /** Whether it is playing now, so the office's own music gives way (see sound/ducking.ts). */
  playing(): boolean {
    const y = this.state();
    return !!y && !y.paused;
  }

  /** Calls `fn` when something the screen shows changed on its own: an error, a click wanted, the sound allowed. */
  listen(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Lays the video over `slot` (a box the phone's screen keeps 16:9), or parks it again with null. */
  mount(slot: HTMLElement | null) {
    this.watch?.disconnect();
    this.slot = slot;
    if (slot) this.watch?.observe(slot);
    this.place();
  }

  /** What the session plays changed: loads it, or stops. */
  changed() {
    this.sp.changed();
  }

  /** Each frame: keeps the player in step; the slot is followed on events, and checked every 10th frame in case one was missed. */
  frame(now: number) {
    if (++this.frames % 10 === 0) this.place();
    this.sp.tick(now);
  }

  currentTime(): number | undefined {
    return this.sp.currentTime();
  }

  duration(): number | undefined {
    return this.sp.duration();
  }

  /** YouTube's error for what's on, if it gave one. */
  errorText(): string | undefined {
    return this.sp.errorText();
  }

  /** Whether you can't hear it yet: the browser wants a click or a key first. */
  needsClick(): boolean {
    return this.sp.needsClick();
  }

  /** Why the speed the session asked for isn't what you see, when it isn't. */
  rateNote(): string | undefined {
    return this.sp.rateNote();
  }

  /** For checks from the console. */
  debug() {
    return { ...this.sp.debug(), mounted: !!this.slot, box: this.placed };
  }

  /** For `tvControls` (youtube/controls.ts): the session as the TV's transport bar controls it. */
  controls(send: (control: PhoneMusicControl) => void): TvControlsSource {
    return {
      state: () => this.state(),
      back: () => !!store.phoneMusic?.list.back,
      send,
      duration: () => this.sp.duration(),
      rateNote: () => this.sp.rateNote(),
      speedFor: 'everyone listening',
    };
  }

  /** The box over the slot (clipped to the window's body, as the TV's is), or parked. */
  private place() {
    if (this.slot && !this.slot.isConnected) this.slot = null;
    // A window opened over the phone (a terminal, a prompt) must not be painted over: parked while the phone isn't on top.
    const r = this.slot && inTopModal(this.slot) ? this.slot.getBoundingClientRect() : undefined;
    const st = this.el.style;
    if (!r || r.width < 8 || r.height < 8) {
      if (this.placed === 'parked') return;
      this.placed = 'parked';
      st.cssText = '';
      return;
    }
    const body = (this.slot!.closest('.body, .phone-body') ?? this.slot!).getBoundingClientRect();
    const key = [r.left, r.top, r.width, r.height, body.top, body.right, body.bottom, body.left].map(Math.round).join(',');
    if (key === this.placed) return;
    this.placed = key;
    st.left = `${r.left}px`;
    st.top = `${r.top}px`;
    st.width = `${r.width}px`;
    st.height = `${r.height}px`;
    st.clipPath = `inset(${Math.max(0, body.top - r.top)}px ${Math.max(0, r.right - body.right)}px ${Math.max(0, r.bottom - body.bottom)}px ${Math.max(0, body.left - r.left)}px)`;
  }
}
