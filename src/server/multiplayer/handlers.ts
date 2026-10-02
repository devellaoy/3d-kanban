// The browser's multiplayer messages. Placeholders until the office's link to the relay exists
// (link.ts, identity.ts, access.ts): they only say so. Replace the bodies, keep the `satisfies`.
import type { MpClientMsg } from '../../shared/multiplayer/protocol.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import type { HandlerMap } from '../ws/handlers/types.js';

const notYet = (ctx: Ctx, c: Client) => ctx.warn(c, 'Multiplayer is not set up yet');

export const mpHandlers = {
  'mp.connect': notYet,
  'mp.disconnect': notYet,
  'mp.identity.start': notYet,
  'mp.identity.cancel': notYet,
  'mp.share': notYet,
  'mp.watch': notYet,
  'mp.unwatch': notYet,
  'mp.probe': notYet,
} satisfies HandlerMap<MpClientMsg>;
