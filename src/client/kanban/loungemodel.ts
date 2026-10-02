// The pure side of the lounge figures in the 3D office (lounge3d.ts): which figure goes where, which of
// the shown ones stay, go or come, and what the hint and the overflow sign say. No three.js here.

import { loungePlaces, sortFigures, type LoungeFigure, type LoungePlace } from '../../shared/kanban/lounge';

/** A figure in its place, and the key that changes whenever it would look or stand any differently. */
export interface PlacedFigure {
  figure: LoungeFigure;
  place: LoungePlace;
  key: string;
}

function placeKey(p: LoungePlace): string {
  return p.kind === 'seat' ? `${p.seatId}:${p.place}` : `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
}

/** Each figure that finds a place (oldest hold first), and how many find none. */
export function layoutLounge(figures: readonly LoungeFigure[]): { placed: PlacedFigure[]; overflow: number } {
  const sorted = sortFigures(figures);
  const { placed, overflow } = loungePlaces(sorted.length);
  return {
    placed: placed.map((place, i) => {
      const f = sorted[i];
      return { figure: f, place, key: [placeKey(place), f.name, f.color, f.title, f.note ?? '', f.until ?? ''].join('|') };
    }),
    overflow,
  };
}

/**
 * From the figures shown now (task id → key) to `next`: the ids to take away (gone, or changed in look
 * or place) and the figures to make. One whose key is the same stays as it is.
 */
export function diffLounge(shown: ReadonlyMap<number, string>, next: readonly PlacedFigure[]): { drop: number[]; make: PlacedFigure[] } {
  const want = new Map(next.map((p) => [p.figure.taskId, p]));
  const drop = [...shown].filter(([id, key]) => want.get(id)?.key !== key).map(([id]) => id);
  const make = next.filter((p) => shown.get(p.figure.taskId) !== p.key);
  return { drop, make };
}

/** "15.11.", the day as it's written in Finland, in the viewer's time zone. */
function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the hint bar says of a figure: "⏸️ #14 The title — the reason · until 15.11." */
export function loungeHint(f: LoungeFigure, now: number): string {
  const note = f.note?.trim();
  let line = `⏸️ #${f.taskId} ${clipTo(f.title.trim(), 48)}`;
  if (note) line += ` — ${clipTo(note, 60)}`;
  if (f.until !== undefined) line += ` · until ${day(f.until)}${f.until < now ? ' (passed)' : ''}`;
  return line;
}

/** The sign over the couch when more are on hold than have a place. */
export function overflowText(overflow: number): string {
  return `⏸️ +${overflow} more on hold`;
}
