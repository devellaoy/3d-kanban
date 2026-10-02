// The phone's music sessions, pure of the office: who listens to which YouTube session, and its TV-like
// playback (a YoutubeTv kept in memory). The handlers (music-handlers.ts) tell people what changed.
import { randomUUID } from 'node:crypto';
import type { PhoneListener, PhoneMusicControl, PhoneMusicState } from '../../shared/phone/music.js';
import type { YoutubeTvState } from '../../shared/youtube/link.js';
import { YoutubeTv } from '../youtube/tv.js';

interface Session {
  id: string;
  by: string;
  tv: YoutubeTv;
  listeners: PhoneListener[];
  /** Play ids and queue ids whose title was already asked for. */
  asked: Set<string>;
}

/** What a change touched: sessions whose listeners need the state again, and people who are out of any session now. */
export interface MusicChange {
  sessions: string[];
  /** Listeners (by id) who left or were moved out, or whose session ended, and are in no session now. */
  gone: string[];
}

export type MusicPlay = { error: string } | { change: MusicChange; session: string; state: YoutubeTvState; queued?: { qid: string }; started?: true };

export class PhoneMusic {
  private readonly sessions = new Map<string, Session>();
  private readonly of = new Map<string, string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** The session this person listens to. */
  sessionOf(clientId: string): string | undefined {
    return this.of.get(clientId);
  }

  listeners(session: string): PhoneListener[] {
    return [...(this.sessions.get(session)?.listeners ?? [])];
  }

  stateOf(session: string): PhoneMusicState | null {
    const s = this.sessions.get(session);
    if (!s) return null;
    return { session: s.id, by: s.by, listeners: [...s.listeners], state: s.tv.state(), list: s.tv.list() };
  }

  /**
   * `from` puts `url` on. Without `queue` a new session starts with `from` (and `to`, if someone else), each leaving the one
   * they were in. With `queue` it goes into from's session's queue, but only when that session is the one for the
   * listeners asked for (`from` alone, or `from` and `to`): a song queued for yourself never plays to whoever you're
   * listening with, nor one meant for Cy to the two of you. Without a session it starts one for them, as a play does.
   */
  play(from: PhoneListener, url: unknown, to?: PhoneListener, queue?: 'end' | 'next'): MusicPlay {
    const mine = this.of.get(from.id);
    if (queue && mine) {
      const s = this.sessions.get(mine)!;
      const others = s.listeners.filter((l) => l.id !== from.id);
      const wanted = to && to.id !== from.id ? to : undefined;
      if (wanted ? others.length !== 1 || others[0].id !== wanted.id : others.length > 0) {
        const now = others.map((l) => l.name).join(' and ');
        if (!wanted) return { error: `Your music is shared with ${now}: ▶ Play starts some just for you` };
        return { error: `${now ? `You're listening with ${now}, not ${wanted.name}` : 'Your music is just yours'}: ▶ Play starts music for you and ${wanted.name}` };
      }
      const r = s.tv.play(url, from.name, queue);
      if ('error' in r) return r;
      return { change: { sessions: [s.id], gone: [] }, session: s.id, state: r.state, ...(r.queued ? { queued: r.queued } : {}), ...(r.started ? { started: true as const } : {}) };
    }
    const tv = new YoutubeTv(null, this.now, this.newId);
    const r = tv.play(url, from.name, queue);
    if ('error' in r) return r;
    const people = to && to.id !== from.id ? [from, to] : [from];
    const change: MusicChange = { sessions: [], gone: [] };
    for (const p of people) this.out(p.id, change);
    const id = this.newId();
    this.sessions.set(id, { id, by: from.name, tv, listeners: people.map((p) => ({ ...p })), asked: new Set() });
    for (const p of people) this.of.set(p.id, id);
    change.sessions.push(id);
    change.gone = change.gone.filter((g) => !this.of.has(g));
    return { change, session: id, state: r.state, ...(r.queued ? { queued: r.queued } : {}) };
  }

  /** One of the TV's controls, for the client's session. Null when they have none, or it changed nothing. */
  control(clientId: string, msg: PhoneMusicControl): MusicChange | null {
    const s = this.sessions.get(this.of.get(clientId) ?? '');
    if (!s) return null;
    const tv = s.tv;
    let done: boolean;
    switch (msg.t) {
      case 'tv.youtube.pause':
        done = tv.pause(msg.id, msg.paused, this.nameOf(s, clientId));
        break;
      case 'tv.youtube.seek':
        done = tv.seek(msg.id, msg.to, msg.by);
        break;
      case 'tv.youtube.rate':
        done = tv.rate(msg.id, msg.rate);
        break;
      case 'tv.youtube.skip':
        done = tv.skip(msg.id, msg.dir) !== null;
        break;
      case 'tv.youtube.ended':
        done = tv.ended(msg.id, msg.next === true, typeof msg.blocked === 'number') !== null;
        break;
      case 'tv.youtube.info':
        done = tv.info(msg.id, msg.duration, msg.listLength);
        break;
      case 'tv.youtube.queue.move':
        done = tv.move(msg.qid, msg.to);
        break;
      case 'tv.youtube.queue.remove':
        done = tv.remove(msg.qid) !== undefined;
        break;
      case 'tv.youtube.queue.jump':
        done = tv.jump(msg.qid);
        break;
      case 'tv.youtube.queue.clear':
        done = tv.clear();
        break;
      default:
        return null;
    }
    if (!done) return null;
    if (!tv.state()) return this.end(s);
    return { sessions: [s.id], gone: [] };
  }

  /** Out of their session (it ends once nobody's left). Null when they were in none. */
  leave(clientId: string): MusicChange | null {
    const change: MusicChange = { sessions: [], gone: [] };
    return this.out(clientId, change) ? change : null;
  }

  /** The title YouTube gave the play `id` of a session; says whether it's still that play. */
  titled(session: string, id: string, title: string): boolean {
    return this.sessions.get(session)?.tv.titled(id, title) ?? false;
  }

  titledQueued(session: string, qid: string, title: string): boolean {
    return this.sessions.get(session)?.tv.titledQueued(qid, title) ?? false;
  }

  /** What of a session still has no title and wasn't asked about yet (each is given once). */
  untitled(session: string): { play?: { id: string; url: string }; queued: { qid: string; url: string }[] } {
    const s = this.sessions.get(session);
    const out: { play?: { id: string; url: string }; queued: { qid: string; url: string }[] } = { queued: [] };
    if (!s) return out;
    const st = s.tv.state();
    if (st && !st.title && !s.asked.has(st.id)) {
      s.asked.add(st.id);
      out.play = { id: st.id, url: st.url };
    }
    for (const i of s.tv.list().queue) {
      if (i.title || s.asked.has(i.qid)) continue;
      s.asked.add(i.qid);
      out.queued.push({ qid: i.qid, url: i.url });
    }
    return out;
  }

  private nameOf(s: Session, clientId: string): string {
    return s.listeners.find((l) => l.id === clientId)?.name ?? s.by;
  }

  /** Takes `clientId` out of its session; says whether it was in one. */
  private out(clientId: string, change: MusicChange): boolean {
    const id = this.of.get(clientId);
    const s = id && this.sessions.get(id);
    if (!s) return false;
    this.of.delete(clientId);
    s.listeners = s.listeners.filter((l) => l.id !== clientId);
    change.gone.push(clientId);
    if (s.listeners.length) change.sessions.push(s.id);
    else this.sessions.delete(s.id);
    return true;
  }

  private end(s: Session): MusicChange {
    this.sessions.delete(s.id);
    for (const l of s.listeners) this.of.delete(l.id);
    return { sessions: [], gone: s.listeners.map((l) => l.id) };
  }
}
