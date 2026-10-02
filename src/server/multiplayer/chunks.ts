// Messages over MP_FRAME_MAX (a floor's whiteboard rides in a welcome or floor.enter and can be
// 16 MB) cross the relay as several `visit.frame` pieces, because the relay refuses a frame's data
// over that. The sender splits, the receiving office puts them back together; the relay in between
// only checks each piece and passes it on.
import { MP_FRAME_MAX, MP_MESSAGE_MAX, MP_PARTIALS_MAX, MP_TOO_LARGE, type MpFramePart } from '../../shared/multiplayer/wire.js';
import { randomBytes } from 'node:crypto';

export interface Piece {
  data: string;
  part: MpFramePart;
}

/** The pieces of `data` in order, or undefined when it is over MP_MESSAGE_MAX (the caller ends the visit). */
export function splitFrame(data: string): Piece[] | undefined {
  if (data.length > MP_MESSAGE_MAX) return undefined;
  const n = Math.ceil(data.length / MP_FRAME_MAX);
  const id = randomBytes(9).toString('base64url');
  return Array.from({ length: n }, (_, i) => ({ data: data.slice(i * MP_FRAME_MAX, (i + 1) * MP_FRAME_MAX), part: { id, i, n } }));
}

interface Partial {
  id: string;
  n: number;
  parts: string[];
  size: number;
}

/**
 * Collects the pieces of one message per visit. The other office sends a message's pieces one
 * straight after the other, so a piece out of order, from another message, or past the size
 * limit is a broken (or hostile) peer: `error` says why and the visit is to end.
 */
export class Reassembler {
  private partial = new Map<string, Partial>();

  push(sid: string, data: string, part: MpFramePart): { data: string } | { error: string } | undefined {
    let p = this.partial.get(sid);
    if (part.i === 0) {
      if (p) return this.fail(sid, 'The other office sent a broken message');
      // Each half-received message can weigh MP_MESSAGE_MAX, so only a few at a time.
      if (this.partial.size >= MP_PARTIALS_MAX) return this.fail(sid, MP_TOO_LARGE);
      p = { id: part.id, n: part.n, parts: [], size: 0 };
      this.partial.set(sid, p);
    }
    if (!p || p.id !== part.id || p.n !== part.n || p.parts.length !== part.i) return this.fail(sid, 'The other office sent a broken message');
    p.size += data.length;
    if (p.size > MP_MESSAGE_MAX) return this.fail(sid, MP_TOO_LARGE);
    p.parts.push(data);
    if (p.parts.length < p.n) return undefined;
    this.partial.delete(sid);
    return { data: p.parts.join('') };
  }

  private fail(sid: string, error: string) {
    this.partial.delete(sid);
    return { error };
  }

  drop(sid: string) {
    this.partial.delete(sid);
  }

  clear() {
    this.partial.clear();
  }
}
