/**
 * Build mode's pure part: the catalogue of furniture, the grid, where a piece's footprint falls, whether
 * it may stand there, and how a floor's pieces are written down and read back. No three.js and no
 * browser here, so it can be tested alone (tests/game-build.test.ts) and a server could keep the list
 * later. What the browser remembers is store.ts; what is drawn is pieces.ts.
 */
import { FLOOR } from '../../../shared/layout';
import type { Collider } from '../../world/types';

/** The grid pieces snap to, in meters. */
export const GRID = 0.5;
/** How far from the walls a piece stays, and how many pieces one floor holds. */
export const WALL_MARGIN = 0.3;
export const MAX_PIECES = 80;

export const PIECE_KINDS = ['chair', 'table', 'sofa', 'plant', 'bookshelf', 'rug', 'lamp', 'whiteboard'] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

export interface PieceDef {
  kind: PieceKind;
  icon: string;
  label: string;
  /** Footprint at rotation 0: width along x, depth along z, and height. */
  w: number;
  d: number;
  h: number;
  /** False for a rug: you walk over it, and it may lie under other things. */
  solid: boolean;
}

export const PIECES: Record<PieceKind, PieceDef> = {
  chair: { kind: 'chair', icon: '🪑', label: 'Chair', w: 0.6, d: 0.6, h: 0.95, solid: true },
  table: { kind: 'table', icon: '🟫', label: 'Small table', w: 1.2, d: 0.8, h: 0.75, solid: true },
  sofa: { kind: 'sofa', icon: '🛋️', label: 'Sofa', w: 2, d: 0.9, h: 0.85, solid: true },
  plant: { kind: 'plant', icon: '🪴', label: 'Potted plant', w: 0.5, d: 0.5, h: 1.3, solid: true },
  bookshelf: { kind: 'bookshelf', icon: '📚', label: 'Bookshelf', w: 1.2, d: 0.4, h: 2, solid: true },
  rug: { kind: 'rug', icon: '🟦', label: 'Rug', w: 2, d: 1.4, h: 0.02, solid: false },
  lamp: { kind: 'lamp', icon: '💡', label: 'Floor lamp', w: 0.4, d: 0.4, h: 1.7, solid: true },
  whiteboard: { kind: 'whiteboard', icon: '📋', label: 'Whiteboard stand', w: 1.2, d: 0.5, h: 1.8, solid: true },
};

/** A piece standing on a floor: where its middle is, and turned a quarter turn `r` times (0-3). */
export interface Piece {
  id: string;
  kind: PieceKind;
  x: number;
  z: number;
  r: number;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

type Placed = Pick<Piece, 'kind' | 'x' | 'z' | 'r'>;

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** A quarter turn on from `r` (a negative step turns the other way). */
export const turn = (r: number, step = 1): number => (((r + step) % 4) + 4) % 4;

/** The ground a piece covers, turned sideways for an odd `r`. */
export function footprint(p: Placed): Rect {
  const def = PIECES[p.kind];
  const sideways = p.r % 2 === 1;
  const hw = (sideways ? def.d : def.w) / 2;
  const hd = (sideways ? def.w : def.d) / 2;
  return { minX: p.x - hw, maxX: p.x + hw, minZ: p.z - hd, maxZ: p.z + hd };
}

/** The collider the piece puts in the office: its footprint, as tall as it is. A rug has none. */
export function colliderOf(p: Placed): Collider | null {
  const def = PIECES[p.kind];
  return def.solid ? { ...footprint(p), top: def.h } : null;
}

const EPS = 1e-6;
export const overlap = (a: Rect, b: Rect): boolean => a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS;

export type Verdict = { ok: true } | { ok: false; why: 'outside' | 'blocked' | 'piece' | 'you' };

export interface Surroundings {
  /** The office's own colliders (without the pieces of this mode). */
  colliders: readonly Collider[];
  /** The other pieces on the floor. */
  pieces: readonly Piece[];
  /** Where you stand, so a piece can't be put on you. */
  you?: { x: number; z: number };
}

/** Whether `p` may stand where it is: on the floor, off the walls, clear of the furniture, other pieces and you. */
export function check(p: Placed, around: Surroundings): Verdict {
  const f = footprint(p);
  const def = PIECES[p.kind];
  if (f.minX < FLOOR.minX + WALL_MARGIN || f.maxX > FLOOR.maxX - WALL_MARGIN || f.minZ < FLOOR.minZ + WALL_MARGIN || f.maxZ > FLOOR.maxZ - WALL_MARGIN) return { ok: false, why: 'outside' };
  if (def.solid) {
    // Whatever is at floor height there: not the loft overhead, not a rug-thin sliver on the ground.
    for (const c of around.colliders) {
      if (c.top <= 0.03 || (c.bottom ?? 0) >= def.h || !overlap(f, c)) continue;
      return { ok: false, why: 'blocked' };
    }
    const you = around.you;
    if (you && you.x > f.minX - 0.4 && you.x < f.maxX + 0.4 && you.z > f.minZ - 0.4 && you.z < f.maxZ + 0.4) return { ok: false, why: 'you' };
  }
  for (const o of around.pieces) {
    // Rugs lie under things; solid pieces and rugs only keep to their own kind of ground.
    if (PIECES[o.kind].solid !== def.solid) continue;
    if (overlap(f, footprint(o))) return { ok: false, why: 'piece' };
  }
  return { ok: true };
}

// ---- Saving ------------------------------------------------------------------------------------

/** What a floor's pieces are kept as: a list of {k, x, z, r}, in JSON. */
export function serialise(pieces: readonly Piece[]): string {
  return JSON.stringify({ v: 1, pieces: pieces.map((p) => ({ k: p.kind, x: p.x, z: p.z, r: p.r })) });
}

const isKind = (k: unknown): k is PieceKind => typeof k === 'string' && (PIECE_KINDS as readonly string[]).includes(k);

/** Reads what serialise wrote back; anything broken, unknown or off the floor is left out rather than failing. */
export function parse(text: string | null | undefined, newId: () => string): Piece[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { pieces?: unknown } | null)?.pieces;
  if (!Array.isArray(list)) return [];
  const out: Piece[] = [];
  for (const e of list) {
    if (out.length >= MAX_PIECES) break;
    if (!e || typeof e !== 'object' || !isKind(e.k) || !Number.isFinite(e.x) || !Number.isFinite(e.z)) continue;
    const p = { kind: e.k, x: snap(e.x), z: snap(e.z), r: Number.isFinite(e.r) ? turn(Math.trunc(e.r), 0) : 0 };
    const f = footprint(p);
    if (f.minX < FLOOR.minX || f.maxX > FLOOR.maxX || f.minZ < FLOOR.minZ || f.maxZ > FLOOR.maxZ) continue;
    out.push({ id: newId(), ...p });
  }
  return out;
}

/** Where a floor's pieces are kept in the browser. */
export const storageKey = (floor: string): string => `office.game.build.${floor}`;
