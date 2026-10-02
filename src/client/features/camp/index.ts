/**
 * The campsite on the lake's west shore (E at the campfire stokes it: the flames leap and throw embers)
 * and the hill lookout, where E at the binoculars zooms in on the view until you let go of them. Both
 * are built into the street (see world.ts); this is what they do.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    campfire: true;
    viewpoint: true;
  }
}

/** The field of view through the binoculars, in degrees. */
const ZOOM_FOV = 18;
/** How far you can walk from them before you lower them. */
const LET_GO = 4.5;

export function installCamp(ctx: Ctx) {
  const camp = () => ctx.office.camp;
  let looking = false;

  ctx.interactions.define('campfire', {
    reach: 4.5,
    hint: () => ({ k: '', parts: [hintTitle('🔥 Campfire'), aside(camp().fire.flare > 0.2 ? 'roaring' : 'crackling'), key('E', 'Stoke the fire')] }),
    use: onE(() => camp().fire.stoke()),
  });

  ctx.interactions.define('viewpoint', {
    reach: 3.5,
    hint: () => ({ k: looking ? 'down' : 'up', parts: [hintTitle('🔭 Hill lookout'), aside('the lake, the pines and the sea'), key('E', looking ? 'Lower the binoculars' : 'Look through them')] }),
    use: onE(() => {
      looking = !looking;
      ctx.hint.invalidate();
    }),
  });

  // Through the binoculars, E or Esc puts them down (the crosshair isn't on them any more).
  ctx.keys.add('guard', (e) => {
    if (!looking || (e.code !== 'KeyE' && e.code !== 'Escape')) return false;
    looking = false;
    ctx.hint.invalidate();
    e.preventDefault();
    return e.code === 'KeyE';
  });
  ctx.view.add({
    fov: (fov) => (looking ? ZOOM_FOV : fov),
  });

  // Only what's near enough to see is drawn, and you put the binoculars down when you walk off or go indoors.
  ctx.ticks.add('world', () => {
    const out = ctx.inOffice() && !ctx.upTop();
    const p = ctx.player.pos;
    if (out) camp().cull(p.x, p.z);
    if (looking) {
      const stand = camp().binoculars;
      if (!out || Math.hypot(p.x - stand.x, p.z - stand.z) > LET_GO) {
        looking = false;
        ctx.hint.invalidate();
      }
    }
  });
}
