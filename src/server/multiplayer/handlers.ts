// The browser's multiplayer messages: connecting the office to a relay, signing in to GitHub, and
// choosing which floors to share. All of them are for this office's admins; a visitor never gets
// here (the inbound gate drops `mp.*` for them), and the check is repeated anyway.
import type { MpClientMsg } from '../../shared/multiplayer/protocol.js';
import { LOGIN_RE } from '../../shared/multiplayer/wire.js';
import { throttle, type Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import type { FeatureHooks, HandlerMap } from '../ws/handlers/types.js';
import { normalizeRelayUrl } from './link.js';
import { mpOf } from './registry.js';
import type { Multiplayer } from './index.js';

/** The service, if `c` may change multiplayer (an admin of this office, not a visitor); else tells them why not. */
function admin(ctx: Ctx, c: Client): Multiplayer | undefined {
  if (c.visitor || !ctx.meOfClient(c).admin) return void ctx.warn(c, 'Only admins can change multiplayer');
  const mp = mpOf(ctx);
  if (!mp) ctx.warn(c, 'Multiplayer is not available');
  return mp;
}

export const mpHandlers = {
  'mp.connect'(ctx, c, msg) {
    const mp = admin(ctx, c);
    if (!mp) return;
    if (typeof msg.url !== 'string' || (msg.password !== undefined && (typeof msg.password !== 'string' || msg.password.length > 200))) return ctx.warn(c, 'That is not a relay address');
    const url = normalizeRelayUrl(msg.url);
    if ('error' in url) return ctx.warn(c, url.error);
    const saved = mp.cfg.get();
    // A password typed here is kept; an empty one leaves the saved one alone ("saved" in the box).
    const password = msg.password ? msg.password : saved.password;
    if (!password) return ctx.warn(c, 'Enter the relay\'s password');
    mp.cfg.update({ url: url.url, password, enabled: true });
    mp.link.connect();
    mp.sendState(c);
  },
  'mp.online'(ctx, c, msg) {
    const mp = admin(ctx, c);
    if (!mp) return;
    if (typeof msg.on !== 'boolean') return ctx.warn(c, 'Online or offline?');
    // Offline only hangs up (ending visits both ways): url, password, token and shared floors stay.
    if (!msg.on) {
      mp.cfg.update({ enabled: false });
      mp.link.disconnect();
    } else {
      if (!mp.cfg.get().url) return ctx.warn(c, 'Connect to a multiplayer server first');
      mp.cfg.update({ enabled: true });
      mp.link.connect();
    }
    mp.sendState(c);
  },
  'mp.identity.start'(ctx, c) {
    const mp = admin(ctx, c);
    if (mp) void mp.startIdentity();
  },
  'mp.identity.cancel'(ctx, c) {
    admin(ctx, c)?.identity.cancel();
  },
  'mp.identity.forget'(ctx, c) {
    admin(ctx, c)?.forgetIdentity();
  },
  'mp.share'(ctx, c, msg) {
    const mp = admin(ctx, c);
    if (!mp) return;
    const def = typeof msg.floor === 'string' ? ctx.building.list().find((d) => d.id === msg.floor) : undefined;
    if (!def || typeof msg.on !== 'boolean') return ctx.warn(c, 'No such floor');
    const shared = mp.cfg.get().sharedFloors;
    if (msg.on) {
      const s = mp.shareable(def, true);
      if (!s.shareable) return ctx.warn(c, `${def.name} cannot be shared: ${s.why}`);
      if (!shared.includes(def.id)) mp.cfg.update({ sharedFloors: [...shared, def.id] });
      // Visitors already in the office are offered it as well, if GitHub lets them read it.
      mp.host.offer(def.id);
    } else {
      mp.cfg.update({ sharedFloors: shared.filter((id) => id !== def.id) });
      mp.host.unshare(def.id);
    }
    mp.updatePresence();
    mp.pushState();
    mp.sendState(c);
  },
  'mp.watch'(ctx, c) {
    const mp = admin(ctx, c);
    if (!mp) return;
    mp.watchers.add(c);
    mp.sendState(c);
    mp.refreshProbes();
  },
  'mp.unwatch'(ctx, c) {
    mpOf(ctx)?.watchers.delete(c);
  },
  async 'mp.probe'(ctx, c, msg) {
    const mp = admin(ctx, c);
    if (!mp || typeof msg.to !== 'string' || !LOGIN_RE.test(msg.to) || !throttle(c, 'mp.probe', 500)) return;
    ctx.sendTo(c, { t: 'mp.probe.res', to: msg.to, floors: await mp.probe(msg.to) });
  },
} satisfies HandlerMap<MpClientMsg>;

/** Someone left the office: no more state for them, and the owner's whereabouts may have changed. */
export const mpHooks: FeatureHooks = {
  // An admin browser learns whether the office is online, and what it shares, without opening the panel
  // (an office that never set multiplayer up has nothing to tell).
  welcomed(ctx, c) {
    const mp = mpOf(ctx);
    if (mp && c.admin && !c.visitor && mp.cfg.get().url) mp.sendState(c);
    if (c.admin && !c.visitor) mp?.updatePresence();
  },
  closed(ctx, c) {
    const mp = mpOf(ctx);
    mp?.watchers.delete(c);
    if (c.admin && !c.visitor) mp?.updatePresence();
  },
};
