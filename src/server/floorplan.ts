import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MOVABLE_BY_ID, NONE_REMOVED, nameOf, poseOf, removedSeats, sentence, type Furniture, type Layout } from '../shared/arrange.js';
import { checkPlace, whyNot, withSpot } from '../shared/arrange-check.js';
import { canLabel, cleanLabel, cleanPlan, rowDesks, signColor, type DeskLabel, type FloorPlan } from '../shared/floorplan.js';
import { DESKS, DESK_BY_ID, MEETING_ROOMS, ROOMS_WING, WING, WING_DESKS, deskBuilt, watchSpotOf } from '../shared/layout.js';

/**
 * A floor's own layout: the signs over its desks, how far its back office is built out, and where its
 * loose furniture stands (shared/arrange.ts). Saved in .agent-office/floorplan.json.
 */
export class FloorPlanStore {
  private plan: FloorPlan;
  private file: string;

  /** `officeMap`: whether the building is on the office's own map: only that one has the furniture's arrangement in force. */
  constructor(
    dataDir: string,
    private officeMap: () => boolean = () => true,
  ) {
    this.file = path.join(dataDir, 'floorplan.json');
    this.plan = this.load();
    // A meeting still going in a room of the meeting wing (saved before it was a wing to build out, or
    // with the wing walled up since) keeps its room: the wing is built out as far as that room.
    const need = roomsInUse(dataDir);
    if (need > this.plan.rooms) {
      this.plan.rooms = need;
      this.save();
    }
    // A worker still at a desk the floor had taken out, or at a bean bag it never put down (saved from
    // before bean bags were put down by hand, or the plan edited by hand): the seat is back, a bean bag where it's first offered.
    const out = removedSeats(this.plan.furniture);
    const back = seatsInUse(dataDir).filter((id) => out.has(id));
    if (back.length) {
      const next = { ...this.plan.furniture };
      for (const id of back) {
        const m = MOVABLE_BY_ID.get(id);
        if (m?.added) next[id] = { x: m.home.x, z: m.home.z, r: 0 };
        else delete next[id];
      }
      this.plan.furniture = next;
      this.save();
    }
  }

  state(): FloorPlan {
    return { wing: this.plan.wing, rooms: this.plan.rooms, labels: { ...this.plan.labels }, furniture: this.plan.furniture };
  }

  /** Where the loose furniture stands (replaced, never changed, when it moves). */
  get furniture(): Furniture {
    return this.plan.furniture;
  }

  /** The desks the floor has taken out, and the bean bags it hasn't put down. */
  get removed(): Set<string> {
    return removedSeats(this.plan.furniture);
  }

  /** The ones that count as taken out here: none, on a map that isn't the office's. */
  seatsOut(): ReadonlySet<string> {
    return this.officeMap() ? this.removed : NONE_REMOVED;
  }

  /** How far the back office and meeting wing are built, and where the furniture stands: what the walking grid is made from. */
  layout(): Layout {
    return { wing: this.plan.wing, rooms: this.plan.rooms, furniture: this.officeMap() ? this.plan.furniture : undefined };
  }

  /** Moves a piece of furniture, or puts one that isn't on the floor (taken out, or a bean bag) down where it's asked: its name, or why not. `spot` is checked here (see shared/arrange-check.ts). */
  arrange(id: unknown, spot: unknown): string | { id: string; label: string; back: boolean; added: boolean } {
    const m = typeof id === 'string' ? MOVABLE_BY_ID.get(id) : undefined;
    if (!m) return 'There is nothing like that to move';
    const s = spot && typeof spot === 'object' ? (spot as Record<string, unknown>) : {};
    const to = { x: Number(s.x), z: Number(s.z), r: Number(s.r ?? 0) };
    const v = checkPlace(this.plan.furniture, m.id, to);
    if (!v.ok) return whyNot(v, nameOf(m));
    const back = !poseOf(m, this.plan.furniture);
    this.plan.furniture = withSpot(this.plan.furniture, m.id, { x: Math.round(to.x * 100) / 100, z: Math.round(to.z * 100) / 100, r: to.r });
    this.save();
    return { id: m.id, label: nameOf(m), back, added: !!m.added };
  }

  /** Takes a piece of furniture out of the floor, unless somebody's at it (`taken`) or it's the last desk. Its name, or why not. */
  remove(id: unknown, taken: (deskId: string) => boolean): string | { id: string; label: string } {
    const m = typeof id === 'string' ? MOVABLE_BY_ID.get(id) : undefined;
    if (!m) return 'There is nothing like that to take out';
    if (!poseOf(m, this.plan.furniture)) return `${sentence(nameOf(m))} is already gone`;
    if ((m.kind === 'desk' || m.kind === 'beanbag') && (taken(m.id) || taken(watchSpotOf(m.id)))) return `Someone's at ${DESK_BY_ID.get(m.id)?.label ?? 'it'}: send them home first`;
    if (m.kind === 'desk' && !this.otherDesks(m.id)) return 'The floor needs at least one desk';
    const next: Furniture = { ...this.plan.furniture, [m.id]: { removed: true } };
    // A bean bag taken out just isn't on the floor any more, as it comes.
    if (m.added) delete next[m.id];
    this.plan.furniture = next;
    this.save();
    return { id: m.id, label: nameOf(m) };
  }

  /** Whether a desk other than `id` is built (the back office `wing` rows out) and standing on this floor. */
  private otherDesks(id: string, wing = this.plan.wing): boolean {
    return [...DESKS, ...WING_DESKS].some((d) => d.id !== id && deskBuilt(d, wing) && !(this.plan.furniture[d.id] && 'removed' in this.plan.furniture[d.id]));
  }

  /**
   * Puts a piece of furniture back where it comes (as far as that's allowed, standing free), or all of
   * it: the bean bags put down go again, but not one somebody's at (`taken`). The names of what was put back, or why not.
   */
  reset(id?: unknown, taken: (deskId: string) => boolean = () => false): string | { labels: string[] } {
    if (id === undefined) {
      const keep = Object.keys(this.plan.furniture).filter((k) => MOVABLE_BY_ID.get(k)?.added && (taken(k) || taken(watchSpotOf(k))));
      const labels = Object.keys(this.plan.furniture)
        .filter((k) => !keep.includes(k))
        .map((k) => (MOVABLE_BY_ID.has(k) ? nameOf(MOVABLE_BY_ID.get(k)!) : k));
      if (!labels.length) return 'The furniture is all where it comes already';
      this.plan.furniture = Object.fromEntries(keep.map((k) => [k, this.plan.furniture[k]]));
      this.save();
      return { labels };
    }
    const m = typeof id === 'string' ? MOVABLE_BY_ID.get(id) : undefined;
    if (m?.added) return `${sentence(nameOf(m))} has nowhere it comes: X takes it out`;
    if (!m || !this.plan.furniture[m.id]) return 'That is where it comes already';
    const rest = { ...this.plan.furniture };
    delete rest[m.id];
    const v = checkPlace(rest, m.id, { x: m.home.x, z: m.home.z, r: 0 });
    if (!v.ok) return whyNot(v, nameOf(m));
    this.plan.furniture = rest;
    this.save();
    return { labels: [nameOf(m)] };
  }

  get wing(): number {
    return this.plan.wing;
  }

  /** How many meeting rooms the meeting wing is built out. */
  get rooms(): number {
    return this.plan.rooms;
  }

  /** Builds the meeting wing out another room: its id, or why not. */
  expandRooms(): string | { id: string } {
    if (this.plan.rooms >= ROOMS_WING.rooms) return "The meeting wing can't go out any further";
    this.plan.rooms++;
    this.save();
    return { id: wingRoomOf(this.plan.rooms).id };
  }

  /** Walls up the meeting wing's last room, unless `busy` says a meeting is in it. The room that went, or why not. */
  shrinkRooms(busy: (roomId: string) => string | undefined): string | { id: string; label: string } {
    if (this.plan.rooms <= 0) return 'There is no meeting room out there to wall up';
    const room = wingRoomOf(this.plan.rooms);
    const why = busy(room.id);
    if (why) return why;
    this.plan.rooms--;
    this.save();
    return { id: room.id, label: room.label };
  }

  /** Hangs a sign over a desk, or takes it down (no text). What it did, for the toast, or why it couldn't. */
  label(deskId: string, text: unknown, color: unknown, by: string): { label?: DeskLabel; old?: DeskLabel } | string {
    if (!canLabel(deskId)) return 'Only a desk can have a sign over it';
    const clean = cleanLabel(text);
    const old = this.plan.labels[deskId];
    if (!clean) {
      if (!old) return {};
      delete this.plan.labels[deskId];
      this.save();
      return { old };
    }
    const label: DeskLabel = { text: clean, color: signColor(color), by, at: Date.now() };
    this.plan.labels[deskId] = label;
    this.save();
    return { label, old };
  }

  /** Knocks the back office out another row: the ids of the desks that came with it, or why not. */
  expand(): string[] | string {
    if (this.plan.wing >= WING.rows) return "The back office can't go back any further";
    this.plan.wing++;
    this.save();
    return rowDesks(this.plan.wing).map((d) => d.id);
  }

  /** Walls up the back office's last row, unless someone's working there (`taken`). What went, or why not. */
  shrink(taken: (deskId: string) => boolean): string[] | string {
    if (this.plan.wing <= 0) return 'There is no back office to wall up';
    const desks = rowDesks(this.plan.wing);
    const busy = desks.find((d) => taken(d.id));
    if (busy) return `Someone's at ${DESK_BY_ID.get(busy.id)?.label ?? 'a desk'} back there: send them home first`;
    if (!this.otherDesks('', this.plan.wing - 1)) return 'The floor needs at least one desk: put one back first';
    this.plan.wing--;
    this.save();
    return desks.map((d) => d.id);
  }

  private load(): FloorPlan {
    if (!existsSync(this.file)) return cleanPlan(undefined);
    try {
      return cleanPlan(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // a broken file just means the office as it comes
      return cleanPlan(undefined);
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.plan, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

/** The ids of the seats the floor's saved workers sit at, the spots behind them counted as the seat. */
function seatsInUse(dataDir: string): string[] {
  try {
    const workers: unknown = JSON.parse(readFileSync(path.join(dataDir, 'workers.json'), 'utf8'));
    return Array.isArray(workers) ? workers.flatMap((w) => (w && typeof (w as { deskId?: unknown }).deskId === 'string' ? [(w as { deskId: string }).deskId.replace(/^watch-/, '')] : [])) : [];
  } catch {
    return [];
  }
}

/** The meeting wing's room number `level` (1 to 3). */
function wingRoomOf(level: number) {
  return MEETING_ROOMS.filter((r) => (r.level ?? 0) > 0)[level - 1];
}

/**
 * How many rooms of the meeting wing a floor's saved meetings and workers need to be there: the
 * furthest one with a meeting running in it or workers seated at its chairs. (A finished meeting nobody
 * sits at needs nothing: it just shows as a room the floor lacks until someone clears it.)
 */
function roomsInUse(dataDir: string): number {
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(path.join(dataDir, name), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const wing = MEETING_ROOMS.filter((r) => (r.level ?? 0) > 0);
  const saved = read('meetings.json') as { rooms?: Record<string, { status?: unknown } | null> } | undefined;
  const workers = read('workers.json');
  const seated = new Set(Array.isArray(workers) ? workers.map((w) => (w && typeof w === 'object' ? (w as { deskId?: unknown }).deskId : undefined)) : []);
  let need = 0;
  for (const r of wing) {
    const m = saved?.rooms && typeof saved.rooms === 'object' ? saved.rooms[r.id] : undefined;
    const running = !!m && typeof m === 'object' && m.status === 'running';
    if (running || r.seats.some((d) => seated.has(d.id))) need = Math.max(need, r.level ?? 0);
  }
  return need;
}
