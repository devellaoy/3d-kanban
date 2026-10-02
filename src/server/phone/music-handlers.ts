// The phone's music over the wire (shared/phone/music.ts): the handlers around PhoneMusic (music.ts). Nothing here
// touches the floor's TV or jukebox; the browser ducks those on its own.
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { str } from '../office/input.js';
import type { FeatureHooks, HandlerMap } from '../ws/handlers/types.js';
import type { PhoneClientMsg } from '../../shared/phone/protocol.js';
import { youtubeTitle } from '../../shared/youtube/link.js';
import { lookUpYoutubeTitle } from '../youtube/titles.js';
import { PhoneMusic, type MusicChange } from './music.js';

const offices = new WeakMap<Ctx, PhoneMusic>();
const musicOf = (ctx: Ctx): PhoneMusic => offices.get(ctx) ?? (offices.set(ctx, new PhoneMusic()), offices.get(ctx)!);

/** How often people may play: to the same person, and overall (queue adds too, which also bounds the title lookups). Tests swap `now`. */
export const musicLimits = { now: () => Date.now(), pairMs: 5000, max: 10, windowMs: 30_000 };

interface Played {
  /** When each recent play went (inside the window). */
  recent: number[];
  /** When each person was last played to by this client. */
  to: Map<string, number>;
}
const playedIn = new WeakMap<Ctx, Map<string, Played>>();
const playedOf = (ctx: Ctx) => playedIn.get(ctx) ?? (playedIn.set(ctx, new Map()), playedIn.get(ctx)!);

/** Says why this play is too soon, or notes it. A play to someone else starts their music, so the same person is spared more than a queue add. */
function tooSoon(ctx: Ctx, c: Client, to: Client | undefined, queue: boolean): string | undefined {
  const now = musicLimits.now();
  const played = playedOf(ctx);
  let p = played.get(c.id);
  if (!p) played.set(c.id, (p = { recent: [], to: new Map() }));
  p.recent = p.recent.filter((t) => now - t < musicLimits.windowMs);
  for (const [id, t] of p.to) if (now - t >= musicLimits.pairMs) p.to.delete(id);
  if (p.recent.length >= musicLimits.max) return 'Slow down: you have played a lot of music just now';
  if (to && !queue && p.to.has(to.id)) return `Wait a moment before playing to ${to.peer.name} again`;
  p.recent.push(now);
  if (to && !queue) p.to.set(to.id, now);
  return undefined;
}

/** One pending title notification per session. */
const timers = new Map<string, NodeJS.Timeout>();

const listener = (c: Client) => ({ id: c.id, name: c.peer.name });

/** Tells each affected session's listeners its state, and those who are out of any, none. */
function notify(ctx: Ctx, m: PhoneMusic, change: MusicChange, look = false) {
  for (const session of change.sessions) {
    const music = m.stateOf(session);
    for (const l of m.listeners(session)) {
      const c = ctx.clients.get(l.id);
      if (c) ctx.sendTo(c, { t: 'phone.music', music });
    }
    if (look) titles(ctx, m, session);
  }
  for (const id of change.gone) {
    const c = ctx.clients.get(id);
    if (c && !m.sessionOf(id)) ctx.sendTo(c, { t: 'phone.music', music: null });
  }
}

/** Drops the pending title notification of a session that ended. */
function dropTimer(m: PhoneMusic, session: string | undefined) {
  if (!session || m.stateOf(session)) return;
  clearTimeout(timers.get(session));
  timers.delete(session);
}

/**
 * Looks up what a session shows without a title and tells its listeners once they are known: one notification per
 * session, bunched over 300 ms as the TV's. Called only after a change that can add something untitled. (youtubeTitles
 * is cached by URL in lookUpYoutubeTitle, so a link seen before costs no request.)
 */
function titles(ctx: Ctx, m: PhoneMusic, session: string) {
  const todo = m.untitled(session);
  const tell = () => {
    if (timers.has(session)) return;
    const timer = setTimeout(() => {
      timers.delete(session);
      notify(ctx, m, { sessions: [session], gone: [] });
    }, 300);
    timer.unref?.();
    timers.set(session, timer);
  };
  if (todo.play) {
    const p = todo.play;
    void lookUpYoutubeTitle(p.url).then((title) => {
      if (title && m.titled(session, p.id, title)) tell();
    });
  }
  for (const i of todo.queued) {
    void lookUpYoutubeTitle(i.url).then((title) => {
      if (title && m.titledQueued(session, i.qid, title)) tell();
    });
  }
}

export const musicHandlers = {
  'phone.music.play'(ctx, c, msg) {
    const m = musicOf(ctx);
    let to: Client | undefined;
    if (msg.to !== undefined) {
      to = ctx.clients.get(str(msg.to, 128));
      if (!to || to.visitor || to.out) return ctx.warn(c, 'That person is not here to play music to');
      if (to.peer.lite) return ctx.warn(c, `${to.peer.name} is on the 2D view and can't hear music`);
    }
    const queue = msg.queue === 'end' || msg.queue === 'next' ? msg.queue : undefined;
    const slow = tooSoon(ctx, c, to && to !== c ? to : undefined, !!queue);
    if (slow) return ctx.warn(c, slow);
    const r = m.play(listener(c), msg.url, to && to !== c ? listener(to) : undefined, queue);
    if ('error' in r) return ctx.warn(c, r.error);
    notify(ctx, m, r.change, true);
    if (!to || to === c || r.queued) return;
    const show = (title: string) => {
      const now = m.stateOf(r.session);
      if (now?.state?.id === r.state.id && ctx.clients.get(to!.id)) ctx.sendTo(to!, { t: 'toast', text: `🎵 ${c.peer.name} is playing you “${title}”`, level: 'info' });
    };
    if (r.state.title) show(r.state.title);
    else void lookUpYoutubeTitle(r.state.url).then((title) => show(title ?? youtubeTitle(r.state)));
  },
  'phone.music.control'(ctx, c, msg) {
    const m = musicOf(ctx);
    if (!msg.control || typeof msg.control !== 'object') return;
    const was = m.sessionOf(c.id);
    const change = m.control(c.id, msg.control);
    dropTimer(m, was);
    // Only these can bring in something untitled (the next of the queue, or a jump to a queued one).
    if (change) notify(ctx, m, change, ['tv.youtube.skip', 'tv.youtube.ended', 'tv.youtube.queue.jump'].includes(msg.control.t));
    else if (!m.sessionOf(c.id)) ctx.sendTo(c, { t: 'phone.music', music: null }); // a client that lost its session (reconnected) can always recover
  },
  'phone.music.leave'(ctx, c) {
    const m = musicOf(ctx);
    const was = m.sessionOf(c.id);
    const change = m.leave(c.id);
    dropTimer(m, was);
    if (change) notify(ctx, m, change);
    else if (!m.sessionOf(c.id)) ctx.sendTo(c, { t: 'phone.music', music: null });
  },
} satisfies HandlerMap<Extract<PhoneClientMsg, { t: `phone.music.${string}` }>>;

export const musicHooks: FeatureHooks = {
  closed(ctx, c) {
    const m = offices.get(ctx);
    playedIn.get(ctx)?.delete(c.id);
    const was = m?.sessionOf(c.id);
    const change = m?.leave(c.id);
    if (m) dropTimer(m, was);
    if (m && change) notify(ctx, m, change);
  },
};
