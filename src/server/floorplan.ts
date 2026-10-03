import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canLabel, cleanLabel, cleanPlan, rowDesks, signColor, type DeskLabel, type FloorPlan } from '../shared/floorplan.js';
import { DESK_BY_ID, MEETING_ROOMS, ROOMS_WING, WING } from '../shared/layout.js';

/**
 * A floor's own layout: the signs over its desks, and how far its back office is built out. Saved in
 * .agent-office/floorplan.json.
 */
export class FloorPlanStore {
  private plan: FloorPlan;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'floorplan.json');
    this.plan = this.load();
    // A meeting still going in a room of the meeting wing (saved before it was a wing to build out, or
    // with the wing walled up since) keeps its room: the wing is built out as far as that room.
    const need = roomsInUse(dataDir);
    if (need > this.plan.rooms) {
      this.plan.rooms = need;
      this.save();
    }
  }

  state(): FloorPlan {
    return { wing: this.plan.wing, rooms: this.plan.rooms, labels: { ...this.plan.labels } };
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
