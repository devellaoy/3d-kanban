// The phone's messages (src/{client,server}/phone/), riding the office's socket (see ClientMsg/ServerMsg
// in shared/protocol.ts): what the workers on a floor you're not standing on are doing, without going there.
import type { ProjectInfo } from '../protocol/floors.js';
import type { WorkerInfo } from '../protocol/workers.js';

export type PhoneClientMsg =
  /** Follow the workers on `floor` (any floor, not just yours); null stops. One floor at a time: a new one replaces the last. */
  { t: 'phone.watch'; floor: string | null };

export type PhoneServerMsg =
  /** Everyone on the floor followed with phone.watch, sent once as it starts (and again when asked). */
  | { t: 'phone.floor'; floor: string; workers: WorkerInfo[]; project: ProjectInfo | null }
  /** One of them changed (or was hired). Kept apart from worker.update, which is only ever your own floor's. */
  | { t: 'phone.worker'; floor: string; worker: WorkerInfo }
  /** One of them went home. */
  | { t: 'phone.workerRemove'; floor: string; workerId: string };
