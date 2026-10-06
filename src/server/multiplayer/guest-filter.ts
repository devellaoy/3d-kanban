// What the visitor's own browser accepts from another office. The owner's office filters what it
// sends (shared/multiplayer/filter.ts), but a modified or hostile owner sends whatever it likes, and
// the browser would act on it as on its own office's word: a `me` that makes it admin, `mp.*`
// that ends or fakes a visit, sign-in, account, invite, settings, secrets or upgrade frames.
// So the frame types a visitor may get are checked again here, on this office's side.
import { typeOf } from '../../shared/multiplayer/droppable.js';
import { SERVER_MSG_OUT } from '../../shared/multiplayer/allow.js';

/** Types (exact, or by prefix) a visitor's browser never gets, whatever the owner's table says. */
const DENY_PREFIX = ['mp.', 'signins', 'upgrade', 'codex-limits', 'kanban.secrets'];
const DENY = new Set(['me', 'accounts', 'invites', 'team', 'usage', 'limits', 'projectsDir', 'prompts', 'notify', 'machine', 'kanban.settings', 'leaveOnMerge', 'carryOn', 'services']);

/** Whether a frame type may reach a visitor's browser: one the owner's filter can send at all, and not a denied one. */
export function visitorMayGet(t: unknown): boolean {
  if (typeof t !== 'string' || DENY.has(t) || DENY_PREFIX.some((p) => t.startsWith(p))) return false;
  return Object.hasOwn(SERVER_MSG_OUT, t) && (SERVER_MSG_OUT as Record<string, string>)[t] !== 'drop';
}

/** A second "t" key anywhere after the first (JSON takes the last one, so the front one cannot be trusted). */
const ANOTHER_T = /"t"\s*:/;

/**
 * The text to hand the browser for a frame from the owner's office, or undefined to drop it. The
 * type is read off the front without parsing when that is safe (no other "t" key in the text, which
 * a string value cannot contain unescaped); otherwise, and for the welcome (whose `me` is
 * rewritten to a visitor's), the frame is parsed. Anything that is not a JSON object is dropped.
 */
export function frameForBrowser(text: string): string | undefined {
  const front = typeOf(text);
  if (front !== 'welcome' && front !== undefined && !ANOTHER_T.test(text.slice(5))) return visitorMayGet(front) ? text : undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return undefined;
  const t = (msg as { t?: unknown }).t;
  if (!visitorMayGet(t)) return undefined;
  if (t !== 'welcome') return text;
  // The owner's welcome says who the visitor is there; in their own browser they are a visitor, whatever it claims.
  return JSON.stringify({ ...msg, me: { admin: false, visitor: true } });
}
