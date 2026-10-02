import type { Client } from './client.js';
import type { Ctx } from './context.js';

/**
 * `floor.add` with a folder (admins only): the folder becomes a floor as it is, and the asker hears how
 * it went. The answer echoes `dir` (and `rid`) exactly as they came, which is how the asking panel knows it's its own.
 */
export function addFolder(ctx: Ctx, c: Client, dir: string, rid?: string) {
  const who = c.peer.name;
  const fail = (error: string) => ctx.sendTo(c, { t: 'floor.added', dir, rid, error });
  if (!ctx.meOfClient(c).admin) return fail('Only admins can add a folder as a project');
  const def = ctx.building.addDir(dir.slice(0, 2048), who);
  if (typeof def === 'string') return fail(def);
  ctx.floorsChanged();
  const floor = ctx.openFloor(def);
  if (!floor) {
    ctx.building.forget(def.id);
    ctx.floorsChanged();
    return fail(`Couldn't open ${def.name}'s floor — see the office's log`);
  }
  console.log(`  ${who} added a floor for the folder ${def.dir}${def.repo ? ` (${def.repo})` : ''}`);
  ctx.toastAll(`🛗 New floor: ${def.name}, added by ${who}`);
  ctx.sendTo(c, { t: 'floor.added', dir, rid, floor: floor.id });
}
