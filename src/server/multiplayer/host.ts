// The owner's side of a visit: someone from the relay asks to come in (`visit.open`), and if their
// version matches and they can read at least one shared floor on GitHub, they join as a Client
// whose socket is a RemoteSocket. From there they go through the same connection code as anyone,
// but they are `visitor`s: what they send passes the inbound gate (ws/dispatch.ts) and what the
// office sends them passes the outbound filter (remote-socket.ts).
import { MP_PROTOCOL, type RelayToOffice } from '../../shared/multiplayer/wire.js';
import type { VisitorScope } from '../../shared/multiplayer/allow.js';
import { MutableScope } from '../../shared/multiplayer/scope.js';
import { repoOk } from '../../shared/multiplayer/repos.js';
import { ROOF } from '../../shared/rooftop.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { onConnection } from '../ws/connection.js';
import { RemoteSocket } from './remote-socket.js';
import { RECHECK_MS, repoIdsOf, repoPrint } from './access.js';
import { taskRepos, workerFloors } from './gate.js';
import type { Multiplayer } from './index.js';

type Msg<T extends RelayToOffice['t']> = Extract<RelayToOffice, { t: T }>;

interface Hosted {
  sock: RemoteSocket;
  scope: MutableScope;
  /** Floor id → the repositories (repoPrint) the visitor was verified against; a floor whose project changed is taken away until it is verified again. */
  prints: Map<string, string>;
  /** Floors taken away, with the repositories they had when GitHub last said no (or has not answered yet): asked again when the project changes once more. */
  denied: Map<string, string>;
}

export class Host {
  readonly sessions = new Map<string, Hosted>();
  /** Visits being checked against GitHub, so a repeated visit.open for the same id is ignored; `ended` when the visitor withdrew or the link dropped meanwhile. */
  private pending = new Map<string, { ended: boolean }>();

  /** Answers from GitHub being waited for, per visit: a visit with no floor left is ended only when none is pending. */
  private checking = new Map<Hosted, number>();
  private timer: NodeJS.Timeout;

  constructor(
    private mp: Multiplayer,
    private ctx: Ctx,
  ) {
    // GitHub access can be withdrawn mid-visit (a collaborator removed): ask again as often as the yes-cache lets a new answer in.
    this.timer = setInterval(() => void this.reverifyAll(), RECHECK_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Visitors in the office now (for their count and for ending visits of a floor that stopped being shared). */
  visitors(): { sid: string; scope: VisitorScope; sock: RemoteSocket }[] {
    return [...this.sessions].map(([sid, h]) => ({ sid, ...h }));
  }

  async open(msg: Msg<'visit.open'>) {
    const { ctx, mp } = this;
    const { sid } = msg;
    if (this.sessions.has(sid) || this.pending.has(sid)) return;
    const refuse = (reason: string) => void mp.link.send({ t: 'visit.close', sid, reason });
    const wait = { ended: false };
    this.pending.set(sid, wait);
    try {
      // The messages are shaped by the code, so both offices must run the same.
      if (msg.protocol !== MP_PROTOCOL || msg.version !== mp.version) {
        return refuse(`@${mp.link.login ?? 'the owner'} runs version ${mp.version} — update both offices to the same version`);
      }
      // GitHub takes a while, and the owner may unshare a floor or change its repositories meanwhile:
      // `admitted` checks the answer against the config as it is when it comes back.
      const allowed = await mp.admitted(msg.from);
      if (wait.ended || !mp.link.online) return;
      if (!allowed.size) return refuse("You don't have access to any shared floor");
      this.admit(msg, allowed);
    } catch (err) {
      refuse(`The visit could not start: ${(err as Error).message}`.slice(0, 200));
    } finally {
      this.pending.delete(sid);
    }
  }

  private admit(msg: Msg<'visit.open'>, verified: Map<string, string>) {
    const { ctx, mp } = this;
    const { sid, profile } = msg;
    const scope = new MutableScope(msg.from);
    // A floor whose project changed since GitHub was asked is not granted (it comes with the next recheck).
    for (const [id, print] of [...verified]) if (!this.grantFloor(scope, id, print)) verified.delete(id);
    const allowed = [...scope.floors];
    if (!allowed.length) return void mp.link.send({ t: 'visit.close', sid, reason: "You don't have access to any shared floor" });
    const sock = new RemoteSocket(
      {
        frame: (data, drop) => mp.link.send({ t: 'visit.frame', sid, data, ...(drop ? { drop: true as const } : {}) }, !!drop),
        up: () => mp.link.online,
        bufferedAmount: () => mp.link.queuedFor(sid),
        closed: (reason) => void mp.link.send({ t: 'visit.close', sid, reason: reason.slice(0, 250) }),
      },
      scope,
      { floorOfPeer: (id) => ctx.clients.get(id)?.peer.floor, workerFloors: (id) => workerFloors(ctx, id), projectOfTask: (id) => ctx.kanban?.ctx.repo.getTask(id)?.project, taskRepos: (id) => taskRepos(ctx, id) },
    );
    this.sessions.set(sid, { sock, scope, prints: new Map(verified), denied: new Map() });
    sock.once('close', () => this.sessions.delete(sid));
    // Accepted before the welcome goes out, since the relay passes frames only for an accepted visit.
    mp.link.send({ t: 'visit.accept', sid });
    // Their look comes in the way a browser's does, through the query the connection code validates.
    const q = new URLSearchParams({ color: profile.color, skin: String(profile.skin), hair: String(profile.hair), style: String(profile.style), floor: allowed[0] });
    onConnection(ctx, sock.asWebSocket(), new URL(`http://visit/ws?${q}`), {}, scope);
  }

  /** A visit.frame / visit.close from the visitor's office. Returns whether the sid is one of ours. */
  message(msg: Msg<'visit.frame'> | Msg<'visit.close'>): boolean {
    const h = this.sessions.get(msg.sid);
    if (!h) {
      // The visitor gave up while their access was being checked.
      const wait = msg.t === 'visit.close' ? this.pending.get(msg.sid) : undefined;
      if (wait) wait.ended = true;
      return !!wait;
    }
    if (msg.t === 'visit.frame') h.sock.receive(msg.data);
    else h.sock.end(msg.reason, false);
    return true;
  }

  /** Ends every visit (the link dropped, or multiplayer was switched off). */
  endAll(reason: string, notify: boolean) {
    for (const wait of this.pending.values()) wait.ended = true;
    for (const h of [...this.sessions.values()]) h.sock.end(reason, notify);
  }

  /**
   * The floors or projects of the office changed. A floor that stopped being shared is taken away for
   * good. A floor whose repositories are not the ones the visitor was verified against is hidden
   * (out of scope, its terminals and diffs let go, the visitor moved off it) while GitHub is asked
   * again, and given back if they can read every repository it has now. Re-checking never closes the
   * visit by itself: only an answer of "no" with no floor left does.
   */
  recheck() {
    const { ctx, mp } = this;
    if (!this.sessions.size) return;
    const defs = new Map(ctx.building.list().map((d) => [d.id, d]));
    const shared = mp.cfg.get().sharedFloors;
    for (const [sid, h] of [...this.sessions]) {
      const gone = [...new Set([...h.prints.keys(), ...h.denied.keys()])].filter((id) => !defs.has(id) || !shared.includes(id));
      if (gone.length) this.drop(h, gone);
      if (h.sock.readyState !== 1) continue;
      const changed = (id: string, print: string) => {
        const def = defs.get(id)!;
        // An unshareable project (a repository without GitHub remote) is hidden and not given back, whatever its print.
        return !mp.shareable(def).shareable || repoPrint(def) !== print;
      };
      const stale = [...h.prints].filter(([id, print]) => changed(id, print)).map(([id]) => id);
      // A floor taken away earlier gets another chance when its repositories change again.
      const retry = [...h.denied].filter(([id, print]) => changed(id, print)).map(([id]) => id);
      if (!stale.length && !retry.length) continue;
      for (const id of stale) {
        h.prints.delete(id);
        h.scope.revoke(id);
      }
      const tried = [...stale, ...retry];
      for (const id of tried) h.denied.set(id, repoPrint(defs.get(id)!));
      if (stale.length) this.relocate(h);
      this.tell(h);
      void this.regain(sid, h, tried);
    }
  }

  /** The owner stopped sharing a floor: every visitor loses it at once. */
  unshare(floorId: string) {
    for (const h of [...this.sessions.values()]) if (h.prints.has(floorId) || h.denied.has(floorId) || h.scope.floors.has(floorId)) this.drop(h, [floorId]);
  }

  /** A floor was shared during visits: offers it to every visitor who can read it. */
  offer(floorId: string) {
    for (const [sid, h] of [...this.sessions]) void this.regain(sid, h, [floorId]);
  }

  /** Takes floors away for good (unshared, or no longer in the building); the visit ends when nothing is left to look at. */
  private drop(h: Hosted, ids: string[]) {
    for (const id of ids) {
      h.prints.delete(id);
      h.denied.delete(id);
      h.scope.revoke(id);
    }
    if (h.sock.readyState !== 1) return;
    this.relocate(h);
    this.tell(h);
    if (!h.scope.floors.size && !this.checking.get(h)) this.end(h, 'That floor is no longer shared');
  }

  /** Verifies the visitor again for floors they lost (or were offered) and gives back those they can still read (the visit may be over by then). */
  private async regain(sid: string, h: Hosted, lost: string[]) {
    const { now, last } = await this.ask(h);
    if (!now || this.sessions.get(sid) !== h || h.sock.readyState !== 1) return;
    this.give(h, now, lost);
    this.tell(h);
    if (h.scope.floors.size || !last) return;
    // GitHub said no and nothing is left. A project that is unshareable for now (a repository whose
    // remote could not be read this moment) is waited out instead: the visitor stays on the roof.
    const defs = this.ctx.building.list();
    const shared = this.mp.cfg.get().sharedFloors;
    const hard = lost.every((id) => {
      const def = defs.find((d) => d.id === id);
      return def && shared.includes(id) && this.mp.shareable(def).shareable;
    });
    if (hard) this.end(h, 'You can no longer read the GitHub repositories of that floor');
  }

  /** Every visit's GitHub access, again: floors the visitor lost are taken away, and any they gained (or were never offered) are given. */
  private async reverifyAll() {
    for (const [sid, h] of [...this.sessions]) {
      const { now, last } = await this.ask(h);
      if (!now || this.sessions.get(sid) !== h || h.sock.readyState !== 1) continue;
      const defs = this.ctx.building.list();
      // Only floors whose answer is about the repositories they have now: a project changed meanwhile is recheck's.
      const lost = [...h.prints].filter(([id, print]) => !now.has(id) && defs.some((d) => d.id === id && repoPrint(d) === print)).map(([id]) => id);
      for (const id of lost) {
        h.prints.delete(id);
        h.scope.revoke(id);
        h.denied.set(id, repoPrint(defs.find((d) => d.id === id)!));
      }
      if (lost.length) this.relocate(h);
      this.give(h, now, [...now.keys()]);
      this.tell(h);
      if (!h.scope.floors.size && last) this.end(h, 'You no longer have access to any shared floor');
    }
  }

  /** What GitHub says `h`'s visitor can enter now (undefined when it could not be asked); `last` when no other question about them is open. */
  private async ask(h: Hosted): Promise<{ now?: Map<string, string>; last: boolean }> {
    this.checking.set(h, (this.checking.get(h) ?? 0) + 1);
    const now = await this.mp.admitted(h.scope.login).catch(() => undefined);
    const left = (this.checking.get(h) ?? 1) - 1;
    if (left) this.checking.set(h, left);
    else this.checking.delete(h);
    return { now, last: !left };
  }

  /** Gives back the floors among `ids` that GitHub's answer `now` allows and whose project is still the one asked about. */
  private give(h: Hosted, now: Map<string, string>, ids: string[]) {
    for (const id of ids) {
      const print = now.get(id);
      if (print === undefined || h.prints.has(id)) continue;
      if (!this.grantFloor(h.scope, id, print)) continue;
      h.prints.set(id, print);
      h.denied.delete(id);
    }
  }

  /**
   * Grants floor `id` with the repositories of its project (`print` is what GitHub was asked about);
   * false when the project is no longer the one that was checked. Workers and tasks that hold a
   * repository taken out of the project since are then not the visitor's to see.
   */
  private grantFloor(scope: MutableScope, id: string, print: string): boolean {
    const def = this.ctx.building.list().find((d) => d.id === id);
    if (!def || repoPrint(def) !== print) return false;
    scope.grant(id, repoIdsOf(def));
    return true;
  }

  private clientOf(h: Hosted): Client | undefined {
    return [...this.ctx.clients.values()].find((x) => x.visitor === h.scope);
  }

  private end(h: Hosted, reason: string) {
    const c = this.clientOf(h);
    if (c) c.ws.close(4000, reason);
    else h.sock.end(reason, true);
  }

  /** The visitor stands on a floor that is no longer theirs: another floor of theirs, else the roof (which carries nothing of any project). */
  private relocate(h: Hosted) {
    const c = this.clientOf(h);
    if (!c) return;
    const here = c.peer.floor;
    if (here !== ROOF && !(here && h.scope.floors.has(here))) {
      const next = [...h.scope.floors].map((id) => this.ctx.floors.get(id)).find((f) => f);
      if (next) this.ctx.goToFloor(c, next);
      else this.ctx.goToRoof(c);
    }
    this.detachOutOfScope(c);
  }

  /** Lets go of every terminal and diff a visitor watches on floors that are no longer theirs (the filter stops the frames too). */
  private detachOutOfScope(c: Client) {
    const scope = c.visitor;
    if (!scope) return;
    for (const wid of [...c.attached]) {
      const floor = this.ctx.workerFloor(wid);
      if (floor && workerFloors(this.ctx, wid)?.every((id) => repoOk(scope, id))) continue;
      floor?.workers.detach(wid, c.id);
      c.attached.delete(wid);
    }
    for (const floor of this.ctx.floors.values()) if (!scope.floors.has(floor.id)) floor.changes.unwatchAll(c.id);
  }

  /** Their floor list, as it is in their scope now. */
  private tell(h: Hosted) {
    const c = this.clientOf(h);
    if (c) this.ctx.sendTo(c, { t: 'floors', floors: this.ctx.floorInfos() });
  }
}
