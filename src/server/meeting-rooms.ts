// The floor's meeting rooms: each its own meeting, chairs and state (see meetings.ts), with a new meeting going to the first free one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MEETING_ROOMS, type MeetingRoomDef } from '../shared/layout.js';
import { FIRST_MEETING_ROOM, isMeetingId, isMeetingPattern, meetingRecord, slimRecord } from '../shared/meetings.js';
import type { Meeting, MeetingRecord, MeetingRequest, MeetingState, WorkerInfo } from '../shared/protocol.js';
import { MeetingRoom, type MeetingEvents, type MeetingTrees, type MeetingWorkers } from './meetings.js';

const PAST_MAX = 20;

/** What is saved: the meeting in each room by its id, and the earlier ones. (Older files had just `current`, which was the first room's.) */
interface Saved {
  rooms?: Record<string, Meeting | null>;
  current?: Meeting | null;
  past?: MeetingRecord[];
}

/** Whether a saved value is a meeting that can carry on. */
const usable = (m: unknown): m is Meeting => {
  const x = m as Partial<Meeting> | null | undefined;
  return !!x && typeof x.id === 'string' && isMeetingPattern(x.pattern) && Array.isArray(x.seats) && Array.isArray(x.turns);
};

/**
 * All of a floor's meeting rooms. `rooms` is the building's map's list of them (it can change while the
 * office runs, so it is asked every time); each has a MeetingRoom of its own, made when first needed.
 * They share the list of earlier meetings and the state file.
 */
export class MeetingRooms {
  private engines = new Map<string, MeetingRoom>();
  private past: MeetingRecord[] = [];
  private statePath: string;

  constructor(
    private dir: string,
    private dataDir: string,
    private workers: MeetingWorkers,
    private trees: MeetingTrees | undefined,
    private events: MeetingEvents,
    private rooms: () => MeetingRoomDef[],
  ) {
    this.statePath = path.join(dataDir, 'meetings.json');
    this.restore();
  }

  /** Every room of the map, with what's on in it. Makes no engines: a room that never had a meeting has none (and no timer). */
  state(): MeetingState {
    const defs = this.rooms();
    const known = new Set(defs.map((d) => d.id));
    // A room the map no longer has still shows while a meeting is in it, so it can be stopped and cleared.
    const rest = [...this.engines.values()].filter((e) => !known.has(e.def.id) && e.peek()).map((e) => e.def);
    return { rooms: [...defs, ...rest].map((d) => ({ id: d.id, label: d.label, current: this.engines.get(d.id)?.meeting() ?? null })), past: this.past.slice() };
  }

  /** Why a room can't be walled up (a meeting is running in it, or someone is still at its table), or undefined when it can. */
  busy(id: string): string | undefined {
    const e = this.engines.get(id);
    if (!e) return undefined;
    const label = e.def.label;
    if (e.peek()?.status === 'running') return `A meeting is on in the ${label}: stop it, and send its workers home, first`;
    if (e.seated()) return `Someone is still at the ${label}'s table: send them home first`;
    return undefined;
  }

  /** Forgets a room that has been walled up: a finished meeting nobody sits at goes (busy() has said it may). */
  release(id: string) {
    const e = this.engines.get(id);
    const m = e?.peek();
    if (m && m.status !== 'running') this.keep(meetingRecord(m)); // a finished meeting goes on the earlier ones
    e?.shutdown(); // its timer goes with it
    this.engines.delete(id);
    this.persist();
    this.events.update(this.state());
  }

  /** The map's rooms changed (the meeting wing was built out or walled up): everyone is told which there are. */
  refresh() {
    this.events.update(this.state());
  }

  /** The meetings that are over but still on their room's table (not cleared yet), in full. */
  finished(): MeetingRecord[] {
    return [...this.engines.values()].flatMap((e) => {
      const m = e.peek();
      return m && m.status !== 'running' ? [meetingRecord(m)] : [];
    });
  }

  /** The earlier meetings the state lists (a line each, see slimRecord). */
  pastRecords(): MeetingRecord[] {
    return this.past.slice();
  }

  /** Where the meetings' notes folders are, one per meeting id. */
  archiveDir(): string {
    return path.join(this.dataDir, 'meetings');
  }

  /** Whether a meeting is running in any room. */
  running(): boolean {
    return [...this.engines.values()].some((e) => e.peek()?.status === 'running');
  }

  /** Calls a meeting in `req.room`, or in the first free room. Returns why it couldn't, or undefined once everyone is sitting down. */
  start(req: MeetingRequest, by: string, owner?: string): string | undefined {
    const defs = this.rooms();
    // A room this map lacks, with a meeting running in it or workers still seated: they sit on this map's chairs, which the
    // rooms that are here share (a one-room map seats every room's workers at its one table), so none is free. (A finished
    // meeting whose workers have gone home is in nobody's way: it only shows, until someone clears it.)
    const stranded = [...this.engines.values()].find((e) => !defs.some((d) => d.id === e.def.id) && (e.peek()?.status === 'running' || e.seated()));
    if (stranded) {
      const m = stranded.peek();
      return `The ${stranded.def.label} still has ${m ? `“${m.title}”` : 'workers'} from another map at this one's table: ${m?.status === 'running' ? 'stop that meeting and ' : ''}clear that room first`;
    }
    // One panel per pull request: a second would post a second review on it.
    if (req.pattern === 'review' && req.pr !== undefined) {
      const same = [...this.engines.values()].find((e) => e.peek()?.status === 'running' && e.peek()!.pattern === 'review' && e.peek()!.pr === req.pr);
      if (same) return `PR #${req.pr} is already being reviewed in the ${same.def.label}`;
    }
    if (req.room !== undefined) {
      const def = defs.find((d) => d.id === req.room);
      return def ? this.room(def).start(req, by, owner) : `There's no meeting room “${String(req.room).slice(0, 40)}”`;
    }
    const all = defs.map((d) => this.room(d));
    // An empty room first; one with a finished meeting in it (whose workers go home to make room) next.
    const pick = all.find((e) => !e.peek() && !e.seated()) ?? all.find((e) => e.peek() && e.peek()!.status !== 'running');
    if (pick) return pick.start(req, by, owner);
    const on = all.some((e) => e.peek()?.status === 'running');
    const list = all.map((e) => `${e.def.label}: ${e.peek()?.status === 'running' ? `“${e.peek()!.title}”` : 'someone is still sitting at the table'}`);
    // The office's own rooms (not another map's one table) can be built out: say so.
    const more = defs.every((d) => (MEETING_ROOMS as MeetingRoomDef[]).includes(d)) && defs.length < MEETING_ROOMS.length ? ' — or knock through the west wall for another room' : '';
    return `Every meeting room is busy: ${list.join(', ')}; ${on ? 'stop one of those meetings first' : 'send those workers home first'}${more}`;
  }

  /** Stops the meeting that's running in a room (the one that is, without `room`). Its workers stay at the table. */
  stop(by: string, room?: string): string | undefined {
    const on = this.target(room, (m) => m.status === 'running', 'No meeting is on');
    return typeof on === 'string' ? on : on.stop(by);
  }

  /** Sends a room's last meeting's workers home and clears the table (the room that has one, without `room`). */
  clear(by: string, room?: string): string | undefined {
    const on = this.target(room, (m) => m.status !== 'running', 'Nobody is in the meeting room');
    return typeof on === 'string' ? on : on.clear(by);
  }

  /** A worker changed: cheap unless it's at a table. */
  onWorker(info: WorkerInfo) {
    for (const e of this.engines.values()) e.onWorker(info);
  }

  onWorkerGone(workerId: string) {
    for (const e of this.engines.values()) e.onWorkerGone(workerId);
  }

  shutdown() {
    for (const e of this.engines.values()) e.shutdown();
    this.persist();
  }

  // ---------------------------------------------------------------------------

  /** The room the caller means: the one named, or the only one with a meeting that `fits`. A string says why there's none. */
  private target(room: string | undefined, fits: (m: Meeting) => boolean, none: string): MeetingRoom | string {
    if (room !== undefined) {
      const def = this.rooms().find((d) => d.id === room);
      return (def ? this.room(def) : this.engines.get(room)) ?? `There's no meeting room “${room.slice(0, 40)}”`;
    }
    const some = [...this.engines.values()].filter((e) => e.peek() && fits(e.peek()!));
    return some.length === 1 ? some[0] : some.length ? `Several rooms have meetings, so say which room: ${some.map((e) => `${e.def.label} (${e.def.id})`).join(', ')}` : none;
  }

  /** A room's engine, made on first use; its chairs are the map's current ones. */
  private room(def: MeetingRoomDef): MeetingRoom {
    let e = this.engines.get(def.id);
    if (!e) {
      e = new MeetingRoom(this.dir, this.dataDir, this.workers, this.trees, {
        ...this.events,
        changed: () => {
          this.persist();
          this.events.update(this.state());
        },
        save: () => this.persist(),
        outputBusy: (room, output) => this.outputBusy(room, output),
        archive: (record) => this.keep(record),
      }, def);
      this.engines.set(def.id, e);
    } else e.def = def;
    return e;
  }

  /** Why `output` can't be written for a meeting in `room`: another running meeting writes that file in the project's own folder (one without a worktree of its own). */
  private outputBusy(room: string, output: string): string | undefined {
    const same = [...this.engines.values()].find((e) => e.def.id !== room && e.peek()?.status === 'running' && !e.peek()!.worktree && e.peek()!.output === output);
    return same && `The ${same.def.label}'s meeting is already writing ${output}: give this one another output file`;
  }

  /** Puts a finished meeting on the earlier ones (a line each) and its full record in its own notes folder, where the archive reads it. */
  private keep(record: MeetingRecord) {
    this.past = [slimRecord(record), ...this.past.filter((r) => r.id !== record.id)].slice(0, PAST_MAX);
    if (!isMeetingId(record.id)) return;
    try {
      const dir = path.join(this.archiveDir(), record.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.meeting.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private persist() {
    const rooms: Record<string, Meeting | null> = {};
    for (const [id, e] of this.engines) rooms[id] = e.meeting();
    try {
      writeFileSync(this.statePath, JSON.stringify({ rooms, past: this.past }, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as Saved;
      if (Array.isArray(saved.past)) this.past = saved.past.filter((r) => r && typeof r.id === 'string' && typeof r.summary === 'string').slice(0, PAST_MAX);
      const defs = this.rooms();
      // The workers at the table outlive a restart of the office, so a meeting carries on where it was.
      const found = Object.entries(saved.rooms ?? {}).map(([id, m]) => [id, m] as const);
      if (saved.current) found.push([FIRST_MEETING_ROOM, saved.current]); // saved before there were several rooms
      for (const [id, m] of found) {
        if (!usable(m)) continue;
        const want = typeof m.room === 'string' ? m.room : id;
        const def = defs.find((d) => d.id === want) ?? MEETING_ROOMS.find((d) => d.id === want) ?? defs[0];
        if (!def || this.engines.get(def.id)?.meeting()) continue;
        m.room = def.id;
        this.room(def).adopt(m);
      }
    } catch {
      // corrupt state file: empty rooms
    }
  }
}
