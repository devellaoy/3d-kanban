// Multiplayer in the office: the link to the relay, who this office is there, which floors it
// shares and who may see them, the visitors it hosts and the visits its own admin makes elsewhere.
// `openMultiplayer` makes it once the floors are open (server.ts); `mpOf(ctx)` finds it.
import { randomBytes } from 'node:crypto';
import type { MpFloorShare, MpPlayer, MpState } from '../../shared/multiplayer/protocol.js';
import { MP_LIMITS, loginKey, type MpProbeFloor, type MpWhere, type RelayToOffice } from '../../shared/multiplayer/wire.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { Access, ghAccess } from './access.js';
import { MpConfigStore } from './config.js';
import { Guest } from './guest.js';
import { Host } from './host.js';
import { answerHttp } from './httpgate.js';
import { Identity } from './identity.js';
import { Link } from './link.js';
import { mpOf, setMp } from './registry.js';

export { mpOf };

const PROBE_TIMEOUT_MS = 12_000;
const PROBE_FRESH_MS = 60_000;
const PRESENCE_EVERY_MS = 2000;

export class Multiplayer {
  readonly cfg: MpConfigStore;
  readonly link: Link;
  readonly identity: Identity;
  readonly access: Access;
  readonly host: Host;
  readonly guest: Guest;
  /** What both offices must run alike for a visit to work (see Host.open). */
  readonly version: string;
  /** Admin browsers with the player list or the settings panel open: the ones told when the state changes. */
  readonly watchers = new Set<Client>();
  private identityError?: string;
  private probes = new Map<string, { resolve(f: MpProbeFloor[]): void; timer: NodeJS.Timeout }>();
  private probed = new Map<string, { at: number; floors: MpProbeFloor[] }>();
  private presenceTimer: NodeJS.Timeout;

  constructor(
    readonly ctx: Ctx,
    opts: { access?: Access; identity?: Identity } = {},
  ) {
    this.version = ctx.upgrader.version;
    this.cfg = new MpConfigStore(ctx.cfg.dataDir);
    this.access = opts.access ?? ghAccess(ctx.cfg.dataDir);
    this.identity = opts.identity ?? new Identity({ onChange: () => this.pushState() });
    this.host = new Host(this, ctx);
    this.guest = new Guest(this);
    this.link = new Link({
      config: this.cfg,
      version: this.version,
      onChange: () => {
        this.pushState();
        this.refreshProbes();
      },
      onMessage: (msg) => this.route(msg),
      onDown: () => this.down(),
    });
    this.presenceTimer = setInterval(() => this.updatePresence(), PRESENCE_EVERY_MS);
    this.presenceTimer.unref();
  }

  // --- State for the browsers ------------------------------------------------------------------------

  state(): MpState {
    const cfg = this.cfg.get();
    const mine = this.link.login ? loginKey(this.link.login) : undefined;
    const players: MpPlayer[] = this.link.players.map((p) => {
      const me = loginKey(p.login) === mine;
      const floor = p.floorKey ? (me ? this.ownFloorName(p.floorKey) : this.probed.get(loginKey(p.login))?.floors.find((f) => f.key === p.floorKey)?.name) : undefined;
      return { login: p.login, ...(p.name ? { name: p.name } : {}), online: true, where: p.where, ...(floor ? { floor } : {}), ...(me ? { me: true } : {}) };
    });
    const floors: MpFloorShare[] = this.ctx.building.list().map((d) => {
      const s = this.access.shareable(d);
      return { id: d.id, name: d.name, shared: cfg.sharedFloors.includes(d.id), shareable: s.shareable, ...(s.why ? { why: s.why } : {}) };
    });
    const device = this.identity.device;
    const error = this.identityError ?? this.link.error;
    return {
      status: this.link.status,
      url: cfg.url,
      passwordSet: !!cfg.password,
      ...(this.link.login ? { login: this.link.login } : {}),
      ...(this.link.needsIdentity || !cfg.identityToken ? { needsIdentity: true } : {}),
      ...(device ? { device } : {}),
      ...(error ? { error } : {}),
      players,
      floors,
    };
  }

  private ownFloorName(key: string): string | undefined {
    const id = Object.entries(this.cfg.get().floorKeys).find(([, k]) => k === key)?.[0];
    return id ? this.ctx.building.list().find((d) => d.id === id)?.name : undefined;
  }

  /** Tells every admin browser that is watching. */
  pushState() {
    if (!this.watchers.size) return;
    const state = this.state();
    for (const c of this.watchers) if (c.ws.readyState === 1) this.ctx.sendTo(c, { t: 'mp.state', state });
  }

  sendState(c: Client) {
    this.ctx.sendTo(c, { t: 'mp.state', state: this.state() });
  }

  // --- Signing in to GitHub --------------------------------------------------------------------------

  /** Runs the device flow (the code shows in mp.state) and reconnects with the token it gives. */
  async startIdentity() {
    if (this.identity.running) return;
    this.identityError = undefined;
    try {
      const { url, password } = this.cfg.get();
      if (!url || !password) throw new Error('Enter the relay address and password first');
      const clientId = await this.link.fetchClientId();
      const token = await this.identity.start(clientId);
      this.cfg.update({ identityToken: token, enabled: true });
      this.link.connect();
    } catch (err) {
      if ((err as Error).message !== 'cancelled') this.identityError = (err as Error).message;
    }
    this.pushState();
  }

  // --- Where this office's owner is --------------------------------------------------------------------

  /**
   * Tells the relay where the owner is: visiting someone, or at home (and on which shared floor, as
   * its key). Simplification: "the owner" is the first admin browser that is not a visitor.
   */
  updatePresence() {
    const visiting = this.guest.visiting;
    let where: MpWhere = 'home';
    let floorKey: string | undefined;
    if (visiting) where = { visiting };
    else {
      const owner = [...this.ctx.clients.values()].find((c) => c.admin && !c.visitor && !c.out);
      const id = owner?.peer.floor;
      const def = id ? this.ctx.building.list().find((d) => d.id === id) : undefined;
      if (def && this.cfg.get().sharedFloors.includes(def.id) && this.access.shareable(def).shareable) floorKey = this.cfg.floorKey(def.id);
    }
    this.link.setPresence(where, floorKey);
  }

  /** A floor stopped being shared: its visitors lose it, and those standing on it are sent home. */
  unshared(floorId: string) {
    for (const c of this.ctx.clients.values()) {
      if (!c.visitor?.floors.has(floorId)) continue;
      (c.visitor.floors as Set<string>).delete(floorId);
      (c.visitor.projects as Set<string>).delete(floorId);
      if (c.peer.floor === floorId || !c.visitor.floors.size) c.ws.close(4000, 'That floor is no longer shared');
    }
  }

  // --- Messages from the relay -----------------------------------------------------------------------

  private route(msg: RelayToOffice) {
    switch (msg.t) {
      case 'visit.open':
        return void this.host.open(msg);
      case 'visit.accept':
        return void this.guest.message(msg);
      case 'visit.frame':
      case 'visit.close':
        return void (this.host.message(msg) || this.guest.message(msg));
      case 'visit.http':
        return void answerHttp(this, msg);
      case 'visit.httpres':
        return this.guest.httpres(msg);
      case 'probe':
        return void this.answerProbe(msg.rid, msg.from);
      case 'probe.res':
        return this.finishProbe(msg.rid, msg.floors);
    }
  }

  /** The link dropped or was closed: every visit riding on it is over, and so is every question. */
  private down() {
    const why = 'The connection to the relay was lost';
    this.host.endAll(why, false);
    this.guest.endAll(why);
    for (const rid of [...this.probes.keys()]) this.finishProbe(rid, []);
  }

  /** The floors of this office `login` could enter, named, for their player list. */
  private async answerProbe(rid: string, login: string) {
    const defs = this.ctx.building.list().filter((d) => this.ctx.floors.has(d.id));
    const ids = await this.access.allowedFloors(defs, this.cfg.get().sharedFloors, login);
    const floors = ids.slice(0, MP_LIMITS.floors).map((id) => ({ key: this.cfg.floorKey(id), name: (defs.find((d) => d.id === id)?.name ?? id).slice(0, MP_LIMITS.name) || id }));
    this.link.send({ t: 'probe.res', rid, floors });
  }

  /** Asks `to`'s office which of its floors this office's viewer may enter. */
  probe(to: string): Promise<MpProbeFloor[]> {
    const rid = randomBytes(9).toString('base64url');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishProbe(rid, []), PROBE_TIMEOUT_MS);
      this.probes.set(rid, { resolve, timer });
      if (!this.link.send({ t: 'probe', rid, to })) this.finishProbe(rid, []);
    });
  }

  private finishProbe(rid: string, floors: MpProbeFloor[]) {
    const p = this.probes.get(rid);
    if (!p) return;
    clearTimeout(p.timer);
    this.probes.delete(rid);
    p.resolve(floors);
  }

  /** While someone watches the player list, learns the names of the floors the other players are on. */
  refreshProbes() {
    if (!this.watchers.size || !this.link.online) return;
    const mine = this.link.login ? loginKey(this.link.login) : undefined;
    for (const p of this.link.players) {
      const key = loginKey(p.login);
      if (key === mine || !p.floorKey) continue;
      const known = this.probed.get(key);
      if (known && Date.now() - known.at < PROBE_FRESH_MS) continue;
      // Marked first, so a burst of player lists asks once.
      this.probed.set(key, { at: Date.now(), floors: known?.floors ?? [] });
      void this.probe(p.login).then((floors) => {
        this.probed.set(key, { at: Date.now(), floors });
        this.pushState();
      });
    }
  }

  close() {
    clearInterval(this.presenceTimer);
    this.identity.cancel();
    this.link.disconnect();
    this.host.endAll('The office closed', false);
    this.watchers.clear();
  }
}

/** Opens multiplayer on the office, and reconnects to the relay if it was on. */
export function openMultiplayer(ctx: Ctx): Multiplayer {
  const mp = new Multiplayer(ctx);
  setMp(ctx, mp);
  if (mp.cfg.get().enabled) mp.link.connect();
  return mp;
}

export function closeMultiplayer(ctx: Ctx) {
  mpOf(ctx)?.close();
  setMp(ctx, undefined);
}
