// The phone's messages (src/{client,server}/phone/), riding the office's socket (see ClientMsg/ServerMsg
// in shared/protocol.ts): what the workers on a floor you're not standing on are doing, without going there.
import type { ProjectInfo } from '../protocol/floors.js';
import type { WorkerInfo } from '../protocol/workers.js';
import type { PhoneMusicControl, PhoneMusicState } from './music.js';

export type * from './music.js';

export type PhoneClientMsg =
  /** Follow the workers on `floor` (any floor, not just yours); null stops. One floor at a time: a new one replaces the last. */
  | { t: 'phone.watch'; floor: string | null }
  /**
   * Music on your phone. Without `to` it's for you; with `to` (someone's PeerInfo id, on any floor) for the
   * two of you, both hearing it in step. It starts a new session (leaving the one you were in), except with
   * `queue`, which adds it to your session's queue ('end' or 'next') and starts one if you have none.
   */
  | { t: 'phone.music.play'; url: string; to?: string; queue?: 'end' | 'next' }
  /** One of the TV's controls, for your session. */
  | { t: 'phone.music.control'; control: PhoneMusicControl }
  /** Stop listening (⏏). The session goes once nobody listens. */
  | { t: 'phone.music.leave' };

export type PhoneServerMsg =
  /** Everyone on the floor followed with phone.watch, sent once as it starts (and again when asked). */
  | { t: 'phone.floor'; floor: string; workers: WorkerInfo[]; project: ProjectInfo | null }
  /** One of them changed (or was hired). Kept apart from worker.update, which is only ever your own floor's. */
  | { t: 'phone.worker'; floor: string; worker: WorkerInfo }
  /** One of them went home. */
  | { t: 'phone.workerRemove'; floor: string; workerId: string }
  /** The music session you're in (or none): sent to each of its listeners whenever it changes. */
  | { t: 'phone.music'; music: PhoneMusicState | null };
