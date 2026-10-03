// People in the office: walking about, reaching for things, sitting, carrying issue cards, emotes,
// their name and look, what they have open, voice and screen sharing, and chat.
import type { ChatLine, PresenceClientMsg } from '../../../shared/protocol.js';
import { removedPlaces } from '../../../shared/arrange.js';
import { seatHereOn } from '../../../shared/maps/index.js';
import { sanitizeLook } from '../../../shared/avatar.js';
import { isEmote } from '../../../shared/emotes.js';
import { ROOF, isDrink } from '../../../shared/rooftop.js';
import { isBarGame } from '../../../shared/bargames.js';
import { throttle } from '../../office/client.js';
import { COLOR_RE, issueNumber, num, str } from '../../office/input.js';
import { isLoungeSeat } from '../../../shared/kanban/lounge.js';
import type { HandlerMap } from './types.js';

export const presenceHandlers = {
  move(ctx, c, msg) {
    const p = c.peer;
    p.x = num(msg.x);
    p.y = num(msg.y);
    p.z = num(msg.z);
    p.rotY = num(msg.rotY);
    p.moving = !!msg.moving;
    ctx.toNeighbors(c, { t: 'peer.move', id: c.id, x: p.x, y: p.y, z: p.z, rotY: p.rotY, moving: p.moving }, true);
  },
  act(ctx, c, msg) {
    if (msg.drink !== undefined) {
      // A drink from the rooftop bar, which stays up there.
      const drink = isDrink(msg.drink) && c.peer.floor === ROOF ? msg.drink : undefined;
      if (drink === c.peer.drink) return;
      if (drink) c.peer.drink = drink;
      else delete c.peer.drink;
      ctx.broadcast({ t: 'peer.act', id: c.id, drink: drink ?? null }, c.id, true);
      return;
    }
    if (typeof msg.smoke === 'boolean') {
      if (msg.smoke === !!c.peer.smoking) return;
      c.peer.smoking = msg.smoke;
      ctx.broadcast({ t: 'peer.act', id: c.id, smoke: msg.smoke }, c.id, true);
      return;
    }
    if (typeof msg.golf === 'boolean') {
      // The tee's on an office floor's balcony; there's none up on the roof.
      const golf = msg.golf && c.peer.floor !== ROOF;
      if (golf === !!c.peer.golfing) return;
      if (golf) c.peer.golfing = true;
      else delete c.peer.golfing;
      ctx.broadcast({ t: 'peer.act', id: c.id, golf }, c.id, true);
      return;
    }
    if (msg.throwing !== undefined) {
      // The dart board and the axe lane are up on the roof.
      const game = isBarGame(msg.throwing) && c.peer.floor === ROOF ? msg.throwing : undefined;
      if (game === c.peer.throwing) return;
      if (game) c.peer.throwing = game;
      else delete c.peer.throwing;
      ctx.broadcast({ t: 'peer.act', id: c.id, throwing: game ?? null }, c.id, true);
      return;
    }
    if (!throttle(c, 'act', 100)) return;
    ctx.toNeighbors(c, { t: 'peer.act', id: c.id }, true);
  },
  emote(ctx, c, msg) {
    if (isEmote(msg.emote) && c.emotes.take(Date.now())) ctx.toNeighbors(c, { t: 'peer.emote', id: c.id, emote: msg.emote }, true);
  },
  sit(ctx, c, msg) {
    // Everyone sees them sit down (or get up), and anyone who comes in later finds them sitting.
    // Only on a seat where they are: the roof's up on the roof, the office's on a floor.
    const key = str(msg.seat, 40);
    const seat = seatHereOn(ctx.maps.plan(), key, c.peer.floor === ROOF) && !removedPlaces(ctx.floorOf(c)?.plan.furniture).includes(key) ? key : undefined; // not on a couch the floor has taken out
    if (seat === c.peer.seat) return;
    // Somebody on the floor got there first (two people arriving at an empty throne at once).
    // (Not yourself, on a connection that hasn't timed out yet after a reconnect.)
    const same = (o: typeof c) => o.peer.name === c.peer.name || (!!o.accountId && o.accountId === c.accountId);
    const there = seat && [...ctx.clients.values()].find((o) => o !== c && !same(o) && o.peer.seat === seat && o.peer.floor === c.peer.floor);
    if (there) {
      ctx.sendTo(c, { t: 'sit.refused', seat: key, by: there.peer.name });
      return;
    }
    // A task on hold's figure sits there (the kanban's lounge, on the office's own map): placed around
    // everyone else's seats, as every browser on the floor places it. Only the lounge's few seats are ever a figure's.
    if (seat && isLoungeSeat(seat) && c.peer.floor && c.peer.floor !== ROOF && ctx.maps.plan().style === 'office') {
      const others = new Set([...ctx.clients.values()].flatMap((o) => (o !== c && o.peer.floor === c.peer.floor && o.peer.seat ? [o.peer.seat] : [])));
      for (const k of removedPlaces(ctx.floorOf(c)?.plan.furniture)) others.add(k); // what the floor has taken out has no places
      const figure = ctx.kanban?.loungeSeat(c.peer.floor, seat, others);
      if (figure) {
        ctx.sendTo(c, { t: 'sit.refused', seat: key, by: `${figure.name} (task #${figure.taskId}, on hold)` });
        return;
      }
    }
    if (seat) c.peer.seat = seat;
    else delete c.peer.seat;
    ctx.broadcast({ t: 'peer.update', peer: c.peer }, c.id);
  },
  carry(ctx, c, msg) {
    // Everyone on the floor sees the issue card in their hands, and whoever comes in later too.
    const issue = issueNumber(msg.issue);
    // A card from the project's issue sources has its key (and no number unless it's the floor's own issue).
    const key = ctx.floorOf(c)?.cardKey(msg.issueKey);
    if (issue === c.peer.carrying?.issue && key === c.peer.carrying?.key) return;
    if (issue !== undefined || key) c.peer.carrying = { issue: issue ?? 0, title: str(msg.title, 200), ...(key ? { key } : {}) };
    else delete c.peer.carrying;
    ctx.broadcast({ t: 'peer.update', peer: c.peer }, c.id);
  },
  profile(ctx, c, msg) {
    const name = str(msg.name, 24).trim();
    // A visitor is always @login.
    if (name && !c.accountId && !c.visitor) c.peer.name = name;
    if (COLOR_RE.test(msg.color)) c.peer.color = msg.color;
    c.peer.look = sanitizeLook(msg.look, c.peer.look);
    ctx.broadcast({ t: 'peer.update', peer: c.peer });
  },
  voice(ctx, c, msg) {
    c.peer.voice = !!msg.voice;
    c.peer.muted = !!msg.muted;
    c.peer.sharing = !!msg.sharing;
    ctx.broadcast({ t: 'peer.update', peer: c.peer });
  },
  rtc(ctx, c, msg) {
    const target = ctx.clients.get(str(msg.to, 32));
    // A visitor talks to people on floors they may see, up on the roof (open to them) and to other
    // visitors, not to the rest of the owner's office (the lobby, the floors that are not shared).
    if (target && c.visitor && !target.visitor && target.peer.floor !== ROOF && !c.visitor.floors.has(target.peer.floor ?? '')) return;
    if (target) ctx.sendTo(target, { t: 'rtc', from: c.id, data: msg.data });
  },
  chat(ctx, c, msg) {
    const who = c.peer.name;
    const text = str(msg.text, 500).trim();
    if (!text) return;
    const line: ChatLine = { from: c.id, name: who, color: c.peer.color, text, at: Date.now(), ...(c.accountId ? { account: true } : {}) };
    ctx.chat.add(line);
    ctx.broadcast({ t: 'chat', ...line });
  },
  doing(ctx, c, msg) {
    const what = str(msg.what, 60).trim() || undefined;
    const reading = msg.reading === true || undefined;
    if (what === c.peer.doing && reading === c.peer.reading) return;
    if (what) c.peer.doing = what;
    else delete c.peer.doing;
    if (reading) c.peer.reading = true;
    else delete c.peer.reading;
    ctx.broadcast({ t: 'peer.update', peer: c.peer });
  },
  ping(ctx, c, msg) {
    ctx.sendTo(c, { t: 'pong', at: num(msg.at), now: Date.now() });
  },
} satisfies HandlerMap<PresenceClientMsg>;
