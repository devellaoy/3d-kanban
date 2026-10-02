// Visits and probes: who may talk to whom through the relay. Everything routes by the
// authenticated login of the sender (`from` is set here, never read from a message), a session's
// frames only go between its two parties, and a session dies with either link.
import { MP_HARD_CAP, type OfficeToRelay, type RelayToOffice } from '../../../shared/multiplayer/wire.js';
import type { Directory, Peer } from './directory.js';

const PENDING_OPEN_MS = 30_000;
const PROBE_MS = 10_000;
const HTTP_MS = 60_000;
const MAX_VISITS_AS_VISITOR = 4;
const MAX_SESSIONS_AT_OWNER = 16;
const MAX_PROBES = 16;
const MAX_HTTP = 32;

interface Session {
  sid: string;
  visitor: string;
  owner: string;
  open: boolean;
  startedAt: number;
  /** Requests the visitor sent that the owner has not answered yet (rid → give-up time). */
  http: Map<string, number>;
}

interface Probe {
  visitor: string;
  owner: string;
  until: number;
}

type Msg<T extends OfficeToRelay['t']> = Extract<OfficeToRelay, { t: T }>;

export class Sessions {
  private sessions = new Map<string, Session>();
  /** Keyed by `${owner}|${rid}`: the owner's probe.res carries only the rid. */
  private probes = new Map<string, Probe>();

  constructor(private dir: Directory) {}

  get count(): number {
    return this.sessions.size;
  }

  private countWhere(f: (s: Session) => boolean): number {
    let n = 0;
    for (const s of this.sessions.values()) if (f(s)) n++;
    return n;
  }

  private end(s: Session, reason: string, notify: { visitor?: boolean; owner?: boolean }) {
    this.sessions.delete(s.sid);
    if (notify.visitor) this.dir.get(s.visitor)?.send({ t: 'visit.close', sid: s.sid, reason });
    if (notify.owner) this.dir.get(s.owner)?.send({ t: 'visit.close', sid: s.sid, reason });
  }

  /** The session `peer` is a party of, and the other party's peer. */
  private party(peer: Peer, sid: string): { s: Session; other: Peer | undefined; isOwner: boolean } | undefined {
    const s = this.sessions.get(sid);
    if (!s || (s.visitor !== peer.key && s.owner !== peer.key)) return undefined;
    const isOwner = s.owner === peer.key;
    return { s, isOwner, other: this.dir.get(isOwner ? s.visitor : s.owner) };
  }

  open(from: Peer, msg: Msg<'visit.open'>) {
    const refuse = (reason: string) => void from.send({ t: 'visit.close', sid: msg.sid, reason });
    const owner = this.dir.get(msg.to);
    if (this.sessions.has(msg.sid)) return refuse('That visit id is taken');
    if (!owner) return refuse(`${msg.to} is not online`);
    if (owner === from) return refuse('You cannot visit yourself');
    if (this.countWhere((s) => s.visitor === from.key) >= MAX_VISITS_AS_VISITOR) return refuse('Too many visits at once');
    if (this.countWhere((s) => s.owner === owner.key) >= MAX_SESSIONS_AT_OWNER) return refuse(`${owner.login}'s office is full of visitors`);
    this.sessions.set(msg.sid, { sid: msg.sid, visitor: from.key, owner: owner.key, open: false, startedAt: Date.now(), http: new Map() });
    // `from` is who the relay authenticated, whatever the message said.
    owner.send({ t: 'visit.open', sid: msg.sid, from: from.login, version: msg.version, protocol: msg.protocol, profile: msg.profile });
  }

  accept(from: Peer, msg: Msg<'visit.accept'>) {
    const p = this.party(from, msg.sid);
    if (!p || !p.isOwner || p.s.open) return;
    p.s.open = true;
    if (!p.other?.send({ t: 'visit.accept', sid: msg.sid })) this.end(p.s, 'The visitor left', { owner: true });
  }

  /** Either party ends it (or the owner refuses it); the other hears why. */
  close(from: Peer, msg: Msg<'visit.close'>) {
    const p = this.party(from, msg.sid);
    if (!p) return;
    this.end(p.s, msg.reason, p.isOwner ? { visitor: true } : { owner: true });
  }

  /**
   * Frames only between the two parties of an accepted session. Returns whether it went (a backed-up
   * receiver drops it). `raw` is the text the sender's frame arrived as: the relay changes nothing
   * in a validated envelope (parseOfficeMsg only drops what it does not know), so that text goes on
   * as it is instead of being stringified again (the data in it is a whole message, up to 2 MB).
   */
  frame(from: Peer, msg: Msg<'visit.frame'>, raw?: string): boolean {
    const p = this.party(from, msg.sid);
    if (!p?.s.open || !p.other) return false;
    if (msg.drop) return p.other.send({ t: 'visit.frame', sid: msg.sid, data: msg.data, drop: true }, true, raw);
    // A frame that must arrive is never skipped, so a visit this far behind would only grow the
    // buffer: that visit ends (the visitor goes home and can visit again for a full resync). Only
    // this visit's own backlog counts; the other visits on the same link are not its business.
    if (p.other.queuedFor(msg.sid) > MP_HARD_CAP) {
      this.end(p.s, 'Connection too slow', { visitor: true, owner: true });
      return false;
    }
    return p.other.send({ t: 'visit.frame', sid: msg.sid, data: msg.data, ...(msg.part ? { part: msg.part } : {}) }, false, raw);
  }

  http(from: Peer, msg: Msg<'visit.http'>) {
    const p = this.party(from, msg.sid);
    if (!p?.s.open || p.isOwner || !p.other) return;
    const now = Date.now();
    for (const [rid, until] of p.s.http) if (until < now) p.s.http.delete(rid);
    if (p.s.http.size >= MAX_HTTP || p.s.http.has(msg.rid)) {
      from.send({ t: 'visit.httpres', sid: msg.sid, rid: msg.rid, status: 429, type: 'text/plain', body: '' });
      return;
    }
    p.s.http.set(msg.rid, now + HTTP_MS);
    p.other.send({ t: 'visit.http', sid: msg.sid, rid: msg.rid, path: msg.path });
  }

  /** Only an answer to a request the visitor made. */
  httpres(from: Peer, msg: Msg<'visit.httpres'>) {
    const p = this.party(from, msg.sid);
    if (!p?.s.open || !p.isOwner || !p.s.http.delete(msg.rid)) return;
    p.other?.send({ t: 'visit.httpres', sid: msg.sid, rid: msg.rid, status: msg.status, type: msg.type, body: msg.body });
  }

  probe(from: Peer, msg: Msg<'probe'>) {
    const owner = this.dir.get(msg.to);
    const key = owner && `${owner.key}|${msg.rid}`;
    const none = () => void from.send({ t: 'probe.res', rid: msg.rid, floors: [] });
    if (!owner || !key || owner === from || this.probes.has(key)) return none();
    let mine = 0;
    for (const pr of this.probes.values()) if (pr.visitor === from.key) mine++;
    if (mine >= MAX_PROBES) return none();
    this.probes.set(key, { visitor: from.key, owner: owner.key, until: Date.now() + PROBE_MS });
    owner.send({ t: 'probe', rid: msg.rid, from: from.login });
  }

  probeRes(from: Peer, msg: Msg<'probe.res'>) {
    const key = `${from.key}|${msg.rid}`;
    const pr = this.probes.get(key);
    if (!pr) return;
    this.probes.delete(key);
    this.dir.get(pr.visitor)?.send({ t: 'probe.res', rid: msg.rid, floors: msg.floors });
  }

  /** A link dropped (or was replaced): its visits end for the other side, its probes are forgotten. */
  dropPeer(peer: Peer) {
    for (const s of [...this.sessions.values()]) {
      if (s.visitor === peer.key) this.end(s, 'The visitor left', { owner: true });
      else if (s.owner === peer.key) this.end(s, 'The owner went offline', { visitor: true });
    }
    for (const [key, pr] of this.probes) {
      if (pr.owner === peer.key) {
        this.probes.delete(key);
        this.dir.get(pr.visitor)?.send({ t: 'probe.res', rid: key.slice(key.indexOf('|') + 1), floors: [] });
      } else if (pr.visitor === peer.key) this.probes.delete(key);
    }
  }

  /** Gives up on visits nobody answered and probes that never came back. */
  sweep(now = Date.now()) {
    for (const s of [...this.sessions.values()]) if (!s.open && now - s.startedAt > PENDING_OPEN_MS) this.end(s, 'No answer', { visitor: true, owner: true });
    for (const [key, pr] of this.probes) {
      if (pr.until > now) continue;
      this.probes.delete(key);
      this.dir.get(pr.visitor)?.send({ t: 'probe.res', rid: key.slice(key.indexOf('|') + 1), floors: [] });
    }
  }
}
