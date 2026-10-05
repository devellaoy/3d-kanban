// The meeting room.

import type { AgentEffort, AgentProvider } from './agents.js';

/** How the workers at the meeting table work together (see shared/meetings.ts). */
export type MeetingPattern = 'debate' | 'lead' | 'mapreduce' | 'redblue' | 'review';

/** A worker's place at a meeting. */
export interface MeetingSeat {
  /** Its part in the meeting, e.g. "Skeptic", "Red team" or "Security". */
  role: string;
  /** Its chair (see MEETING_ROOMS in layout). */
  deskId: string;
  workerId?: string;
  workerName?: string;
  /** What its worker has used, kept after it goes home. `cost` is missing when its provider doesn't say. */
  tokens?: number;
  cost?: number;
}

/** One worker's part in a round: what it's doing, and the file that says it has done it. */
export interface MeetingTurn {
  /** Which of the meeting's seats. */
  seat: number;
  /** e.g. "proposing", "critiquing", "writing the decision". */
  doing: string;
  /** Relative to the meeting's checkout. */
  file: string;
  /** waiting: not handed over yet; sent: handed over, not started on; working: on it; done: its file is written. */
  state: 'waiting' | 'sent' | 'working' | 'done';
  sentAt?: number;
  /** It was reminded once already: it ended its turn without writing the file, or never started. */
  retried?: boolean;
}

/** Where a finished meeting's output was handed on to: a kanban task or a hired worker (exactly one of `task` and `worker`). */
export interface MeetingHandoff {
  /** A kanban task's id. */
  task?: number;
  /** A hired worker's name. */
  worker?: string;
  /** Who handed it on. */
  by: string;
  at: number;
}

export type MeetingStatus = 'running' | 'done' | 'stopped';

/**
 * A meeting in the meeting room: 2–5 workers on one question or task, in rounds, following a pattern.
 * It ends when its output file is written, or stops at its round limit or token budget and says why.
 */
export interface Meeting {
  id: string;
  /** The meeting room it's held in (see MEETING_ROOMS in layout). */
  room: string;
  pattern: MeetingPattern;
  title: string;
  /** The question or task, as whoever called the meeting put it. */
  prompt: string;
  /** The file the meeting writes, relative to its checkout, declared up front. */
  output: string;
  /** The head of the table first. */
  seats: MeetingSeat[];
  /** Map-reduce: what the task runs over, a part per line. */
  parts?: string[];
  /** Review panel: the pull request under review. */
  pr?: number;
  /** The GitHub issue it's about, when it was called from one. */
  issue?: number;
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
  /** The round limit. */
  rounds: number;
  /** The round it's on (from 1), and the step within it (red / blue take turns inside a round). */
  round: number;
  step: number;
  /** Red / blue: the red team found nothing more in this round, so it's the last. */
  lastRound?: number;
  /** The current step's parts. */
  turns: MeetingTurn[];
  /** Tokens every worker in the meeting may use between them (0: no limit, a review panel's default), and how many they have. */
  budget: number;
  tokens: number;
  /** USD, where the providers report it. */
  cost: number;
  /** False when a worker's provider reports no cost, so `cost` leaves it out. */
  costKnown: boolean;
  status: MeetingStatus;
  /** Why it stopped short. */
  reason?: string;
  calledBy: string;
  /** The account that called it: its workers run on that account's own sign-ins, and its review is posted as them. */
  owner?: string;
  startedAt: number;
  finishedAt?: number;
  /** The meeting's own git worktree, relative to the project, which everyone at the table shares. */
  worktree?: { path: string; branch: string; base: string; from?: string };
  /** Where the round notes go, relative to the checkout. */
  notes: string;
  /** The commit on the meeting's branch that holds the output. */
  commit?: string;
  /** Review panel: the review the office posted on the pull request, or why it couldn't. */
  review?: { url?: string; error?: string };
  /** The start of the output file as it gets written, for the board in the room. */
  preview?: string;
  /** Its workers have gone home and its worktree was tidied away. */
  cleared?: boolean;
  /** Where its output was handed on to, oldest first (see MeetingHandoff). */
  handedTo?: MeetingHandoff[];
}

/** A meeting that's over, in a line. */
export interface MeetingRecord {
  id: string;
  /** The room it was held in; missing in records saved before there were several. */
  room?: string;
  pattern: MeetingPattern;
  title: string;
  status: MeetingStatus;
  /** The line on the room's door: pattern, rounds, tokens, cost, and the output (or why it stopped). */
  summary: string;
  calledBy: string;
  finishedAt: number;
  branch?: string;
  output: string;
  // The rest is only in the full record, kept in the meeting's own folder (meetings/<id>/.meeting.json) and
  // served over HTTP (/api/meetings), never in MeetingState: the state goes to every browser every few seconds.
  /** The question or task, cut short when it's long. */
  prompt?: string;
  /** Who sat at the table, the head first. */
  seats?: { role: string; workerName?: string }[];
  /** The rounds it held. */
  rounds?: number;
  tokens?: number;
  /** Missing when a worker's provider doesn't report its cost. */
  cost?: number;
  /** The commit on `branch` that holds the output. */
  commit?: string;
  /** Review panel: the pull request, and the review the office posted on it. */
  pr?: number;
  reviewUrl?: string;
  /** Where its notes are kept, relative to the floor's .agent-office/ (meetings/<id>). */
  notesDir?: string;
  /** Where its output was handed on to, oldest first (see MeetingHandoff). */
  handedTo?: MeetingHandoff[];
}

/** A meeting in the archive. An orphan is a notes folder with no record: its id and date only. */
export type ArchivedMeeting = MeetingRecord & { orphan?: boolean };

/**
 * The floor's earlier meetings, newest first (GET /api/meetings). Each entry is a line (see slimRecord) with only a
 * snippet of the question as `prompt` (cut with "…"); the full record, seats and all, is GET /api/meetings/<id> (an ArchivedMeeting).
 */
export interface MeetingArchiveList {
  meetings: ArchivedMeeting[];
  /** More were found than were sent. */
  more: boolean;
}

/** A meeting's notes folder (GET /api/meetings/<id>/files): the output first, then the notes by round. */
export interface MeetingFiles {
  files: MeetingFileInfo[];
  /** How many top-level entries were left out: folders, links and files that aren't plain (not hidden files). */
  skipped: number;
}

/** One file in a meeting's notes folder. */
export interface MeetingFileInfo {
  name: string;
  size: number;
  kind: 'output' | 'note';
  round?: number;
}

/** One file's text (GET /api/meetings/<id>/file?name=). */
export interface MeetingFileText {
  name: string;
  size: number;
  text: string;
}

/** One meeting room on the floor and what's on in it. */
export interface MeetingRoomState {
  id: string;
  label: string;
  /** The meeting in the room: the one running, or the last one until the room is cleared or the next is called. */
  current: Meeting | null;
}

export interface MeetingState {
  /** Every meeting room on the floor's map, in MEETING_ROOMS order. */
  rooms: MeetingRoomState[];
  /** Earlier meetings on the floor, newest first. */
  past: MeetingRecord[];
}

/** What calling a meeting asks for (see shared/meetings.ts for each pattern's defaults and limits). */
export interface MeetingRequest {
  /** The room to hold it in; the first free one without. */
  room?: string;
  pattern: MeetingPattern;
  prompt: string;
  title?: string;
  /** The output file, relative to the checkout; the pattern's default when missing. */
  output?: string;
  /** A role per worker, the head of the table first. */
  roles: string[];
  parts?: string[];
  pr?: number;
  issue?: number;
  rounds?: number;
  budget?: number;
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
}

export type MeetingClientMsg =
  /** Call a meeting: workers sit down round the meeting room's table and work through it in rounds. */
  | ({ t: 'meeting.start' } & MeetingRequest)
  /** Stop the meeting that's running in a room; its workers stay at the table. */
  | { t: 'meeting.stop'; room?: string }
  /** Send a room's last meeting's workers home and clear the table. */
  | { t: 'meeting.clear'; room?: string }
  /** A finished meeting's output was made into kanban task `task` (the client created it): the meeting remembers where it went. */
  | { t: 'meeting.handed'; id: string; task: number };

export type MeetingServerMsg =
  | { t: 'meeting'; state: MeetingState };
