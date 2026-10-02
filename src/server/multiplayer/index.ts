// Multiplayer in the office: the link to the relay, who this office is there, which floors it
// shares and who may see them, the visitors it hosts and the visits its own admin makes elsewhere.
// `openMultiplayer` makes it once the floors are open (server.ts); `mpOf(ctx)` finds it.
import { randomBytes } from 'node:crypto';
import type { MpFloorShare, MpPlayer, MpState } from '../../shared/multiplayer/protocol.js';
import { MP_LIMITS, loginKey, type MpProbeFloor, type MpWhere, type RelayToOffice } from '../../shared/multiplayer/wire.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import type { FloorDef } from '../building.js';
import { Access, ghAccess, repoPrint } from './access.js';
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
  /** Whether each floor can be shared at all, as of the last floorsChanged: reading a checkout's remote runs git, which state() and the presence must not do on every call. */
  private shareables = new Map<string, { shareable: boolean; why?: string }>();

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
      const s = this.shareable(d);
      return { id: d.id, name: d.name, shared: cfg.sharedFloors.includes(d.id), shareable: s.shareable, ...(s.why ? { why: s.why } : {}) };
    });
    const device = this.identity.device;
    const error = this.identityError ?? this.link.error;
    return {
      status: this.link.status,
      url: cfg.url,
      configured: !!cfg.url,
      offline: !!cfg.url && !cfg.enabled,
      passwordSet: !!cfg.password,
      ...(this.link.login && cfg.identityToken ? { login: this.link.login } : {}),
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

  /** Tells every admin browser: the watchers and the other admins. */
  pushState() {
    // The panel's watchers, and every other admin browser, which shows the status without watching.
    const to = new Set<Client>(this.watchers);
    for (const c of this.ctx.clients.values()) if (c.admin && !c.visitor && !c.out) to.add(c);
    if (!to.size) return;
    const state = this.state();
    for (const c of to) if (c.ws.readyState === 1) this.ctx.sendTo(c, { t: 'mp.state', state });
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
      if (def && this.cfg.get().sharedFloors.includes(def.id) && this.shareable(def).shareable) floorKey = this.cfg.floorKey(def.id);
    }
    this.link.setPresence(where, floorKey);
  }

  /** Whether floor `def` can be shared (see Access.shareable), from the cache unless `fresh`; floorsChanged refreshes the cache. */
  shareable(def: FloorDef, fresh = false): { shareable: boolean; why?: string } {
    let s = fresh ? undefined : this.shareables.get(def.id);
    if (!s) this.shareables.set(def.id, (s = this.access.shareable(def)));
    return s;
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

  /**
   * The shared floors `login` can enter right now, each with the repositories (repoPrint) it was
   * checked against. GitHub takes a while to answer, so the answer is held to the config as it is
   * when it comes back: a floor unshared meanwhile, or given other repositories, is not in it.
   */
  async admitted(login: string): Promise<Map<string, string>> {
    const defs = () => this.ctx.building.list().filter((d) => this.ctx.floors.has(d.id));
    const asked = new Map(defs().map((d) => [d.id, repoPrint(d)]));
    const ids = await this.access.allowedFloors(defs(), this.cfg.get().sharedFloors, login);
    const shared = this.cfg.get().sharedFloors;
    const out = new Map<string, string>();
    for (const d of defs()) {
      const print = repoPrint(d);
      if (ids.includes(d.id) && shared.includes(d.id) && this.shareable(d).shareable && asked.get(d.id) === print) out.set(d.id, print);
    }
    return out;
  }

  /**
   * The floors or projects changed (the elevator's list, a project's repositories, someone moving
   * between floors): see Host.recheck. Also where the owner's presence follows, so nothing polls.
   */
  floorsChanged() {
    const live = new Set<string>();
    for (const d of this.ctx.building.list()) {
      live.add(d.id);
      this.shareables.set(d.id, this.access.shareable(d));
    }
    for (const id of this.shareables.keys()) if (!live.has(id)) this.shareables.delete(id);
    this.host.recheck();
    this.updatePresence();
  }

  /** Forgets the GitHub account: the stored token goes, and the office hangs up (a token proves identity to any relay with the same password, so it should not outlive the wish). */
  forgetIdentity() {
    this.identity.cancel();
    this.cfg.update({ identityToken: '', login: undefined, enabled: false });
    this.link.disconnect();
    this.identityError = undefined;
    this.pushState();
  }

  /** The floors of this office `login` could enter, named, for their player list. */
  private async answerProbe(rid: string, login: string) {
    const allowed = await this.admitted(login);
    if (!this.link.online) return;
    const defs = this.ctx.building.list();
    const ids = [...allowed.keys()];
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
    this.host.stop();
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
