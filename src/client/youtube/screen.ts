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
import { visiting } from '../multiplayer/visit';
import { ducking } from '../sound/ducking';
import { store, type Settings } from '../state';
import { h } from '../ui/dom';
import { SyncedPlayer } from './player';

/** The player's own size in CSS pixels: 16:9 like the TV, and well over the 200×200 YouTube asks for. */
const W = 1280;
const H = 720;
/** How the TV fades with distance: the jukebox's curve (features/jukebox/sound.ts). */
const REF = 2.5;
const ROLLOFF = 1.3;

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

  /** The player on the TV's screen: it follows what's on (player.ts); this class says where it shows and how loud it is. */
  private readonly sp: SyncedPlayer;
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
    this.sp = new SyncedPlayer({
      host: this.host,
      size: { width: W, height: H },
      state: () => store.youtube,
      send: (m) => ctx.net.send(m),
      quiet: () => !!visiting(),
      shouldPlay: () => this.shown === 'yes',
      volume: () => this.level(),
      changed: () => {
        this.paint();
        ctx.hint.invalidate();
      },
      // CSS3DRenderer puts the element in the page on its first render: YouTube's player needs it there.
      prepare: () => {
        if (this.el.isConnected) return;
        this.obj.visible = true;
        this.css.render(this.scene, ctx.camera);
        this.obj.visible = false;
        this.css.render(this.scene, ctx.camera);
      },
      icon: '📺',
    });
    // Your phone's music has the sound to itself (sound/ducking.ts).
    ducking.listen(() => this.applyVolume());
  }

  /** For checks from the console and headless runs (like window.__office). */
  debug() {
    const { ready, unlocked, blockedAutoplay, volume, error, state, at, want } = this.sp.debug();
    return { shown: this.shown, inOffice: this.ctx.inOffice(), upTop: this.ctx.upTop(), share: this.deps.shareOn(), ready, unlocked, blockedAutoplay, volume, error, state, at, want };
  }

  /** Whether you can't hear it yet: the browser wants a click or a key first. */
  needsClick(): boolean {
    return this.sp.needsClick();
  }

  /** YouTube's error for what's on, if it gave one. */
  errorText(): string | undefined {
    return this.sp.errorText();
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
    this.paint();
    this.sp.changed();
  }

  /** Where the video is now, in seconds: the player's own once it has this play, else where the office has it. */
  currentTime(): number | undefined {
    return this.sp.currentTime();
  }

  /** How long the video is, if the player or the office knows. */
  duration(): number | undefined {
    return this.sp.duration();
  }

  /** What unpacking the loaded playlist needs (see SyncedPlayer.playlistAt). */
  playlistAt() {
    return this.sp.playlistAt();
  }

  /** Why the speed the office asked for isn't what you see, when it isn't. */
  rateNote(): string | undefined {
    return this.sp.rateNote();
  }

  /** Each frame: where the player is, whether it's shown, how loud it is, and that it's in step. */
  frame(now: number) {
    const y = store.youtube;
    const shown: Shown = !y ? 'away' : this.deps.shareOn() ? 'share' : !this.ctx.inOffice() || this.ctx.upTop() || this.errorText() ? 'away' : 'yes';
    if (shown !== this.shown) {
      this.shown = shown;
      this.paint();
      if (y) {
        if (shown === 'yes') this.sp.resume();
        else this.sp.pause();
      }
      this.ctx.hint.invalidate();
    }
    const visible = shown === 'yes' && (!!this.slot || this.onScreen());
    const was = this.obj.visible;
    this.obj.visible = visible;
    const mesh = this.ctx.office.tvScreen;
    // Until YouTube's player is there, the TV shows its card rather than a hole onto nothing.
    const mat = shown === 'yes' && !this.slot && this.sp.ready ? this.hole : y && shown !== 'share' ? this.card : this.screenMat;
    if (mesh.material !== mat) mesh.material = mat;
    if (visible) this.place();
    if (visible || was) this.css.render(this.scene, this.ctx.camera);
    this.sp.tick(now);
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

  /** As loud as the jukebox would be from where you stand (or right up close, in the TV window), at your own music volume. */
  applyVolume(force = false) {
    this.sp.applyVolume(force);
  }

  /** The loudness the player is given (0–100): the jukebox's curve from where you stand, silent while your phone's music plays. */
  private level(): number {
    if (ducking.on) return 0;
    const s = this.deps.settings();
    const base = s.musicMuted ? 0 : s.music * s.music;
    const pos = this.ctx.player.pos;
    // "Same volume" (the TV's setting) is the same as standing at the reference distance for everyone.
    const d = this.slot || store.youtubeList.sameVolume ? REF : Math.max(REF, Math.hypot(pos.x - TV.x, pos.y + 1.6 - TV.y, pos.z - TV.z));
    return Math.round(100 * Math.min(1, base * (REF / (REF + ROLLOFF * (d - REF)))));
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
