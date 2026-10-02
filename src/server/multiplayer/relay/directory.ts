// The relay's directory: one connected office per GitHub login, and where its owner is now.
import type { WebSocket } from 'ws';
import { MP_HIGH_WATER, loginKey, type MpWhere, type MpWirePlayer, type RelayToOffice } from '../../../shared/multiplayer/wire.js';

/** A connected, authenticated office. */
export class Peer {
  where: MpWhere = 'home';
  floorKey?: string;
  /** Replaced by a newer connection or closed: nothing is routed to it any more. */
  dead = false;
  readonly key: string;

  constructor(
    readonly login: string,
    readonly name: string | undefined,
    readonly ws: WebSocket,
  ) {
    this.key = loginKey(login);
  }

  /** Characters of visit.frame text queued per visit sid, until the socket has taken them. */
  private queued = new Map<string, number>();

  /** What is queued for one visit: congestion is judged per visit, since one link carries all of an office's visits. */
  queuedFor(sid: string): number {
    return this.queued.get(sid) ?? 0;
  }

  /**
   * Sends a message; a `droppable` one is skipped while this receiver is backed up (for a
   * visit.frame: while that visit is). Returns whether it went. `text` is the message already
   * serialized, when the caller has the exact text to pass on.
   */
  send(msg: RelayToOffice, droppable = false, text?: string): boolean {
    if (this.dead || this.ws.readyState !== this.ws.OPEN) return false;
    const sid = msg.t === 'visit.frame' ? msg.sid : undefined;
    if (droppable && (sid === undefined ? this.ws.bufferedAmount : this.queuedFor(sid)) > MP_HIGH_WATER) return false;
    const out = text ?? JSON.stringify(msg);
    if (sid === undefined) {
      this.ws.send(out);
      return true;
    }
    this.queued.set(sid, this.queuedFor(sid) + out.length);
    this.ws.send(out, () => {
      const left = this.queuedFor(sid) - out.length;
      if (left > 0) this.queued.set(sid, left);
      else this.queued.delete(sid);
    });
    return true;
  }
}

export class Directory {
  private peers = new Map<string, Peer>();

  get size(): number {
    return this.peers.size;
  }

  get(login: string): Peer | undefined {
    return this.peers.get(loginKey(login));
  }

  /** Adds `peer`; the office it replaces, if any, is returned (the caller closes it). */
  add(peer: Peer): Peer | undefined {
    const old = this.peers.get(peer.key);
    this.peers.set(peer.key, peer);
    return old;
  }

  /** Removes `peer` unless a newer connection of the same login already took its place. */
  remove(peer: Peer): boolean {
    if (this.peers.get(peer.key) !== peer) return false;
    this.peers.delete(peer.key);
    return true;
  }

  all(): IterableIterator<Peer> {
    return this.peers.values();
  }

  /** The rows every office is sent. */
  list(): MpWirePlayer[] {
    return [...this.peers.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((p) => ({ login: p.login, ...(p.name ? { name: p.name } : {}), online: true as const, where: p.where, ...(p.floorKey ? { floorKey: p.floorKey } : {}) }));
  }
}
