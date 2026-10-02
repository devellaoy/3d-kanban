// Finding a worker on any floor the page knows: yours (`store.workers`) or the one the phone follows.
import type { ProjectInfo, WorkerInfo } from '../../shared/protocol';
import { store } from './index';

export function findWorker(id: string): WorkerInfo | undefined {
  return store.workers.get(id) ?? store.phoneFloor?.workers.get(id);
}

/** Whether a worker is on the floor the phone follows (and not on yours). */
const onPhoneFloor = (id: string) => !store.workers.has(id) && !!store.phoneFloor?.workers.has(id);

/** The project of the floor a worker is on, for its provider's name: yours when it's on your floor. */
export function projectOf(id: string): ProjectInfo | null {
  return onPhoneFloor(id) ? store.phoneFloor!.project : store.project;
}

/** The id of the floor a worker sits on: yours, or the one the phone follows. */
export function floorOfWorker(id: string): string | null {
  return onPhoneFloor(id) ? store.phoneFloor!.floor : store.floor;
}
