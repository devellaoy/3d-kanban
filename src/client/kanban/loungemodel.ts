// The pure side of the lounge figures in the 3D office (lounge3d.ts): which figure goes where, which of
// the shown ones stay, go, come or move, and what the hint and the overflow sign say. No three.js here.

import { loungePlaces, placeKey, type LoungeFigure, type LoungePlace } from '../../shared/kanban/lounge';

/** A figure in its place: `look` changes whenever it would look any different, `spot` whenever it moves. */
export interface PlacedFigure {
  figure: LoungeFigure;
  place: LoungePlace;
  look: string;
  spot: string;
}

function spotKey(p: LoungePlace): string {
  return p.kind === 'seat' ? placeKey(p) : `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
}

/**
 * Each figure that finds a place, around the seats people sit on (`occupied`), and how many find none.
 * `figures` come oldest hold first, as the server sends them (sortFigures), which is the order the places fill in.
 */
export function layoutLounge(figures: readonly LoungeFigure[], occupied: ReadonlySet<string> = new Set()): { placed: PlacedFigure[]; overflow: number } {
  const { placed, overflow } = loungePlaces(figures.length, occupied);
  return {
    placed: placed.map((place, i) => {
      const f = figures[i];
      return { figure: f, place, look: [f.name, f.color, f.title, f.note ?? '', f.until ?? ''].join('|'), spot: spotKey(place) };
    }),
    overflow,
  };
}

/**
 * From the figures shown now (task id → look and spot) to `next`: the ids to take away (gone, or
 * looking different), the figures to make, and the ones that only move to another place (someone sat
 * down on their seat, or got up). One whose look and spot are the same stays as it is.
 */
export function diffLounge(shown: ReadonlyMap<number, { look: string; spot: string }>, next: readonly PlacedFigure[]): { drop: number[]; make: PlacedFigure[]; move: PlacedFigure[] } {
  const want = new Map(next.map((p) => [p.figure.taskId, p]));
  const drop = [...shown].filter(([id, s]) => want.get(id)?.look !== s.look).map(([id]) => id);
  const make = next.filter((p) => shown.get(p.figure.taskId)?.look !== p.look);
  const move = next.filter((p) => {
    const s = shown.get(p.figure.taskId);
    return s?.look === p.look && s.spot !== p.spot;
  });
  return { drop, make, move };
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
