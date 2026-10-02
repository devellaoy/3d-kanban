// A visitor's browser as the owner's office sees it: not a socket of its own, but frames the relay
// carries. It has exactly the members of `ws`'s WebSocket the office uses on a client's `ws`
// (send, readyState, bufferedAmount, ping, terminate, close and on/once for message, pong, close,
// error), so a visitor goes through the same connection code as anyone, and everything the office
// sends them passes `filterForVisitor` on the way out (deny by default, see shared/multiplayer).
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { filterForVisitor, type VisitorScope } from '../../shared/multiplayer/allow.js';
import type { FilterCtx } from '../../shared/multiplayer/filter.js';
import { serverFrameDroppable } from '../../shared/multiplayer/droppable.js';
import type { ServerMsg } from '../../shared/protocol.js';

/** ws's readyState numbers. */
const OPEN = 1;
const CLOSED = 3;

export interface RemoteSocketLink {
  /** Sends one visit.frame (text) to the visitor's office; a `drop` one is skipped (false) when the link is backed up. */
  frame(data: string, drop?: boolean): boolean;
  /** Whether the link to the relay is up (a synthetic pong needs one). */
  up(): boolean;
  /** How much the link has queued, so droppable frames (cursors, terminal output) are skipped when it is a lot. */
  bufferedAmount(): number;
  /** The visitor is going: tell the other side, with a reason it can show. */
  closed(reason: string): void;
}

export class RemoteSocket extends EventEmitter {
  readyState = OPEN;

  constructor(
    private link: RemoteSocketLink,
    private scope: VisitorScope,
    private lookups: FilterCtx,
  ) {
    super();
  }

  get bufferedAmount(): number {
    return this.link.bufferedAmount();
  }

  /** The office sends text (JSON.stringify of a ServerMsg); each one is filtered before it leaves. */
  send(data: unknown): void {
    if (this.readyState !== OPEN || typeof data !== 'string') return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data) as ServerMsg;
    } catch {
      return;
    }
    const out = filterForVisitor(msg, this.scope, this.lookups);
    if (!out) return;
    // Unchanged frames keep their text; rewritten ones are sent as rewritten.
    const text = out === msg ? data : JSON.stringify(out);
    this.link.frame(text, serverFrameDroppable(text));
  }

  /** The heartbeat's ping: the relay link has its own, so this answers for the visitor while the link is up. */
  ping(): void {
    if (this.readyState === OPEN && this.link.up()) setImmediate(() => this.emit('pong'));
  }

  /** A frame from the visitor's browser (parsing is the connection code's job, as with a real socket). */
  receive(data: string) {
    if (this.readyState === OPEN) this.emit('message', data);
  }

  close(_code?: number, reason?: string): void {
    this.end(typeof reason === 'string' && reason ? reason : 'The visit ended', true);
  }

  terminate(): void {
    this.end('The visit ended', true);
  }

  /** The visit is over (`notify`: we say so; otherwise the other side already did). Idempotent. */
  end(reason: string, notify: boolean) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (notify) this.link.closed(reason);
    this.emit('close', 1000, Buffer.from(reason));
  }

  /** For the one place that hands this to code typed against ws's WebSocket (Client.ws). */
  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}
