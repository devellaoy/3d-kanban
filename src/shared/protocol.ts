// Wire protocol between browser and server. Every WebSocket frame is one JSON object.
//
// Each part of the office keeps its state types and its messages in ./protocol/<domain>.ts; this
// file puts them back together, so everything is still imported from here, and makes the two
// unions every frame is one of.

import type { AccountsClientMsg, AccountsServerMsg, SignInsClientMsg, TeamClientMsg } from './protocol/accounts.js';
import type { ChangesClientMsg, ChangesServerMsg } from './protocol/changes.js';
import type { FloorClientMsg, FloorServerMsg, PlanClientMsg } from './protocol/floors.js';
import type { GitHubClientMsg, GitHubServerMsg } from './protocol/github.js';
import type { MeetingClientMsg, MeetingServerMsg } from './protocol/meetings.js';
import type { PresenceClientMsg, PresenceServerMsg } from './protocol/presence.js';
import type { QueueClientMsg, QueueServerMsg } from './protocol/queue.js';
import type { RooftopClientMsg, RooftopServerMsg } from './protocol/rooftop.js';
import type { SettingsClientMsg, SettingsServerMsg } from './protocol/settings.js';
import type { BallClientMsg, CabinetClientMsg, CarClientMsg, DecorClientMsg, DogClientMsg, JukeboxClientMsg, ToysServerMsg, WhiteboardClientMsg } from './protocol/toys.js';
import type { UsageClientMsg, UsageServerMsg } from './protocol/usage.js';
import type { WorkerClientMsg, WorkerServerMsg } from './protocol/workers.js';
import type { KanbanClientMsg, KanbanServerMsg } from './kanban/protocol.js';
import type { YoutubeClientMsg, YoutubeServerMsg } from './youtube/protocol.js';
import type { CodexLimitsClientMsg, CodexLimitsServerMsg } from './codex-limits/protocol.js';
import type { MpClientMsg, MpServerMsg } from './multiplayer/protocol.js';
import type { PhoneClientMsg, PhoneServerMsg } from './phone/protocol.js';

export * from './protocol/accounts.js';
export * from './protocol/agents.js';
export * from './protocol/changes.js';
export * from './protocol/floors.js';
export * from './protocol/github.js';
export * from './protocol/meetings.js';
export * from './protocol/presence.js';
export * from './protocol/queue.js';
export * from './protocol/rooftop.js';
export * from './protocol/settings.js';
export * from './protocol/toys.js';
export * from './protocol/usage.js';
export * from './protocol/workers.js';
export * from './multiplayer/protocol.js';
export * from './phone/protocol.js';

export type ClientMsg =
  | PresenceClientMsg
  | RooftopClientMsg
  | WorkerClientMsg
  | GitHubClientMsg
  | QueueClientMsg
  | MeetingClientMsg
  | FloorClientMsg
  | PlanClientMsg
  | ChangesClientMsg
  | TeamClientMsg
  | AccountsClientMsg
  | SignInsClientMsg
  | SettingsClientMsg
  | UsageClientMsg
  | DecorClientMsg
  | JukeboxClientMsg
  | CabinetClientMsg
  | WhiteboardClientMsg
  | BallClientMsg
  | CarClientMsg
  | DogClientMsg
  | KanbanClientMsg // the kanban's messages ride the office's socket
  | YoutubeClientMsg // YouTube on the Office TV
  | CodexLimitsClientMsg // the Codex sign-in's allowance
  | MpClientMsg // multiplayer: the link to the relay
  | PhoneClientMsg; // the phone: other floors' workers

export type ServerMsg =
  | PresenceServerMsg
  | RooftopServerMsg
  | WorkerServerMsg
  | GitHubServerMsg
  | QueueServerMsg
  | MeetingServerMsg
  | FloorServerMsg
  | ChangesServerMsg
  | AccountsServerMsg
  | SettingsServerMsg
  | UsageServerMsg
  | ToysServerMsg
  | KanbanServerMsg
  | YoutubeServerMsg // YouTube on the Office TV
  | CodexLimitsServerMsg // the Codex sign-in's allowance
  | MpServerMsg // multiplayer: the link to the relay
  | PhoneServerMsg; // the phone: other floors' workers
