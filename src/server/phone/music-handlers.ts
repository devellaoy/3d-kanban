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

const listener = (c: Client) => ({ id: c.id, name: c.peer.name });

/** Tells each affected session's listeners its state, and those who are out of any, none. */
function notify(ctx: Ctx, m: PhoneMusic, change: MusicChange) {
  for (const session of change.sessions) {
    const music = m.stateOf(session);
    for (const l of m.listeners(session)) {
      const c = ctx.clients.get(l.id);
      if (c) ctx.sendTo(c, { t: 'phone.music', music });
    }
    titles(ctx, m, session);
  }
  for (const id of change.gone) {
    const c = ctx.clients.get(id);
    if (c && !m.sessionOf(id)) ctx.sendTo(c, { t: 'phone.music', music: null });
  }
}

/** Looks up what a session shows without a title and tells its listeners once they are known (bunched, as the TV's). */
function titles(ctx: Ctx, m: PhoneMusic, session: string) {
  const todo = m.untitled(session);
  let timer: NodeJS.Timeout | undefined;
  const tell = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      notify(ctx, m, { sessions: [session], gone: [] });
    }, 300);
    timer.unref?.();
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
    const r = m.play(listener(c), msg.url, to && to !== c ? listener(to) : undefined, queue);
    if ('error' in r) return ctx.warn(c, r.error);
    notify(ctx, m, r.change);
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
    const change = m.control(c.id, msg.control);
    if (change) notify(ctx, m, change);
    else if (!m.sessionOf(c.id)) ctx.sendTo(c, { t: 'phone.music', music: null }); // a client that lost its session (reconnected) can always recover
  },
  'phone.music.leave'(ctx, c) {
    const m = musicOf(ctx);
    const change = m.leave(c.id);
    if (change) notify(ctx, m, change);
    else if (!m.sessionOf(c.id)) ctx.sendTo(c, { t: 'phone.music', music: null });
  },
} satisfies HandlerMap<Extract<PhoneClientMsg, { t: `phone.music.${string}` }>>;

export const musicHooks: FeatureHooks = {
  closed(ctx, c) {
    const m = offices.get(ctx);
    const change = m?.leave(c.id);
    if (m && change) notify(ctx, m, change);
  },
};
