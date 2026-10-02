// The building's floors: riding the elevator between them and up to the roof, and adding and taking
// off floors.
import type { FloorClientMsg } from '../../../shared/protocol.js';
import { groupFloors } from '../../../shared/floororder.js';
import { ROOF } from '../../../shared/rooftop.js';
import { arrivalSpot, str } from '../../office/input.js';
import { addFolder } from '../../office/addfloor.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const projectView: ViewPieces['project'] = (_ctx, floor) => floor?.project ?? null;

export const floorHandlers = {
  'floor.go'(ctx, c, msg) {
    if (msg.floor === ROOF) {
      if (ctx.floors.size) ctx.goToRoof(c);
      else ctx.warn(c, 'There is no building to go up on yet');
      return;
    }
    const floor = ctx.floors.get(str(msg.floor, 64));
    if (!floor) ctx.warn(c, ctx.building.pending().some((d) => d.id === msg.floor) ? "That floor is still being cloned — it'll be ready in a moment" : 'No such floor');
    else ctx.goToFloor(c, floor, arrivalSpot(msg.at));
  },
  'floor.repos'(ctx, c, msg) {
    void ctx.building.repos(msg.refresh === true).then(
      (repos) => ctx.sendTo(c, { t: 'floor.repos', repos }),
      (err: Error) => ctx.sendTo(c, { t: 'floor.repos', repos: [], error: `Couldn't list your repositories with gh: ${err.message}` }),
    );
  },
  'floor.add'(ctx, c, msg) {
    const who = c.peer.name;
    const rid = typeof msg.rid === 'string' ? msg.rid.slice(0, 64) : undefined;
    if (typeof msg.dir === 'string') return addFolder(ctx, c, msg.dir, rid);
    const repo = str(msg.repo, 200);
    void ctx.building
      .add(repo, who, (def) => {
        ctx.floorsChanged();
        ctx.toastAll(`🛗 ${who} is adding a floor for ${def.repo ?? def.name}…`);
      })
      .then((r) => {
        ctx.floorsChanged();
        if (typeof r === 'string') return ctx.sendTo(c, { t: 'floor.added', repo, rid, error: r });
        const floor = ctx.openFloor(r);
        if (!floor) return ctx.sendTo(c, { t: 'floor.added', repo, rid, error: `Cloned ${r.repo}, but couldn't open its floor — see the office's log` });
        console.log(`  ${who} added a floor for ${r.repo} (${r.dir})`);
        ctx.toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
        ctx.sendTo(c, { t: 'floor.added', repo, rid, floor: floor.id });
      });
  },
  'floor.remove'(ctx, c, msg) {
    const who = c.peer.name;
    // Everyone's workers on it stop: admins do it.
    if (!ctx.meOfClient(c).admin) return ctx.warn(c, 'Only admins can take a floor off the building');
    const id = str(msg.floor, 64);
    const r = ctx.building.remove(id, who);
    if (typeof r === 'string') return ctx.warn(c, r);
    console.log(`  ${who} took the ${r.name} floor off the building (${r.dir} stays where it is)`);
    const floor = ctx.floors.get(id);
    if (floor) ctx.closeFloor(floor, who);
    else ctx.floorsChanged();
  },
  'floor.move'(ctx, c, msg) {
    const who = c.peer.name;
    // The order is the whole office's, so admins set it.
    if (!ctx.meOfClient(c).admin) return ctx.warn(c, 'Only admins can reorder the floors');
    const above = msg.above === null ? null : str(msg.above, 64);
    const key = typeof msg.group === 'string' ? str(msg.group, 64) : undefined;
    const id = key === undefined ? str(msg.floor, 64) : '';
    const r = key !== undefined ? ctx.building.moveGroup(key, above) : ctx.building.moveFloor(id, above);
    // Whatever happened, everyone gets the real order again: the sender's guess goes back to it, and so do other admins' guesses of their own that the final order doesn't equal the last one sent.
    ctx.floorsChanged(true);
    if ('err' in r) return ctx.warn(c, r.err);
    // A stale step (something another admin just changed) or one that changed nothing (the same drop twice) is nothing to tell anyone.
    if ('stale' in r || !r.changed) return;
    const list = ctx.building.list();
    const text =
      key !== undefined
        ? `🛗 ${who} reordered the floors: the ${groupFloors(list).find((g) => g.key === key)?.label ?? key} floors moved`
        : `🛗 ${who} moved ${list.find((d) => d.id === id)?.name} ${r.up ? 'up' : 'down'} the building`;
    console.log(`  ${text.slice(3)}`);
    for (const o of ctx.clients.values()) if (o !== c) ctx.sendTo(o, { t: 'toast', text, level: 'info' });
  },
  'floor.projectsDir'(ctx, c, msg) {
    const who = c.peer.name;
    // It's a folder on the office's machine that `gh` writes into: admins pick it.
    const err = ctx.meOfClient(c).admin ? ctx.building.setProjectsDir(str(msg.dir, 1024), who) : 'Only admins can move the workspace folder';
    ctx.warn(c, err);
    if (err) return;
    const state = ctx.building.projectsDirState();
    ctx.broadcast({ t: 'projectsDir', state });
    ctx.toastAll(state.custom ? `📁 ${who} moved the workspace folder to ${state.dir}` : `📁 ${who} put the workspace folder back to ${state.dir}`);
  },
} satisfies HandlerMap<FloorClientMsg>;
