// Where the Multiplayer service of an office is kept. A module of its own so the WebSocket handler
// map (ws/handlers/index.ts) can reach it without importing the service, which imports the
// connection code, which imports the handler map.
import type { Ctx } from '../office/context.js';
import type { Multiplayer } from './index.js';

const services = new WeakMap<Ctx, Multiplayer>();

export const mpOf = (ctx: Ctx): Multiplayer | undefined => services.get(ctx);
export const setMp = (ctx: Ctx, mp: Multiplayer | undefined) => void (mp ? services.set(ctx, mp) : services.delete(ctx));
