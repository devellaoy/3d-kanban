/** Quick reactions: 7 👏, 8 🎉, 9 ❤️, 0 😂 float up from your character and fade; repeats stack into one badge with a count. */
import * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { textSprite } from '../../world/toon';
import { badgeText, REACTIONS, ReactionStack, type Badge } from './stack';

/** How high the badge rises while it floats (metres). */
const RISE = 0.7;
/** Where a badge starts in third person: above the head. */
const HEAD = 2.15;

interface Shown {
  sprite: THREE.Sprite;
  text: string;
}

export function installReactions(ctx: Ctx) {
  const stack = new ReactionStack();
  const shown = new Map<number, Shown>();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function drop(id: number) {
    const s = shown.get(id);
    if (!s) return;
    ctx.scene.remove(s.sprite);
    s.sprite.material.map?.dispose();
    s.sprite.material.dispose();
    shown.delete(id);
  }

  /** Makes (or remakes, when its count changed) the sprite of a badge. */
  function sprite(b: Badge): THREE.Sprite {
    const text = badgeText(b);
    const have = shown.get(b.id);
    if (have && have.text === text) return have.sprite;
    drop(b.id);
    const s = textSprite(text, { size: 56, bg: 'rgba(255,255,255,0.92)' });
    s.material.depthTest = false;
    s.renderOrder = 12;
    ctx.scene.add(s);
    shown.set(b.id, { sprite: s, text });
    return s;
  }

  /** The size the sprite was made at, kept so the view can scale it each frame. */
  function base(s: THREE.Sprite): THREE.Vector3 {
    return (s.userData.base ??= s.scale.clone()) as THREE.Vector3;
  }

  function react(emoji: string) {
    stack.add(emoji, performance.now());
  }

  ctx.keys.bind({
    code: REACTIONS.map((r) => r.code),
    repeat: false,
    run: (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const r = REACTIONS.find((x) => x.code === e.code);
      if (!r) return false;
      react(r.emoji);
    },
  });

  ctx.ticks.add('hud', ({ now }) => {
    const list = stack.active(now);
    const live = new Set(list.map((b) => b.id));
    for (const id of [...shown.keys()]) if (!live.has(id)) drop(id);
    if (!list.length) return;
    const first = ctx.player.view === 'first';
    const cam = ctx.camera;
    // In first person, the badges float in front of and a little above the view; otherwise over the head.
    cam.getWorldDirection(fwd);
    list.forEach((b, i) => {
      const s = sprite(b);
      const p = ReactionStack.progress(b, now);
      const rise = RISE * (1 - (1 - p) * (1 - p));
      // Older badges sit higher so they don't overlap.
      const slot = list.length - 1 - i;
      if (first) {
        s.scale.copy(base(s)).multiplyScalar(0.33);
        s.position.copy(cam.position).addScaledVector(fwd, 1.4).addScaledVector(up, 0.12 + rise * 0.4 + slot * 0.16);
      } else {
        s.scale.copy(base(s)).multiplyScalar(0.5);
        const pp = ctx.player.pos;
        s.position.set(pp.x, pp.y + HEAD + rise + slot * 0.3, pp.z);
      }
      s.material.opacity = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
    });
  });

  return { react, stack };
}
