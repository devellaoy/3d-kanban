// YouTube's own player on the Office TV. The player is an iframe (YouTube's terms: no
// pulling its sound or picture out, no hiding it), so it isn't drawn by WebGL: three.js's
// CSS3DRenderer puts it in a layer just behind the canvas, lined up with the TV's screen, and the
// screen is drawn as a hole in the canvas (alpha 0) so the player shows through it, behind whatever
// stands in front of the TV. Watching it big (the TV window) lines the same iframe up with the
// window's video slot instead, never moving it in the page (an iframe that moves reloads).
import './youtube.css';
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { TV } from '../../shared/layout';
import { youtubeTitle } from '../../shared/youtube/link';
import type { Ctx } from '../core/context';
import { store, type Settings } from '../state';
import { h, toast } from '../ui/dom';
import { BLOCKED, YT_STATE, loadYoutubeApi, youtubeError, type YtPlayer } from './api';
import { youtubeAt, type YoutubeOnTv } from './slice';

/** The player's own size in CSS pixels: 16:9 like the TV, and well over the 200×200 YouTube asks for. */
const W = 1280;
const H = 720;
/** How the TV fades with distance: the jukebox's curve (features/jukebox/sound.ts). */
const REF = 2.5;
const ROLLOFF = 1.3;
/** Out of step by more than this many seconds, it jumps to where everyone else is. */
const DRIFT = 1;

export interface TvScreenDeps {
  /** Someone's screen is shared on the floor: that has the TV (see docs/features.md). */
  shareOn(): boolean;
  /** Your settings now (the jukebox's volume is the TV's too). */
  settings(): Settings;
}

/** Why the TV isn't showing what's on, when it isn't. */
type Shown = 'yes' | 'share' | 'away';

export class TvScreen {
  private readonly css = new CSS3DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly el = h('div.ytv-screen');
  private readonly host = h('div.ytv-host');
  private readonly caption = h('div.ytv-caption');
  private readonly notice = h('div.ytv-notice');
  private readonly obj: CSS3DObject;
  private readonly hole = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    blending: THREE.NoBlending,
  });
  private readonly card: THREE.MeshBasicMaterial;
  private readonly cardCanvas = document.createElement('canvas');
  private readonly screenMat: THREE.Material | THREE.Material[];

  private player: YtPlayer | null = null;
  private ready = false;
  private making = false;
  /** The play the player has loaded (its `id`), its playlist, and when it was loaded (performance.now()). */
  private loaded: { id: string; list?: string; at: number } | null = null;
  /** The plays already said to be over, so it's said once. */
  private told = new Set<string>();
  /** YouTube's error for the play that's on, if it gave one. */
  private error: { id: string; text: string } | null = null;
  /** The page has had a click or a key, so the browser lets the TV be heard. */
  private unlocked = navigator.userActivation?.hasBeenActive ?? false;
  private blockedAutoplay = false;
  private volume = -1;
  private lastSync = 0;
  /** Since when it should have been playing and hasn't, on performance.now()'s clock (see sync). */
  private stuckSince = 0;
  private shown: Shown = 'away';
  /** The TV window's video slot, while it's open: the player is lined up with it instead of the TV. */
  private slot: HTMLElement | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly deps: TvScreenDeps,
  ) {
    const layer = this.css.domElement;
    layer.className = 'ytv-layer';
    layer.setAttribute('aria-hidden', 'true');
    ctx.canvas.before(layer);
    this.el.append(this.host, this.caption, this.notice);
    this.obj = new CSS3DObject(this.el);
    this.obj.matrixAutoUpdate = false;
    this.obj.visible = false;
    this.scene.add(this.obj);
    this.cardCanvas.width = W;
    this.cardCanvas.height = H;
    const tex = new THREE.CanvasTexture(this.cardCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.card = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    this.screenMat = ctx.office.tvScreen.material;
    // Flat, like the screen they stand in for: no toon outline (see core/outline.ts).
    this.hole.userData.outlineParameters = { visible: false };
    this.card.userData.outlineParameters = { visible: false };
    const fit = () => this.css.setSize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', fit);
    fit();
    // A click or a key on the page lets the browser play the TV out loud: the first one, or the next
    // one after the browser held it back anyway (it played muted meanwhile, see sync).
    const unlock = () => {
      if (this.unlocked && !this.blockedAutoplay) return;
      this.unlocked = true;
      this.blockedAutoplay = false;
      this.applyVolume(true);
      this.paint();
      if (this.shown === 'yes' && this.ready && this.player?.getPlayerState() !== YT_STATE.playing) this.player?.playVideo();
      ctx.hint.invalidate();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  /** For checks from the console and headless runs (like window.__office). */
  debug() {
    const p = this.ready ? this.player : null;
    return { shown: this.shown, inOffice: this.ctx.inOffice(), upTop: this.ctx.upTop(), share: this.deps.shareOn(), ready: this.ready, unlocked: this.unlocked, blockedAutoplay: this.blockedAutoplay, volume: this.volume, error: this.errorText(), state: p?.getPlayerState(), at: p?.getCurrentTime(), want: store.youtube ? youtubeAt(store.youtube) : undefined };
  }

  /** Whether you can't hear it yet: the browser wants a click or a key first. */
  needsClick(): boolean {
    return !!store.youtube && this.shown === 'yes' && (!this.unlocked || this.blockedAutoplay);
  }

  /** YouTube's error for what's on, if it gave one. */
  errorText(): string | undefined {
    return this.error && this.error.id === store.youtube?.id ? this.error.text : undefined;
  }

  /** Lines the player up with `slot` (the TV window's), or back on the TV with null. */
  watchIn(slot: HTMLElement | null) {
    this.slot = slot;
    this.css.domElement.classList.toggle('ytv-up', !!slot);
    if (!slot) this.css.domElement.style.clipPath = '';
    this.paint();
    this.applyVolume(true);
  }

  /** What's on changed (or you came onto another floor). */
  changed() {
    const y = store.youtube;
    this.paint();
    if (!y) {
      this.loaded = null;
      if (this.ready) this.player?.stopVideo();
      return;
    }
    if (!this.player) return void this.make();
    if (this.ready) this.load(y);
  }

  /** Each frame: where the player is, whether it's shown, how loud it is, and that it's in step. */
  frame(now: number) {
    const y = store.youtube;
    const shown: Shown = !y ? 'away' : this.deps.shareOn() ? 'share' : !this.ctx.inOffice() || this.ctx.upTop() || this.errorText() ? 'away' : 'yes';
    if (shown !== this.shown) {
      this.shown = shown;
      this.paint();
      if (this.ready && this.player && y) {
        if (shown === 'yes') this.resume(y);
        else this.player.pauseVideo();
      }
      this.ctx.hint.invalidate();
    }
    const visible = shown === 'yes' && (!!this.slot || this.onScreen());
    const was = this.obj.visible;
    this.obj.visible = visible;
    const mesh = this.ctx.office.tvScreen;
    // Until YouTube's player is there, the TV shows its card rather than a hole onto nothing.
    const mat = shown === 'yes' && !this.slot && this.ready ? this.hole : y && shown !== 'share' ? this.card : this.screenMat;
    if (mesh.material !== mat) mesh.material = mat;
    if (visible) this.place();
    if (visible || was) this.css.render(this.scene, this.ctx.camera);
    if (now - this.lastSync > 250) {
      this.lastSync = now;
      this.applyVolume();
      if (y && shown === 'yes') this.sync(y, now);
    }
  }

  private onScreen(): boolean {
    for (let o: THREE.Object3D | null = this.ctx.office.tvScreen; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  /** The player on the TV's screen, or lined up with the TV window's slot. */
  private place() {
    const cam = this.ctx.camera;
    const m = this.obj.matrix;
    if (this.slot) {
      // In front of the camera at the distance where one unit is one pixel (CSS3DRenderer's `fov`).
      const r = this.slot.getBoundingClientRect();
      // Only where the window's body shows it: scrolled up or down, it doesn't cover the header or the buttons.
      const body = (this.slot.closest('.body') ?? this.slot).getBoundingClientRect();
      this.css.domElement.style.clipPath = `inset(${body.top}px ${window.innerWidth - body.right}px ${window.innerHeight - body.bottom}px ${body.left}px)`;
      const fov = cam.projectionMatrix.elements[5] * (window.innerHeight / 2);
      const s = r.width / W;
      cam.updateMatrixWorld();
      m.copy(cam.matrixWorld)
        .multiply(new THREE.Matrix4().makeTranslation(r.left + r.width / 2 - window.innerWidth / 2, window.innerHeight / 2 - (r.top + r.height / 2), -fov))
        .multiply(new THREE.Matrix4().makeScale(s, s, 1));
    } else {
      const screen = this.ctx.office.tvScreen;
      screen.updateWorldMatrix(true, false);
      m.copy(screen.matrixWorld).multiply(new THREE.Matrix4().makeScale(TV.width / W, TV.height / H, 1));
    }
    this.obj.matrixWorldNeedsUpdate = true;
  }

  private async make() {
    if (this.making || this.player) return;
    this.making = true;
    try {
      const YT = await loadYoutubeApi();
      // CSS3DRenderer puts the element in the page on its first render: YouTube's player needs it there.
      if (!this.el.isConnected) {
        this.obj.visible = true;
        this.css.render(this.scene, this.ctx.camera);
        this.obj.visible = false;
        this.css.render(this.scene, this.ctx.camera);
      }
      this.player = new YT.Player(this.host, {
        width: W,
        height: H,
        playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1, enablejsapi: 1, origin: location.origin, widget_referrer: location.href },
        events: {
          onReady: () => {
            this.ready = true;
            const f = this.player!.getIframe();
            // Never the keyboard's or the mouse's: those are the game's.
            f.tabIndex = -1;
            f.setAttribute('aria-hidden', 'true');
            this.applyVolume(true);
            if (store.youtube) this.load(store.youtube);
          },
          onStateChange: (e) => this.stateChanged(e.data),
          onError: (e) => this.failed(e.data),
          onAutoplayBlocked: () => {
            this.blockedAutoplay = true;
            this.ctx.hint.invalidate();
            this.paint();
          },
        },
      });
    } catch {
      toast("📺 YouTube's player didn't load: is youtube.com blocked here?", 'warn');
    } finally {
      this.making = false;
    }
  }

  /** Loads what's on, from where everyone else is. */
  private load(y: YoutubeOnTv) {
    const p = this.player!;
    const at = youtubeAt(y);
    const same = this.loaded?.id === y.id;
    if (y.list) {
      // The playlist went on by itself (YouTube plays the next one): only the clock is put right.
      if (this.loaded?.list === y.list && p.getPlaylistIndex() === y.index) this.seek(at);
      else p.loadPlaylist({ list: y.list, listType: 'playlist', index: y.index ?? 0, startSeconds: at });
    } else if (!same && y.videoId) p.loadVideoById({ videoId: y.videoId, startSeconds: at });
    else this.seek(at);
    this.loaded = { id: y.id, list: y.list, at: performance.now() };
    this.stuckSince = 0;
    if (this.shown !== 'yes') p.pauseVideo();
    this.applyVolume(true);
  }

  private seek(at: number) {
    this.player?.seekTo(at, true);
    if (this.shown === 'yes') this.player?.playVideo();
  }

  /** Back on after the share ended, or you came back to the office: where everyone else is now. */
  private resume(y: YoutubeOnTv) {
    if (this.loaded?.id !== y.id) return this.load(y);
    this.seek(youtubeAt(y));
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
    const duration = p.getDuration();
    if (duration > 0 && !y.list && want >= duration - 0.5 && !this.told.has(y.id)) return this.over(y);
    if (state === YT_STATE.ended) return;
    if (state !== YT_STATE.playing && state !== YT_STATE.buffering) {
      p.playVideo();
      // Held back for its sound (the browser's autoplay rule): it plays muted until the next click or key.
      this.stuckSince ||= now;
      if (now - this.stuckSince > 2500 && !this.blockedAutoplay && this.volume > 0) {
        this.blockedAutoplay = true;
        this.applyVolume(true);
        this.paint();
        this.ctx.hint.invalidate();
      }
      return;
    }
    this.stuckSince = 0;
    if (state !== YT_STATE.playing || duration <= 0) return;
    if (Math.abs(p.getCurrentTime() - want) > DRIFT) p.seekTo(want, true);
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
    const y = store.youtube;
    if (!y) return;
    if (state === YT_STATE.playing && this.blockedAutoplay) {
      this.blockedAutoplay = false;
      this.paint();
    }
    if (state === YT_STATE.ended && this.current(y, 1000)) this.over(y);
    // A playlist went on to its next video by itself: the office hears it from whoever's first.
    if (y.list && state === YT_STATE.playing && this.player && this.player.getPlaylistIndex() > (y.index ?? 0) && !this.told.has(y.id) && this.current(y, 1000)) this.over(y, true);
  }

  /** What's on has played to its end: the office takes it off, or goes on to a playlist's next video. */
  private over(y: YoutubeOnTv, next?: boolean) {
    if (this.told.has(y.id)) return;
    this.told.add(y.id);
    const p = this.player;
    const list = p?.getPlaylist();
    const more = next ?? (!!y.list && !!list && (y.index ?? 0) + 1 < list.length);
    this.ctx.net.send({ t: 'tv.youtube.ended', id: y.id, ...(more ? { next: true } : {}) });
  }

  private failed(code: number) {
    const y = store.youtube;
    if (!y || !this.current(y, 250)) return;
    this.error = { id: y.id, text: youtubeError(code) };
    this.paint();
    this.ctx.hint.invalidate();
    if (BLOCKED.has(code) && !this.told.has(y.id)) {
      this.told.add(y.id);
      const list = this.player?.getPlaylist();
      const more = !!y.list && !!list && (y.index ?? 0) + 1 < list.length;
      this.ctx.net.send({ t: 'tv.youtube.ended', id: y.id, blocked: code, ...(more ? { next: true } : {}) });
    }
  }

  /** As loud as the jukebox would be from where you stand (or right up close, in the TV window), at your own music volume. */
  private applyVolume(force = false) {
    const p = this.player;
    if (!p || !this.ready) return;
    const s = this.deps.settings();
    const base = s.musicMuted ? 0 : s.music * s.music;
    const pos = this.ctx.player.pos;
    const d = this.slot ? REF : Math.max(REF, Math.hypot(pos.x - TV.x, pos.y + 1.6 - TV.y, pos.z - TV.z));
    const volume = this.unlocked && !this.blockedAutoplay && this.shown === 'yes' ? Math.round(100 * Math.min(1, base * (REF / (REF + ROLLOFF * (d - REF))))) : 0;
    if (volume === this.volume && !force) return;
    this.volume = volume;
    if (volume > 0) {
      if (p.isMuted()) p.unMute();
      p.setVolume(volume);
    } else p.mute();
  }

  /** The caption and the notice over the player, and the card the TV shows when the player can't be. */
  private paint() {
    const y = store.youtube;
    const title = y ? youtubeTitle(y) : '';
    this.caption.textContent = y ? `▶ ${title} · ${y.by}` : '';
    this.notice.textContent = this.needsClick() ? '🔇 Click the office to hear the TV' : '';
    this.notice.hidden = !this.notice.textContent;
    const g = this.cardCanvas.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#1b1d2e');
    grad.addColorStop(1, '#3a0ca3');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = '900 64px Nunito, ui-rounded, system-ui, sans-serif';
    g.fillText(this.errorText() ?? (this.slot ? '📺 Watching it big' : '📺 YouTube'), W / 2, 300, W - 80);
    g.font = '700 40px Nunito, ui-rounded, system-ui, sans-serif';
    if (y) g.fillText(`${title} · put on by ${y.by}`, W / 2, 400, W - 80);
    (this.card.map as THREE.CanvasTexture).needsUpdate = true;
  }
}
