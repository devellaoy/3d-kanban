// Which browser frames a congested link may drop: only the high-rate ephemeral streams, each of
// which is superseded by the next one. Everything else (welcome, floor.enter, chat, whiteboard
// elements, signalling) must arrive or the visit would be out of step, so a link too slow for those
// ends the visit instead (see the relay's Sessions.frame).

/** Office → visitor: positions, cursors and pictures that the next frame replaces. */
const SERVER_DROPPABLE: ReadonlySet<string> = new Set(['peer.move', 'peer.act', 'peer.emote', 'car.move', 'cabinet.frame', 'screen', 'wb.pointer']);
/** Visitor → office: the same kind, going the other way. */
const CLIENT_DROPPABLE: ReadonlySet<string> = new Set(['move', 'wb.pointer', 'car.drive', 'cabinet.frame']);

/** The `t` at the front of a frame's JSON (every message is built with `t` first); undefined when it is not there. */
export function typeOf(text: string): string | undefined {
  return /^\{"t":"([\w.]+)"/.exec(text)?.[1];
}

/** Whether a frame the office sends to a visitor may be dropped when the link is backed up. */
export const serverFrameDroppable = (text: string): boolean => SERVER_DROPPABLE.has(typeOf(text) ?? '');
/** Whether a frame a visitor's browser sends may be dropped when the link is backed up. */
export const clientFrameDroppable = (text: string): boolean => CLIENT_DROPPABLE.has(typeOf(text) ?? '');
