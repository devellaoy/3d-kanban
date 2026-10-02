/**
 * The seasons in the landscape: the scenic loop's leafy trees blossom in spring, are green in summer,
 * turn in autumn and stand bare in winter, the pines and the lawn change colour with them, and in
 * winter snow lies on everything that faces up outside (the sky's own snow, see skySnow in world/sky.ts).
 * The season is the calendar's, in the hemisphere the office's sky is in. `?season=autumn` in the URL
 * (or `__season('winter')` in the console) tries the others.
 */
import { seasonFromQuery, seasonOf, snowCover, type Season } from '../../../shared/season';
import type { Ctx } from '../../core/context';
import { store } from '../../state';
import { applySeason, seasonalCount } from '../../world/scenic/seasonal';
import { uniforms } from '../../world/sky';

export function installSeasons(ctx: Ctx) {
  let forced: Season | null = seasonFromQuery(location.search);
  let shown: Season | null = null;
  let known = -1;
  let checked = 0;
  /** The season by the calendar: the southern hemisphere is the sky's guess at where the office is (see guessPlace). */
  const calendar = () => seasonOf(new Date(), (store.sky?.lat ?? 40) < 0);
  const current = () => forced ?? calendar();

  ctx.ticks.add('world', ({ t }) => {
    // Once a minute is plenty to notice the season has turned; anything built since is painted too.
    if (shown && t - checked < 60 && known === seasonalCount()) return;
    checked = t;
    const now = current();
    if (now === shown && known === seasonalCount()) return;
    shown = now;
    known = seasonalCount();
    applySeason(now);
  });

  // After the sky has set how much snow lies (the 'env' phase), winter keeps some on the ground outside whatever the weather is.
  ctx.ticks.add('aim', () => {
    // Only on the office's own map: a map of its own (the castle's hall) is where the sky keeps snow off.
    if (!shown || !ctx.inOffice()) return;
    const cover = snowCover(shown);
    if (cover <= 0) return;
    uniforms.skySnow.value = Math.max(uniforms.skySnow.value, cover);
    // Snow lying on the ground isn't wet as well (as the sky does with its own snow).
    uniforms.skyWet.value *= 1 - cover;
  });

  const season = (s?: Season | null) => {
    if (s !== undefined) {
      forced = s;
      shown = null;
    }
    return current();
  };
  (window as { __season?: typeof season }).__season = season;
  return { season };
}
